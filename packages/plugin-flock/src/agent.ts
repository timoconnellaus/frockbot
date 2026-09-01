// The Flock runtime Contribution: a Bot's own self-management tools.
//
// GrokBot exposes two of these and no more (§2.12): `UpdateAgent`, where only
// the fields the call carries change, and `CreateAgent`, which makes a new
// agent in the same user's flock. **There is no delete tool** — deletion is a
// user-only action — and this Package matches that: `bot_update` cannot
// archive, restore, or remove anything, and no third tool exists to do it.
//
// AUTHORITY. "Self-modification never widens authority." Both tools run
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
import {
  applyBotProfilePatchV1,
  ConfigurationConflictError,
  type BotProfile,
  type BotProfilePatchV1,
  type BotSelfWriterV1,
  type BotSettingsViewV1,
  type ConfigurationCommandV1,
  type OperationReceiptV1,
} from "@frockbot/configuration-core";
import type {
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";
import {
  FlockConflictError,
  randomSheepRecipeV1,
  type BotDirectoryViewV1,
  type CreateBotCommandV1,
  type FlockReceiptV1,
} from "./shared.js";
export type {
  BotDirectoryViewV1,
  CreateBotCommandV1,
  FlockReceiptV1,
} from "./shared.js";
export type { BotSelfWriterV1 } from "@frockbot/configuration-core";

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
 * Every method is a command the User's own surfaces already issue. This
 * Package holds no authority: the Bot Durable Object owns the profile, the
 * User Durable Object owns the Flock directory, and neither is reachable from
 * here except through these four calls.
 */
export interface FlockSelfRuntimeHostV1 {
  owner: FlockSelfOwnerV1;
  /** The provenance every write this Turn records. */
  writer: BotSelfWriterV1;
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
}

/** How many times a command is re-issued after losing an optimistic race. */
const REVISION_RETRIES = 3;

/** The patch field each `bot_update` argument writes, in report order. */
const PROFILE_FIELD_NAMES = [
  ["name", "name"],
  ["description", "description"],
  ["title", "title"],
  ["hiddenFromSidebar", "hidden_from_sidebar"],
] as const satisfies ReadonlyArray<readonly [keyof BotProfilePatchV1, string]>;

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
        "Hide yourself from the default sidebar list. You stay reachable and nothing is archived or deleted.",
    },
    notify_on_updates: {
      type: "boolean",
      description: "Whether your User is notified when you have news.",
    },
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

interface BotUpdateInputV1 {
  profile: BotProfilePatchV1;
  notifyOnUpdates?: boolean;
}

interface BotCreateInputV1 {
  name: string;
  description?: string;
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

export function decodeBotUpdateInputV1(input: unknown): BotUpdateInputV1 {
  const value = fields(input, [
    "name",
    "description",
    "title",
    "hidden_from_sidebar",
    "notify_on_updates",
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
    profile.label ?? null,
    profile.description ?? null,
    profile.title ?? null,
    profile.namedBy ?? null,
    profile.hiddenFromSidebar === true,
  ];
}

async function sha256HexV1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The Bot id one `bot_create` occurrence asks for.
 *
 * Derived from the User, the calling Bot and the durable tool-call occurrence,
 * so the same call always asks for the same id and a replay after eviction
 * collides with the Bot it already made instead of registering another. The
 * readable half is the requested name, exactly as the sidebar's create does.
 */
export async function createdBotIdV1(
  owner: FlockSelfOwnerV1,
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
  const digest = await sha256HexV1(`${owner.userId} ${owner.botId} ${effectId}`);
  return `${base}-${digest.slice(0, 12)}`;
}

/** A `commandId` derived from the occurrence, so a retry reuses one receipt. */
function occurrenceCommandIdV1(prefix: string, effectId: string): string {
  return `${prefix}-${effectId.replace(/[^a-zA-Z0-9._-]/g, "-")}`;
}

export function createBotUpdateTool(
  host: FlockSelfRuntimeHostV1,
): ToolDefinition {
  return {
    name: "bot_update",
    description:
      "Change your own name, description, title, sidebar visibility, or update notifications. Only the fields you pass change; everything else stays exactly as it is. Renaming yourself is announced in the conversation. This cannot archive or delete you — only your User can do that.",
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
        if (!sameProfile(settings.profile, target)) {
          const renamed = target.name !== settings.profile.name;
          settings = await applySelfProfileV1(host, settings, decoded.profile);
          for (const [patchKey, toolKey] of PROFILE_FIELD_NAMES) {
            if (decoded.profile[patchKey] === undefined) continue;
            if (patchKey === "name" && !renamed) continue;
            changed.push(toolKey);
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
  random?: () => number,
): ToolDefinition {
  return {
    name: "bot_create",
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
        context.effectId,
        decoded.name,
      );
      const sheep = randomSheepRecipeV1(random);
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
              commandId: occurrenceCommandIdV1("bot-create", context.effectId),
              expectedRevision: directory.revision,
              botId,
              name: decoded.name,
              ...(decoded.description === undefined
                ? {}
                : { description: decoded.description }),
              createdBy: host.writer,
              sheep,
            });
            if (receipt.status === "rejected") {
              return refusal(
                `bot_create was rejected: ${receipt.failure ?? "the Flock refused it"}`,
              );
            }
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

/**
 * The runtime Contribution. Registers the two self-management tools; both are
 * work tools, offered on every turn type, because an automation or a subagent
 * Turn is as entitled to correct its own title as a chat Turn is.
 */
export function createFlockRuntimePlugin(
  host: FlockSelfRuntimeHostV1,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const disposers = [
      ctx.tools.register(createBotUpdateTool(host)),
      ctx.tools.register(createBotCreateTool(host)),
    ];
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
  plugin.inject = ["tools"];
  return plugin;
}

export default createFlockRuntimePlugin;
