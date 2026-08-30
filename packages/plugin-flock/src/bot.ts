import type { Plugin } from "cordis";
import {
  FlockConflictError,
  FlockDecodeError,
  decodeBotRegistrationV1,
  decodeSheepIdentityViewV1,
  decodeStoredFlockReceiptV1,
  flockCommandFingerprint,
  type BotRegistrationV1,
  type FlockReceiptV1,
  type SheepIdentityViewV1,
  type UpdateSheepCommandV1,
} from "./shared.js";

const IDENTITY_KEY = "flock:sheep:v1";
const RECEIPT_PREFIX = "flock:sheep-receipt:";
interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}
interface Storage extends Transaction {
  transaction<T>(callback: (storage: Transaction) => Promise<T>): Promise<T>;
}
export interface FlockBotBackendHost {
  storage: Storage;
  materializeSettings(
    registration: BotRegistrationV1,
    userId: string,
  ): Promise<void>;
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
      const existing =
        existingValue === undefined
          ? undefined
          : decodeSheepIdentityViewV1(existingValue);
      if (existing) {
        if (existing.botId !== registration.botId)
          throw new Error("sheep identity does not match Bot registration");
        return existing;
      }
      const initial = {
        schemaVersion: 1,
        botId: registration.botId,
        revision: 0,
        sheep: structuredClone(registration.sheep),
      } satisfies SheepIdentityViewV1;
      await storage.put(IDENTITY_KEY, initial);
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
