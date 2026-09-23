// The Flock runtime Contribution: a Bot's flock tools and prompt context.
//
// GrokBot's self-management surface (§2.12) has `UpdateAgent`, where only the
// fields the call carries change, and `CreateAgent`, which makes a new agent
// in the same user's flock. **There is no delete tool** — deletion is a
// user-only action — and this Package matches that: `bot_update` cannot
// archive, restore, or remove anything. Direct Bot messaging is the separate
// `bot_message` capability and does not mutate either Bot.
//
// AUTHORITY. "Self-modification never widens authority." The mutation tools run
// through paths the Bot's User already owns:
//
//  - `bot_update` issues the same `bot/set-profile` command the settings UI
//    issues, against *this* Bot's own Durable Object, with `namedBy: "bot"` so
//    the `bot/renamed` announcement records who did it. The seam refuses a
//    writer that names any Bot but this one.
//  - `bot_create` issues the User's own `bot/create`, and nothing else. The
//    new Bot is registered with no Assignments and no model of its own: it
//    follows the User's default model exactly as a Bot the User creates in the
//    sidebar does. A Bot therefore cannot hand a Bot it makes — or itself —
//    any authority the User's create path does not already give.
//
// A `model` argument is deliberately absent from `bot_create`. Giving the new
// Bot the caller's model would mean writing a `bot/select-model` and a
// Capability Assignment onto another Bot, which is exactly the authority
// widening the constitution forbids; a User grants that, in the UI.
//
// REPLAY. Both tools survive Durable Object eviction without duplicating an
// effect, and both declare `idempotent: true` so the registry may recover them
// by re-running:
//
//  - `bot_create` derives the new Bot's id from the tool-call occurrence, so a
//    replay asks for the *same* Bot id. The tool checks the directory for it
//    before commanding anything: on a replay it finds the Bot it already made
//    and reports that, rather than registering a second one. The directory's
//    uniqueness rule is the fence; the durable `commandId` receipt is only the
//    first line of it.
//  - `bot_update` computes the durable result the patch would produce and
//    commands nothing when it already holds, so a replay is a read. That also
//    keeps a replayed rename from appending a second announcement.
import { packageAdmissionCeilingV1 } from "@frockbot/core/contracts";
import {
  createReplyToRequestToolV1,
  REPLY_TO_REQUEST_TOOL_V1,
} from "@frockbot/app/shell/reply-to-caller";
import {
  applyBotProfilePatchV1,
  ConfigurationConflictError,
  type BotProfile,
  type BotProfilePatchV1,
  type BotSelfWriterV1,
  type BotSettingsViewV1,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
} from "@frockbot/core/configuration";
import type {
  AgentRuntimeV1,
  PromptSection,
  RuntimeFeatureV1,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  TurnTypeV1,
} from "@frockbot/core/contracts";
import { canonicalJson, decodeTurnTypeV1 } from "@frockbot/core/contracts";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  BOT_MESSAGE_TOOL_V1,
  FlockConflictError,
  decodeBotVoiceForFlockV1,
  isFlockIdentifier,
  randomAvatarAppearanceV1,
  type BotDirectoryViewV1,
  type BotVoiceAppearanceV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
  type UpdateVoiceCommandV1,
} from "./shared.js";
import {
  GEMINI_VOICES_V1,
  resolveBotVoiceV1,
  VOICE_ACCENTS_V1,
  VOICE_ATTITUDES_V1,
  type VoiceDeliveryV1,
} from "@frockbot/app/voice/appearance";
import { flockDefinitionV1 } from "./definition.js";
import {
  groupTurnPromptV1,
  type GroupTurnOriginV1,
} from "@frockbot/app/groups/context";
import {
  createSubagentTool,
  subagentHandoffAdmissionCeilingV1,
  type SubagentHandoffHostV1,
} from "./subagent.js";
export { BOT_MESSAGE_TOOL_V1 } from "./shared.js";
export type { SubagentHandoffHostV1 } from "./subagent.js";
export type {
  BotDirectoryViewV1,
  CreateBotCommandV1,
  FlockReceiptV1,
} from "./shared.js";
export type { BotSelfWriterV1 } from "@frockbot/core/configuration";

/** The User and Bot one admitted Turn's self-management runs as. */
export interface FlockSelfOwnerV1 {
  userId: string;
  botId: string;
}

/**
 * The host seam this Contribution receives, supplied by the Bot Durable Object
 * for one admitted Turn. It is absent outside a Turn, and the tools are then
 * not registered at all: a Bot changes itself only inside a Turn whose Session
 * and Turn its provenance can name.
 *
 * This Package holds no authority: the Bot Durable Object owns profiles and
 * Turn admission, while the User Durable Object owns the Flock directory and
 * concurrency slots. Each is reachable only through the narrow calls below.
 */
export interface FlockSelfRuntimeHostV1 {
  owner: FlockSelfOwnerV1;
  /** The provenance every write this Turn records. */
  writer: BotSelfWriterV1;
  /**
   * The durable run this Turn is. Effect ids restart in every Session, so an
   * id derived from one names the run as well.
   */
  runId: string;
  /** This Bot's durable settings, including the revision a command expects. */
  readSelf(): Promise<BotSettingsViewV1>;
  /** Applies one Bot-scoped configuration command to this Bot. */
  commandSelf(
    command: Extract<ConfigurationCommandV1, { botId: string }>,
  ): Promise<OperationReceiptV1>;
  /** The User's Flock directory. */
  listBots(): Promise<BotDirectoryViewV1>;
  /** The User's own `bot/create` path, and no wider. */
  createBot(command: CreateBotCommandV1): Promise<FlockReceiptV1>;
  /**
   * This Bot's voice record: the revision a command must expect, the voice it
   * chose if it ever did, and the character whose default answers when it did
   * not. The tool resolves the default itself rather than being handed one.
   */
  readOwnVoice(): Promise<{
    revision: number;
    voice?: BotVoiceAppearanceV1;
    characterId?: string;
  }>;
  /** `bot/update-voice` against this Bot, through the User's own path. */
  updateOwnVoice(command: UpdateVoiceCommandV1): Promise<FlockReceiptV1>;
  /** Ask another Bot registered to this same User. */
  messageBot(request: BotMessageRequestV1): Promise<BotMessageOutcomeV1>;
  /**
   * Who asked, for an inbound agent Turn. Another Bot of the same User, or the
   * account's voice session — two different callers on one lane, and the Bot
   * is told which so it answers the one that is actually listening.
   */
  inboundAgent?:
    { kind: "bot"; fromBotId: string; fromBotName: string } | { kind: "voice" };
  /**
   * The Group Chat this Turn is in, off its own admission record: the Turn
   * speaks to the group, and is told who is there and how to address them.
   */
  groupChat?: { origin: GroupTurnOriginV1; botId: string; runId: string };
  /**
   * Handing work off to this same Bot. Optional because it is a seam a host
   * may not have bound — a host with no way to admit a Turn on its own agent
   * lane simply does not offer the tool.
   */
  subagent?: SubagentHandoffHostV1;
}

export interface BotMessageRequestV1 {
  targetBotId: string;
  message: string;
  effectId: string;
}

export interface BotMessageOutcomeV1 {
  targetBotId: string;
  targetBotName: string;
  runId: string;
  text: string;
}

export const BOT_MESSAGING_CAPABILITY_V1 = "bot-messaging";
export const GROUP_BOT_MESSAGING_CAPABILITY_V1 = "group-bot-messaging";
export const TEAMMATES_PROMPT_SECTION_V1 = "teammates";
export const INBOUND_AGENT_PROMPT_SECTION_V1 = "agent-message";

/** How many times a command is re-issued after losing an optimistic race. */
const REVISION_RETRIES = 3;

/** The patch field each `bot_update` argument writes, in report order. */
const PROFILE_FIELD_NAMES = [
  ["name", "name"],
  ["description", "description"],
  ["title", "title"],
  ["hiddenFromSidebar", "hidden_from_sidebar"],
] as const satisfies ReadonlyArray<readonly [keyof BotProfilePatchV1, string]>;

/**
 * The delivery dials, as the tool spells them. The slugs are the appearance
 * module's own tables; the three-value dials are listed literally because they
 * are the union types themselves, and the decoder is the authority on all of
 * them either way.
 */
const VOICE_SCHEMA = {
  type: "object",
  description:
    "How you sound in a voice call. Only the fields you pass change; the rest of your voice stays as it is.",
  properties: {
    name: {
      type: "string",
      enum: GEMINI_VOICES_V1.map((voice) => voice.voiceName),
      description: `The prebuilt voice you speak in: ${GEMINI_VOICES_V1.map((voice) => `${voice.voiceName} (${voice.character.toLowerCase()})`).join(", ")}.`,
    },
    accent: {
      type: "string",
      enum: VOICE_ACCENTS_V1.map((accent) => accent.slug),
      description: "The accent you speak English in.",
    },
    attitude: {
      type: "string",
      enum: VOICE_ATTITUDES_V1.map((attitude) => attitude.slug),
      description: "Your manner on a call. Exactly one; it is a personality.",
    },
    pace: { type: "string", enum: ["slower", "natural", "faster"] },
    turn_length: { type: "string", enum: ["terse", "natural", "chatty"] },
    humour: { type: "string", enum: ["none", "dry", "playful"] },
    disfluency: { type: "string", enum: ["clean", "natural"] },
    formality: { type: "string", enum: ["casual", "neutral", "formal"] },
    custom: {
      type: "string",
      description:
        "Anything else about how you sound, in your own words. The empty string clears it.",
    },
  },
  additionalProperties: false,
} as const;

const BOT_UPDATE_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description:
        "Your new name. Renaming yourself is announced in the conversation and recorded as your own change.",
    },
    description: {
      type: "string",
      description:
        "Your persona and standing instructions. The empty string clears it.",
    },
    title: {
      type: "string",
      description:
        "A short role line shown under your name. The empty string clears it.",
    },
    hidden_from_sidebar: {
      type: "boolean",
      description:
        "Hide yourself from the default sidebar list. You stay reachable and nothing is archived or deleted. Hiding also turns notify_on_updates off, and showing yourself again leaves it off.",
    },
    notify_on_updates: {
      type: "boolean",
      description:
        "Whether your User is notified when you have news. Cannot be turned on while you are hidden from the sidebar.",
    },
    voice: VOICE_SCHEMA,
  },
  additionalProperties: false,
} as const;

const BOT_CREATE_SCHEMA = {
  type: "object",
  properties: {
    name: {
      type: "string",
      description: "The new Bot's name.",
    },
    description: {
      type: "string",
      description:
        "The new Bot's persona and standing instructions, which become its profile.",
    },
  },
  required: ["name"],
  additionalProperties: false,
} as const;

const BOT_MESSAGE_SCHEMA = {
  type: "object",
  properties: {
    target_id: {
      type: "string",
      description: "The id of another Bot listed in <teammates>.",
    },
    message: {
      type: "string",
      description: "The complete question or task to send to that Bot.",
    },
  },
  required: ["target_id", "message"],
  additionalProperties: false,
} as const;

/**
 * A partial voice. Each field is carried as the model wrote it and validated
 * once, by the appearance decoder, after it is merged onto the voice the Bot
 * already has — so an unknown slug is refused by the one table that knows.
 */
export interface BotVoicePatchV1 {
  voiceName?: string;
  delivery: VoiceDeliveryV1;
}

interface BotUpdateInputV1 {
  profile: BotProfilePatchV1;
  notifyOnUpdates?: boolean;
  voice?: BotVoicePatchV1;
}

interface BotCreateInputV1 {
  name: string;
  description?: string;
}

interface BotMessageInputV1 {
  targetId: string;
  message: string;
}

function fields(
  input: unknown,
  allowed: readonly string[],
): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    throw new Error("input has unknown fields");
  }
  return value;
}

/**
 * A patch field carrying text. A non-empty string sets it; the empty string
 * clears it, which is the only way a partial update can say "remove this".
 */
function patchText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const normalized = value.trim();
  if (normalized.length > maximum) throw new Error(`${label} is too long`);
  return normalized;
}

function boolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be a boolean`);
  return value;
}

/** The dials, by the name the tool uses and the field the delivery stores. */
const VOICE_DIAL_FIELDS = [
  ["accent", "accent"],
  ["attitude", "attitude"],
  ["pace", "pace"],
  ["turn_length", "turnLength"],
  ["humour", "humour"],
  ["disfluency", "disfluency"],
  ["formality", "formality"],
  ["custom", "custom"],
] as const satisfies ReadonlyArray<readonly [string, keyof VoiceDeliveryV1]>;

function decodeVoicePatchV1(input: unknown): BotVoicePatchV1 {
  const value = fields(input, [
    "name",
    ...VOICE_DIAL_FIELDS.map(([toolKey]) => toolKey),
  ]);
  if (Object.keys(value).length === 0) {
    throw new Error("voice needs at least one field to change");
  }
  const delivery: Record<string, string> = {};
  for (const [toolKey, deliveryKey] of VOICE_DIAL_FIELDS) {
    const field = value[toolKey];
    if (field === undefined) continue;
    if (typeof field !== "string")
      throw new Error(`${toolKey} must be a string`);
    delivery[deliveryKey] = field;
  }
  return {
    ...(value.name === undefined
      ? {}
      : (() => {
          if (typeof value.name !== "string") {
            throw new Error("name must be a string");
          }
          return { voiceName: value.name };
        })()),
    delivery: delivery as VoiceDeliveryV1,
  };
}

/**
 * The voice the Bot would have after this patch. The empty string clears a
 * dial, which is the only way a partial update can say "stop doing that"; the
 * decoder then refuses anything the tables do not hold.
 */
export function mergeVoicePatchV1(
  current: BotVoiceAppearanceV1,
  patch: BotVoicePatchV1,
): BotVoiceAppearanceV1 {
  const delivery: Record<string, unknown> = { ...current.delivery };
  for (const [, deliveryKey] of VOICE_DIAL_FIELDS) {
    const field = patch.delivery[deliveryKey];
    if (field === undefined) continue;
    if (field === "") delete delivery[deliveryKey];
    else delivery[deliveryKey] = field;
  }
  return decodeBotVoiceForFlockV1({
    schemaVersion: 1,
    voiceName: patch.voiceName ?? current.voiceName,
    delivery,
  });
}

export function decodeBotUpdateInputV1(input: unknown): BotUpdateInputV1 {
  const value = fields(input, [
    "name",
    "description",
    "title",
    "hidden_from_sidebar",
    "notify_on_updates",
    "voice",
  ]);
  if (Object.keys(value).length === 0) {
    throw new Error("bot_update needs at least one field to change");
  }
  const profile: BotProfilePatchV1 = {};
  if (value.name !== undefined) {
    // The name is the one field a partial update may not blank.
    const name = patchText(value.name, "name", 100);
    if (!name) throw new Error("name must not be empty");
    profile.name = name;
  }
  if (value.description !== undefined) {
    profile.description = patchText(value.description, "description", 10_000);
  }
  if (value.title !== undefined) {
    profile.title = patchText(value.title, "title", 120);
  }
  if (value.hidden_from_sidebar !== undefined) {
    profile.hiddenFromSidebar = boolean(
      value.hidden_from_sidebar,
      "hidden_from_sidebar",
    );
  }
  return {
    profile,
    ...(value.notify_on_updates === undefined
      ? {}
      : {
          notifyOnUpdates: boolean(
            value.notify_on_updates,
            "notify_on_updates",
          ),
        }),
    ...(value.voice === undefined
      ? {}
      : { voice: decodeVoicePatchV1(value.voice) }),
  };
}

export function decodeBotCreateInputV1(input: unknown): BotCreateInputV1 {
  const value = fields(input, ["name", "description"]);
  const name = patchText(value.name, "name", 100);
  if (!name) throw new Error("name must not be empty");
  return {
    name,
    ...(value.description === undefined
      ? {}
      : {
          description: (() => {
            const description = patchText(
              value.description,
              "description",
              10_000,
            );
            if (!description) {
              throw new Error("description must not be empty");
            }
            return description;
          })(),
        }),
  };
}

export function decodeBotMessageInputV1(input: unknown): BotMessageInputV1 {
  const value = fields(input, ["target_id", "message"]);
  if (!isFlockIdentifier(value.target_id)) {
    throw new Error("target_id is invalid");
  }
  const message = patchText(value.message, "message", 32_000);
  if (!message) throw new Error("message must not be empty");
  return { targetId: value.target_id, message };
}

function flockAdmissionCeilingV1(
  capabilityId: string,
): readonly TurnTypeV1[] | undefined {
  return packageAdmissionCeilingV1(flockDefinitionV1, capabilityId);
}

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

/** Two profiles are the same durable record when their fields all match. */
function sameProfile(left: BotProfile, right: BotProfile): boolean {
  return (
    JSON.stringify(canonicalProfile(left)) ===
    JSON.stringify(canonicalProfile(right))
  );
}

function canonicalProfile(profile: BotProfile): unknown[] {
  return [
    profile.name,
    profile.description ?? null,
    profile.title ?? null,
    profile.namedBy ?? null,
    profile.hiddenFromSidebar === true,
  ];
}

const sha256HexV1 = sha256HexTextV1;

/**
 * One durable tool-call occurrence, as a digest: the User, the calling Bot,
 * the run and the effect id. The run is there because effect ids restart in
 * every Session — a Bot's first Routine Turn and its first chat Turn both call
 * `tool:1:1:0` — and the Bot because run ids are unique only per Bot.
 */
function occurrenceDigestV1(
  owner: FlockSelfOwnerV1,
  runId: string,
  effectId: string,
): Promise<string> {
  return sha256HexV1(
    `${owner.userId}\u0000${owner.botId}\u0000${runId}\u0000${effectId}`,
  );
}

/**
 * The Bot id one `bot_create` occurrence asks for.
 *
 * Derived from the occurrence, so the same call always asks for the same id
 * and a replay after eviction collides with the Bot it already made instead of
 * registering another. The readable half is the requested name, exactly as the
 * sidebar's create does.
 */
export async function createdBotIdV1(
  owner: FlockSelfOwnerV1,
  runId: string,
  effectId: string,
  name: string,
): Promise<string> {
  const base =
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 80) || "bot";
  const digest = await occurrenceDigestV1(owner, runId, effectId);
  return `${base}-${digest.slice(0, 12)}`;
}

/**
 * The `bot/create` command id one occurrence sends, so a retry reuses one
 * receipt. The User Durable Object keys receipts by it across all its Bots.
 */
export async function botCreateCommandIdV1(
  owner: FlockSelfOwnerV1,
  runId: string,
  effectId: string,
): Promise<string> {
  const digest = await occurrenceDigestV1(owner, runId, effectId);
  return `bot-create-${digest.slice(0, 32)}`;
}

export function createBotUpdateTool(
  host: FlockSelfRuntimeHostV1,
): ToolDefinition {
  return {
    name: "bot_update",
    namespace: "frockbot",
    description:
      "Change your own name, description, title, sidebar visibility, update notifications, or how you sound on a voice call. Only the fields you pass change; everything else stays exactly as it is. Renaming yourself is announced in the conversation. This cannot archive or delete you — only your User can do that.",
    inputSchema: BOT_UPDATE_SCHEMA as unknown as Record<string, unknown>,
    // Re-running converges on the same durable record and commands nothing
    // once it already holds, so recovery may replay it.
    idempotent: true,
    validate: (input) => {
      try {
        decodeBotUpdateInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown) => {
      let decoded: BotUpdateInputV1;
      try {
        decoded = decodeBotUpdateInputV1(input);
      } catch (error) {
        return refusal(
          `bot_update was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const changed: string[] = [];
      try {
        let settings = await host.readSelf();
        const target = applyBotProfilePatchV1(
          settings.profile,
          decoded.profile,
          "bot",
        );
        // Refused before anything is written, so the call is not half applied.
        if (target.hiddenFromSidebar === true && decoded.notifyOnUpdates) {
          return refusal(
            "bot_update was refused: a Bot hidden from the sidebar can't have notifications on. Pass hidden_from_sidebar: false to turn them back on.",
          );
        }
        const wasNotifying = settings.notifications.enabled;
        if (!sameProfile(settings.profile, target)) {
          const renamed = target.name !== settings.profile.name;
          settings = await applySelfProfileV1(host, settings, decoded.profile);
          for (const [patchKey, toolKey] of PROFILE_FIELD_NAMES) {
            if (decoded.profile[patchKey] === undefined) continue;
            if (patchKey === "name" && !renamed) continue;
            changed.push(toolKey);
          }
          // Hiding mutes in the same write; the report says so.
          if (wasNotifying && !settings.notifications.enabled) {
            changed.push("notify_on_updates");
          }
        }
        if (
          decoded.notifyOnUpdates !== undefined &&
          decoded.notifyOnUpdates !== settings.notifications.enabled
        ) {
          await applyWithRevisionV1(host, settings, (revision) => ({
            schemaVersion: 1,
            type: "bot/update-notifications",
            commandId: crypto.randomUUID(),
            expectedRevision: revision,
            botId: host.owner.botId,
            notifications: { enabled: decoded.notifyOnUpdates! },
          }));
          changed.push("notify_on_updates");
        }
        if (decoded.voice && (await applySelfVoiceV1(host, decoded.voice))) {
          changed.push("voice");
        }
      } catch (error) {
        return refusal(
          `bot_update failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (changed.length === 0) {
        return {
          content:
            "Nothing changed: your profile already holds every value you asked for.",
          isError: false,
        };
      }
      return {
        content: `Updated ${changed.join(", ")}. Everything else is unchanged.`,
        isError: false,
      };
    },
  };
}

/**
 * Issues one Bot-scoped command, re-reading the revision when an unrelated
 * write wins the race. The receipt is the authority for the outcome: a
 * rejection is a refusal, not a thrown error.
 */
async function applyWithRevisionV1(
  host: FlockSelfRuntimeHostV1,
  settings: BotSettingsViewV1,
  build: (
    revision: number,
  ) => Extract<ConfigurationCommandV1, { botId: string }>,
): Promise<BotSettingsViewV1> {
  let current = settings;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const receipt = await host.commandSelf(build(current.revision));
      if (receipt.status === "rejected") {
        throw new Error(receipt.failure ?? "the command was rejected");
      }
      return host.readSelf();
    } catch (error) {
      const conflict =
        error instanceof ConfigurationConflictError ||
        (typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "ConfigurationConflictError");
      if (!conflict || attempt >= REVISION_RETRIES) throw error;
      current = await host.readSelf();
    }
  }
}

/**
 * The voice half of `bot_update`. Answers whether anything changed, so a
 * replay that asks for the voice the Bot already has reports nothing.
 *
 * The record is fenced on its own revision, so a losing race is re-read and
 * re-issued rather than failing the whole call.
 */
async function applySelfVoiceV1(
  host: FlockSelfRuntimeHostV1,
  patch: BotVoicePatchV1,
): Promise<boolean> {
  for (let attempt = 0; ; attempt += 1) {
    const record = await host.readOwnVoice();
    const current = resolveBotVoiceV1({
      ...(record.voice ? { chosen: record.voice } : {}),
      ...(record.characterId ? { characterId: record.characterId } : {}),
    });
    const next = mergeVoicePatchV1(current, patch);
    if (record.voice && canonicalJson(record.voice) === canonicalJson(next)) {
      return false;
    }
    try {
      const receipt = await host.updateOwnVoice({
        schemaVersion: 1,
        type: "bot/update-voice",
        commandId: crypto.randomUUID(),
        expectedRevision: record.revision,
        botId: host.owner.botId,
        voice: next,
      });
      if (receipt.status === "rejected") {
        throw new Error(receipt.failure ?? "the command was rejected");
      }
      return true;
    } catch (error) {
      const conflict =
        error instanceof FlockConflictError ||
        (typeof error === "object" &&
          error !== null &&
          "name" in error &&
          error.name === "FlockConflictError");
      if (!conflict || attempt >= REVISION_RETRIES) throw error;
    }
  }
}

/** The profile half of `bot_update`, with its provenance attached. */
async function applySelfProfileV1(
  host: FlockSelfRuntimeHostV1,
  settings: BotSettingsViewV1,
  profile: BotProfilePatchV1,
): Promise<BotSettingsViewV1> {
  return applyWithRevisionV1(host, settings, (revision) => ({
    schemaVersion: 1,
    type: "bot/set-profile",
    commandId: crypto.randomUUID(),
    expectedRevision: revision,
    botId: host.owner.botId,
    // The provenance of a self-rename: `namedBy` says a Bot did it, and the
    // writer says which Bot, in which Session and Turn.
    namedBy: "bot",
    writer: host.writer,
    profile: structuredClone(profile),
  }));
}

export function createBotCreateTool(
  host: FlockSelfRuntimeHostV1,
  flock: TurnBotDirectoryV1,
  random?: () => number,
): ToolDefinition {
  return {
    name: "bot_create",
    namespace: "frockbot",
    description:
      "Create a new Bot in your User's flock, with a name and an optional description that becomes its profile. It starts with no capabilities of its own beyond what your User's own create gives a new Bot, and follows your User's default model. There is no matching delete: only your User can remove a Bot.",
    inputSchema: BOT_CREATE_SCHEMA as unknown as Record<string, unknown>,
    // The requested Bot id is derived from the occurrence, so a replay asks
    // for a Bot that already exists and reports it instead of making another.
    idempotent: true,
    validate: (input) => {
      try {
        decodeBotCreateInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: BotCreateInputV1;
      try {
        decoded = decodeBotCreateInputV1(input);
      } catch (error) {
        return refusal(
          `bot_create was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const botId = await createdBotIdV1(
        host.owner,
        host.runId,
        context.effectId,
        decoded.name,
      );
      const commandId = await botCreateCommandIdV1(
        host.owner,
        host.runId,
        context.effectId,
      );
      const avatar = randomAvatarAppearanceV1(random);
      try {
        for (let attempt = 0; ; attempt += 1) {
          const directory = await host.listBots();
          // The occurrence-derived id is the fence. A replay of this exact
          // call finds the Bot it already registered and stops here.
          if (directory.bots.some((bot) => bot.botId === botId)) {
            return {
              content: `Bot "${decoded.name}" already exists as ${botId}; nothing was created a second time.`,
              isError: false,
            };
          }
          try {
            const receipt = await host.createBot({
              schemaVersion: 1,
              type: "bot/create",
              commandId,
              expectedRevision: directory.revision,
              botId,
              name: decoded.name,
              ...(decoded.description === undefined
                ? {}
                : { description: decoded.description }),
              createdBy: host.writer,
              avatar,
            });
            if (receipt.status === "rejected") {
              return refusal(
                `bot_create was rejected: ${receipt.failure ?? "the Flock refused it"}`,
              );
            }
            // The flock this Turn has already named in its prompt is now out
            // of date by exactly this Bot.
            flock.invalidate();
            return {
              content: `Created Bot "${decoded.name}" as ${botId}. It follows your User's default model and holds no capabilities of its own.`,
              isError: false,
            };
          } catch (error) {
            const conflict =
              error instanceof FlockConflictError ||
              (typeof error === "object" &&
                error !== null &&
                "name" in error &&
                error.name === "FlockConflictError");
            if (!conflict || attempt >= REVISION_RETRIES) throw error;
          }
        }
      } catch (error) {
        return refusal(
          `bot_create failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

export function createBotMessageTool(
  host: FlockSelfRuntimeHostV1,
): ToolDefinition {
  return {
    name: BOT_MESSAGE_TOOL_V1,
    namespace: "frockbot",
    description:
      "Ask one of your User's other Bots a question. Use a target_id from <teammates>. The other Bot runs an agent Turn and its reply is returned here as this tool result. Do not message yourself or fan out speculatively.",
    inputSchema: BOT_MESSAGE_SCHEMA as unknown as Record<string, unknown>,
    idempotent: true,
    validate: (input) => {
      try {
        decodeBotMessageInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: BotMessageInputV1;
      try {
        decoded = decodeBotMessageInputV1(input);
      } catch (error) {
        return refusal(
          `bot_message was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (decoded.targetId === host.owner.botId) {
        return refusal("bot_message was refused: a Bot cannot message itself");
      }
      try {
        const outcome = await host.messageBot({
          targetBotId: decoded.targetId,
          message: decoded.message,
          effectId: context.effectId,
        });
        return { content: outcome.text, isError: false };
      } catch (error) {
        return refusal(
          `bot_message failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    },
  };
}

/**
 * `bot_message` inside a Group Chat Turn: for a Bot outside the group only.
 * Its run id folds in this Turn's run, because the occurrence id is numbered
 * within the group's Session and would otherwise repeat one from the Bot's
 * own chat.
 */
export function createGroupBotMessageTool(
  host: FlockSelfRuntimeHostV1 & {
    groupChat: NonNullable<FlockSelfRuntimeHostV1["groupChat"]>;
  },
): ToolDefinition {
  const base = createBotMessageTool(host);
  return {
    ...base,
    description:
      "Ask one of your User's Bots who is not in this group chat a question. Use a target_id from <teammates>. Its reply is returned here as this tool result, and the group sees that you asked. Ask a member of this group in the thread with an @mention instead.",
    execute: async (input: unknown, context: ToolExecutionContext) => {
      const target = (input as { target_id?: unknown } | null)?.target_id;
      if (
        host.groupChat.origin.members.some((member) => member.botId === target)
      ) {
        return refusal(
          "bot_message was refused: that Bot is in this group. Ask it in the thread with an @mention.",
        );
      }
      return base.execute(input, {
        ...context,
        effectId: `${host.groupChat.runId}:${context.effectId}`,
      });
    },
  };
}

function promptText(value: string): string {
  return value.replace(/[<>]/g, (character) =>
    character === "<" ? "&lt;" : "&gt;",
  );
}

/**
 * One Turn's reading of the Bot directory, for the sections that only need to
 * name the flock.
 *
 * `listBots` is a cross-Durable-Object call to the User object, and the
 * teammates section rendered it on every step's prompt assembly - the same
 * answer, fetched again, against an object that is single-threaded and shared
 * by every Bot this User owns.
 *
 * It is a Turn-scoped memo and not a cache: the runtime Contribution this
 * lives in is built once per admitted Turn. `bot_create` invalidates it, so a
 * Bot made mid-Turn is named in the next step's prompt rather than after the
 * Turn ends. Fencing reads - `bot_create`'s own revision check - never go
 * through it.
 */
export interface TurnBotDirectoryV1 {
  read(): Promise<BotDirectoryViewV1>;
  invalidate(): void;
}

export function createTurnBotDirectoryV1(
  host: FlockSelfRuntimeHostV1,
): TurnBotDirectoryV1 {
  let pending: Promise<BotDirectoryViewV1> | undefined;
  return {
    read: () =>
      (pending ??= host.listBots().catch((error: unknown) => {
        pending = undefined;
        throw error;
      })),
    invalidate: () => {
      pending = undefined;
    },
  };
}

export function createTeammatesPromptSectionV1(
  host: FlockSelfRuntimeHostV1,
  directory: TurnBotDirectoryV1,
): PromptSection {
  return {
    id: TEAMMATES_PROMPT_SECTION_V1,
    order: 92,
    render: async (context) => {
      const group = host.groupChat;
      if (context.turnType !== "chat" && !group) return "";
      const view = await directory.read();
      // In a group, only the Bots outside it: a member is asked in the thread.
      const teammates = view.bots.filter(
        (bot) =>
          bot.botId !== host.owner.botId &&
          !group?.origin.members.some((member) => member.botId === bot.botId),
      );
      if (teammates.length === 0) return "";
      const lines = teammates.map((bot) => {
        const description = bot.initialDescription?.trim();
        return `- ${promptText(bot.botId)}: ${promptText(bot.initialName)}${
          description ? ` — ${promptText(description)}` : ""
        }`;
      });
      return [
        "<teammates>",
        "These are the other Bots owned by your User. Use bot_message only when another Bot's perspective or specialty is materially useful.",
        ...lines,
        "</teammates>",
      ].join("\n");
    },
  };
}

export function createInboundAgentPromptSectionV1(
  host: FlockSelfRuntimeHostV1,
): PromptSection {
  return {
    id: INBOUND_AGENT_PROMPT_SECTION_V1,
    order: 93,
    render: (context) => {
      const inbound = host.inboundAgent;
      if (context.turnType !== "agent" || !inbound) return "";
      if (inbound.kind === "voice") {
        // Two addressees on one Turn, so the prompt has to name both: the
        // answer goes back to the caller, anything else is conversation.
        return `The person asked you the current question out loud, through the account's voice assistant. Answer it with a single \`${REPLY_TO_REQUEST_TOOL_V1}\` call: that answer goes back to the voice session and is read out to them, and it ends this Turn. It is spoken, so keep it short and speakable — a few sentences, no markdown, no lists, no code. Say it once: do not also write the answer, or a version of it, into this conversation with \`send_to_user\`. A send here is for two things only — a brief progress note when the work will take more than a minute, and material that cannot be spoken, such as a link, a table or code, which you then point to in the spoken answer. Do not finish this Turn with \`send_to_user\`; the person is waiting to hear an answer, and a send is not one.`;
      }
      // The same two addressees as voice: the answer goes back to the Bot
      // that asked, and a send is a message to the person, not an answer.
      return `Bot ${promptText(inbound.fromBotName)} (${promptText(inbound.fromBotId)}) asked you the current question. Answer it with a single \`${REPLY_TO_REQUEST_TOOL_V1}\` call: that answer is returned to the asking Bot as its tool result, and it ends this Turn. Make it complete and direct — it is the whole of what the other Bot receives. Do not also write the answer into this conversation with \`send_to_user\`: a send here is for your User, and only when they should hear about this directly. Do not finish this Turn with \`send_to_user\`; the other Bot is waiting on an answer, and a send is not one.`;
    },
  };
}

export const GROUP_CHAT_PROMPT_SECTION_V1 = "flock-group-chat";

/** Where a group Turn is, and how talking there works. */
export function createGroupChatPromptSectionV1(
  host: FlockSelfRuntimeHostV1,
): PromptSection {
  return {
    id: GROUP_CHAT_PROMPT_SECTION_V1,
    order: 93,
    render: () =>
      host.groupChat
        ? groupTurnPromptV1(host.groupChat.origin, host.groupChat.botId)
        : "",
  };
}

/**
 * The runtime Contribution. The two self-management tools remain work tools
 * on every turn type. `bot_message` is separately bounded to chat by the
 * manifest so an inbound agent Turn cannot recursively fan out.
 */
export function createFlockRuntimeFeature(
  host: FlockSelfRuntimeHostV1,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => {
    const messagingCeiling = flockAdmissionCeilingV1(
      BOT_MESSAGING_CAPABILITY_V1,
    );
    const groupMessagingCeiling = flockAdmissionCeilingV1(
      GROUP_BOT_MESSAGING_CAPABILITY_V1,
    );
    const handoffCeiling = subagentHandoffAdmissionCeilingV1();
    const turnDirectory = createTurnBotDirectoryV1(host);
    const disposers = [
      runtime.systemPrompt.register(
        createTeammatesPromptSectionV1(host, turnDirectory),
      ),
      runtime.systemPrompt.register(createInboundAgentPromptSectionV1(host)),
      runtime.systemPrompt.register(createGroupChatPromptSectionV1(host)),
      // Mounted only on a Turn that actually has a caller to answer, and
      // bound to that caller here rather than read from an argument. The
      // Shell owns the delivery; Flock provides the caller identity.
      ...(host.inboundAgent
        ? [
            runtime.tools.register(
              createReplyToRequestToolV1(
                host.inboundAgent.kind,
                runtime.sessions,
              ),
            ),
          ]
        : []),
      runtime.tools.register(createBotUpdateTool(host)),
      runtime.tools.register(createBotCreateTool(host, turnDirectory)),
      ...(host.groupChat
        ? [
            runtime.tools.register(
              createGroupBotMessageTool({ ...host, groupChat: host.groupChat }),
              groupMessagingCeiling
                ? { admissionCeiling: groupMessagingCeiling }
                : undefined,
            ),
          ]
        : [
            runtime.tools.register(
              createBotMessageTool(host),
              messagingCeiling
                ? { admissionCeiling: messagingCeiling }
                : undefined,
            ),
          ]),
      // Offered wherever the host bound the seam, and bounded by the manifest
      // to the conversation: a hand-off runs on the agent lane and must not be
      // handed the tool that put it there.
      ...(host.subagent
        ? [
            runtime.tools.register(
              createSubagentTool(host.subagent),
              handoffCeiling ? { admissionCeiling: handoffCeiling } : undefined,
            ),
          ]
        : []),
    ];
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
}

export default createFlockRuntimeFeature;
