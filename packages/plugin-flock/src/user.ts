import type {
  CapabilityAssignmentView,
  ModelAssignment,
  UserSettingsViewV1,
} from "@frockbot/configuration-core";
import type { Plugin } from "cordis";
import {
  BotNotFoundError,
  FLOCK_DIRECTORY_LIMIT,
  FlockConflictError,
  FlockDecodeError,
  decodeDirectoryViewV1,
  decodeStoredFlockReceiptV1,
  flockCommandFingerprint,
  randomSheepRecipeV1,
  type BotDirectoryViewV1,
  type BotRegistrationV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
} from "./shared.js";

const DIRECTORY_KEY = "flock:directory:v1";
const RECEIPT_PREFIX = "flock:create-receipt:";
export interface FlockUserTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}
interface Storage extends FlockUserTransaction {
  transaction<T>(
    callback: (storage: FlockUserTransaction) => Promise<T>,
  ): Promise<T>;
}
export interface FlockUserBackendHost {
  storage: Storage;
  /**
   * Retained for hosts that materialize a Bot from User state. A new Bot no
   * longer copies the User default model, so neither seam is called here.
   */
  readUserSettings?(
    storage: FlockUserTransaction,
    userId: string,
  ): Promise<UserSettingsViewV1>;
  claimInitialModelBinding?(
    storage: FlockUserTransaction,
    input: {
      userId: string;
      botId: string;
      generation: string;
      model: ModelAssignment;
    },
  ): Promise<CapabilityAssignmentView | undefined>;
  now?: () => Date;
  random?: () => number;
}

function initialDirectory(): BotDirectoryViewV1 {
  return { schemaVersion: 1, revision: 0, bots: [] };
}

export class FlockUserBackendContribution {
  constructor(private readonly host: FlockUserBackendHost) {}

  async listBots(): Promise<BotDirectoryViewV1> {
    const stored = await this.host.storage.get<unknown>(DIRECTORY_KEY);
    return structuredClone(
      stored === undefined ? initialDirectory() : decodeDirectoryViewV1(stored),
    );
  }

  async registration(botId: string): Promise<BotRegistrationV1> {
    const found = (await this.listBots()).bots.find(
      (bot) => bot.botId === botId,
    );
    if (!found) throw new BotNotFoundError(botId);
    return found;
  }

  async hasBot(botId: string): Promise<boolean> {
    return (await this.listBots()).bots.some((bot) => bot.botId === botId);
  }

  async createBot(
    userId: string,
    command: CreateBotCommandV1,
  ): Promise<FlockReceiptV1> {
    const fingerprint = flockCommandFingerprint(command);
    return this.host.storage.transaction(async (storage) => {
      const receiptKey = `${RECEIPT_PREFIX}${command.commandId}`;
      const storedValue = await storage.get<unknown>(receiptKey);
      const stored =
        storedValue === undefined
          ? undefined
          : decodeStoredFlockReceiptV1(storedValue);
      if (stored) {
        if (stored.fingerprint !== fingerprint)
          throw new FlockDecodeError(
            `command ID collision: ${command.commandId}`,
          );
        return structuredClone(stored.receipt);
      }
      const currentValue = await storage.get<unknown>(DIRECTORY_KEY);
      const current =
        currentValue === undefined
          ? initialDirectory()
          : decodeDirectoryViewV1(currentValue);
      if (current.revision !== command.expectedRevision)
        throw new FlockConflictError(current.revision);
      let receipt: FlockReceiptV1;
      if (current.bots.some((bot) => bot.botId === command.botId)) {
        receipt = {
          schemaVersion: 1,
          commandId: command.commandId,
          status: "rejected",
          revision: current.revision,
          failure: `Bot "${command.botId}" already exists`,
        };
      } else if (current.bots.length >= FLOCK_DIRECTORY_LIMIT) {
        receipt = {
          schemaVersion: 1,
          commandId: command.commandId,
          status: "rejected",
          revision: current.revision,
          failure: "Bot directory limit reached",
        };
      } else {
        // A new Bot carries no model of its own: it follows the User's
        // default model dynamically, and claims the Connection's model
        // Capability the first time it resolves its execution context. Only a
        // Bot that overrides the default owns a durable `model`.
        const registration: BotRegistrationV1 = {
          schemaVersion: 1,
          botId: command.botId,
          registeredAt: (this.host.now?.() ?? new Date()).toISOString(),
          initialName: command.name,
          initialModel: undefined,
          initialModelBinding: undefined,
          sheep: structuredClone(
            command.sheep ?? randomSheepRecipeV1(this.host.random),
          ),
        };
        const next = {
          ...current,
          revision: current.revision + 1,
          bots: [...current.bots, registration],
        } satisfies BotDirectoryViewV1;
        await storage.put(DIRECTORY_KEY, next);
        receipt = {
          schemaVersion: 1,
          commandId: command.commandId,
          status: "applied",
          revision: next.revision,
        };
      }
      await storage.put(receiptKey, { fingerprint, receipt });
      return structuredClone(receipt);
    });
  }
}

export function createFlockUserBackendContribution(
  host: FlockUserBackendHost,
): FlockUserBackendContribution {
  return new FlockUserBackendContribution(host);
}

export function createFlockUserBackendPlugin(
  host: FlockUserBackendHost,
  lifecycle: { mount(value: FlockUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createFlockUserBackendContribution(host));
}
