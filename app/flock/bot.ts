import {
  FlockConflictError,
  FlockDecodeError,
  decodeBotLifecycleCommandV1,
  decodeBotLifecycleReceiptV1,
  decodeBotLifecycleViewV1,
  decodeBotRegistrationV1,
  decodeAvatarIdentityViewV1,
  decodeVoiceIdentityViewV1,
  decodeLookIdentityViewV1,
  decodeStoredBotLifecycleReceiptV1,
  decodeStoredFlockReceiptV1,
  flockCommandFingerprint,
  type BotLifecycleCommandV1,
  type BotLifecycleReceiptV1,
  type BotLifecycleViewV1,
  type BotRegistrationV1,
  type FlockReceiptV1,
  type AvatarIdentityViewV1,
  type UpdateAvatarCommandV1,
  type VoiceIdentityViewV1,
  type UpdateVoiceCommandV1,
  type LookIdentityViewV1,
  type UpdateLookCommandV1,
} from "./shared.js";
import {
  defaultBotLookV1,
  type BotLookV1,
  type ThemeDocumentV1,
} from "@frockbot/core/theme";
import { defineBotBackendContribution } from "@frockbot/core/contracts/contributions";

const IDENTITY_KEY = "flock:avatar:v1";
const RECEIPT_PREFIX = "flock:avatar-receipt:";
// A Bot's voice is its own record with its own revision, so changing how a Bot
// sounds never races a change to how it looks (ADR 0031).
const VOICE_KEY = "flock:voice:v1";
const VOICE_RECEIPT_PREFIX = "flock:voice-receipt:";
const LOOK_KEY = "flock:look:v1";
const LOOK_RECEIPT_PREFIX = "flock:look-receipt:";
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
  /**
   * Destroy everything this Bot owns: every durable key in its own Durable
   * Object, its scheduled alarm, and any object-store root keyed to it.
   *
   * The host owns this rather than the Contribution because the surfaces are
   * the application's — `deleteAll()` and `deleteAlarm()` are not part of the
   * transaction seam this Package writes against, and the object store is not
   * named here at all. It must be idempotent: the delete saga replays, and a
   * Bot torn down twice is torn down once.
   */
  tearDown(identity: {
    userId: string;
    botId: string;
  }): Promise<"complete" | "pending">;
}

export class BotArchivedError extends Error {
  constructor(readonly botId: string) {
    super(`Bot "${botId}" is archived`);
    this.name = "BotArchivedError";
  }
}

/**
 * A Bot that has been permanently deleted. Distinct from `BotNotFoundError`
 * because the tombstone is the one thing a deleted Bot still knows about
 * itself: the registration may already be gone from the User's directory, or
 * it may not be gone yet, and either way no Turn, command or routine may run.
 */
export class BotDeletedError extends Error {
  constructor(readonly botId: string) {
    super(`Bot "${botId}" is deleted`);
    this.name = "BotDeletedError";
  }
}

export class FlockBotBackendContribution {
  constructor(private readonly host: FlockBotBackendHost) {}

  async materialize(
    registrationInput: BotRegistrationV1,
    userId: string,
  ): Promise<AvatarIdentityViewV1> {
    const registration = decodeBotRegistrationV1(registrationInput);
    // A tombstone is checked before anything is written back: materializing a
    // deleted Bot would recreate the very rows the delete removed.
    const tombstone = await this.deletedLifecycle();
    if (tombstone) throw new BotDeletedError(registration.botId);
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
          : decodeAvatarIdentityViewV1(existingValue);
      if (existing) {
        if (existing.botId !== registration.botId)
          throw new Error("avatar identity does not match Bot registration");
        if (lifecycleValue === undefined)
          await storage.put(LIFECYCLE_KEY, lifecycle);
        return existing;
      }
      const initial = {
        schemaVersion: 1,
        botId: registration.botId,
        revision: 0,
        avatar: structuredClone(registration.avatar),
      } satisfies AvatarIdentityViewV1;
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
  ): Promise<AvatarIdentityViewV1> {
    return structuredClone(await this.materialize(registration, userId));
  }

  async update(
    registration: BotRegistrationV1,
    userId: string,
    command: UpdateAvatarCommandV1,
  ): Promise<FlockReceiptV1> {
    if (registration.botId !== command.botId)
      throw new Error("avatar command does not match Bot registration");
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
        throw new Error("avatar identity was not materialized");
      const current = decodeAvatarIdentityViewV1(currentValue);
      if (current.revision !== command.expectedRevision)
        throw new FlockConflictError(current.revision);
      const next = {
        ...current,
        revision: current.revision + 1,
        avatar: structuredClone(command.avatar),
      } satisfies AvatarIdentityViewV1;
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

  /**
   * The Bot's voice record, seeded once from the registration.
   *
   * Lazy rather than written in `materialize`: a Bot registered before voices
   * existed has no record, and seeding it on the first read costs one write
   * instead of a migration. An absent `voice` is not a gap to fill — it means
   * nobody chose, and the character default answers for the Bot.
   */
  private async materializeVoice(
    registration: BotRegistrationV1,
    userId: string,
  ): Promise<VoiceIdentityViewV1> {
    // The avatar path owns the tombstone check and the lifecycle record; voice
    // rides on it rather than repeating the rule.
    await this.materialize(registration, userId);
    return this.host.storage.transaction(async (storage) => {
      const existingValue = await storage.get<unknown>(VOICE_KEY);
      if (existingValue !== undefined) {
        const existing = decodeVoiceIdentityViewV1(existingValue);
        if (existing.botId !== registration.botId)
          throw new Error("voice identity does not match Bot registration");
        return existing;
      }
      const initial = {
        schemaVersion: 1,
        botId: registration.botId,
        revision: 0,
        ...(registration.voice === undefined
          ? {}
          : { voice: structuredClone(registration.voice) }),
      } satisfies VoiceIdentityViewV1;
      await storage.put(VOICE_KEY, initial);
      return initial;
    });
  }

  async readVoice(
    registration: BotRegistrationV1,
    userId: string,
  ): Promise<VoiceIdentityViewV1> {
    return structuredClone(await this.materializeVoice(registration, userId));
  }

  /** `bot/update-voice`, fenced and receipted exactly as the avatar update is. */
  async updateVoice(
    registration: BotRegistrationV1,
    userId: string,
    command: UpdateVoiceCommandV1,
  ): Promise<FlockReceiptV1> {
    if (registration.botId !== command.botId)
      throw new Error("voice command does not match Bot registration");
    await this.materializeVoice(registration, userId);
    const fingerprint = flockCommandFingerprint(command);
    return this.host.storage.transaction(async (storage) => {
      await this.assertActive(storage, registration.botId);
      const receiptKey = `${VOICE_RECEIPT_PREFIX}${command.commandId}`;
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
      const currentValue = await storage.get<unknown>(VOICE_KEY);
      if (currentValue === undefined)
        throw new Error("voice identity was not materialized");
      const current = decodeVoiceIdentityViewV1(currentValue);
      if (current.revision !== command.expectedRevision)
        throw new FlockConflictError(current.revision);
      const next = {
        ...current,
        revision: current.revision + 1,
        voice: structuredClone(command.voice),
      } satisfies VoiceIdentityViewV1;
      const receipt = {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "applied",
        revision: next.revision,
      } satisfies FlockReceiptV1;
      await storage.put({
        [VOICE_KEY]: next,
        [receiptKey]: { fingerprint, receipt },
      });
      return receipt;
    });
  }

  private async materializeLook(
    registration: BotRegistrationV1,
    userId: string,
  ): Promise<LookIdentityViewV1> {
    await this.materialize(registration, userId);
    return this.host.storage.transaction(async (storage) => {
      const existingValue = await storage.get<unknown>(LOOK_KEY);
      if (existingValue !== undefined) {
        const existing = decodeLookIdentityViewV1(existingValue);
        if (existing.botId !== registration.botId)
          throw new Error("look identity does not match Bot registration");
        return existing;
      }
      const initial = {
        schemaVersion: 1,
        botId: registration.botId,
        revision: 0,
        look: registration.look ?? defaultBotLookV1(),
        ...(registration.document === undefined
          ? {}
          : { document: structuredClone(registration.document) }),
      } satisfies LookIdentityViewV1;
      await storage.put(LOOK_KEY, initial);
      return initial;
    });
  }

  async readLook(
    registration: BotRegistrationV1,
    userId: string,
  ): Promise<LookIdentityViewV1> {
    return structuredClone(await this.materializeLook(registration, userId));
  }

  async updateLook(
    registration: BotRegistrationV1,
    userId: string,
    command: UpdateLookCommandV1,
  ): Promise<FlockReceiptV1> {
    if (registration.botId !== command.botId)
      throw new Error("look command does not match Bot registration");
    await this.materializeLook(registration, userId);
    const fingerprint = flockCommandFingerprint(command);
    return this.host.storage.transaction(async (storage) => {
      await this.assertActive(storage, registration.botId);
      const receiptKey = `${LOOK_RECEIPT_PREFIX}${command.commandId}`;
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
      const currentValue = await storage.get<unknown>(LOOK_KEY);
      if (currentValue === undefined)
        throw new Error("look identity was not materialized");
      const current = decodeLookIdentityViewV1(currentValue);
      if (current.revision !== command.expectedRevision)
        throw new FlockConflictError(current.revision);
      if (command.look !== "custom" && command.document !== undefined) {
        throw new FlockDecodeError("named look does not take a document");
      }
      const customDocument =
        command.look === "custom"
          ? (command.document ?? current.document)
          : undefined;
      if (command.look === "custom" && customDocument === undefined) {
        throw new FlockDecodeError("custom look needs a document");
      }
      const next = {
        schemaVersion: 1 as const,
        botId: current.botId,
        revision: current.revision + 1,
        look: command.look,
        ...(customDocument === undefined
          ? {}
          : { document: structuredClone(customDocument) }),
      } satisfies LookIdentityViewV1;
      const receipt = {
        schemaVersion: 1,
        commandId: command.commandId,
        status: "applied",
        revision: next.revision,
      } satisfies FlockReceiptV1;
      await storage.put({
        [LOOK_KEY]: next,
        [receiptKey]: { fingerprint, receipt },
      });
      return receipt;
    });
  }

  /**
   * Persist an assembled document onto the look record, or drop it. Bumps the
   * revision. `undefined` is a named look compiling locally again. `look`
   * is the pick after assemble: Custom when a Plugin changed the tokens.
   */
  async persistAssembledDocument(
    registration: BotRegistrationV1,
    userId: string,
    document: ThemeDocumentV1 | undefined,
    look?: BotLookV1,
  ): Promise<LookIdentityViewV1> {
    await this.materializeLook(registration, userId);
    return this.host.storage.transaction(async (storage) => {
      await this.assertActive(storage, registration.botId);
      const currentValue = await storage.get<unknown>(LOOK_KEY);
      if (currentValue === undefined)
        throw new Error("look identity was not materialized");
      const current = decodeLookIdentityViewV1(currentValue);
      const next = {
        schemaVersion: 1 as const,
        botId: current.botId,
        revision: current.revision + 1,
        look: look ?? current.look,
        ...(document === undefined
          ? {}
          : { document: structuredClone(document) }),
      } satisfies LookIdentityViewV1;
      await storage.put(LOOK_KEY, next);
      return structuredClone(next);
    });
  }

  /**
   * The tombstone, if this Bot has been deleted.
   *
   * The delete teardown wipes every key and then writes the lifecycle back as
   * `deleted`, so this single read is the whole of what a deleted Bot is.
   */
  private async deletedLifecycle(): Promise<BotLifecycleViewV1 | undefined> {
    const stored = await this.host.storage.get<unknown>(LIFECYCLE_KEY);
    if (stored === undefined) return undefined;
    const lifecycle = decodeBotLifecycleViewV1(stored);
    return lifecycle.status === "deleted" ? lifecycle : undefined;
  }

  async readLifecycle(
    registration: BotRegistrationV1,
    userId: string,
  ): Promise<BotLifecycleViewV1> {
    // The saga reconciles an uncertain delete by reading the lifecycle back,
    // so a tombstone answers here rather than throwing: it is the proof the
    // teardown ran.
    const tombstone = await this.deletedLifecycle();
    if (tombstone) return structuredClone(tombstone);
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
    const fingerprint = flockCommandFingerprint(command);
    // Deletion is terminal, so the tombstone is read before the Bot is
    // materialized: a replayed `bot/delete` settles from it, and archive or
    // restore is refused instead of resurrecting the Bot.
    const tombstone = await this.deletedLifecycle();
    if (tombstone)
      return {
        schemaVersion: 1,
        commandId: command.commandId,
        botId: command.botId,
        status: command.type === "bot/delete" ? "applied" : "rejected",
        lifecycle: structuredClone(tombstone),
        ...(command.type === "bot/delete"
          ? {}
          : { failure: `Bot "${command.botId}" is deleted` }),
      } satisfies BotLifecycleReceiptV1;
    if (command.type === "bot/delete")
      return this.delete(registration, userId, command, fingerprint);
    await this.materialize(registration, userId);
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

  /**
   * Permanent deletion, as one replayable step.
   *
   * The teardown runs first and the tombstone is written after it, so a crash
   * anywhere in between leaves an empty Durable Object that the saga's retry
   * tears down again — `tearDown` is idempotent, and an empty object has
   * nothing left to remove. Writing the tombstone first would be the unsafe
   * order: `deleteAll` would take it out again and the Bot would look alive.
   */
  private async delete(
    registration: BotRegistrationV1,
    userId: string,
    command: BotLifecycleCommandV1,
    fingerprint: string,
  ): Promise<BotLifecycleReceiptV1> {
    const currentValue = await this.host.storage.get<unknown>(LIFECYCLE_KEY);
    const current =
      currentValue === undefined
        ? undefined
        : decodeBotLifecycleViewV1(currentValue);
    if (current && current.botId !== registration.botId)
      throw new Error("Bot lifecycle identity does not match");
    const teardown = await this.host.tearDown({
      userId,
      botId: registration.botId,
    });
    if (teardown === "pending") {
      return decodeBotLifecycleReceiptV1({
        schemaVersion: 1,
        commandId: command.commandId,
        botId: command.botId,
        status: "pending",
        lifecycle:
          current ??
          ({
            schemaVersion: 1,
            botId: command.botId,
            status: "active",
            revision: 0,
          } satisfies BotLifecycleViewV1),
      });
    }
    const lifecycle = {
      schemaVersion: 1,
      botId: command.botId,
      status: "deleted",
      revision: (current?.revision ?? 0) + 1,
    } satisfies BotLifecycleViewV1;
    const receipt = {
      schemaVersion: 1,
      commandId: command.commandId,
      botId: command.botId,
      status: "applied",
      lifecycle,
    } satisfies BotLifecycleReceiptV1;
    await this.host.storage.put({
      [LIFECYCLE_KEY]: lifecycle,
      [`${LIFECYCLE_RECEIPT_PREFIX}${command.commandId}`]: {
        fingerprint,
        receipt,
      },
    });
    return decodeBotLifecycleReceiptV1(receipt);
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
    if (lifecycle.status === "deleted") throw new BotDeletedError(botId);
    if (lifecycle.status === "archived") throw new BotArchivedError(botId);
  }
}

export function createFlockBotBackendContribution(
  host: FlockBotBackendHost,
): FlockBotBackendContribution {
  return new FlockBotBackendContribution(host);
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
  specifier: "@frockbot/app/flock/bot",
  mount: (host, lifecycle) =>
    lifecycle.mount(createFlockBotBackendContribution(host.flock)),
});
