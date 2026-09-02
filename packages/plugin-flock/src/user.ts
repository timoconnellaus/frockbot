import type { Plugin } from "cordis";
import {
  BotNotFoundError,
  FLOCK_DIRECTORY_LIMIT,
  FlockConflictError,
  FlockDecodeError,
  decodeBotLifecycleCommandV1,
  decodeBotLifecycleReceiptV1,
  decodeBotLifecycleViewV1,
  decodeDirectoryViewV1,
  decodeStoredBotLifecycleReceiptV1,
  decodeStoredFlockReceiptV1,
  flockCommandFingerprint,
  migrateStoredBotDirectoryV1,
  randomSheepRecipeV1,
  type BotDirectoryViewV1,
  type BotLifecycleCommandV1,
  type BotLifecycleDirectoryViewV1,
  type BotLifecycleReceiptV1,
  type BotLifecycleViewV1,
  type BotRegistrationV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
} from "./shared.js";

const DIRECTORY_KEY = "flock:directory:v1";
const RECEIPT_PREFIX = "flock:create-receipt:";
const LIFECYCLE_PREFIX = "flock:lifecycle:";
const LIFECYCLE_RECEIPT_PREFIX = "flock:lifecycle-receipt:";
const LIFECYCLE_SAGA_PREFIX = "flock:lifecycle-saga:";
const LIFECYCLE_OPERATION_PREFIX = "flock:lifecycle-operation:";
export interface FlockUserTransaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  delete(key: string): Promise<boolean>;
  setAlarm(timestamp: number | Date): Promise<void>;
}
interface Storage extends FlockUserTransaction {
  transaction<T>(
    callback: (storage: FlockUserTransaction) => Promise<T>,
  ): Promise<T>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  delete(key: string): Promise<boolean>;
  setAlarm(timestamp: number | Date): Promise<void>;
}
export interface FlockUserBackendHost {
  storage: Storage;
  now?: () => Date;
  random?: () => number;
  commandBotLifecycle(
    userId: string,
    command: BotLifecycleCommandV1,
  ): Promise<BotLifecycleReceiptV1>;
  readBotLifecycle(userId: string, botId: string): Promise<BotLifecycleViewV1>;
}

interface StoredLifecycleSagaV1 {
  schemaVersion: 1;
  userId: string;
  fingerprint: string;
  command: BotLifecycleCommandV1;
}

function decodeStoredLifecycleSagaV1(input: unknown): StoredLifecycleSagaV1 {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new FlockDecodeError("stored lifecycle saga must be an object");
  const value = input as Record<string, unknown>;
  const keys = Reflect.ownKeys(value);
  if (
    keys.length !== 4 ||
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !["schemaVersion", "userId", "fingerprint", "command"].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    typeof value.userId !== "string" ||
    !isFinite(value.userId.length) ||
    value.userId.length < 1 ||
    value.userId.length > 200 ||
    typeof value.fingerprint !== "string"
  )
    throw new FlockDecodeError("stored lifecycle saga is invalid");
  return {
    schemaVersion: 1,
    userId: value.userId,
    fingerprint: value.fingerprint,
    command: decodeBotLifecycleCommandV1(value.command),
  };
}

function initialDirectory(): BotDirectoryViewV1 {
  return { schemaVersion: 1, revision: 0, bots: [] };
}

export class FlockUserBackendContribution {
  constructor(private readonly host: FlockUserBackendHost) {}

  async listBots(): Promise<BotDirectoryViewV1> {
    const stored = await this.host.storage.get<unknown>(DIRECTORY_KEY);
    return structuredClone(
      stored === undefined
        ? initialDirectory()
        : decodeDirectoryViewV1(migrateStoredBotDirectoryV1(stored)),
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
          : decodeDirectoryViewV1(migrateStoredBotDirectoryV1(currentValue));
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
        // A new Bot carries neither a model nor a grant. Both resolve from the
        // User's enabled Packages and Connections at its next admitted Turn
        // (AGENTS.md Configuration shape; ADR 0019).
        const registration: BotRegistrationV1 = {
          schemaVersion: 1,
          botId: command.botId,
          registeredAt: (this.host.now?.() ?? new Date()).toISOString(),
          initialName: command.name,
          ...(command.description === undefined
            ? {}
            : { initialDescription: command.description }),
          // The creator is durable history: a Bot the Flock made on another
          // Bot's behalf says so in the registration seed itself.
          ...(command.createdBy
            ? { createdBy: structuredClone(command.createdBy) }
            : {}),
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
        await storage.put(`${LIFECYCLE_PREFIX}${command.botId}`, {
          schemaVersion: 1,
          botId: command.botId,
          status: "active",
          revision: 0,
        } satisfies BotLifecycleViewV1);
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

  async listBotLifecycles(): Promise<BotLifecycleDirectoryViewV1> {
    const directory = await this.listBots();
    const lifecycles = await Promise.all(
      directory.bots.map(async (bot) => {
        const value = await this.host.storage.get<unknown>(
          `${LIFECYCLE_PREFIX}${bot.botId}`,
        );
        if (value === undefined)
          throw new FlockDecodeError(
            `Bot lifecycle projection is missing for "${bot.botId}"`,
          );
        return decodeBotLifecycleViewV1(value);
      }),
    );
    return { schemaVersion: 1, lifecycles };
  }

  async executeLifecycle(
    userId: string,
    input: unknown,
  ): Promise<BotLifecycleReceiptV1> {
    const command = decodeBotLifecycleCommandV1(input);
    const fingerprint = flockCommandFingerprint(command);
    const receiptKey = `${LIFECYCLE_RECEIPT_PREFIX}${command.commandId}`;
    const admitted = await this.host.storage.transaction(async (storage) => {
      const existingValue = await storage.get<unknown>(receiptKey);
      if (existingValue !== undefined) {
        const existing = decodeStoredBotLifecycleReceiptV1(existingValue);
        if (existing.fingerprint !== fingerprint)
          throw new FlockDecodeError(
            `command ID collision: ${command.commandId}`,
          );
        return existing.receipt;
      }
      const activeOperation = await storage.get<unknown>(
        `${LIFECYCLE_OPERATION_PREFIX}${command.botId}`,
      );
      if (activeOperation !== undefined)
        throw new FlockDecodeError(
          `Bot "${command.botId}" already has a lifecycle operation retrying`,
        );
      const directoryValue = await storage.get<unknown>(DIRECTORY_KEY);
      const directory =
        directoryValue === undefined
          ? initialDirectory()
          : decodeDirectoryViewV1(migrateStoredBotDirectoryV1(directoryValue));
      if (!directory.bots.some((bot) => bot.botId === command.botId))
        throw new BotNotFoundError(command.botId);
      const lifecycleValue = await storage.get<unknown>(
        `${LIFECYCLE_PREFIX}${command.botId}`,
      );
      if (lifecycleValue === undefined)
        throw new FlockDecodeError(
          `Bot lifecycle projection is missing for "${command.botId}"`,
        );
      const lifecycle = decodeBotLifecycleViewV1(lifecycleValue);
      const receipt = {
        schemaVersion: 1,
        commandId: command.commandId,
        botId: command.botId,
        status: "pending",
        lifecycle,
      } satisfies BotLifecycleReceiptV1;
      const saga = {
        schemaVersion: 1,
        userId,
        fingerprint,
        command,
      } satisfies StoredLifecycleSagaV1;
      await storage.put({
        [receiptKey]: { fingerprint, receipt },
        [`${LIFECYCLE_SAGA_PREFIX}${command.commandId}`]: saga,
        [`${LIFECYCLE_OPERATION_PREFIX}${command.botId}`]: command.commandId,
      });
      await storage.setAlarm(Date.now());
      return receipt;
    });
    if (admitted.status !== "pending") return admitted;
    return this.settleLifecycle(command.commandId);
  }

  async alarm(): Promise<void> {
    const sagas = await this.host.storage.list<unknown>({
      prefix: LIFECYCLE_SAGA_PREFIX,
    });
    let pending = false;
    for (const key of sagas.keys()) {
      const receipt = await this.settleLifecycle(
        key.slice(LIFECYCLE_SAGA_PREFIX.length),
      );
      if (receipt.status === "pending") pending = true;
    }
    if (pending) await this.host.storage.setAlarm(Date.now() + 1_000);
  }

  private async settleLifecycle(
    commandId: string,
  ): Promise<BotLifecycleReceiptV1> {
    const sagaValue = await this.host.storage.get<unknown>(
      `${LIFECYCLE_SAGA_PREFIX}${commandId}`,
    );
    if (sagaValue === undefined) {
      const receipt = await this.host.storage.get<unknown>(
        `${LIFECYCLE_RECEIPT_PREFIX}${commandId}`,
      );
      if (receipt === undefined)
        throw new Error("lifecycle saga is unavailable");
      return decodeStoredBotLifecycleReceiptV1(receipt).receipt;
    }
    const saga = decodeStoredLifecycleSagaV1(sagaValue);
    const target = saga.command.type === "bot/archive" ? "archived" : "active";
    let outcome: BotLifecycleReceiptV1 | undefined;
    let reconcileMarker = false;
    try {
      const candidate = decodeBotLifecycleReceiptV1(
        await this.host.commandBotLifecycle(saga.userId, saga.command),
      );
      const correlated =
        candidate.commandId === saga.command.commandId &&
        candidate.botId === saga.command.botId &&
        candidate.lifecycle.botId === saga.command.botId;
      if (!correlated || candidate.status === "pending") {
        reconcileMarker = true;
      } else if (candidate.status === "applied") {
        if (candidate.lifecycle.status === target) outcome = candidate;
        else reconcileMarker = true;
      } else {
        outcome = candidate;
      }
    } catch {
      reconcileMarker = true;
    }
    if (reconcileMarker) {
      try {
        const lifecycle = decodeBotLifecycleViewV1(
          await this.host.readBotLifecycle(saga.userId, saga.command.botId),
        );
        if (
          lifecycle.botId === saga.command.botId &&
          lifecycle.status === target
        ) {
          outcome = {
            schemaVersion: 1,
            commandId: saga.command.commandId,
            botId: saga.command.botId,
            status: "applied",
            lifecycle,
          };
        }
      } catch {
        // The durable pending receipt and alarm own retry after an uncertain call.
      }
    }
    if (!outcome) {
      const stored = await this.host.storage.get<unknown>(
        `${LIFECYCLE_RECEIPT_PREFIX}${commandId}`,
      );
      if (stored === undefined)
        throw new Error("lifecycle receipt is unavailable");
      return decodeStoredBotLifecycleReceiptV1(stored).receipt;
    }
    return this.host.storage.transaction(async (storage) => {
      const currentSagaValue = await storage.get<unknown>(
        `${LIFECYCLE_SAGA_PREFIX}${commandId}`,
      );
      if (currentSagaValue === undefined) {
        const settled = await storage.get<unknown>(
          `${LIFECYCLE_RECEIPT_PREFIX}${commandId}`,
        );
        if (settled === undefined)
          throw new Error("lifecycle receipt is unavailable");
        return decodeStoredBotLifecycleReceiptV1(settled).receipt;
      }
      const currentSaga = decodeStoredLifecycleSagaV1(currentSagaValue);
      if (currentSaga.fingerprint !== saga.fingerprint)
        throw new FlockDecodeError(`command ID collision: ${commandId}`);
      await storage.put({
        [`${LIFECYCLE_PREFIX}${saga.command.botId}`]: outcome!.lifecycle,
        [`${LIFECYCLE_RECEIPT_PREFIX}${commandId}`]: {
          fingerprint: saga.fingerprint,
          receipt: outcome,
        },
      });
      await storage.delete(`${LIFECYCLE_SAGA_PREFIX}${commandId}`);
      await storage.delete(
        `${LIFECYCLE_OPERATION_PREFIX}${saga.command.botId}`,
      );
      return outcome!;
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
