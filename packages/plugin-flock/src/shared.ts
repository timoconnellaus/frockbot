// Shared configuration types remain provider-neutral at this package seam.
import {
  decodeBotAvatarV1,
  decodeCapabilityAssignmentV1,
  decodeBotIdV1,
  decodeBotSelfWriterV1,
  isPublicIdentifier,
  type BotAvatarV1,
  type BotNameProvenanceV1,
  type BotSelfWriterV1,
  type CapabilityAssignmentView,
  type ModelAssignment,
} from "@frockbot/configuration-core";
export type { BotSelfWriterV1 } from "@frockbot/configuration-core";
export {
  BOT_AVATAR_CONTENT_TYPES,
  BOT_AVATAR_MAX_BYTES,
  botAvatarObjectKeyV1,
  decodeBotAvatarBytesV1,
  decodeBotAvatarUploadReceiptV1,
  decodeUploadBotAvatarCommandV1,
  type BotAvatarContentTypeV1,
  type BotAvatarUploadReceiptV1,
  type UploadBotAvatarCommandV1,
} from "@frockbot/configuration-core";
import assetManifest from "../assets/manifest.json" with { type: "json" };

export const FLOCK_DIRECTORY_LIMIT = 100;

export function isFlockIdentifier(value: unknown): value is string {
  return isPublicIdentifier(value);
}

type Band = "upper" | "middle" | "lower";
export interface SheepRecipeV1 {
  schemaVersion: 1;
  background: string;
  upper: string;
  middle: string;
  lower: string;
}
export interface InitialModelBindingV1 {
  assignment: CapabilityAssignmentView;
  generation: string;
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
  initialModel?: ModelAssignment;
  initialModelBinding?: InitialModelBindingV1;
  /**
   * Connection-less Capability authority snapshotted from the User's installed
   * Packages when this Bot was admitted.
   */
  initialAssignments?: CapabilityAssignmentView[];
  /**
   * The Bot and Turn that created this Bot, when a Bot created it. Absent for
   * a User-created Bot and for every registration written before this existed.
   */
  createdBy?: BotSelfWriterV1;
  sheep: SheepRecipeV1;
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
export type BotLifecycleStatusV1 = "active" | "archived";
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
  type: "bot/archive" | "bot/restore";
  commandId: string;
  botId: string;
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
  sheep?: SheepRecipeV1;
}
export interface UpdateSheepCommandV1 {
  schemaVersion: 1;
  type: "bot/update-sheep";
  commandId: string;
  expectedRevision: number;
  botId: string;
  sheep: SheepRecipeV1;
}
export interface SheepIdentityViewV1 {
  schemaVersion: 1;
  botId: string;
  revision: number;
  sheep: SheepRecipeV1;
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
 * The registration seed in the User Durable Object is immutable (ADR 0006), so
 * the mutable half of a Bot's identity — the current name, its provenance, a
 * title, an uploaded avatar, and whether the sidebar hides it — is read through
 * from the Bot Durable Object that owns it rather than copied into the seed.
 */
export interface BotIdentityViewV1 {
  schemaVersion: 1;
  botId: string;
  name: string;
  namedBy: BotNameProvenanceV1;
  hiddenFromSidebar: boolean;
  title?: string;
  /** Present only for an uploaded image; absent means the sheep recipe. */
  avatar?: Extract<BotAvatarV1, { kind: "image" }>;
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
export class BotNotFoundError extends Error {
  constructor(readonly botId: string) {
    super(`Bot "${botId}" is not registered`);
    this.name = "BotNotFoundError";
  }
}

const backgrounds = assetManifest.backgrounds.map((item) => item.id);
const tree = assetManifest.trees as Record<
  Band,
  Array<{ id: string; label: string; parent: string | null; kind: string }>
>;
const ids = Object.fromEntries(
  (Object.keys(tree) as Band[]).map((band) => [
    band,
    tree[band].map((item) => item.id),
  ]),
) as Record<Band, string[]>;
const nodeIndex = new Map<
  string,
  { id: string; parent: string | null; band: Band }
>();
for (const band of Object.keys(tree) as Band[])
  for (const node of tree[band])
    nodeIndex.set(node.id, { id: node.id, parent: node.parent, band });

export const sheepCatalog = {
  backgrounds: assetManifest.backgrounds,
  trees: assetManifest.trees,
  assets: assetManifest.assets,
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
function modelAssignment(value: unknown): ModelAssignment {
  const model = record(value, "initialModel");
  exact(model, ["connectionId", "providerModelId"]);
  return {
    connectionId: identifier(model.connectionId, "initialModel.connectionId"),
    providerModelId: boundedText(
      model.providerModelId,
      "initialModel.providerModelId",
      256,
    ),
  };
}

function initialModelBinding(value: unknown): InitialModelBindingV1 {
  const binding = record(value, "initialModelBinding");
  exact(binding, ["assignment", "generation"]);
  const assignment = record(
    binding.assignment,
    "initialModelBinding.assignment",
  );
  exact(assignment, [
    "assignmentId",
    "packageId",
    "capabilityId",
    "connectionId",
    "state",
  ]);
  if (assignment.state !== "enabled") {
    throw new FlockDecodeError("initial model assignment is invalid");
  }
  return {
    assignment: {
      assignmentId: identifier(
        assignment.assignmentId,
        "initialModelBinding.assignment.assignmentId",
      ),
      packageId: identifier(
        assignment.packageId,
        "initialModelBinding.assignment.packageId",
      ),
      capabilityId: identifier(
        assignment.capabilityId,
        "initialModelBinding.assignment.capabilityId",
      ),
      connectionId: identifier(
        assignment.connectionId,
        "initialModelBinding.assignment.connectionId",
      ),
      state: "enabled",
    },
    generation: identifier(
      binding.generation,
      "initialModelBinding.generation",
    ),
  };
}

export function decodeSheepRecipeV1(input: unknown): SheepRecipeV1 {
  const value = record(input, "sheep recipe");
  exact(value, ["schemaVersion", "background", "upper", "middle", "lower"]);
  if (value.schemaVersion !== 1)
    throw new FlockDecodeError("unsupported sheep recipe");
  const recipe = {
    schemaVersion: 1,
    background: identifier(value.background, "background"),
    upper: identifier(value.upper, "upper"),
    middle: identifier(value.middle, "middle"),
    lower: identifier(value.lower, "lower"),
  } satisfies SheepRecipeV1;
  if (
    !backgrounds.includes(recipe.background) ||
    !ids.upper.includes(recipe.upper) ||
    !ids.middle.includes(recipe.middle) ||
    !ids.lower.includes(recipe.lower)
  )
    throw new FlockDecodeError(
      "sheep recipe references an unknown catalog item",
    );
  return recipe;
}

export function decodeCreateBotCommandV1(input: unknown): CreateBotCommandV1 {
  const value = record(input, "create Bot command");
  exact(
    value,
    ["schemaVersion", "type", "commandId", "expectedRevision", "botId", "name"],
    ["description", "createdBy", "sheep"],
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
    sheep:
      value.sheep === undefined ? undefined : decodeSheepRecipeV1(value.sheep),
  };
}

export function decodeUpdateSheepCommandV1(
  input: unknown,
): UpdateSheepCommandV1 {
  const value = record(input, "update sheep command");
  exact(value, [
    "schemaVersion",
    "type",
    "commandId",
    "expectedRevision",
    "botId",
    "sheep",
  ]);
  if (value.schemaVersion !== 1 || value.type !== "bot/update-sheep")
    throw new FlockDecodeError("unsupported update sheep command");
  return {
    schemaVersion: 1,
    type: "bot/update-sheep",
    commandId: identifier(value.commandId, "commandId"),
    expectedRevision: revision(value.expectedRevision),
    botId: botIdentifier(value.botId),
    sheep: decodeSheepRecipeV1(value.sheep),
  };
}

export function decodeBotRegistrationV1(input: unknown): BotRegistrationV1 {
  const bot = record(input, "Bot registration");
  exact(
    bot,
    ["schemaVersion", "botId", "registeredAt", "initialName", "sheep"],
    [
      "initialDescription",
      "initialModel",
      "initialModelBinding",
      "initialAssignments",
      "createdBy",
    ],
  );
  if (bot.schemaVersion !== 1)
    throw new FlockDecodeError("unsupported Bot registration");
  const initialModel =
    bot.initialModel === undefined
      ? undefined
      : modelAssignment(bot.initialModel);
  const binding =
    bot.initialModelBinding === undefined
      ? undefined
      : initialModelBinding(bot.initialModelBinding);
  if (
    bot.initialAssignments !== undefined &&
    !Array.isArray(bot.initialAssignments)
  )
    throw new FlockDecodeError("initial Assignments are invalid");
  const initialAssignments =
    bot.initialAssignments === undefined
      ? undefined
      : bot.initialAssignments.map(decodeCapabilityAssignmentV1);
  if (
    new Set(
      (initialAssignments ?? []).map((assignment) => assignment.assignmentId),
    ).size !== (initialAssignments ?? []).length ||
    (initialAssignments ?? []).some(
      (assignment) =>
        assignment.connectionId !== undefined || assignment.state !== "enabled",
    )
  ) {
    throw new FlockDecodeError("initial Assignments are invalid");
  }
  if (
    binding &&
    (!initialModel ||
      binding.assignment.connectionId !== initialModel.connectionId)
  ) {
    throw new FlockDecodeError("initial model binding is invalid");
  }
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
    initialModel,
    initialModelBinding: binding,
    ...(initialAssignments ? { initialAssignments } : {}),
    ...(createdBy ? { createdBy } : {}),
    sheep: decodeSheepRecipeV1(bot.sheep),
  };
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
  exact(value, ["schemaVersion", "type", "commandId", "botId"]);
  if (
    value.schemaVersion !== 1 ||
    (value.type !== "bot/archive" && value.type !== "bot/restore")
  )
    throw new FlockDecodeError("unsupported Bot lifecycle command");
  return {
    schemaVersion: 1,
    type: value.type,
    commandId: identifier(value.commandId, "commandId"),
    botId: botIdentifier(value.botId),
  };
}

export function decodeBotLifecycleViewV1(input: unknown): BotLifecycleViewV1 {
  const value = record(input, "Bot lifecycle");
  exact(value, ["schemaVersion", "botId", "status", "revision"]);
  if (
    value.schemaVersion !== 1 ||
    (value.status !== "active" && value.status !== "archived")
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

export function decodeSheepIdentityViewV1(input: unknown): SheepIdentityViewV1 {
  const value = record(input, "sheep identity");
  exact(value, ["schemaVersion", "botId", "revision", "sheep"]);
  if (value.schemaVersion !== 1)
    throw new FlockDecodeError("unsupported sheep identity");
  return {
    schemaVersion: 1,
    botId: botIdentifier(value.botId),
    revision: revision(value.revision),
    sheep: decodeSheepRecipeV1(value.sheep),
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
    ["title", "avatar"],
  );
  if (value.schemaVersion !== 1 || typeof value.hiddenFromSidebar !== "boolean")
    throw new FlockDecodeError("Bot identity is invalid");
  let avatar: Extract<BotAvatarV1, { kind: "image" }> | undefined;
  if (value.avatar !== undefined) {
    let decoded: BotAvatarV1;
    try {
      decoded = decodeBotAvatarV1(value.avatar, "avatar");
    } catch (error) {
      throw new FlockDecodeError(
        error instanceof Error ? error.message : "avatar is invalid",
      );
    }
    if (decoded.kind !== "image")
      throw new FlockDecodeError("Bot identity avatar is invalid");
    avatar = decoded;
  }
  return {
    schemaVersion: 1,
    botId: botIdentifier(value.botId),
    name: boundedText(value.name, "name", 100),
    namedBy: nameProvenance(value.namedBy),
    hiddenFromSidebar: value.hiddenFromSidebar,
    ...(value.title === undefined
      ? {}
      : { title: boundedText(value.title, "title", 120) }),
    ...(avatar ? { avatar } : {}),
  };
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

export function randomSheepRecipeV1(
  random: () => number = Math.random,
): SheepRecipeV1 {
  const pick = (items: string[]) =>
    items[Math.min(items.length - 1, Math.floor(random() * items.length))]!;
  return {
    schemaVersion: 1,
    background: pick(backgrounds),
    upper: pick(ids.upper),
    middle: pick(ids.middle),
    lower: pick(ids.lower),
  };
}

export function sheepLayerIds(recipe: SheepRecipeV1): string[] {
  const result = [`background-${recipe.background}`, "canonical"];
  for (const selected of [recipe.upper, recipe.middle, recipe.lower]) {
    const path: string[] = [];
    let node = nodeIndex.get(selected);
    while (node) {
      if (node.parent !== null) path.unshift(node.id);
      node = node.parent ? nodeIndex.get(node.parent) : undefined;
    }
    result.push(...path);
  }
  return result;
}

export function flockCommandFingerprint(
  value: CreateBotCommandV1 | UpdateSheepCommandV1 | BotLifecycleCommandV1,
): string {
  return JSON.stringify(value);
}
