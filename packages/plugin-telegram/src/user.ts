// The Telegram Connection, in the User Durable Object.
//
// One Connection Type — `telegram-bot`, `authorization: {kind: "api-key"}` —
// and the ordinary Connection command protocol every provider answers. The bot
// token is sealed by the Credential Store the moment it arrives, validated
// against Telegram's own `getMe` before the Connection is allowed to reach
// `ready`, and thereafter only ever leaves storage as a `CredentialLeaseV1`
// opened inside this object for one bounded effect.
//
// This Contribution deliberately holds *no* Channel state. The Channel record,
// its message log, its webhook key and its fan-out are `plugin-channels`, in
// the same Durable Object; what is here is the credential and the Connection
// projection, which is all a Connection Type is.
import {
  decodeConnectionCommandV1,
  type ConnectionCommandReceiptV1,
  type ConnectionCommandV1,
  type ConnectionSettingsV1,
  type CredentialLeaseV1,
} from "@frockbot/connection-core";
import type { ConnectionView } from "@frockbot/configuration-core";
import type {
  CredentialStorage,
  CredentialUserBackendContribution,
} from "@frockbot/plugin-credentials/user";
import type {
  UserSettingsBackendContribution,
  UserSettingsStorage,
} from "@frockbot/plugin-settings/user";
import type { Plugin } from "cordis";
import {
  createTelegramConnectorV1,
  TELEGRAM_CONNECTION_TYPE_V1,
  TELEGRAM_PACKAGE_ID_V1,
} from "./connector.js";

const COMMAND_PREFIX = "telegram-connection-command:";
const COMMAND_INDEX_KEY = "telegram-connection-command-index";
/** Most command receipts retained. A retry beyond this is a fresh command. */
const MAX_RECEIPTS = 128;
/** How long a lease this object opens for its own call is good for. */
const OWN_LEASE_MS = 5 * 60 * 1_000;
/** How long a lease handed across a seam is good for. */
const TOOL_LEASE_MS = 5 * 60 * 1_000;

interface StoredTelegramCommand {
  schemaVersion: 1;
  commandId: string;
  fingerprint: string;
  connectionId: string;
  receipt: ConnectionCommandReceiptV1;
}

export interface TelegramUserBackendHost {
  storage: UserSettingsStorage & CredentialStorage;
  settings: UserSettingsBackendContribution;
  credentials: CredentialUserBackendContribution;
  /** The Package's own outbound seam. Absent uses the ambient `fetch`. */
  fetch?: typeof fetch;
  now?(): number;
  randomId?(): string;
}

async function fingerprint(command: ConnectionCommandV1): Promise<string> {
  const bytes = new TextEncoder().encode(JSON.stringify(command));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export class TelegramUserBackendContribution {
  readonly packageId = TELEGRAM_PACKAGE_ID_V1;
  readonly #host: TelegramUserBackendHost;
  readonly #now: () => number;
  readonly #randomId: () => string;
  readonly #fetch: typeof fetch;

  constructor(host: TelegramUserBackendHost) {
    this.#host = host;
    this.#now = host.now ?? (() => Date.now());
    this.#randomId = host.randomId ?? (() => crypto.randomUUID());
    // Bound: calling an unbound global `fetch` through a class field would
    // hand workerd the wrong `this` and fail as an illegal invocation.
    this.#fetch = host.fetch ?? fetch.bind(globalThis);
  }

  /**
   * One Connection command, applied once.
   *
   * The receipt is durable and fingerprinted, exactly as every other
   * Connection owner does it: a retried command replays its recorded outcome,
   * and a reused command id carrying different bytes is an error rather than a
   * second Connection.
   */
  async executeConnection(
    accountId: string,
    input: unknown,
  ): Promise<ConnectionCommandReceiptV1> {
    const command = decodeConnectionCommandV1(input);
    const commandFingerprint = await fingerprint(command);
    const stored = await this.#readCommand(command.commandId);
    if (stored) {
      if (stored.fingerprint !== commandFingerprint) {
        throw new Error(
          `Telegram Connection command "${command.commandId}" was reused for a different command`,
        );
      }
      return stored.receipt;
    }
    const receipt = await this.#apply(accountId, command);
    await this.#recordCommand({
      schemaVersion: 1,
      commandId: command.commandId,
      fingerprint: commandFingerprint,
      connectionId: receipt.connectionId,
      receipt,
    });
    return receipt;
  }

  async lookupConnectionCommand(
    _accountId: string,
    commandId: string,
  ): Promise<ConnectionCommandReceiptV1 | undefined> {
    return (await this.#readCommand(commandId))?.receipt;
  }

  /** A Telegram Connection carries no model, and says so rather than pretending. */
  leaseModelCredential(): Promise<never> {
    return Promise.reject(
      new Error("Telegram Connections offer no model to lease"),
    );
  }

  settleModelCredential(): Promise<void> {
    return Promise.resolve();
  }

  /**
   * An expiring lease over this Connection's bot token.
   *
   * The lease crosses a seam; the *key* does not. What comes back is a sealed
   * envelope that only a holder of the deployment keyring can open, and the
   * only holder that ever opens one is the backend.
   */
  async leaseToolCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
    connectionGeneration: string;
  }): Promise<CredentialLeaseV1> {
    const connection = await this.#requireConnection(
      input.accountId,
      input.connectionId,
    );
    if (connection.state !== "ready") {
      throw new Error("Telegram Connection carries no usable credential");
    }
    if (connection.generation !== input.connectionGeneration) {
      throw new Error("Telegram Connection generation changed");
    }
    return this.#host.credentials.lease({
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: TELEGRAM_PACKAGE_ID_V1,
      effectId: input.effectId,
      expiresAt: new Date(this.#now() + TOOL_LEASE_MS).toISOString(),
      expectedGeneration: connection.generation,
    });
  }

  async settleToolCredential(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
  }): Promise<void> {
    await this.#host.credentials.settle({
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: TELEGRAM_PACKAGE_ID_V1,
      effectId: input.effectId,
    });
  }

  /**
   * The plaintext bot token, opened inside this Durable Object for one call.
   *
   * The whole of "no secret leaves the backend" is this method's contract: it
   * is called by the Channels connector seam, the string it returns is handed
   * to one `fetch`, and the lease it minted is settled immediately whatever
   * happened. No caller outside this object may reach it.
   */
  async openConnectionKey(input: {
    accountId: string;
    connectionId: string;
    effectId: string;
  }): Promise<string> {
    const connection = await this.#requireConnection(
      input.accountId,
      input.connectionId,
    );
    const generation = connection.generation;
    if (!generation) {
      throw new Error("Telegram Connection carries no credential generation");
    }
    if (connection.state === "authorizing") {
      return this.#host.credentials.readStagedApiKey({
        accountId: input.accountId,
        connectionId: input.connectionId,
        packageId: TELEGRAM_PACKAGE_ID_V1,
        generation,
      });
    }
    const lease = await this.#host.credentials.lease({
      accountId: input.accountId,
      connectionId: input.connectionId,
      packageId: TELEGRAM_PACKAGE_ID_V1,
      effectId: input.effectId,
      expiresAt: new Date(this.#now() + OWN_LEASE_MS).toISOString(),
      expectedGeneration: generation,
    });
    try {
      return await this.#host.credentials.openLease({
        accountId: input.accountId,
        packageId: TELEGRAM_PACKAGE_ID_V1,
        lease,
      });
    } finally {
      await this.#host.credentials
        .settle({
          accountId: input.accountId,
          connectionId: input.connectionId,
          packageId: TELEGRAM_PACKAGE_ID_V1,
          effectId: input.effectId,
        })
        .catch(() => undefined);
    }
  }

  /** Whether one Connection is this Package's, and therefore speaks Telegram. */
  async ownsConnection(
    accountId: string,
    connectionId: string,
  ): Promise<boolean> {
    const connection = await this.#host.settings.getConnection(
      accountId,
      connectionId,
    );
    return connection?.packageId === TELEGRAM_PACKAGE_ID_V1;
  }

  async #apply(
    accountId: string,
    command: ConnectionCommandV1,
  ): Promise<ConnectionCommandReceiptV1> {
    switch (command.type) {
      case "connection/create-api-key":
        return this.#create(accountId, command);
      case "connection/rotate-api-key":
        return this.#rotate(accountId, command);
      case "connection/update-label": {
        const connection = await this.#requireConnection(
          accountId,
          command.connectionId,
        );
        await this.#host.settings.replaceConnection(
          accountId,
          connection.connectionId,
          connection.generation,
          { ...connection, displayName: command.label },
        );
        return this.#receipt(command.commandId, connection.connectionId);
      }
      case "connection/set-enabled": {
        const connection = await this.#requireConnection(
          accountId,
          command.connectionId,
        );
        if (connection.state === "revoked" || connection.state === "revoking") {
          throw new Error("Telegram Connection is revoked");
        }
        await this.#host.settings.replaceConnection(
          accountId,
          connection.connectionId,
          connection.generation,
          { ...connection, state: command.enabled ? "ready" : "disabled" },
        );
        return this.#receipt(command.commandId, connection.connectionId);
      }
      case "connection/disconnect": {
        const connection = await this.#requireConnection(
          accountId,
          command.connectionId,
        );
        await this.#host.credentials.disconnect(connection.connectionId);
        await this.#host.settings.replaceConnection(
          accountId,
          connection.connectionId,
          connection.generation,
          { ...connection, state: "revoked", failure: undefined },
        );
        return this.#receipt(command.commandId, connection.connectionId);
      }
      case "connection/refresh-models":
        throw new Error("Telegram Connections offer no model catalog");
      default:
        throw new Error(
          "Telegram Connection Type does not accept this command",
        );
    }
  }

  async #create(
    accountId: string,
    command: Extract<
      ConnectionCommandV1,
      { type: "connection/create-api-key" }
    >,
  ): Promise<ConnectionCommandReceiptV1> {
    if (command.connectionTypeId !== TELEGRAM_CONNECTION_TYPE_V1) {
      throw new Error(
        `Telegram Connection Type "${command.connectionTypeId}" does not accept this command`,
      );
    }
    const connectionId = `telegram-${this.#randomId()}`;
    const generation = this.#randomId();
    await this.#host.credentials.stageApiKey({
      accountId,
      connectionId,
      packageId: TELEGRAM_PACKAGE_ID_V1,
      generation,
      apiKey: command.apiKey,
    });
    const connection: ConnectionView = {
      connectionId,
      packageId: TELEGRAM_PACKAGE_ID_V1,
      connectionTypeId: command.connectionTypeId,
      displayName: command.label,
      state: "authorizing",
      generation,
      providerType: "telegram",
      ...(command.settings === undefined
        ? {}
        : { settings: command.settings as ConnectionSettingsV1 }),
      safeMetadata: {},
    };
    await this.#host.settings.createConnection(accountId, connection);
    return this.#validateAndActivate(
      accountId,
      command.commandId,
      connection,
      generation,
    );
  }

  async #rotate(
    accountId: string,
    command: Extract<
      ConnectionCommandV1,
      { type: "connection/rotate-api-key" }
    >,
  ): Promise<ConnectionCommandReceiptV1> {
    const connection = await this.#requireConnection(
      accountId,
      command.connectionId,
    );
    const generation = this.#randomId();
    await this.#host.credentials.stageApiKey({
      accountId,
      connectionId: connection.connectionId,
      packageId: TELEGRAM_PACKAGE_ID_V1,
      generation,
      apiKey: command.apiKey,
    });
    const staged = await this.#host.settings.replaceConnection(
      accountId,
      connection.connectionId,
      connection.generation,
      { ...connection, state: "authorizing", generation, failure: undefined },
    );
    return this.#validateAndActivate(
      accountId,
      command.commandId,
      staged,
      generation,
    );
  }

  /**
   * Prove the token before the Connection is allowed to say it works.
   *
   * `getMe` is the cheapest call that distinguishes a real bot token from a
   * plausible-looking string, and it is the only one whose failure is
   * unambiguous. A Connection that reached `ready` on an unvalidated key would
   * be a Channel that silently never delivers.
   */
  async #validateAndActivate(
    accountId: string,
    commandId: string,
    connection: ConnectionView,
    generation: string,
  ): Promise<ConnectionCommandReceiptV1> {
    try {
      const apiKey = await this.#host.credentials.readStagedApiKey({
        accountId,
        connectionId: connection.connectionId,
        packageId: TELEGRAM_PACKAGE_ID_V1,
        generation,
      });
      const identity = await this.#getMe(apiKey);
      await this.#host.credentials.activate({
        accountId,
        connectionId: connection.connectionId,
        packageId: TELEGRAM_PACKAGE_ID_V1,
        generation,
      });
      await this.#host.settings.replaceConnection(
        accountId,
        connection.connectionId,
        generation,
        {
          ...connection,
          state: "ready",
          failure: undefined,
          // A label, never a credential: this is what the WebUI is allowed to
          // see about a Connection, and it is a bot's public username.
          safeMetadata: {
            ...(identity.username === undefined
              ? {}
              : { username: identity.username }),
            ...(identity.name === undefined ? {} : { name: identity.name }),
          },
        },
      );
      return this.#receipt(commandId, connection.connectionId);
    } catch (error) {
      const failure =
        error instanceof Error
          ? error.message
          : "the Telegram bot token could not be validated";
      await this.#host.settings.replaceConnection(
        accountId,
        connection.connectionId,
        generation,
        { ...connection, state: "failed", failure: failure.slice(0, 2_000) },
      );
      return {
        schemaVersion: 1,
        commandId,
        connectionId: connection.connectionId,
        status: "failed",
      };
    }
  }

  async #getMe(apiKey: string): Promise<{ username?: string; name?: string }> {
    const { TELEGRAM_API_ORIGIN_V1 } = await import("./connector.js");
    const response = await this.#fetch(
      `${TELEGRAM_API_ORIGIN_V1}/bot${apiKey}/getMe`,
      { method: "POST", headers: { "content-type": "application/json" } },
    );
    let payload:
      { ok?: unknown; description?: unknown; result?: unknown } | undefined;
    try {
      payload = (await response.json()) as typeof payload;
    } catch {
      payload = undefined;
    }
    if (!response.ok || payload?.ok !== true) {
      throw new Error(
        typeof payload?.description === "string"
          ? `Telegram rejected the bot token: ${payload.description}`
          : `Telegram rejected the bot token with HTTP ${response.status}`,
      );
    }
    const result =
      payload.result && typeof payload.result === "object"
        ? (payload.result as Record<string, unknown>)
        : {};
    return {
      ...(typeof result.username === "string"
        ? { username: result.username }
        : {}),
      ...(typeof result.first_name === "string"
        ? { name: result.first_name }
        : {}),
    };
  }

  async #requireConnection(
    accountId: string,
    connectionId: string,
  ): Promise<ConnectionView> {
    const connection = await this.#host.settings.getConnection(
      accountId,
      connectionId,
    );
    if (!connection || connection.packageId !== TELEGRAM_PACKAGE_ID_V1) {
      throw new Error("Telegram Connection is unavailable");
    }
    return connection;
  }

  #receipt(
    commandId: string,
    connectionId: string,
  ): ConnectionCommandReceiptV1 {
    return { schemaVersion: 1, commandId, connectionId, status: "applied" };
  }

  async #readCommand(
    commandId: string,
  ): Promise<StoredTelegramCommand | undefined> {
    const stored = await this.#host.storage.get<StoredTelegramCommand>(
      `${COMMAND_PREFIX}${commandId}`,
    );
    return stored ?? undefined;
  }

  async #recordCommand(entry: StoredTelegramCommand): Promise<void> {
    // Typed as the Credential seam, which is the one of the two intersected
    // storage interfaces that offers `delete`.
    const storage: CredentialStorage = this.#host.storage;
    await storage.transaction(async (transaction) => {
      const index = (await transaction.get<string[]>(COMMAND_INDEX_KEY)) ?? [];
      const next = [
        ...index.filter((id) => id !== entry.commandId),
        entry.commandId,
      ];
      for (const expired of next.slice(
        0,
        Math.max(0, next.length - MAX_RECEIPTS),
      )) {
        await transaction.delete(`${COMMAND_PREFIX}${expired}`);
      }
      await transaction.put(`${COMMAND_PREFIX}${entry.commandId}`, entry);
      await transaction.put(COMMAND_INDEX_KEY, next.slice(-MAX_RECEIPTS));
    });
  }
}

export function createTelegramUserBackendPlugin(
  host: TelegramUserBackendHost,
  lifecycle: { mount(value: TelegramUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(new TelegramUserBackendContribution(host));
}

export { createTelegramConnectorV1 };
export default createTelegramUserBackendPlugin;
