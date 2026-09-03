import type { Plugin } from "cordis";
import {
  FlockConflictError,
  FlockDecodeError,
  decodeBotLifecycleCommandV1,
  decodeBotLifecycleReceiptV1,
  decodeBotLifecycleViewV1,
  decodeBotRegistrationV1,
  decodeSheepIdentityViewV1,
  decodeStoredBotLifecycleReceiptV1,
  decodeStoredFlockReceiptV1,
  flockCommandFingerprint,
  type BotLifecycleCommandV1,
  type BotLifecycleReceiptV1,
  type BotLifecycleViewV1,
  type BotRegistrationV1,
  type FlockReceiptV1,
  type SheepIdentityViewV1,
  type UpdateSheepCommandV1,
} from "./shared.js";
import { defineBotBackendContribution } from "@frockbot/kernel-contracts/contributions";

const IDENTITY_KEY = "flock:sheep:v1";
const RECEIPT_PREFIX = "flock:sheep-receipt:";
const LIFECYCLE_KEY = "flock:lifecycle:v1";
const LIFECYCLE_RECEIPT_PREFIX = "flock:lifecycle-receipt:";
export interface FlockBotTransaction {
  get<T>(key: string): Promise<T | undefined>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}
interface Storage extends FlockBotTransaction {
  transaction<T>(
    callback: (storage: FlockBotTransaction) => Promise<T>,
  ): Promise<T>;
}
export interface FlockBotBackendHost {
  storage: Storage;
  materializeSettings(
    registration: BotRegistrationV1,
    userId: string,
  ): Promise<void>;
  archiveEligible(storage: FlockBotTransaction): Promise<boolean>;
}

export class BotArchivedError extends Error {
  constructor(readonly botId: string) {
    super(`Bot "${botId}" is archived`);
    this.name = "BotArchivedError";
  }
}

export class FlockBotBackendContribution {
  constructor(private readonly host: FlockBotBackendHost) {}

  async materialize(
    registrationInput: BotRegistrationV1,
    userId: string,
  ): Promise<SheepIdentityViewV1> {
    const registration = decodeBotRegistrationV1(registrationInput);
    await this.host.materializeSettings(registration, userId);
    return this.host.storage.transaction(async (storage) => {
      const existingValue = await storage.get<unknown>(IDENTITY_KEY);
      const lifecycleValue = await storage.get<unknown>(LIFECYCLE_KEY);
      const lifecycle =
        lifecycleValue === undefined
          ? {
              schemaVersion: 1 as const,
              botId: registration.botId,
              status: "active" as const,
              revision: 0,
            }
          : decodeBotLifecycleViewV1(lifecycleValue);
      if (lifecycle.botId !== registration.botId)
        throw new Error("Bot lifecycle does not match Bot registration");
      const existing =
        existingValue === undefined
          ? undefined
          : decodeSheepIdentityViewV1(existingValue);
      if (existing) {
        if (existing.botId !== registration.botId)
          throw new Error("sheep identity does not match Bot registration");
        if (lifecycleValue === undefined)
          await storage.put(LIFECYCLE_KEY, lifecycle);
        return existing;
      }
      const initial = {
        schemaVersion: 1,
        botId: registration.botId,
        revision: 0,
        sheep: structuredClone(registration.sheep),
      } satisfies SheepIdentityViewV1;
      await storage.put({
        [IDENTITY_KEY]: initial,
        [LIFECYCLE_KEY]: lifecycle,
      });
      return initial;
    });
  }

  async read(
    registration: BotRegistrationV1,
    userId: string,
  ): Promise<SheepIdentityViewV1> {
    return structuredClone(await this.materialize(registration, userId));
  }

  async update(
    registration: BotRegistrationV1,
    userId: string,
    command: UpdateSheepCommandV1,
  ): Promise<FlockReceiptV1> {
    if (registration.botId !== command.botId)
      throw new Error("sheep command does not match Bot registration");
    await this.materialize(registration, userId);
    const fingerprint = flockCommandFingerprint(command);
    return this.host.storage.transaction(async (storage) => {
      await this.assertActive(storage, registration.botId);
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
      const currentValue = await storage.get<unknown>(IDENTITY_KEY);
      if (currentValue === undefined)
        throw new Error("sheep identity was not materialized");
      const current = decodeSheepIdentityViewV1(currentValue);
      if (current.revision !== command.expectedRevision)
        throw new FlockConflictError(current.revision);
      const next = {
        ...current,
        revision: current.revision + 1,
        sheep: structuredClone(command.sheep),
      } satisfies SheepIdentityViewV1;
      const receipt = {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "applied",
        revision: next.revision,
      } satisfies FlockReceiptV1;
      await storage.put({
        [IDENTITY_KEY]: next,
        [receiptKey]: { fingerprint, receipt },
      });
      return receipt;
    });
  }

  async readLifecycle(
    registration: BotRegistrationV1,
    userId: string,
  ): Promise<BotLifecycleViewV1> {
    await this.materialize(registration, userId);
    const stored = await this.host.storage.get<unknown>(LIFECYCLE_KEY);
    if (stored === undefined)
      throw new Error("Bot lifecycle was not materialized");
    return structuredClone(decodeBotLifecycleViewV1(stored));
  }

  async executeLifecycle(
    registration: BotRegistrationV1,
    userId: string,
    input: unknown,
  ): Promise<BotLifecycleReceiptV1> {
    const command = decodeBotLifecycleCommandV1(input);
    if (registration.botId !== command.botId)
      throw new Error("lifecycle command does not match Bot registration");
    await this.materialize(registration, userId);
    const fingerprint = flockCommandFingerprint(command);
    return this.host.storage.transaction(async (storage) => {
      const receiptKey = `${LIFECYCLE_RECEIPT_PREFIX}${command.commandId}`;
      const storedReceipt = await storage.get<unknown>(receiptKey);
      if (storedReceipt !== undefined) {
        const decoded = decodeStoredBotLifecycleReceiptV1(storedReceipt);
        if (decoded.fingerprint !== fingerprint)
          throw new FlockDecodeError(
            `command ID collision: ${command.commandId}`,
          );
        return structuredClone(decoded.receipt);
      }
      const currentValue = await storage.get<unknown>(LIFECYCLE_KEY);
      if (currentValue === undefined)
        throw new Error("Bot lifecycle was not materialized");
      const current = decodeBotLifecycleViewV1(currentValue);
      const target = command.type === "bot/archive" ? "archived" : "active";
      let receipt: BotLifecycleReceiptV1;
      if (
        target === "archived" &&
        current.status !== "archived" &&
        !(await this.host.archiveEligible(storage))
      ) {
        receipt = {
          schemaVersion: 1,
          commandId: command.commandId,
          botId: command.botId,
          status: "rejected",
          lifecycle: current,
          failure: "Bot has active or reconciling work",
        };
      } else {
        const lifecycle =
          current.status === target
            ? current
            : ({
                ...current,
                status: target,
                revision: current.revision + 1,
              } satisfies BotLifecycleViewV1);
        receipt = {
          schemaVersion: 1,
          commandId: command.commandId,
          botId: command.botId,
          status: "applied",
          lifecycle,
        };
        await storage.put(LIFECYCLE_KEY, lifecycle);
      }
      await storage.put(receiptKey, { fingerprint, receipt });
      return decodeBotLifecycleReceiptV1(receipt);
    });
  }

  async assertActive(
    storage: FlockBotTransaction,
    botId: string,
  ): Promise<void> {
    const value = await storage.get<unknown>(LIFECYCLE_KEY);
    if (value === undefined) return;
    const lifecycle = decodeBotLifecycleViewV1(value);
    if (lifecycle.botId !== botId)
      throw new Error("Bot lifecycle identity does not match");
    if (lifecycle.status === "archived") throw new BotArchivedError(botId);
  }
}

export function createFlockBotBackendContribution(
  host: FlockBotBackendHost,
): FlockBotBackendContribution {
  return new FlockBotBackendContribution(host);
}

export function createFlockBotBackendPlugin(
  host: FlockBotBackendHost,
  lifecycle: { mount(value: FlockBotBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(createFlockBotBackendContribution(host));
}

/**
 * What an application hands this Contribution: the Bot's own lifecycle state, under the
 * Package's own key so one wide host object can satisfy every Package's slice
 * without their fields colliding.
 */
export interface FlockBotApplicationHostV1 {
  flock: FlockBotBackendHost;
}

/**
 * The manifest's `bot` entry, resolved by specifier. The
 * application looks this descriptor up in its Contribution table; it never
 * branches on which Package it belongs to.
 */
export const botContribution = defineBotBackendContribution<
  FlockBotApplicationHostV1,
  FlockBotBackendContribution
>({
  specifier: "@frockbot/plugin-flock/bot",
  create: (host, lifecycle) =>
    createFlockBotBackendPlugin(host.flock, lifecycle),
});
