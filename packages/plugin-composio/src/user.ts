import { ConnectedAccountTools } from "./tools.js";
import {
  decodeStartConnectionCommandV1,
  isConnectionIdentifier,
  type ConnectionView,
} from "@frockbot/configuration-core";
import {
  decodeConnectionCommandV1,
  decodeConnectorCatalogV1,
  type ConnectorCatalogEntryV1,
} from "@frockbot/connection-core";
import { defineUserBackendContribution } from "@frockbot/kernel-contracts/contributions";
import type { UserSettingsBackendContribution } from "@frockbot/plugin-settings/user";
import {
  ComposioClient,
  ComposioRequestError,
  type ToolkitSummary,
} from "./composio-client.js";
import {
  ComposioConnectionCoordinator,
  retireProviderAccount,
} from "./connections.js";
import {
  ComposioUserBackendContribution,
  type ComposioStorage,
} from "./user-configuration.js";
import { reconcileComposioProviderConnection } from "./provider-reconciliation.js";

export interface ComposioUserHost {
  storage: ComposioStorage;
  settings: UserSettingsBackendContribution;
  apiKey?: string;
  apiBaseUrl?: string;
  client?: ComposioClient;
  callbackBaseUrl: string;
}

type CachedCatalog = {
  schemaVersion: 1;
  expiresAt: number;
  items: ToolkitSummary[];
};
const AUTH_PENDING_KEY = "composio:auth-config-pending:v1";
const AUTH_RETRY_MS = 60_000;
const CATALOG_KEY = "composio:catalog:v1";

/** All provider calls and durable authorization records live in the User DO. */
export class ComposioUserService {
  readonly packageId = "composio";
  readonly records: ComposioUserBackendContribution;
  private readonly client?: ComposioClient;
  constructor(private readonly host: ComposioUserHost) {
    this.client =
      host.client ??
      (host.apiKey?.trim()
        ? new ComposioClient({ apiKey: host.apiKey, baseUrl: host.apiBaseUrl })
        : undefined);
    this.records = new ComposioUserBackendContribution({
      state: { storage: host.storage },
      settings: host.settings,
      availablePackages: [{ packageId: "composio", version: "0.0.1" }],
      reconcileProviderConnection: (request) =>
        reconcileComposioProviderConnection(this.requireClient(), request),
      revokeConnectedAccount: (id, userId, connectionId) =>
        retireProviderAccount(
          this.requireClient(),
          this.records,
          userId,
          connectionId,
          id,
        ),
    });
  }
  private requireClient(): ComposioClient {
    if (!this.client) throw new Error("Connected apps are unavailable");
    return this.client;
  }
  private coordinator(types = {}) {
    return new ComposioConnectionCoordinator({
      client: this.requireClient(),
      store: this.records,
      callbackBaseUrl: this.host.callbackBaseUrl,
      connectionTypes: types,
    });
  }
  async catalog(
    userId: string,
  ): Promise<{ schemaVersion: 1; items: ConnectorCatalogEntryV1[] }> {
    if (
      !this.client ||
      !(await this.host.settings.isPackageInstalled(userId, this.packageId))
    )
      return { schemaVersion: 1, items: [] };
    let cache = await this.host.storage.get<CachedCatalog>(CATALOG_KEY);
    if (!cache || cache.schemaVersion !== 1 || cache.expiresAt <= Date.now()) {
      const [toolkits, configs] = await Promise.all([
        this.client.listToolkits(),
        this.client.listAuthConfigs(),
      ]);
      const usable = new Set(configs.map((config) => config.toolkitSlug));
      cache = {
        schemaVersion: 1,
        expiresAt: Date.now() + 15 * 60_000,
        items: toolkits.filter(
          (item) => item.managedOAuth || usable.has(item.slug),
        ),
      };
      await this.host.storage.put(CATALOG_KEY, cache);
    }
    const retained = (
      await this.host.settings.readSnapshot()
    ).connections.filter(
      (row) => row.packageId === this.packageId && row.state !== "revoked",
    );
    const items = cache.items.map((item) => ({
      id: item.slug,
      name: item.name,
      description: item.description,
      ...(item.logo ? { icon: item.logo } : {}),
    }));
    for (const connection of retained) {
      const slug = connection.safeMetadata.toolkitSlug;
      if (typeof slug === "string" && !items.some((item) => item.id === slug))
        items.push({
          id: slug,
          name: String(
            connection.safeMetadata.toolkitName ?? connection.displayName,
          ),
          description: "This connection needs attention",
        });
    }
    return {
      schemaVersion: 1,
      items: decodeConnectorCatalogV1({
        schemaVersion: 1,
        items,
      }),
    };
  }
  private async authConfig(userId: string, slug: string) {
    const catalog = await this.catalog(userId);
    const toolkit = catalog.items.find((item) => item.id === slug);
    if (!toolkit) throw new Error("This connector is unavailable");
    const client = this.requireClient();
    const configs = await client.listAuthConfigs();
    const configured = configs.find((item) => item.toolkitSlug === slug);
    if (configured) {
      await this.host.storage.put(`composio:auth-config:${slug}`, {
        schemaVersion: 1,
        status: "ready",
        id: configured.id,
      });
      return {
        authConfigId: configured.id,
        displayName: toolkit.name,
        toolkitSlug: slug,
      };
    }
    const cache = await this.host.storage.get<CachedCatalog>(CATALOG_KEY);
    if (!cache?.items.find((item) => item.slug === slug)?.managedOAuth)
      throw new Error("This connector needs administrator setup");
    const key = `composio:auth-config:${slug}`;
    // The provider has no documented idempotency key. An interrupted creation
    // is reconciled from its catalog, never blindly repeated.
    const claimed = await this.host.storage.transaction(async (tx) => {
      const previous = await tx.get<{ status: string }>(key);
      if (
        previous &&
        previous.status !== "ready" &&
        previous.status !== "failed"
      )
        return false;
      const pending = (await tx.get<string[]>(AUTH_PENDING_KEY)) ?? [];
      if (!pending.includes(slug)) {
        if (pending.length >= 1000)
          throw new Error("Too many connectors awaiting setup");
        await tx.put(AUTH_PENDING_KEY, [...pending, slug]);
      }
      const alarm = await tx.getAlarm?.();
      await tx.setAlarm(
        Math.min(alarm ?? Infinity, Date.now() + AUTH_RETRY_MS),
      );
      await tx.put(key, {
        schemaVersion: 1,
        status: "creating",
        startedAt: Date.now(),
      });
      return true;
    });
    if (!claimed)
      throw new Error(
        "This connector needs administrator setup before it can connect.",
      );
    let created;
    try {
      created = await client.createManagedAuthConfig(
        slug,
        `FrockBot ${toolkit.name}`,
      );
    } catch (error) {
      const definitive =
        error instanceof ComposioRequestError &&
        error.status >= 400 &&
        error.status < 500 &&
        error.status !== 408 &&
        error.status !== 409;
      await this.host.storage.put(key, {
        schemaVersion: 1,
        status: definitive ? "failed" : "uncertain",
        failure: definitive
          ? "Setup was rejected; another connection attempt may retry."
          : "Setup outcome is unknown; the administrator can finish setup and the next read will reconcile it.",
      });
      throw new Error(
        definitive
          ? "This connector could not be prepared. Try connecting again."
          : "This connector needs administrator setup before it can connect.",
      );
    }
    await this.host.storage.put(key, {
      schemaVersion: 1,
      status: "ready",
      id: created.id,
    });
    return {
      authConfigId: created.id,
      displayName: toolkit.name,
      toolkitSlug: slug,
    };
  }
  async request(userId: string, input: unknown): Promise<unknown> {
    await this.host.settings.read(userId);
    await this.migrate(userId);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Connection command is invalid");
    const value = input as Record<string, unknown>;
    if (value.schemaVersion !== 1)
      throw new Error("Connection command version is unsupported");
    const fields: Record<string, string[]> = {
      catalog: [],
      "tool-availability": [],
      "list-tools": ["connectionId"],
      "execute-tool": [
        "connectionId",
        "toolName",
        "version",
        "arguments",
        "effectId",
        "sessionId",
      ],
      start: ["command", "start"],
      revoke: ["connectionId"],
      fail: ["connectionId", "authorizationStateId"],
      complete: ["connectionId", "authorizationStateId", "connectedAccountId"],
    };
    if (
      typeof value.operation !== "string" ||
      !Object.hasOwn(fields, value.operation)
    )
      throw new Error("Connection command is unsupported");
    const allowed = new Set([
      "schemaVersion",
      "operation",
      ...fields[value.operation]!,
    ]);
    if (Object.keys(value).some((key) => !allowed.has(key)))
      throw new Error("Connection command has invalid fields");
    if (value.operation === "tool-availability")
      return {
        schemaVersion: 1,
        available:
          !!this.client &&
          (await this.host.settings.isPackageInstalled(userId, this.packageId)),
      };
    if (value.operation === "execute-tool" && !this.client)
      return {
        content:
          "This connector is temporarily unavailable. The action was not started.",
        isError: true,
      };
    if (
      value.operation === "list-tools" ||
      value.operation === "execute-tool"
    ) {
      if (!isConnectionIdentifier(value.connectionId))
        throw new Error("Connection is invalid");
      const tools = new ConnectedAccountTools({
        client: this.requireClient(),
        storage: this.host.storage,
        connection: async (owner, id) => {
          const snapshot = await this.host.settings.readSnapshot();
          if (
            !snapshot.packages.some(
              (item) =>
                item.packageId === this.packageId && item.state === "installed",
            )
          )
            throw new Error("This connector is unavailable");
          const connection = snapshot.connections.find(
            (item) =>
              item.packageId === this.packageId && item.connectionId === id,
          );
          if (!connection || connection.state !== "ready")
            throw new Error("This connection is unavailable");
          return connection;
        },
      });
      return value.operation === "list-tools"
        ? tools.list(userId, value.connectionId)
        : tools.execute(userId, value);
    }
    if (value.operation === "catalog") {
      await this.reconcile(userId);
      return this.catalog(userId);
    }
    if (value.operation === "start") {
      const command = decodeStartConnectionCommandV1(value.command);
      if (command.connectionTypeId !== "app" || !command.connectorId)
        throw new Error("Choose a connector");
      const start = value.start as Record<string, unknown> | undefined;
      if (
        !start ||
        typeof start.callbackState !== "string" ||
        start.callbackState.length > 8192 ||
        !isConnectionIdentifier(start.authorizationStateId) ||
        typeof start.authorizationStateExpiresAt !== "number" ||
        !Number.isSafeInteger(start.authorizationStateExpiresAt) ||
        start.authorizationStateExpiresAt <= Date.now() ||
        (start.returnTarget !== "browser" && start.returnTarget !== "desktop")
      )
        throw new Error("Connection authorization is invalid");
      const startInput: Parameters<ComposioConnectionCoordinator["start"]>[1] =
        {
          ...command,
          returnTarget: start.returnTarget,
          callbackState: start.callbackState,
          authorizationStateId: start.authorizationStateId,
          authorizationStateExpiresAt: start.authorizationStateExpiresAt,
        };
      const replay = await this.coordinator().replayStart(userId, startInput);
      if (replay) return replay;
      const type = await this.authConfig(userId, command.connectorId);
      return this.coordinator({ [command.connectorId]: type }).start(
        userId,
        startInput,
      );
    }
    if (!isConnectionIdentifier(value.connectionId))
      throw new Error("Connection is invalid");
    if (value.operation === "revoke")
      return this.coordinator().revoke(userId, value.connectionId);
    if (!isConnectionIdentifier(value.authorizationStateId))
      throw new Error("Connection authorization is invalid");
    if (value.operation === "fail")
      return this.coordinator().fail(
        userId,
        value.connectionId,
        "Authorization was not completed",
        value.authorizationStateId,
      );
    if (
      value.operation === "complete" &&
      typeof value.connectedAccountId === "string" &&
      value.connectedAccountId.length <= 200
    ) {
      return this.coordinator().complete(userId, {
        connectionId: value.connectionId,
        connectedAccountId: value.connectedAccountId,
        authorizationStateId: value.authorizationStateId,
      });
    }
    throw new Error("Connection command is unsupported");
  }
  private async migrate(userId: string): Promise<void> {
    await this.host.storage.transaction(async (tx) => {
      const snapshot = await this.host.settings.readSnapshot(tx);
      for (const connection of snapshot.connections) {
        if (
          connection.packageId !== this.packageId ||
          connection.safeMetadata.recordVersion === 1
        )
          continue;
        await this.host.settings.replaceConnection(
          userId,
          connection.connectionId,
          connection.generation,
          {
            ...connection,
            connectionTypeId: "app",
            generation: crypto.randomUUID(),
            safeMetadata: {
              ...connection.safeMetadata,
              recordVersion: 1,
              toolkitSlug:
                connection.safeMetadata.toolkitSlug ??
                connection.connectionTypeId,
              toolkitName:
                connection.safeMetadata.toolkitName ?? connection.displayName,
            },
          },
          tx,
        );
      }
    });
  }
  async reconcile(userId: string): Promise<void> {
    await this.migrate(userId);
    if (
      !this.client ||
      !(await this.host.settings.isPackageInstalled(userId, this.packageId))
    )
      return;
    const snapshot = await this.host.settings.readSnapshot();
    for (const connection of snapshot.connections.filter(
      (row) =>
        row.packageId === this.packageId &&
        (row.state === "ready" ||
          (row.state === "reconciliation-required" &&
            row.safeMetadata.availabilityCheck === true)),
    )) {
      let next = connection;
      try {
        const id = connection.safeMetadata.connectedAccountId;
        const account =
          typeof id === "string"
            ? await this.client.getConnectedAccount(id)
            : undefined;
        const active =
          account &&
          account.userId === userId &&
          account.id === id &&
          account.toolkitSlug === connection.safeMetadata.toolkitSlug &&
          account.status === "ACTIVE" &&
          !account.disabled;
        if (active && connection.state === "ready") continue;
        const { availabilityCheck: _check, ...safeMetadata } =
          connection.safeMetadata;
        next = {
          ...connection,
          state: active ? "ready" : "failed",
          safeMetadata,
          failure: active
            ? undefined
            : `${safeMetadata.toolkitName ?? "This connection"} needs reconnecting`,
        };
      } catch (error) {
        next = {
          ...connection,
          state:
            error instanceof ComposioRequestError && error.status === 404
              ? "failed"
              : "reconciliation-required",
          safeMetadata: { ...connection.safeMetadata, availabilityCheck: true },
          failure: "Could not check this connection. Try again shortly.",
        };
      }
      // Read again inside the DO transaction: provider I/O may overlap a
      // Disconnect. A stale observation must never change that decision.
      await this.host.storage.transaction(async (tx) => {
        const current = await this.host.settings.readSnapshot(tx);
        const live = current.connections.find(
          (row) => row.connectionId === connection.connectionId,
        );
        if (!live || JSON.stringify(live) !== JSON.stringify(connection))
          return;
        await this.host.settings.replaceConnection(
          userId,
          connection.connectionId,
          connection.generation,
          { ...next, generation: crypto.randomUUID() },
          tx,
        );
      });
    }
  }
  projectConnection(connection: ConnectionView): ConnectionView {
    const { toolkitSlug, toolkitName } = connection.safeMetadata;
    return {
      ...connection,
      safeMetadata: {
        ...(typeof toolkitSlug === "string"
          ? { connectorId: toolkitSlug }
          : {}),
        ...(typeof toolkitName === "string"
          ? { connectorName: toolkitName }
          : {}),
      },
      ...(connection.failure
        ? {
            failure:
              connection.state === "failed"
                ? `${toolkitName ?? "This connection"} needs reconnecting`
                : "Checking your connection. Try again shortly.",
          }
        : {}),
    };
  }
  async alarm() {
    await this.records.alarm();
    const pending =
      (await this.host.storage.get<string[]>(AUTH_PENDING_KEY)) ?? [];
    if (!pending.length || !this.client) return;
    try {
      const configs = await this.client.listAuthConfigs();
      await this.host.storage.transaction(async (tx) => {
        const live = (await tx.get<string[]>(AUTH_PENDING_KEY)) ?? [];
        const remaining: string[] = [];
        for (const slug of pending) {
          const key = `composio:auth-config:${slug}`;
          const record = await tx.get<{ status: string; startedAt?: number }>(
            key,
          );
          if (record?.status !== "creating" && record?.status !== "uncertain")
            continue;
          if (
            record.startedAt &&
            record.startedAt + AUTH_RETRY_MS > Date.now()
          ) {
            remaining.push(slug);
            continue;
          }
          const config = configs.find((item) => item.toolkitSlug === slug);
          await tx.put(
            key,
            config
              ? { schemaVersion: 1, status: "ready", id: config.id }
              : {
                  schemaVersion: 1,
                  status: "uncertain",
                  failure: "Administrator setup is needed before connecting.",
                },
          );
        }
        // Unknown creates are terminal and visible on the next connect attempt.
        // A later catalog lookup can resolve them; never repeat their POST.
        await tx.put(AUTH_PENDING_KEY, [
          ...live.filter((slug) => !pending.includes(slug)),
          ...remaining,
        ]);
        if (remaining.length) {
          const alarm = await tx.getAlarm?.();
          await tx.setAlarm(
            Math.min(
              alarm && alarm > Date.now() ? alarm : Infinity,
              Date.now() + AUTH_RETRY_MS,
            ),
          );
        }
      });
    } catch {
      const alarm = await this.host.storage.getAlarm?.();
      await this.host.storage.setAlarm(
        Math.min(
          alarm && alarm > Date.now() ? alarm : Infinity,
          Date.now() + AUTH_RETRY_MS,
        ),
      );
    }
  }
  async lookupConnectionCommand(userId: string, commandId: string) {
    await this.host.settings.read(userId);
    return (
      await this.host.storage.get<{ receipt: unknown }>(
        `composio:command:${commandId}`,
      )
    )?.receipt;
  }
  async executeConnection(userId: string, input: unknown) {
    const command = decodeConnectionCommandV1(input);
    if (!("connectionId" in command))
      throw new Error("Connect this account on Connectors");
    const key = `composio:command:${command.commandId}`;
    const fingerprint = JSON.stringify(command);
    const previous = await this.host.storage.get<{
      fingerprint: string;
      receipt?: unknown;
    }>(key);
    if (previous && previous.fingerprint !== fingerprint)
      throw new Error("Connection command was reused");
    if (previous?.receipt) return previous.receipt;
    const connection = await this.records.getConnection(
      userId,
      command.connectionId,
    );
    if (!connection || connection.packageId !== this.packageId)
      throw new Error("Connection is unavailable");
    await this.host.storage.put(key, { schemaVersion: 1, fingerprint });
    let next: ConnectionView = connection;
    if (command.type === "connection/disconnect")
      await this.coordinator().revoke(userId, command.connectionId);
    else if (command.type === "connection/update-label")
      next = {
        ...connection,
        generation: crypto.randomUUID(),
        displayName: command.label,
      };
    else if (command.type === "connection/set-enabled") {
      if (command.enabled && connection.state !== "disabled")
        throw new Error("Reconnect this account first");
      next = {
        ...connection,
        generation: crypto.randomUUID(),
        state: command.enabled ? "ready" : "disabled",
      };
    } else throw new Error("Connection command is unsupported");
    if (next !== connection)
      await this.host.settings.replaceConnection(
        userId,
        connection.connectionId,
        connection.generation,
        next,
      );
    const receipt = {
      schemaVersion: 1,
      commandId: command.commandId,
      connectionId: connection.connectionId,
      status: "applied",
    };
    await this.host.storage.put(key, {
      schemaVersion: 1,
      fingerprint,
      receipt,
    });
    return receipt;
  }
  async leaseModelCredential(): Promise<never> {
    throw new Error("This connection does not provide models");
  }
  async settleModelCredential(): Promise<void> {}
}

export interface ComposioUserApplicationHostV1 {
  composio: ComposioUserHost;
}
export const userContribution = defineUserBackendContribution<
  ComposioUserApplicationHostV1,
  ComposioUserService
>({
  specifier: "@frockbot/plugin-composio/user-configuration",
  create: (host, lifecycle) => () =>
    lifecycle.mount(new ComposioUserService(host.composio)),
});
