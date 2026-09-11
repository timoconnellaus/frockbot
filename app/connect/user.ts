// Connected apps in the User Durable Object: the Connection commands the
// Package owns, and what a Connection of its own looks like at each step.
//
// A hosted grant has three moments and this module owns all of them:
//
//  1. **Start.** The person presses Connect. A sign-in link is minted with the
//     provider, a Connection is written in `authorizing`, and the link is the
//     answer. The connected-account id is known from this moment.
//  2. **Return.** The person finishes on the app's own sign-in page and lands
//     on a public page that says to come back. Nothing there touches this
//     object: an anonymous redirect must not address a Durable Object.
//  3. **Reconcile.** The next read of the User's settings — the Connectors
//     page reloading when the app resumes — asks the provider what became of
//     each `authorizing` Connection and moves it to `ready` or `failed`.
//
// The provider key is the deployment's, not the User's, so a Connection here
// carries no credential of its own; the account id in its safe metadata is
// what a Bot presents beside that key. Rigor is proportional to consequence:
// a start and a disconnect are external effects keyed by their command id and
// replayed from their stored receipt, and everything else is a setting.
import type { ConnectionView } from "@frockbot/core/configuration";
import {
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/core/connection";
import { defineUserBackendContribution } from "@frockbot/core/contracts/contributions";
import type {
  UserSettingsBackendContribution,
  UserSettingsStorage,
} from "@frockbot/app/settings/user";
import {
  CONNECT_PACKAGE_ID,
  connectToolkitForConnectionTypeV1,
  type ConnectToolkitV1,
} from "./catalog.js";
import {
  ComposioClient,
  ComposioRequestError,
  type ComposioFetch,
  type ConnectedAccountSummaryV1,
} from "./composio.js";

const COMMAND_PREFIX = "connect:command:v1:";
const AUTH_CONFIG_PREFIX = "connect:auth-config:v1:";
const POLL_PREFIX = "connect:poll:v1:";
/** How often a still-authorizing Connection is asked about, at most. */
const POLL_INTERVAL_MS = 3_000;
/** How long a sign-in may stay unfinished before it is called failed. */
const AUTHORIZATION_TIMEOUT_MS = 30 * 60_000;
export const CONNECT_CALLBACK_PATH = "/api/connect/callback";

/** What a Connection of this Package keeps beside its state. Never a secret. */
export interface ConnectSafeMetadataV1 {
  toolkitSlug: string;
  toolkitName: string;
  connectedAccountId: string;
  /** The Bot-facing Tool Namespace; the slug, suffixed for a second account. */
  namespace: string;
  startedAt: string;
}

interface StoredCommand {
  accountId: string;
  fingerprint: string;
  receipt: ConnectionCommandReceiptV1;
}

interface StoredAuthConfig {
  id: string;
}

export interface ConnectUserBackendHost {
  storage: UserSettingsStorage & { delete(key: string): Promise<boolean> };
  settings: UserSettingsBackendContribution;
  /** The deployment's provider key. Absent, nothing can be connected. */
  apiKey?: string;
  /** The deployment's own origin, which the sign-in returns to. */
  callbackBaseUrl?: string;
  apiBaseUrl?: string;
  client?: ComposioClient;
  fetch?: ComposioFetch;
  now?: () => number;
  randomId?: () => string;
}

function decodeStoredCommand(value: unknown): StoredCommand {
  if (
    !value ||
    typeof value !== "object" ||
    typeof (value as StoredCommand).accountId !== "string" ||
    typeof (value as StoredCommand).fingerprint !== "string" ||
    !(value as StoredCommand).receipt
  ) {
    throw new Error("Stored Connected apps command is invalid");
  }
  return value as StoredCommand;
}

export function connectSafeMetadataV1(
  connection: ConnectionView,
): ConnectSafeMetadataV1 | undefined {
  const meta = connection.safeMetadata;
  if (
    connection.packageId !== CONNECT_PACKAGE_ID ||
    typeof meta.toolkitSlug !== "string" ||
    typeof meta.toolkitName !== "string" ||
    typeof meta.connectedAccountId !== "string" ||
    typeof meta.namespace !== "string" ||
    typeof meta.startedAt !== "string"
  ) {
    return undefined;
  }
  return {
    toolkitSlug: meta.toolkitSlug,
    toolkitName: meta.toolkitName,
    connectedAccountId: meta.connectedAccountId,
    namespace: meta.namespace,
    startedAt: meta.startedAt,
  };
}

/** What a person is told when a sign-in ends without an account. */
export function connectFailureLineV1(
  account: Pick<ConnectedAccountSummaryV1, "status" | "statusReason">,
): string {
  switch (account.status) {
    case "EXPIRED":
      return "This app's access has expired. Connect it again.";
    case "REVOKED":
      return "Access to this app was revoked. Connect it again.";
    case "INACTIVE":
      return "This app's connection is inactive. Connect it again.";
    default:
      return "Sign-in didn't finish. Connect it again.";
  }
}

export class ConnectUserBackendContribution {
  readonly packageId = CONNECT_PACKAGE_ID;
  private readonly client?: ComposioClient;
  private readonly now: () => number;
  private readonly randomId: () => string;

  constructor(private readonly host: ConnectUserBackendHost) {
    this.client =
      host.client ??
      (host.apiKey?.trim()
        ? new ComposioClient({
            apiKey: host.apiKey,
            ...(host.apiBaseUrl ? { baseUrl: host.apiBaseUrl } : {}),
            ...(host.fetch ? { fetch: host.fetch } : {}),
          })
        : undefined);
    this.now = host.now ?? Date.now;
    this.randomId = host.randomId ?? (() => crypto.randomUUID());
  }

  async executeConnection(
    accountId: string,
    input: unknown,
  ): Promise<ConnectionCommandReceiptV1> {
    const command = decodeConnectionCommandV1(input);
    const key = `${COMMAND_PREFIX}${command.commandId}`;
    const fingerprint = JSON.stringify(command);
    const stored = await this.host.storage.get<unknown>(key);
    if (stored !== undefined) {
      const decoded = decodeStoredCommand(stored);
      if (
        decoded.accountId !== accountId ||
        decoded.fingerprint !== fingerprint
      ) {
        throw new Error("Connection command idempotency key was reused");
      }
      return decoded.receipt;
    }
    const receipt = await this.execute(accountId, command);
    await this.host.storage.put<StoredCommand>(key, {
      accountId,
      fingerprint,
      receipt,
    });
    return receipt;
  }

  async lookupConnectionCommand(
    accountId: string,
    commandId: string,
  ): Promise<ConnectionCommandReceiptV1 | undefined> {
    const stored = await this.host.storage.get<unknown>(
      `${COMMAND_PREFIX}${commandId}`,
    );
    if (stored === undefined) return undefined;
    const decoded = decodeStoredCommand(stored);
    return decoded.accountId === accountId ? decoded.receipt : undefined;
  }

  leaseModelCredential(): Promise<never> {
    return Promise.reject(new Error("Connected apps hold no model credential"));
  }

  settleModelCredential(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * Runs before every settings read. Each Connection still waiting on a
   * sign-in is asked about, at most every few seconds, and settled when the
   * provider has an answer. A provider that cannot be reached leaves the
   * Connection where it is; the next read asks again.
   */
  async bootstrap(userId: string): Promise<void> {
    const snapshot = await this.host.settings.readSnapshot();
    const waiting = snapshot.connections.filter(
      (connection) =>
        connection.packageId === CONNECT_PACKAGE_ID &&
        connection.state === "authorizing",
    );
    if (waiting.length === 0) return;
    for (const connection of waiting) {
      // A read must never fail because the provider is down or a concurrent
      // command moved the Connection first; the next read asks again.
      await this.reconcile(userId, connection).catch(() => undefined);
    }
  }

  private async execute(
    accountId: string,
    command: ConnectionCommandV1,
  ): Promise<ConnectionCommandReceiptV1> {
    switch (command.type) {
      case "connection/oauth":
        return this.start(accountId, command);
      case "connection/set-enabled":
      case "connection/disconnect":
      case "connection/update-label":
        return this.change(accountId, command);
      default:
        return {
          schemaVersion: 1,
          commandId: command.commandId,
          connectionId:
            "connectionId" in command ? command.connectionId : "none",
          status: "failed",
        };
    }
  }

  private async start(
    accountId: string,
    command: Extract<ConnectionCommandV1, { type: "connection/oauth" }>,
  ): Promise<ConnectionCommandReceiptV1> {
    // A start that never made a Connection has no id to name; the receipt
    // still needs one, and "none" says exactly that.
    const failed = (): ConnectionCommandReceiptV1 => ({
      schemaVersion: 1,
      commandId: command.commandId,
      connectionId: "none",
      status: "failed",
    });
    const toolkit = command.connectionTypeId
      ? connectToolkitForConnectionTypeV1(command.connectionTypeId)
      : undefined;
    if (
      command.action !== "start" ||
      command.packageId !== CONNECT_PACKAGE_ID ||
      !toolkit ||
      !this.client ||
      !this.host.callbackBaseUrl
    ) {
      return failed();
    }
    if (
      !(await this.host.settings.isPackageInstalled(
        accountId,
        CONNECT_PACKAGE_ID,
      ))
    ) {
      return failed();
    }
    const authConfigId = await this.authConfigId(toolkit);
    const link = await this.client.createConnectLink({
      userId: accountId,
      authConfigId,
      callbackUrl: `${this.host.callbackBaseUrl.replace(/\/$/, "")}${CONNECT_CALLBACK_PATH}`,
    });
    const snapshot = await this.host.settings.readSnapshot();
    // A second account of the same app gets the first free suffix, never a
    // count: a count is reused the moment an earlier account is disconnected,
    // and two live Connections would then mount the same namespace.
    const taken = new Set(
      snapshot.connections
        .filter(
          (connection) =>
            connection.packageId === CONNECT_PACKAGE_ID &&
            connection.connectionTypeId === command.connectionTypeId &&
            connection.state !== "revoked",
        )
        .map((connection) => connectSafeMetadataV1(connection)?.namespace),
    );
    let ordinal = 1;
    while (
      taken.has(ordinal === 1 ? toolkit.slug : `${toolkit.slug}-${ordinal}`)
    )
      ordinal += 1;
    const connectionId = `connection-${this.randomId()}`;
    const metadata: ConnectSafeMetadataV1 = {
      toolkitSlug: toolkit.slug,
      toolkitName: toolkit.name,
      connectedAccountId: link.connectedAccountId,
      namespace: ordinal === 1 ? toolkit.slug : `${toolkit.slug}-${ordinal}`,
      startedAt: new Date(this.now()).toISOString(),
    };
    await this.host.settings.createConnection(accountId, {
      connectionId,
      packageId: CONNECT_PACKAGE_ID,
      connectionTypeId: command.connectionTypeId!,
      displayName: ordinal === 1 ? toolkit.name : `${toolkit.name} ${ordinal}`,
      state: "authorizing",
      safeMetadata: { ...metadata },
    });
    return {
      schemaVersion: 1,
      commandId: command.commandId,
      connectionId,
      status: "applied",
      oauth: {
        attemptId: command.attemptId,
        status: "waiting",
        authorizationUrl: link.redirectUrl,
        expiresAt: Date.parse(link.expiresAt),
      },
    };
  }

  /**
   * One provider-managed OAuth app per toolkit, per project. The provider has
   * no idempotency key for creating one, so the durable record is written
   * only once an id exists; a creation that raced another simply reads the
   * survivor from the provider's own list next time.
   */
  private async authConfigId(toolkit: ConnectToolkitV1): Promise<string> {
    const key = `${AUTH_CONFIG_PREFIX}${toolkit.slug}`;
    const stored = await this.host.storage.get<StoredAuthConfig>(key);
    if (stored?.id) return stored.id;
    const client = this.client!;
    const existing = (await client.listAuthConfigs()).find(
      (config) => config.toolkitSlug === toolkit.slug,
    );
    const config =
      existing ??
      (await client.createManagedAuthConfig(
        toolkit.slug,
        `FrockBot ${toolkit.name}`,
      ));
    await this.host.storage.put<StoredAuthConfig>(key, { id: config.id });
    return config.id;
  }

  private async change(
    accountId: string,
    command: Extract<
      ConnectionCommandV1,
      {
        type:
          | "connection/set-enabled"
          | "connection/disconnect"
          | "connection/update-label";
      }
    >,
  ): Promise<ConnectionCommandReceiptV1> {
    const receipt = (
      status: ConnectionCommandReceiptV1["status"],
    ): ConnectionCommandReceiptV1 => ({
      schemaVersion: 1,
      commandId: command.commandId,
      connectionId: command.connectionId,
      status,
    });
    const connection = await this.host.settings.getConnection(
      accountId,
      command.connectionId,
    );
    const metadata = connection && connectSafeMetadataV1(connection);
    if (!connection || !metadata || connection.state === "revoked") {
      return receipt("failed");
    }
    if (command.type === "connection/update-label") {
      await this.host.settings.replaceConnection(
        accountId,
        connection.connectionId,
        connection.generation,
        { ...connection, displayName: command.label },
      );
      return receipt("applied");
    }
    if (command.type === "connection/set-enabled") {
      if (connection.state !== "ready" && connection.state !== "disabled") {
        return receipt("failed");
      }
      await this.host.settings.replaceConnection(
        accountId,
        connection.connectionId,
        connection.generation,
        { ...connection, state: command.enabled ? "ready" : "disabled" },
      );
      return receipt("applied");
    }
    // Disconnect. The person has no surface of their own at the provider, so
    // the upstream grant goes with the account whatever the client asked;
    // a deletion the provider has already done counts as done.
    if (this.client) {
      await this.client.deleteConnectedAccount(metadata.connectedAccountId);
    }
    await this.host.settings.replaceConnection(
      accountId,
      connection.connectionId,
      connection.generation,
      {
        ...connection,
        state: "revoked",
        failure: undefined,
      } as ConnectionView,
    );
    await this.host.storage.delete(`${POLL_PREFIX}${connection.connectionId}`);
    return receipt("applied");
  }

  private async reconcile(
    userId: string,
    connection: ConnectionView,
  ): Promise<void> {
    const metadata = connectSafeMetadataV1(connection);
    if (!metadata || !this.client) return;
    const pollKey = `${POLL_PREFIX}${connection.connectionId}`;
    const lastPolled = await this.host.storage.get<number>(pollKey);
    const now = this.now();
    if (typeof lastPolled === "number" && now - lastPolled < POLL_INTERVAL_MS) {
      return;
    }
    await this.host.storage.put(pollKey, now);
    let account: ConnectedAccountSummaryV1;
    try {
      account = await this.client.getConnectedAccount(
        metadata.connectedAccountId,
      );
    } catch (error) {
      // Gone at the provider: the sign-in link expired unused, or the account
      // was removed from the dashboard. Either way there is nothing to wait for.
      if (error instanceof ComposioRequestError && error.status === 404) {
        await this.settle(userId, connection, "failed", {
          failure: connectFailureLineV1({ status: "FAILED" }),
        });
      }
      return;
    }
    if (account.status === "ACTIVE" && !account.disabled) {
      await this.settle(userId, connection, "ready", {
        generation: this.randomId(),
      });
      return;
    }
    if (account.status === "INITIALIZING" || account.status === "INITIATED") {
      if (now - Date.parse(metadata.startedAt) > AUTHORIZATION_TIMEOUT_MS) {
        await this.settle(userId, connection, "failed", {
          failure: "Sign-in timed out. Connect it again.",
        });
      }
      return;
    }
    await this.settle(userId, connection, "failed", {
      failure: connectFailureLineV1(account),
    });
  }

  private async settle(
    userId: string,
    connection: ConnectionView,
    state: "ready" | "failed",
    extra: { generation?: string; failure?: string },
  ): Promise<void> {
    // The provider round trip took time; a disconnect or an earlier settle
    // may have landed since the snapshot. Only a Connection still waiting is
    // settled, and from its current record rather than the stale one.
    const current = await this.host.settings.getConnection(
      userId,
      connection.connectionId,
    );
    if (!current || current.state !== "authorizing") return;
    const next: ConnectionView = {
      ...current,
      state,
      ...(extra.generation ? { generation: extra.generation } : {}),
    };
    if (extra.failure) next.failure = extra.failure;
    else delete next.failure;
    await this.host.settings.replaceConnection(
      userId,
      connection.connectionId,
      current.generation,
      next,
    );
    await this.host.storage.delete(`${POLL_PREFIX}${connection.connectionId}`);
  }
}

export function createConnectUserBackendContribution(
  host: ConnectUserBackendHost,
): ConnectUserBackendContribution {
  return new ConnectUserBackendContribution(host);
}

/** What an application hands this Contribution, under the Package's own key. */
export interface ConnectUserApplicationHostV1 {
  connect: ConnectUserBackendHost;
}

export const userContribution = defineUserBackendContribution<
  ConnectUserApplicationHostV1,
  ConnectUserBackendContribution
>({
  specifier: "@frockbot/app/connect/user",
  mount: (host, lifecycle) => {
    const contribution = createConnectUserBackendContribution(host.connect);
    const unregister =
      host.connect.settings.registerConfigurationReadBootstrap(contribution);
    const dispose = lifecycle.mount(contribution);
    return () => {
      unregister();
      dispose();
    };
  },
});
