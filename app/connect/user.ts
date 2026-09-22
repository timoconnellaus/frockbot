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
import {
  CONNECTION_RETURN_CLIENTS_V1,
  type ConnectionReturnClientV1,
  type ConnectionView,
} from "@frockbot/core/configuration";
import {
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
} from "@frockbot/core/connection";
import { defineUserBackendContribution } from "@frockbot/core/contracts/contributions";
import type {
  UserSettingsBackendContribution,
  UserSettingsStorage,
  UserSettingsTransaction,
} from "@frockbot/app/settings/user";
import {
  armConnectCatalogAlarmV1,
  coalesceConnectCatalogDiscoveryV1,
  commitConnectCatalogJobV1,
  CONNECT_CATALOG_FIRST_USE_MS_V1,
  CONNECT_CATALOG_JOB_PREFIX_V1,
  connectCatalogDisclosableV1,
  connectCatalogRefreshDueV1,
  ConnectCatalogInvalidError,
  dueConnectCatalogJobsV1,
  invalidateConnectCatalogV1,
  publishConnectCatalogV1,
  readConnectCatalogBodyV1,
  readConnectCatalogDirectoryV1,
  recordConnectCatalogFailureV1,
  CONNECT_CATALOG_UNAVAILABLE_MESSAGE_V1,
  CONNECT_STALE_CONTRACT_MESSAGE_V1,
  type ConnectAccountCatalogAnswerV1,
  type ConnectCatalogDirectoryV1,
  type ConnectCatalogJobV1,
  type ConnectCatalogStorageV1,
  type ConnectCatalogTransactionV1,
} from "./account-catalog.js";
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
  type ConnectToolV1,
} from "./composio.js";
import {
  connectReadyConnectionsV1,
  connectTriggerByRoutineKeyV1,
  connectTriggerEffectKeyV1,
  connectTriggerInstanceKeyV1,
  CONNECT_TRIGGER_INSTANCE_PREFIX,
  connectTriggerOffersV1,
  decodeConnectTriggerEffectReceiptV1,
  decodeConnectTriggerInstanceRecordV1,
  type ConnectTriggerEffectReceiptV1,
  type ConnectTriggerInstanceRecordV1,
  type ConnectTriggerOfferV1,
} from "./triggers.js";

const COMMAND_PREFIX = "connect:command:v1:";
const AUTH_CONFIG_PREFIX = "connect:auth-config:v1:";
const POLL_PREFIX = "connect:poll:v1:";
/** How often a still-authorizing Connection is asked about, at most. */
const POLL_INTERVAL_MS = 3_000;
/** How long a sign-in may stay unfinished before it is called failed. */
const AUTHORIZATION_TIMEOUT_MS = 30 * 60_000;
/** How long a settings read may wait on the provider before moving on. */
const BOOTSTRAP_DEADLINE_MS = 5_000;
export const CONNECT_CALLBACK_PATH = "/api/connect/callback";

/**
 * Where the app's sign-in sends the person afterwards: the plain page for a
 * browser tab, or the page under the client's own segment — the one the
 * Android app claims as a verified link, the one the Mac page hands to the
 * app's scheme. Deployment policy names the origin; the client names only
 * which of these pages it can come back through.
 */
export function connectCallbackPathV1(
  client?: ConnectionReturnClientV1,
): string {
  return client === undefined
    ? CONNECT_CALLBACK_PATH
    : `${CONNECT_CALLBACK_PATH}/${client}`;
}

/** The client a callback path names, or `undefined` for the plain page. */
export function connectReturnClientV1(
  pathname: string,
): ConnectionReturnClientV1 | undefined | null {
  if (pathname === CONNECT_CALLBACK_PATH) return undefined;
  const client = CONNECTION_RETURN_CLIENTS_V1.find(
    (candidate) => pathname === connectCallbackPathV1(candidate),
  );
  return client ?? null;
}

/** What a Connection of this Package keeps beside its state. Never a secret. */
export interface ConnectSafeMetadataV1 {
  toolkitSlug: string;
  toolkitName: string;
  connectedAccountId: string;
  /** The Bot-facing Tool Namespace; the slug, suffixed for a second account. */
  namespace: string;
  startedAt: string;
}

/** What a poll of the provider says to do with a waiting Connection. */
interface ConnectSettlementV1 {
  state: "ready" | "failed";
  extra: { generation?: string; failure?: string };
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
  storage: UserSettingsStorage & {
    delete(key: string): Promise<boolean>;
    list<T>(options: {
      prefix: string;
      limit?: number;
      start?: string;
    }): Promise<Map<string, T>>;
    getAlarm?(): Promise<number | null>;
    setAlarm?(scheduledTime: number): Promise<void>;
  };
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
  /** How long a settings read waits on the provider. Tests shorten it. */
  bootstrapDeadlineMs?: number;
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
  account: Pick<ConnectedAccountSummaryV1, "status">,
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
  private readonly bootstrapDeadlineMs: number;
  /** One provider listing per Connection generation, shared by concurrent Turns. */
  private readonly catalogDiscovery = new Map<
    string,
    Promise<ConnectAccountCatalogAnswerV1>
  >();

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
    this.bootstrapDeadlineMs =
      host.bootstrapDeadlineMs ?? BOOTSTRAP_DEADLINE_MS;
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
   * Runs before every settings read. Every Connection still waiting on a
   * sign-in is asked about at once, at most every few seconds each, and
   * settled when the provider has an answer. The answers are applied one at a
   * time because each settle rewrites the one settings record. A read waits no
   * longer than the deadline: a provider that is slow or unreachable leaves
   * the Connection where it is and the next read asks again.
   */
  async bootstrap(userId: string): Promise<void> {
    const snapshot = await this.host.settings.readSnapshot();
    const waiting = snapshot.connections.filter(
      (connection) =>
        connection.packageId === CONNECT_PACKAGE_ID &&
        connection.state === "authorizing",
    );
    if (waiting.length === 0) return;
    let applied: Promise<unknown> = Promise.resolve();
    const settled = waiting.map(async (connection) => {
      const outcome = await this.poll(connection).catch(() => undefined);
      if (!outcome) return;
      // A settle must never fail the read either: a concurrent command may
      // have moved the Connection first, and the next read asks again.
      const next = applied.then(() =>
        this.settle(userId, connection, outcome.state, outcome.extra).catch(
          () => undefined,
        ),
      );
      applied = next;
      await next;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.bootstrapDeadlineMs);
    });
    await Promise.race([Promise.all(settled), deadline]);
    clearTimeout(timer);
  }

  /**
   * The events ready Connections of this User can start a Routine on.
   * Only connected apps' events: an app nobody connected is not offered.
   */
  async listTriggers(userId: string): Promise<ConnectTriggerOfferV1[]> {
    if (!this.client) return [];
    const snapshot = await this.host.settings.readSnapshot();
    const ready = connectReadyConnectionsV1(snapshot.connections);
    const offers: ConnectTriggerOfferV1[] = [];
    for (const connection of ready) {
      try {
        const types = await this.client.listTriggerTypes(
          connection.toolkitSlug,
        );
        offers.push(...connectTriggerOffersV1(connection, types));
      } catch {
        // One app that cannot list its events must not hide the others.
      }
    }
    void userId;
    return offers;
  }

  async upsertTrigger(input: {
    userId: string;
    commandId: string;
    botId: string;
    routineId: string;
    connectionId: string;
    triggerType: string;
    config?: Record<string, string | number | boolean>;
  }): Promise<{ instanceId: string; routineId: string }> {
    const effectKey = connectTriggerEffectKeyV1(input.commandId);
    const replayed = decodeConnectTriggerEffectReceiptV1(
      await this.host.storage.get<unknown>(effectKey),
    );
    if (replayed?.status === "upserted" && replayed.instanceId) {
      return {
        instanceId: replayed.instanceId,
        routineId: replayed.routineId,
      };
    }
    if (!this.client) {
      throw new Error("Connecting apps isn't available right now.");
    }
    const connection = await this.host.settings.getConnection(
      input.userId,
      input.connectionId,
    );
    const metadata = connection && connectSafeMetadataV1(connection);
    if (!connection || !metadata || connection.state !== "ready") {
      throw new Error("Connect this app before a Routine can fire on it.");
    }
    const types = await this.client.listTriggerTypes(metadata.toolkitSlug);
    if (!types.some((type) => type.slug === input.triggerType)) {
      throw new Error("That app does not offer this event.");
    }
    const heldKey = connectTriggerByRoutineKeyV1(input.botId, input.routineId);
    const previousId = await this.host.storage.get<string>(heldKey);
    const instance = await this.client.upsertTriggerInstance({
      slug: input.triggerType,
      userId: input.userId,
      connectedAccountId: metadata.connectedAccountId,
      ...(input.config === undefined ? {} : { config: input.config }),
    });
    if (previousId && previousId !== instance.id) {
      await this.client
        .deleteTriggerInstance(previousId)
        .catch(() => undefined);
      await this.host.storage.delete(connectTriggerInstanceKeyV1(previousId));
    }
    const record: ConnectTriggerInstanceRecordV1 = {
      schemaVersion: 1,
      instanceId: instance.id,
      botId: input.botId,
      routineId: input.routineId,
      connectionId: input.connectionId,
      triggerType: input.triggerType,
    };
    await this.host.storage.put(
      connectTriggerInstanceKeyV1(instance.id),
      record,
    );
    await this.host.storage.put(heldKey, instance.id);
    const receipt: ConnectTriggerEffectReceiptV1 = {
      schemaVersion: 1,
      commandId: input.commandId,
      instanceId: instance.id,
      botId: input.botId,
      routineId: input.routineId,
      status: "upserted",
    };
    await this.host.storage.put(effectKey, receipt);
    return { instanceId: instance.id, routineId: input.routineId };
  }

  async deleteTrigger(input: {
    commandId: string;
    botId: string;
    routineId: string;
  }): Promise<void> {
    const effectKey = connectTriggerEffectKeyV1(input.commandId);
    const replayed = decodeConnectTriggerEffectReceiptV1(
      await this.host.storage.get<unknown>(effectKey),
    );
    if (replayed?.status === "deleted") return;
    const heldKey = connectTriggerByRoutineKeyV1(input.botId, input.routineId);
    const instanceId =
      replayed?.instanceId ?? (await this.host.storage.get<string>(heldKey));
    if (instanceId && this.client) {
      await this.client
        .deleteTriggerInstance(instanceId)
        .catch(() => undefined);
      await this.host.storage.delete(connectTriggerInstanceKeyV1(instanceId));
    }
    await this.host.storage.delete(heldKey);
    await this.host.storage.put(effectKey, {
      schemaVersion: 1,
      commandId: input.commandId,
      botId: input.botId,
      routineId: input.routineId,
      status: "deleted",
      ...(instanceId ? { instanceId } : {}),
    } satisfies ConnectTriggerEffectReceiptV1);
  }

  async resolveTrigger(
    instanceId: string,
  ): Promise<ConnectTriggerInstanceRecordV1 | undefined> {
    return decodeConnectTriggerInstanceRecordV1(
      await this.host.storage.get<unknown>(
        connectTriggerInstanceKeyV1(instanceId),
      ),
    );
  }

  /**
   * A ready Connection whose grant has expired. The Routines that fired on
   * it lose their instances; the caller pauses them.
   */
  async failExpiredAccount(
    userId: string,
    connectedAccountId: string,
  ): Promise<
    | {
        connectionId: string;
        routines: Array<{ botId: string; routineId: string }>;
      }
    | undefined
  > {
    const snapshot = await this.host.settings.readSnapshot();
    const connection = snapshot.connections.find((candidate) => {
      const metadata = connectSafeMetadataV1(candidate);
      return metadata?.connectedAccountId === connectedAccountId;
    });
    if (!connection || connection.state === "revoked") return undefined;
    const routines = await this.deleteTriggersForConnection(
      connection.connectionId,
    );
    if (connection.state === "ready" || connection.state === "disabled") {
      await this.host.settings.replaceConnection(
        userId,
        connection.connectionId,
        connection.generation,
        {
          ...connection,
          state: "failed",
          failure: connectFailureLineV1({ status: "EXPIRED" }),
        } as ConnectionView,
      );
      await invalidateConnectCatalogV1(
        this.catalogStorage(),
        connection.connectionId,
        "failed",
      );
    }
    return { connectionId: connection.connectionId, routines };
  }

  async deleteTriggersForConnection(
    connectionId: string,
  ): Promise<Array<{ botId: string; routineId: string }>> {
    const held = await this.host.storage.list<unknown>({
      prefix: CONNECT_TRIGGER_INSTANCE_PREFIX,
    });
    const routines: Array<{ botId: string; routineId: string }> = [];
    for (const [key, value] of held) {
      const record = decodeConnectTriggerInstanceRecordV1(value);
      if (!record || record.connectionId !== connectionId) continue;
      if (this.client) {
        await this.client
          .deleteTriggerInstance(record.instanceId)
          .catch(() => undefined);
      }
      await this.host.storage.delete(key);
      await this.host.storage.delete(
        connectTriggerByRoutineKeyV1(record.botId, record.routineId),
      );
      routines.push({ botId: record.botId, routineId: record.routineId });
    }
    return routines;
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
    // The gateway names which return page the client can come back through;
    // the origin is this deployment's own, whatever the command carried.
    const requested = command.callbackUrl
      ? connectReturnClientV1(URL.parse(command.callbackUrl)?.pathname ?? "")
      : undefined;
    const link = await this.client.createConnectLink({
      userId: accountId,
      authConfigId,
      callbackUrl: `${this.host.callbackBaseUrl.replace(/\/$/, "")}${connectCallbackPathV1(requested ?? undefined)}`,
    });
    const snapshot = await this.host.settings.readSnapshot();
    const siblings = snapshot.connections.filter(
      (connection) =>
        connection.packageId === CONNECT_PACKAGE_ID &&
        connection.connectionTypeId === command.connectionTypeId &&
        connection.state !== "revoked",
    );
    // A sign-in that failed is a retry waiting to happen, not a live account:
    // it holds no name, and it is retired once this Connection is written.
    const dead = siblings.filter((sibling) => sibling.state === "failed");
    const live = siblings.filter((sibling) => sibling.state !== "failed");
    // A second account of the same app gets the first free suffix, never a
    // count: a count is reused the moment an earlier account is disconnected,
    // and two live Connections would then mount the same namespace.
    const taken = new Set(
      live.map((connection) => connectSafeMetadataV1(connection)?.namespace),
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
    for (const sibling of dead) await this.retire(accountId, sibling);
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
   * Retires a Connection that will never become live: the upstream grant is
   * dropped best effort, because a provider that cannot be reached must not
   * keep a dead sign-in holding the app's name.
   */
  private async retire(
    accountId: string,
    connection: ConnectionView,
  ): Promise<void> {
    const metadata = connectSafeMetadataV1(connection);
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
    await invalidateConnectCatalogV1(
      this.catalogStorage(),
      connection.connectionId,
      "revoked",
    );
    if (this.client && metadata) {
      try {
        await this.client.deleteConnectedAccount(metadata.connectedAccountId);
      } catch {
        // The dead account is retired here either way.
      }
    }
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
    await this.deleteTriggersForConnection(command.connectionId);
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
    await invalidateConnectCatalogV1(
      this.catalogStorage(),
      connection.connectionId,
      "revoked",
    );
    return receipt("applied");
  }

  /**
   * Asks the provider what became of one waiting Connection. It answers what
   * to settle it to, or nothing at all when it is throttled, unreachable, or
   * the sign-in is still legitimately outstanding. It never rejects: a read
   * must not fail because the provider is down.
   */
  private async poll(
    connection: ConnectionView,
  ): Promise<ConnectSettlementV1 | undefined> {
    const metadata = connectSafeMetadataV1(connection);
    if (!metadata || !this.client) return undefined;
    const pollKey = `${POLL_PREFIX}${connection.connectionId}`;
    const lastPolled = await this.host.storage.get<number>(pollKey);
    const now = this.now();
    if (typeof lastPolled === "number" && now - lastPolled < POLL_INTERVAL_MS) {
      return undefined;
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
        return {
          state: "failed",
          extra: { failure: connectFailureLineV1({ status: "FAILED" }) },
        };
      }
      return undefined;
    }
    if (account.status === "ACTIVE" && !account.disabled) {
      return { state: "ready", extra: { generation: this.randomId() } };
    }
    if (account.status === "INITIALIZING" || account.status === "INITIATED") {
      if (now - Date.parse(metadata.startedAt) > AUTHORIZATION_TIMEOUT_MS) {
        return {
          state: "failed",
          extra: { failure: "Sign-in timed out. Connect it again." },
        };
      }
      return undefined;
    }
    return {
      state: "failed",
      extra: { failure: connectFailureLineV1(account) },
    };
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
    if (state === "ready" && next.generation) {
      await this.scheduleCatalogRefresh(next);
    }
  }

  /**
   * The account catalog a Turn may list or disclose.
   *
   * `disclose: false` reads the directory only. Schemas are fetched only when
   * a Turn asks to disclose them and the stored catalog is missing or older
   * than the disclosure window.
   */
  async readToolCatalog(input: {
    userId: string;
    connectionId: string;
    generation: string;
    disclose: boolean;
    /** Tests shorten the first-use bound. Production uses the policy constant. */
    firstUseMs?: number;
  }): Promise<ConnectAccountCatalogAnswerV1> {
    if (!input.disclose) return this.readDirectoryAnswer(input);
    return coalesceConnectCatalogDiscoveryV1(
      this.catalogDiscovery,
      `${input.connectionId}:${input.generation}`,
      () => this.discloseCatalog(input),
    );
  }

  private async readDirectoryAnswer(input: {
    userId: string;
    connectionId: string;
    generation: string;
  }): Promise<ConnectAccountCatalogAnswerV1> {
    const connection = await this.host.settings.getConnection(
      input.userId,
      input.connectionId,
    );
    const metadata = connection && connectSafeMetadataV1(connection);
    if (
      !connection ||
      !metadata ||
      connection.state !== "ready" ||
      connection.generation !== input.generation
    ) {
      return {
        kind: "stale-contract",
        message: CONNECT_STALE_CONTRACT_MESSAGE_V1,
      };
    }
    const directory = await this.directoryOrUndefined(input.connectionId);
    return {
      kind: "directory",
      tools:
        directory &&
        directory.status !== "revoked" &&
        directory.generation === input.generation
          ? directory.tools.map((tool) => ({
              name: tool.name,
              description: tool.description,
            }))
          : [],
    };
  }

  private async discloseCatalog(input: {
    userId: string;
    connectionId: string;
    generation: string;
    firstUseMs?: number;
  }): Promise<ConnectAccountCatalogAnswerV1> {
    const connection = await this.host.settings.getConnection(
      input.userId,
      input.connectionId,
    );
    const metadata = connection && connectSafeMetadataV1(connection);
    if (
      !connection ||
      !metadata ||
      connection.state !== "ready" ||
      connection.generation !== input.generation
    ) {
      return {
        kind: "stale-contract",
        message: CONNECT_STALE_CONTRACT_MESSAGE_V1,
      };
    }
    const directory = await this.directoryOrUndefined(input.connectionId);
    if (
      directory &&
      connectCatalogDisclosableV1(directory, input.generation, this.now())
    ) {
      if (connectCatalogRefreshDueV1(directory, this.now())) {
        await this.scheduleCatalogRefresh(connection);
      }
      return this.catalogAnswer(input.connectionId, directory);
    }
    const firstUseMs = input.firstUseMs ?? CONNECT_CATALOG_FIRST_USE_MS_V1;
    return this.discoverCatalog(connection, metadata, firstUseMs);
  }

  /** Drains due catalog refreshes. One provider fetch per firing. */
  async alarm(): Promise<void> {
    const due = await dueConnectCatalogJobsV1(
      this.catalogStorage(),
      this.now(),
    );
    const next = due[0];
    if (next) await this.refreshJob(next);
    const remaining = await dueConnectCatalogJobsV1(
      this.catalogStorage(),
      this.now(),
    );
    const waiting = remaining[0];
    if (waiting) {
      await armConnectCatalogAlarmV1(this.catalogStorage(), waiting.dueAt);
      return;
    }
    const listed = await this.host.storage.list<unknown>({
      prefix: CONNECT_CATALOG_JOB_PREFIX_V1,
    });
    let earliest = Number.POSITIVE_INFINITY;
    for (const value of listed.values()) {
      if (
        value &&
        typeof value === "object" &&
        typeof (value as { dueAt?: unknown }).dueAt === "number"
      ) {
        earliest = Math.min(earliest, (value as { dueAt: number }).dueAt);
      }
    }
    if (Number.isFinite(earliest)) {
      await armConnectCatalogAlarmV1(this.catalogStorage(), earliest);
    }
  }

  private catalogStorage(): ConnectCatalogStorageV1 {
    const storage = this.host.storage;
    return {
      get: (key) => storage.get(key),
      put: (key, value) => storage.put(key, value),
      delete: (key) => storage.delete(key),
      list: (options) => storage.list(options),
      transaction: (callback) =>
        storage.transaction((tx) =>
          callback(tx as unknown as ConnectCatalogTransactionV1),
        ),
      ...(storage.getAlarm ? { getAlarm: () => storage.getAlarm!() } : {}),
      ...(storage.setAlarm
        ? { setAlarm: (time: number) => storage.setAlarm!(time) }
        : {}),
    };
  }

  private async directoryOrUndefined(
    connectionId: string,
  ): Promise<ConnectCatalogDirectoryV1 | undefined> {
    try {
      return await readConnectCatalogDirectoryV1(
        this.catalogStorage(),
        connectionId,
      );
    } catch {
      return undefined;
    }
  }

  private readConnection(userId: string, connectionId: string) {
    return (tx: ConnectCatalogTransactionV1) =>
      this.host.settings.getConnection(
        userId,
        connectionId,
        tx as unknown as UserSettingsTransaction,
      );
  }

  private async scheduleCatalogRefresh(
    connection: ConnectionView,
  ): Promise<void> {
    const metadata = connectSafeMetadataV1(connection);
    if (!metadata || !connection.generation || connection.state !== "ready") {
      return;
    }
    await commitConnectCatalogJobV1(this.catalogStorage(), {
      schemaVersion: 1,
      connectionId: connection.connectionId,
      generation: connection.generation,
      toolkitSlug: metadata.toolkitSlug,
      namespace: metadata.namespace,
      dueAt: this.now(),
      attempts: 0,
    });
  }

  private async discoverCatalog(
    connection: ConnectionView,
    metadata: ConnectSafeMetadataV1,
    firstUseMs: number,
  ): Promise<ConnectAccountCatalogAnswerV1> {
    await this.scheduleCatalogRefresh(connection);
    const finished = this.refreshConnection(connection, metadata).then(
      async () => {
        const directory = await this.directoryOrUndefined(
          connection.connectionId,
        );
        if (
          !directory ||
          !connectCatalogDisclosableV1(
            directory,
            connection.generation ?? "",
            this.now(),
          )
        ) {
          return {
            kind: "unavailable" as const,
            message: CONNECT_CATALOG_UNAVAILABLE_MESSAGE_V1,
          };
        }
        return this.catalogAnswer(connection.connectionId, directory);
      },
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<ConnectAccountCatalogAnswerV1>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          kind: "unavailable",
          message: CONNECT_CATALOG_UNAVAILABLE_MESSAGE_V1,
        });
      }, firstUseMs);
    });
    const answer = await Promise.race([finished, timeout]);
    if (timer) clearTimeout(timer);
    return answer;
  }

  private async refreshConnection(
    connection: ConnectionView,
    metadata: ConnectSafeMetadataV1,
  ): Promise<void> {
    if (!this.client || !connection.generation) return;
    const job: ConnectCatalogJobV1 = {
      schemaVersion: 1,
      connectionId: connection.connectionId,
      generation: connection.generation,
      toolkitSlug: metadata.toolkitSlug,
      namespace: metadata.namespace,
      dueAt: this.now(),
      attempts: 0,
    };
    await this.refreshJob(job);
  }

  private async refreshJob(job: ConnectCatalogJobV1): Promise<void> {
    if (!this.client) return;
    const userId = await this.catalogUserId();
    if (!userId) return;
    let tools: ConnectToolV1[];
    try {
      tools = await this.client.listImportantTools(job.toolkitSlug);
    } catch (error) {
      await recordConnectCatalogFailureV1(this.catalogStorage(), {
        job,
        message:
          error instanceof Error
            ? error.message.slice(0, 300)
            : "The tool catalog could not be loaded",
        now: this.now(),
        readConnection: this.readConnection(userId, job.connectionId),
      });
      return;
    }
    try {
      await publishConnectCatalogV1(this.catalogStorage(), {
        connectionId: job.connectionId,
        generation: job.generation,
        toolkitSlug: job.toolkitSlug,
        namespace: job.namespace,
        tools,
        now: this.now(),
        readConnection: this.readConnection(userId, job.connectionId),
      });
    } catch (error) {
      if (error instanceof ConnectCatalogInvalidError) {
        await recordConnectCatalogFailureV1(this.catalogStorage(), {
          job,
          message: error.message,
          now: this.now(),
          readConnection: this.readConnection(userId, job.connectionId),
        });
        return;
      }
      throw error;
    }
  }

  private async catalogUserId(): Promise<string | undefined> {
    // The alarm has no caller. Settings already pinned this object's User
    // when the account was provisioned.
    const stored = await this.host.storage.get<unknown>("user-id");
    return typeof stored === "string" ? stored : undefined;
  }

  private async catalogAnswer(
    connectionId: string,
    directory: ConnectCatalogDirectoryV1,
  ): Promise<ConnectAccountCatalogAnswerV1> {
    try {
      const body = await readConnectCatalogBodyV1(
        this.catalogStorage(),
        connectionId,
        directory.contentHash,
      );
      return {
        kind: "catalog",
        catalog: {
          schemaVersion: 1,
          toolkitSlug: directory.toolkitSlug,
          tools: body.tools,
        },
      };
    } catch {
      return {
        kind: "unavailable",
        message: CONNECT_CATALOG_UNAVAILABLE_MESSAGE_V1,
      };
    }
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
