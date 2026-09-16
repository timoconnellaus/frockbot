// Shared configuration types remain provider-neutral at this package seam.
import {
  decodeBotIdV1,
  decodeBotSelfWriterV1,
  isPublicIdentifier,
  type BotNameProvenanceV1,
  type BotSelfWriterV1,
} from "@frockbot/core/configuration";
export type { BotSelfWriterV1 } from "@frockbot/core/configuration";
import { APPLET_IMPACT_FINGERPRINT_V1 } from "@frockbot/core/contracts";
export const FLOCK_DIRECTORY_LIMIT = 100;

/**
 * Which Bot the account's authority provisioned as General, while it is still
 * registered. General's id is minted fresh like any other, so this is the only
 * way a client knows which Bot it is; nothing is inferred from a name or id.
 */
export interface FlockBootstrapViewV1 {
  schemaVersion: 1;
  generalBotId: string | null;
}

export function decodeFlockBootstrapViewV1(
  input: unknown,
): FlockBootstrapViewV1 {
  const value = record(input, "Flock bootstrap view");
  exact(value, ["schemaVersion", "generalBotId"], []);
  if (value.schemaVersion !== 1)
    throw new FlockDecodeError("unsupported Flock bootstrap view");
  return {
    schemaVersion: 1,
    generalBotId:
      value.generalBotId === null ? null : botIdentifier(value.generalBotId),
  };
}

export function isFlockIdentifier(value: unknown): value is string {
  return isPublicIdentifier(value);
}

export interface AvatarAppearanceV1 {
  schemaVersion: 1;
  characterId: string;
  primary: string;
}
export interface BotRegistrationV1 {
  schemaVersion: 1;
  botId: string;
  registeredAt: string;
  initialName: string;
  /**
   * The persona the Bot is materialized with. GrokBot's `CreateAgent` takes a
   * `description` that becomes the new agent's profile, and the seed is the
   * only place a creator can put it: the Bot's own profile lives in the Bot
   * Durable Object, which no other Bot may write.
   */
  initialDescription?: string;
  /**
   * The Bot and Turn that created this Bot, when a Bot created it. Absent for
   * a User-created Bot and for every registration written before this existed.
   */
  createdBy?: BotSelfWriterV1;
  avatar: AvatarAppearanceV1;
}
export interface BotMembershipViewV1 {
  schemaVersion: 1;
  botId: string;
  registered: boolean;
}
export interface BotDirectoryViewV1 {
  schemaVersion: 1;
  revision: number;
  bots: BotRegistrationV1[];
}
/**
 * A Bot's durable lifecycle. `deleted` is terminal: the Bot and its chat
 * history are gone, and the status survives only as a tombstone so a late
 * command or Turn is refused rather than resurrecting the Bot.
 */
export type BotLifecycleStatusV1 = "active" | "archived" | "deleted";
export interface BotLifecycleViewV1 {
  schemaVersion: 1;
  botId: string;
  status: BotLifecycleStatusV1;
  revision: number;
}
export interface BotLifecycleDirectoryViewV1 {
  schemaVersion: 1;
  lifecycles: BotLifecycleViewV1[];
}
export interface BotLifecycleCommandV1 {
  schemaVersion: 1;
  type: "bot/archive" | "bot/restore" | "bot/delete";
  commandId: string;
  botId: string;
  /**
   * `bot/delete` only: the fingerprint of the Applets its confirmation named
   * (ADR 0027). The client's route requires it; admission refuses a command
   * whose fingerprint no longer matches the directory.
   */
  appletImpact?: string;
}
export interface BotLifecycleReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  botId: string;
  status: "pending" | "applied" | "rejected";
  lifecycle: BotLifecycleViewV1;
  failure?: string;
}
export interface StoredBotLifecycleReceiptV1 {
  fingerprint: string;
  receipt: BotLifecycleReceiptV1;
}
export interface CreateBotCommandV1 {
  schemaVersion: 1;
  type: "bot/create";
  commandId: string;
  expectedRevision: number;
  botId: string;
  name: string;
  /** The new Bot's persona, materialized into its profile. */
  description?: string;
  /** The Bot and Turn issuing this command, when a Bot issues it. */
  createdBy?: BotSelfWriterV1;
  avatar?: AvatarAppearanceV1;
}
export interface UpdateAvatarCommandV1 {
  schemaVersion: 1;
  type: "bot/update-avatar";
  commandId: string;
  expectedRevision: number;
  botId: string;
  avatar: AvatarAppearanceV1;
}
export interface AvatarIdentityViewV1 {
  schemaVersion: 1;
  botId: string;
  revision: number;
  avatar: AvatarAppearanceV1;
}
export interface FlockReceiptV1 {
  schemaVersion: 1;
  commandId: string;
  status: "applied" | "rejected";
  revision: number;
  failure?: string;
}
export interface StoredFlockReceiptV1 {
  fingerprint: string;
  receipt: FlockReceiptV1;
}

/**
 * One Bot's live identity, as the Flock directory surfaces it.
 *
 * The registration seed in the User Durable Object is immutable, so the mutable
 * half of a Bot's identity — the current name, its provenance, a title and
 * whether the sidebar hides it — is read through from the Bot Durable Object
 * that owns it rather than copied into the seed.
 */
export interface BotIdentityViewV1 {
  schemaVersion: 1;
  botId: string;
  name: string;
  namedBy: BotNameProvenanceV1;
  hiddenFromSidebar: boolean;
  /** Purely organisational sidebar group; never part of Bot instructions. */
  label?: string;
  title?: string;
  /**
   * When the User pinned this Bot, as an ISO 8601 instant. A pinned Bot is
   * shown as a tile above the list instead of a row inside it, earliest pin
   * first. Absent means not pinned.
   */
  pinnedAt?: string;
  /**
   * Where this Bot sits among the Bots of its label, lower first; a Bot
   * without one follows every Bot with one. Purely organisational, like the
   * label.
   */
  sidebarOrder?: number;
}

export interface BotIdentityDirectoryViewV1 {
  schemaVersion: 1;
  identities: BotIdentityViewV1[];
}

export class FlockDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlockDecodeError";
  }
}
export class FlockConflictError extends Error {
  constructor(readonly currentRevision: number) {
    super(`flock revision is ${currentRevision}`);
    this.name = "FlockConflictError";
  }
}
/**
 * The status a lifecycle command settles on. The saga on the User side and the
 * Bot Durable Object both read the target from here rather than each writing
 * out the same mapping.
 */
export function lifecycleTargetStatusV1(
  type: BotLifecycleCommandV1["type"],
): BotLifecycleStatusV1 {
  if (type === "bot/archive") return "archived";
  if (type === "bot/delete") return "deleted";
  return "active";
}

export class BotNotFoundError extends Error {
  constructor(readonly botId: string) {
    super(`Bot "${botId}" is not registered`);
    this.name = "BotNotFoundError";
  }
}

export const avatarCatalog = {
  pixel: "#fc85ae",
  guardian: "#3c3543",
  sunny: "#ffc928",
  chill: "#59c7ff",
  nudge: "#ff8b27",
  fox: "#ef6b4a",
  dog: "#dca258",
  goat: "#d8c8ab",
  cow: "#f4eee4",
  cat: "#8b72d9",
  rabbit: "#d7b9f1",
} as const;

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input))
    throw new FlockDecodeError(`${label} must be an object`);
  return input as Record<string, unknown>;
}
function exact(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  // Values read over Durable Object RPC carry a disposal symbol as an own
  // key; it is transport, not a field.
  const keys = Reflect.ownKeys(value).filter(
    (key) => key !== Symbol.dispose && key !== Symbol.asyncDispose,
  );
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    keys.some((key) => typeof key !== "string" || !allowed.has(key))
  )
    throw new FlockDecodeError("unknown or missing field");
}
function identifier(value: unknown, label: string): string {
  if (!isFlockIdentifier(value))
    throw new FlockDecodeError(`${label} is invalid`);
  return value;
}

function botIdentifier(value: unknown): string {
  try {
    return decodeBotIdV1(value);
  } catch {
    throw new FlockDecodeError("botId is invalid");
  }
}
/** An optional Bot writer, decoded once at this seam and never re-shaped. */
function botWriter(value: unknown, label: string): BotSelfWriterV1 | undefined {
  if (value === undefined) return undefined;
  try {
    return decodeBotSelfWriterV1(value, label);
  } catch (error) {
    throw new FlockDecodeError(
      error instanceof Error ? error.message : `${label} is invalid`,
    );
  }
}

function boundedText(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.trim() !== value ||
    value.length < 1 ||
    value.length > maximum
  )
    throw new FlockDecodeError(`${label} is invalid`);
  return value;
}
function revision(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new FlockDecodeError("revision is invalid");
  return value as number;
}
export function decodeAvatarAppearanceV1(input: unknown): AvatarAppearanceV1 {
  const value = record(input, "avatar appearance");
  exact(value, ["schemaVersion", "characterId", "primary"]);
  if (value.schemaVersion !== 1)
    throw new FlockDecodeError("unsupported avatar appearance");
  const appearance = {
    schemaVersion: 1,
    characterId: identifier(value.characterId, "characterId"),
    primary:
      typeof value.primary === "string" ? value.primary.toLowerCase() : "",
  } satisfies AvatarAppearanceV1;
  if (
    !Object.hasOwn(avatarCatalog, appearance.characterId) ||
    !/^#[0-9a-f]{6}$/.test(appearance.primary)
  )
    throw new FlockDecodeError("avatar appearance is invalid");
  return appearance;
}

export function decodeCreateBotCommandV1(input: unknown): CreateBotCommandV1 {
  const value = record(input, "create Bot command");
  exact(
    value,
    ["schemaVersion", "type", "commandId", "expectedRevision", "botId", "name"],
    ["description", "createdBy", "avatar"],
  );
  if (value.schemaVersion !== 1 || value.type !== "bot/create")
    throw new FlockDecodeError("unsupported create Bot command");
  const botId = botIdentifier(value.botId);
  const createdBy = botWriter(value.createdBy, "createdBy");
  // The creator names itself; a Bot may not claim the new Bot wrote its own
  // registration, and it may not attribute the create to some third Bot.
  if (createdBy && createdBy.botId === botId)
    throw new FlockDecodeError("createdBy is invalid");
  return {
    schemaVersion: 1,
    type: "bot/create",
    commandId: identifier(value.commandId, "commandId"),
    expectedRevision: revision(value.expectedRevision),
    botId,
    name: boundedText(value.name, "name", 100),
    ...(value.description === undefined
      ? {}
      : { description: boundedText(value.description, "description", 10_000) }),
    ...(createdBy ? { createdBy } : {}),
    avatar:
      value.avatar === undefined
        ? undefined
        : decodeAvatarAppearanceV1(value.avatar),
  };
}

export function decodeUpdateAvatarCommandV1(
  input: unknown,
): UpdateAvatarCommandV1 {
  const value = record(input, "update avatar command");
  exact(value, [
    "schemaVersion",
    "type",
    "commandId",
    "expectedRevision",
    "botId",
    "avatar",
  ]);
  if (value.schemaVersion !== 1 || value.type !== "bot/update-avatar")
    throw new FlockDecodeError("unsupported update avatar command");
  return {
    schemaVersion: 1,
    type: "bot/update-avatar",
    commandId: identifier(value.commandId, "commandId"),
    expectedRevision: revision(value.expectedRevision),
    botId: botIdentifier(value.botId),
    avatar: decodeAvatarAppearanceV1(value.avatar),
  };
}

export function decodeBotRegistrationV1(input: unknown): BotRegistrationV1 {
  const bot = record(input, "Bot registration");
  exact(
    bot,
    ["schemaVersion", "botId", "registeredAt", "initialName", "avatar"],
    ["initialDescription", "createdBy"],
  );
  if (bot.schemaVersion !== 1)
    throw new FlockDecodeError("unsupported Bot registration");
  const botId = botIdentifier(bot.botId);
  const createdBy = botWriter(bot.createdBy, "createdBy");
  if (createdBy && createdBy.botId === botId)
    throw new FlockDecodeError("createdBy is invalid");
  return {
    schemaVersion: 1,
    botId,
    registeredAt: boundedText(bot.registeredAt, "registeredAt", 64),
    initialName: boundedText(bot.initialName, "initialName", 100),
    ...(bot.initialDescription === undefined
      ? {}
      : {
          initialDescription: boundedText(
            bot.initialDescription,
            "initialDescription",
            10_000,
          ),
        }),
    ...(createdBy ? { createdBy } : {}),
    avatar: decodeAvatarAppearanceV1(bot.avatar),
  };
}

/**
 * Fields a Bot registration seed carried before per-Bot model bindings and
 * Assignments were removed (commit 03034e0). A directory written before that
 * refactor still holds them on disk, and the exact-field decoder rejects every
 * read of it — which takes out the sidebar and Bot creation together, because
 * both start by decoding the stored directory. Migration drops the fields
 * without interpreting them: a Bot's model and tools now resolve from the
 * User's enabled Packages and Connections at its next admitted Turn.
 */
const PRE_ACCOUNT_WIDE_REGISTRATION_FIELDS_V1 = [
  "initialModel",
  "initialModelBinding",
  "initialAssignments",
] as const;

/** A durable record only ever deserializes to a plain object; nothing else. */
function storedPlainRecordV1(
  value: unknown,
): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return undefined;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Migrates one raw stored Bot directory across known durable shapes before the
 * current exact-field decoder sees it. A record already in the current shape is
 * returned untouched, so this is safe to apply on every read.
 */
export function migrateStoredBotDirectoryV1(stored: unknown): unknown {
  const directory = storedPlainRecordV1(stored);
  if (!directory || !Array.isArray(directory.bots)) return stored;
  let changed = false;
  const bots = directory.bots.map((storedBot) => {
    const bot = storedPlainRecordV1(storedBot);
    if (!bot) return storedBot;
    const removed = PRE_ACCOUNT_WIDE_REGISTRATION_FIELDS_V1.filter((key) =>
      Object.hasOwn(bot, key),
    );
    if (removed.length === 0) return storedBot;
    changed = true;
    const next = { ...bot };
    for (const key of removed) delete next[key];
    return next;
  });
  return changed ? { ...directory, bots } : stored;
}

export function decodeBotMembershipViewV1(input: unknown): BotMembershipViewV1 {
  const value = record(input, "Bot membership");
  exact(value, ["schemaVersion", "botId", "registered"]);
  if (value.schemaVersion !== 1 || typeof value.registered !== "boolean")
    throw new FlockDecodeError("Bot membership is invalid");
  return {
    schemaVersion: 1,
    botId: botIdentifier(value.botId),
    registered: value.registered,
  };
}

export function decodeDirectoryViewV1(input: unknown): BotDirectoryViewV1 {
  const value = record(input, "Bot directory");
  exact(value, ["schemaVersion", "revision", "bots"]);
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.bots) ||
    value.bots.length > FLOCK_DIRECTORY_LIMIT
  )
    throw new FlockDecodeError("Bot directory is invalid");
  const bots = value.bots.map(decodeBotRegistrationV1);
  if (new Set(bots.map((bot) => bot.botId)).size !== bots.length)
    throw new FlockDecodeError("Bot directory contains duplicate IDs");
  return {
    schemaVersion: 1,
    revision: revision(value.revision),
    bots,
  };
}

export function decodeBotLifecycleCommandV1(
  input: unknown,
): BotLifecycleCommandV1 {
  const value = record(input, "Bot lifecycle command");
  exact(
    value,
    ["schemaVersion", "type", "commandId", "botId"],
    ["appletImpact"],
  );
  if (
    value.schemaVersion !== 1 ||
    (value.type !== "bot/archive" &&
      value.type !== "bot/restore" &&
      value.type !== "bot/delete")
  )
    throw new FlockDecodeError("unsupported Bot lifecycle command");
  if (
    value.appletImpact !== undefined &&
    (value.type !== "bot/delete" ||
      typeof value.appletImpact !== "string" ||
      !APPLET_IMPACT_FINGERPRINT_V1.test(value.appletImpact))
  )
    throw new FlockDecodeError("appletImpact is invalid");
  return {
    schemaVersion: 1,
    type: value.type,
    commandId: identifier(value.commandId, "commandId"),
    botId: botIdentifier(value.botId),
    ...(value.appletImpact === undefined
      ? {}
      : { appletImpact: value.appletImpact as string }),
  };
}

export function decodeBotLifecycleViewV1(input: unknown): BotLifecycleViewV1 {
  const value = record(input, "Bot lifecycle");
  exact(value, ["schemaVersion", "botId", "status", "revision"]);
  if (
    value.schemaVersion !== 1 ||
    (value.status !== "active" &&
      value.status !== "archived" &&
      value.status !== "deleted")
  )
    throw new FlockDecodeError("Bot lifecycle is invalid");
  return {
    schemaVersion: 1,
    botId: botIdentifier(value.botId),
    status: value.status,
    revision: revision(value.revision),
  };
}

export function decodeBotLifecycleDirectoryViewV1(
  input: unknown,
): BotLifecycleDirectoryViewV1 {
  const value = record(input, "Bot lifecycle directory");
  exact(value, ["schemaVersion", "lifecycles"]);
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.lifecycles) ||
    value.lifecycles.length > FLOCK_DIRECTORY_LIMIT
  )
    throw new FlockDecodeError("Bot lifecycle directory is invalid");
  const lifecycles = value.lifecycles.map(decodeBotLifecycleViewV1);
  if (new Set(lifecycles.map((item) => item.botId)).size !== lifecycles.length)
    throw new FlockDecodeError(
      "Bot lifecycle directory contains duplicate IDs",
    );
  return { schemaVersion: 1, lifecycles };
}

export function decodeBotLifecycleReceiptV1(
  input: unknown,
): BotLifecycleReceiptV1 {
  const value = record(input, "Bot lifecycle receipt");
  exact(
    value,
    ["schemaVersion", "commandId", "botId", "status", "lifecycle"],
    ["failure"],
  );
  if (
    value.schemaVersion !== 1 ||
    (value.status !== "pending" &&
      value.status !== "applied" &&
      value.status !== "rejected")
  )
    throw new FlockDecodeError("Bot lifecycle receipt is invalid");
  const lifecycle = decodeBotLifecycleViewV1(value.lifecycle);
  const botId = botIdentifier(value.botId);
  if (lifecycle.botId !== botId)
    throw new FlockDecodeError("Bot lifecycle receipt identity is invalid");
  return {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "commandId"),
    botId,
    status: value.status,
    lifecycle,
    failure:
      value.failure === undefined
        ? undefined
        : boundedText(value.failure, "Bot lifecycle receipt failure", 1_000),
  };
}

export function decodeStoredBotLifecycleReceiptV1(
  input: unknown,
): StoredBotLifecycleReceiptV1 {
  const value = record(input, "stored Bot lifecycle receipt");
  exact(value, ["fingerprint", "receipt"]);
  return {
    fingerprint: boundedText(value.fingerprint, "fingerprint", 10_000),
    receipt: decodeBotLifecycleReceiptV1(value.receipt),
  };
}

export function decodeFlockReceiptV1(input: unknown): FlockReceiptV1 {
  const value = record(input, "Flock receipt");
  exact(
    value,
    ["schemaVersion", "commandId", "status", "revision"],
    ["failure"],
  );
  if (
    value.schemaVersion !== 1 ||
    (value.status !== "applied" && value.status !== "rejected")
  )
    throw new FlockDecodeError("Flock receipt is invalid");
  const failure =
    value.failure === undefined
      ? undefined
      : boundedText(value.failure, "Flock receipt failure", 1_000);
  return {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "commandId"),
    status: value.status,
    revision: revision(value.revision),
    failure,
  };
}

export function decodeStoredFlockReceiptV1(
  input: unknown,
): StoredFlockReceiptV1 {
  const value = record(input, "stored Flock receipt");
  exact(value, ["fingerprint", "receipt"]);
  return {
    fingerprint: boundedText(value.fingerprint, "fingerprint", 10_000),
    receipt: decodeFlockReceiptV1(value.receipt),
  };
}

export function decodeAvatarIdentityViewV1(
  input: unknown,
): AvatarIdentityViewV1 {
  const value = record(input, "avatar identity");
  exact(value, ["schemaVersion", "botId", "revision", "avatar"]);
  if (value.schemaVersion !== 1)
    throw new FlockDecodeError("unsupported avatar identity");
  return {
    schemaVersion: 1,
    botId: botIdentifier(value.botId),
    revision: revision(value.revision),
    avatar: decodeAvatarAppearanceV1(value.avatar),
  };
}

function nameProvenance(value: unknown): BotNameProvenanceV1 {
  if (value !== "user" && value !== "bot")
    throw new FlockDecodeError("namedBy is invalid");
  return value;
}

export function decodeBotIdentityViewV1(input: unknown): BotIdentityViewV1 {
  const value = record(input, "Bot identity");
  exact(
    value,
    ["schemaVersion", "botId", "name", "namedBy", "hiddenFromSidebar"],
    ["label", "title", "pinnedAt", "sidebarOrder"],
  );
  if (value.schemaVersion !== 1 || typeof value.hiddenFromSidebar !== "boolean")
    throw new FlockDecodeError("Bot identity is invalid");
  return {
    schemaVersion: 1,
    botId: botIdentifier(value.botId),
    name: boundedText(value.name, "name", 100),
    namedBy: nameProvenance(value.namedBy),
    hiddenFromSidebar: value.hiddenFromSidebar,
    ...(value.label === undefined
      ? {}
      : { label: boundedText(value.label, "label", 120) }),
    ...(value.title === undefined
      ? {}
      : { title: boundedText(value.title, "title", 120) }),
    ...(value.pinnedAt === undefined
      ? {}
      : { pinnedAt: timestampText(value.pinnedAt, "pinnedAt") }),
    ...(value.sidebarOrder === undefined
      ? {}
      : { sidebarOrder: sidebarOrderNumber(value.sidebarOrder) }),
  };
}

function sidebarOrderNumber(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value)) {
    throw new FlockDecodeError("sidebarOrder is invalid");
  }
  return value;
}

/** An ISO 8601 instant. The sidebar orders pinned Bots by it. */
function timestampText(value: unknown, label: string): string {
  const candidate = boundedText(value, label, 64);
  if (!Number.isFinite(Date.parse(candidate)))
    throw new FlockDecodeError(`${label} is invalid`);
  return candidate;
}

export function decodeBotIdentityDirectoryViewV1(
  input: unknown,
): BotIdentityDirectoryViewV1 {
  const value = record(input, "Bot identity directory");
  exact(value, ["schemaVersion", "identities"]);
  if (
    value.schemaVersion !== 1 ||
    !Array.isArray(value.identities) ||
    value.identities.length > FLOCK_DIRECTORY_LIMIT
  )
    throw new FlockDecodeError("Bot identity directory is invalid");
  const identities = value.identities.map(decodeBotIdentityViewV1);
  if (new Set(identities.map((item) => item.botId)).size !== identities.length)
    throw new FlockDecodeError("Bot identity directory contains duplicate IDs");
  return { schemaVersion: 1, identities };
}

export function randomAvatarAppearanceV1(
  random: () => number = Math.random,
): AvatarAppearanceV1 {
  const characters = Object.keys(avatarCatalog) as Array<
    keyof typeof avatarCatalog
  >;
  const characterId =
    characters[
      Math.min(characters.length - 1, Math.floor(random() * characters.length))
    ]!;
  return {
    schemaVersion: 1,
    characterId,
    primary: avatarCatalog[characterId],
  };
}

export function flockCommandFingerprint(
  value: CreateBotCommandV1 | UpdateAvatarCommandV1 | BotLifecycleCommandV1,
): string {
  return JSON.stringify(value);
}
