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
import { ComposioConnectionCoordinator } from "./connections.js";
import {
  ComposioUserBackendContribution,
  type ComposioStorage,
} from "./user-configuration.js";
import { reconcileComposioProviderConnection } from "./provider-reconciliation.js";

export interface ComposioUserHost {
  storage: ComposioStorage;
  settings: UserSettingsBackendContribution;
  apiKey?: string;
  client?: ComposioClient;
  callbackBaseUrl: string;
}

type CachedCatalog = {
  schemaVersion: 1;
  expiresAt: number;
  items: ToolkitSummary[];
};
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
        ? new ComposioClient({ apiKey: host.apiKey })
        : undefined);
    this.records = new ComposioUserBackendContribution({
      state: { storage: host.storage },
      settings: host.settings,
      availablePackages: [{ packageId: "composio", version: "0.0.1" }],
      reconcileProviderConnection: (request) =>
        reconcileComposioProviderConnection(this.requireClient(), request),
      revokeConnectedAccount: (id) =>
        this.requireClient().revokeConnectedAccount(id),
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
    return {
      schemaVersion: 1,
      items: decodeConnectorCatalogV1({
        schemaVersion: 1,
        items: cache.items.map((item) => ({
          id: item.slug,
          name: item.name,
          description: item.description,
          ...(item.logo ? { icon: item.logo } : {}),
        })),
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
      if (await tx.get(key)) return false;
      await tx.put(key, {
        schemaVersion: 1,
        status: "creating",
        startedAt: Date.now(),
      });
      return true;
    });
    if (!claimed)
      throw new Error(
        "This connector is still being prepared. Try again shortly.",
      );
    const created = await client.createManagedAuthConfig(
      slug,
      `FrockBot ${toolkit.name}`,
    );
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
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new Error("Connection command is invalid");
    const value = input as Record<string, unknown>;
    if (value.schemaVersion !== 1)
      throw new Error("Connection command version is unsupported");
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
  async reconcile(userId: string): Promise<void> {
    if (!this.client) return;
    const snapshot = await this.host.settings.readSnapshot();
    for (const connection of snapshot.connections.filter(
      (row) => row.packageId === this.packageId && row.state === "ready",
    )) {
      const id = connection.safeMetadata.connectedAccountId;
      let active = false;
      try {
        if (this.client && typeof id === "string") {
          const account = await this.client.getConnectedAccount(id);
          active =
            account.userId === userId &&
            account.id === id &&
            account.toolkitSlug === connection.safeMetadata.toolkitSlug &&
            account.status === "ACTIVE" &&
            !account.disabled;
        }
      } catch (error) {
        // A provider outage fails closed for this read, but does not claim the
        // grant expired. The next read retries and can restore availability.
        if (!(error instanceof ComposioRequestError && error.status === 404))
          throw new Error(
            "Could not check your connected apps. Try again shortly.",
          );
      }
      if (!active)
        await this.host.settings.replaceConnection(
          userId,
          connection.connectionId,
          connection.generation,
          {
            ...connection,
            state: "failed",
            failure: `${connection.safeMetadata.toolkitName ?? "This connection"} needs reconnecting`,
          },
        );
    }
  }
  projectConnection(connection: ConnectionView): ConnectionView {
    const { toolkitSlug, toolkitName } = connection.safeMetadata;
    return {
      ...connection,
      safeMetadata: {
        ...(typeof toolkitSlug === "string" ? { toolkitSlug } : {}),
        ...(typeof toolkitName === "string" ? { toolkitName } : {}),
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
      next = { ...connection, displayName: command.label };
    else if (command.type === "connection/set-enabled") {
      if (command.enabled && connection.state !== "disabled")
        throw new Error("Reconnect this account first");
      next = { ...connection, state: command.enabled ? "ready" : "disabled" };
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
