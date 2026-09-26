// The Plugin worker boundary: every DTO that crosses between a Bot's Durable
// Object and the one Dynamic Worker that holds every Plugin its User installed.
//
// The worker is layer two (ADR 0026). The loop stays in the Durable Object and
// calls the worker once per open hook per Turn with the Bot's enabled list;
// the worker's generated index fans out to the enabled Plugins in order and
// answers with one patch. A Plugin that throws is skipped and named in the
// answer, so the Durable Object can count it toward quarantine without the
// Turn failing.
//
// Everything decoded here is untrusted: Plugin code produces the results and
// the health report.
import { canonicalJson, sha256 } from "./canonical-json.js";
import {
  decodeIsolateContractVersionV1,
  decodeIsolateHealthV1,
  decodeIsolateHookInvocationV1,
  decodeIsolateHookResultV1,
  decodeIsolateToolInvocationV1,
  ISOLATE_MAX_DEADLINE_MS,
  type IsolateContractVersion,
  type IsolateHealthV1,
  type IsolateHookInvocationV1,
  type IsolateHookResultV1,
  type IsolateToolDescriptorV1,
  type IsolateToolInvocationV1,
  type IsolateToolResultV1,
} from "./isolate.js";
import type { BotIsolateHookEventNameV1 } from "./loop-events.js";
import {
  servedPluginContractVersionsV1,
  type PluginServiceV1,
} from "./plugin-descriptor.js";
import { PLUGIN_CARD_ACTION_NAME_PATTERN_V1 } from "./plugin-card-contract.js";
import type {
  PluginModelInvocationV1,
  PluginWorkerModelResultV1,
} from "./plugin-model.js";
import { exactKeysV1, recordV1 } from "./records.js";

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const PLUGIN_TRIGGER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** The `Identifier` a `ViewDocument.surfaceId` is, as the descriptor bounds it. */
const PLUGIN_SURFACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
/** Views one Plugin may export, matching the descriptor's bound. */
const MAX_PLUGIN_VIEWS_V1 = 16;
/** Cards one Plugin may export, matching the descriptor's bound. */
const MAX_PLUGIN_CARDS_V1 = 16;
/** Model providers one Plugin may serve, matching the descriptor's bound. */
const MAX_PLUGIN_MODEL_PROVIDERS_V1 = 4;
/** A model provider type: the id a model binding names. */
const PLUGIN_PROVIDER_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** A card id, as the descriptor bounds it. */
const PLUGIN_CARD_ID = /^[a-z][a-z0-9_]{0,31}$/;
/** A card action name, as the descriptor bounds it. */
const PLUGIN_CARD_ACTION_NAME = new RegExp(PLUGIN_CARD_ACTION_NAME_PATTERN_V1);
/** Actions one card may declare, matching the descriptor's bound. */
const MAX_PLUGIN_CARD_ACTIONS_V1 = 16;
/** A rendered view, serialized. A card, not a page. */
export const MAX_PLUGIN_VIEW_DOCUMENT_BYTES_V1 = 256_000;
const MAX_PLUGINS_V1 = 64;
export const MAX_FAILURE_REASON_V1 = 1_024;
const MAX_TRIGGER_HEADERS_V1 = 64;
const UTF8 = new TextEncoder();
const MAX_TRIGGER_HEADER_BYTES_V1 = 8_192;
export const MAX_TRIGGER_BODY_BYTES_V1 = 1_000_000;

/** One Plugin's artifact and identity in the worker's module set. */
export interface PluginWorkerMemberV1 {
  pluginId: string;
  contentHash: string;
  /** The grants `env.IDENTITY` carries for this Plugin. */
  grants: readonly string[];
  /** The service names `env.IDENTITY` carries for this Plugin. */
  consumes: readonly string[];
}

/**
 * The module-set hash the loader id is derived from. A reused loader id
 * silently serves the first code and `env`, so it covers everything the load
 * depends on: the contract the wrapper speaks, the generated index's own
 * version, every artifact by content in mount order, each Plugin's grants and
 * consumed services as `env.IDENTITY` carries them, and the digest of the
 * bindings baked into `env`. Mount order is part of the load: the index
 * imports and `IDENTITY.plugins` follow it, and it decides which Plugin
 * provides a service to which and how the hook chain runs. A deploy that
 * changes none of these leaves every User's worker where it is.
 */
export async function pluginWorkerModuleSetHashV1(input: {
  contractVersion: IsolateContractVersion;
  indexVersion: string;
  members: readonly PluginWorkerMemberV1[];
  bindingDigest: string;
}): Promise<string> {
  const members = input.members.map((member) => ({
    pluginId: boundedString(member.pluginId, "plugin worker member id", 64),
    contentHash: hex(member.contentHash, "plugin worker member hash"),
    grants: canonicalNames(member.grants, "plugin worker member grants"),
    consumes: canonicalNames(member.consumes, "plugin worker member consumes"),
  }));
  if (
    new Set(members.map((member) => member.pluginId)).size !== members.length
  ) {
    throw new Error("plugin worker members contain duplicate ids");
  }
  return sha256(
    canonicalJson({
      contractVersion: input.contractVersion,
      indexVersion: boundedString(
        input.indexVersion,
        "plugin worker index version",
        64,
      ),
      members,
      bindingDigest: hex(input.bindingDigest, "plugin worker binding digest"),
    }),
  );
}

/** A member's declared names, ordered so only the set itself moves the hash. */
function canonicalNames(values: readonly string[], label: string): string[] {
  if (!Array.isArray(values) || values.length > 64) {
    throw new Error(`${label} must be a bounded array`);
  }
  return values
    .map((value, index) => boundedString(value, `${label}[${index}]`, 64))
    .toSorted();
}

export function pluginWorkerLoaderIdV1(input: {
  userId: string;
  moduleSetHash: string;
}): string {
  const userId = boundedString(input.userId, "plugin worker userId", 256);
  if (/[:\s]/.test(userId)) {
    throw new Error("plugin worker loader id components are invalid");
  }
  return `plugin-worker:${userId}:${hex(input.moduleSetHash, "plugin worker module set hash")}`;
}

/** What one Plugin reported at mount, as the wrapper saw it. */
export interface PluginWorkerPluginHealthV1 {
  pluginId: string;
  ok: boolean;
  /** Present exactly when `ok` is false. */
  reason?: string;
  tools: IsolateToolDescriptorV1[];
  hooks: BotIsolateHookEventNameV1[];
  provides: PluginServiceV1[];
  consumes: PluginServiceV1[];
  triggers: string[];
  /**
   * The model providers the module serves, by id; the descriptor's
   * `modelProviders` must match, name for name.
   */
  modelProviders: string[];
  /** The surfaces the module renders, by id; the descriptor's `views` must match. */
  views: string[];
  /**
   * The cards the module draws and the actions each one owns; the descriptor's
   * `cards` must match, name for name. A press names no card — the namespace
   * is `plugin/<pluginId>/<action>` — so which card owns an action is what
   * says whose handler a press reaches, and it is checked here rather than
   * assumed.
   */
  cards: PluginWorkerCardHealthV1[];
}

/** One card a module declared, with the actions it owns. */
export interface PluginWorkerCardHealthV1 {
  id: string;
  actions: string[];
}

export interface PluginWorkerHealthV1 {
  schemaVersion: 1;
  contractVersion: IsolateContractVersion;
  plugins: PluginWorkerPluginHealthV1[];
}

/** A hook invocation carries the Bot's enabled list; the index skips the rest. */
export interface PluginWorkerHookInvocationV1<
  Event extends BotIsolateHookEventNameV1 = BotIsolateHookEventNameV1,
> extends IsolateHookInvocationV1<Event> {
  enabled: string[];
}

/** One Plugin the index skipped during a hook or a mount. */
export interface PluginWorkerFailureV1 {
  pluginId: string;
  reason: string;
}

export type PluginWorkerHookResultV1 = IsolateHookResultV1 & {
  failures: PluginWorkerFailureV1[];
};

export interface PluginWorkerToolInvocationV1 extends IsolateToolInvocationV1 {
  pluginId: string;
  /**
   * The Turn's tool call this runs as, which a device call is keyed by.
   * Absent for a tool run outside any Turn, such as a section's control.
   */
  effectId?: string;
}

/** An event arriving on the app-owned hooks route, handed to one Plugin. */
export interface PluginWorkerTriggerInvocationV1 {
  schemaVersion: 1;
  pluginId: string;
  trigger: string;
  headers: Record<string, string>;
  body: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  routineId: string;
  deadlineMs: number;
}

export type PluginWorkerTriggerResultV1 =
  | { schemaVersion: 1; status: "drop"; reason?: string }
  | { schemaVersion: 1; status: "fire"; text: string };

/**
 * One slot render (ADR 0026 step 9): the Plugin returns a `ViewDocument` for
 * a surface it declared, and the host renders it with the host's own widgets.
 * Outside a Turn, so the identity is the page's, shaped like a Turn's.
 */
export interface PluginWorkerViewInvocationV1 {
  schemaVersion: 1;
  pluginId: string;
  surfaceId: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  deadlineMs: number;
}

/**
 * The prefix every surface of one Plugin's one card carries. A plugin id holds
 * no `_` and neither id holds a `.`, so the pair a prefix names is the only
 * pair that could have written it — which is what makes it something to check
 * a surface id against on the draw and on the press alike. At most 98
 * characters, leaving the uniqueness room inside the 128 the Card seam bounds
 * a surface id to.
 */
export function cardSurfacePrefixV1(pluginId: string, cardId: string): string {
  return `${pluginId}_${cardId}.`;
}

/**
 * The Plugin a minted surface id names, or `undefined` for a surface no card
 * draw minted. A Bot-drawn surface has no prefix and so belongs to no Plugin,
 * which is what stops one Plugin's handler being handed another's card.
 */
export function cardSurfacePluginIdV1(surfaceId: string): string | undefined {
  const separator = surfaceId.indexOf("_");
  const dot = surfaceId.indexOf(".");
  if (separator <= 0 || dot <= separator + 1) return undefined;
  return surfaceId.slice(0, separator);
}

/**
 * The card a minted surface id names, or `undefined` for a surface no card
 * draw minted. It is what tells a handler which of its Plugin's cards it was
 * pressed on, and what the pressed action's declared owner is checked against.
 */
export function cardSurfaceCardIdV1(surfaceId: string): string | undefined {
  const separator = surfaceId.indexOf("_");
  const dot = surfaceId.indexOf(".");
  if (separator <= 0 || dot <= separator + 1) return undefined;
  return surfaceId.slice(separator + 1, dot);
}

/**
 * One Card action routed to a Plugin (ADR 0030): the renderer's
 * `plugin/<pluginId>/<action>` reaching the handler that wrote the Card. The
 * surface's data model travels with it when the surface asked for it, so a
 * handler answers about the card as the person actually saw it.
 */
export interface PluginWorkerCardActionInvocationV1 {
  schemaVersion: 1;
  pluginId: string;
  /** The card the pressed surface was minted for; see `cardSurfaceCardIdV1`. */
  cardId: string;
  surfaceId: string;
  /** The `<action>` half of the name; the namespace is the kernel's. */
  action: string;
  context?: Record<string, unknown>;
  dataModel?: Record<string, unknown>;
  /**
   * The Card's stored data model as the kernel holds it, which is what the
   * surface is actually made of rather than what a client sent back. A handler
   * reads the state of its own card from here instead of keeping a second copy
   * of it keyed by surface id.
   */
  record?: Record<string, unknown>;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  deadlineMs: number;
}

/**
 * The handler's answer: A2UI messages the kernel folds into the Card, carried
 * opaque and bounded, or a drop with its reason. A handler that throws or
 * overruns is a drop, and the Card is left exactly as it was.
 *
 * `deliberate` tells a well-formed refusal apart from a failure. The wrapper
 * sets it only when the handler itself answered `{ drop: true }`, so a throw,
 * a deadline overrun, an unreachable worker and an undecodable answer stay
 * charged to the Plugin's health while a handler saying "not on this card"
 * costs it nothing.
 *
 * `input` is the one thing a handler may say to the Bot rather than to the
 * card: a line the kernel enqueues as the next user-lane Turn's pending
 * input, the way a conversation action on a Card is. A handler that only
 * redraws the surface costs no Turn, which is the point of the route.
 */
export type PluginWorkerCardActionResultV1 =
  | {
      schemaVersion: 1;
      status: "drop";
      reason?: string;
      deliberate?: true;
    }
  | {
      schemaVersion: 1;
      status: "rendered";
      messages: Record<string, unknown>[];
      input?: string;
    };

/**
 * One Card a Plugin draws from the values the Bot sent (ADR 0030). The
 * surface id is the kernel's — minted when the Bot named none — so a Plugin
 * can never draw over a surface it was not handed, and `data` has already
 * been validated against the card's declared `dataSchema`.
 */
export interface PluginWorkerRenderCardInvocationV1 {
  schemaVersion: 1;
  pluginId: string;
  /** The `id` of one of the Plugin's declared cards. */
  cardId: string;
  surfaceId: string;
  data: Record<string, unknown>;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  deadlineMs: number;
}

/**
 * What `renderCard` answers with: the same two shapes a Card action answers
 * with, for the same reason. The messages are carried opaque and decoded as
 * A2UI where the Card's own budgets are, and anything else is a refusal the
 * Bot reads in the tool result.
 *
 * `covers` is what the Plugin says this draw is *about*: the canonical values
 * a decision on this card would authorize, stated by the Plugin that drew
 * them rather than read off the tool input the model sent. A Plugin that does
 * not draw its input verbatim — the email card redraws the draft it is
 * holding — would otherwise have the kernel bind a decision to values the
 * person never saw. A draw that asks for a decision and declares none of
 * these is refused at the seam.
 *
 * `deliberate` means the same here as it does on a press: a draw that refused
 * in as many words costs the Plugin's health nothing, while a throw, an
 * overrun, an unreachable worker and an answer the kernel could not read are
 * all charged toward quarantine.
 */
export type PluginWorkerRenderCardResultV1 =
  | { schemaVersion: 1; status: "drop"; reason?: string; deliberate?: true }
  | {
      schemaVersion: 1;
      status: "rendered";
      messages: Record<string, unknown>[];
      covers?: Record<string, unknown>;
      decision?: PluginCardDecisionV1;
    };

/**
 * What the decision a draw asks for is recorded as: the words a person is
 * asked, how much it costs to get wrong, and why when the words do not say.
 *
 * They are stated beside `covers` rather than on the `ApprovalActions`
 * component because the Frock catalog allows that component an `approvalId`
 * and its two labels and nothing else — the host draws the labels, and the
 * Approval is recorded with these. A draw that puts an `ApprovalActions` on
 * the card and states none of this is refused at the seam, exactly as one
 * that declares no `covers` is.
 */
export interface PluginCardDecisionV1 {
  action: string;
  risk: "low" | "medium" | "high";
  rationale?: string;
}

/**
 * What a person left in a card's fields when they approved it, put back to
 * the Plugin that drew the card before the decision is recorded.
 *
 * A card whose surface asks for its data model can be edited — a draft's
 * recipients, its subject, its body — and the person's Send is then a
 * decision about the edited values, not about the ones the card was drawn
 * with. The kernel cannot say what the edit means: only the Plugin knows how
 * its fields become what it acts on, so it is asked to restate what the
 * decision now covers.
 */
export interface PluginWorkerReviseCardInvocationV1 {
  schemaVersion: 1;
  pluginId: string;
  /** The card the decided surface was minted for; see `cardSurfaceCardIdV1`. */
  cardId: string;
  surfaceId: string;
  /** The data model as the client held it when the person pressed. */
  dataModel: Record<string, unknown>;
  /** The Card's data model as the kernel stores it. */
  record: Record<string, unknown>;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  deadlineMs: number;
}

/**
 * The Plugin's restatement of a decided card.
 *
 * `revised` is the decision's new subject: the `covers` the Approval is bound
 * to from now on, the words it is recorded with, and optionally the messages
 * that settle the card's face onto the values it now covers — which, like a
 * press's, may not carry trust chrome. `unchanged` is a card that takes no
 * edits: its decision covers what it was drawn with, whatever the fields say.
 * A drop refuses the edit, and nothing is decided.
 */
export type PluginWorkerReviseCardResultV1 =
  | { schemaVersion: 1; status: "drop"; reason?: string; deliberate?: true }
  | { schemaVersion: 1; status: "unchanged" }
  | {
      schemaVersion: 1;
      status: "revised";
      covers: Record<string, unknown>;
      decision: PluginCardDecisionV1;
      messages?: Record<string, unknown>[];
    };

/** The bounds a decision's words are held to, matching a `send_to_user` approval. */
export const MAX_PLUGIN_CARD_DECISION_ACTION_V1 = 2_000;
export const MAX_PLUGIN_CARD_DECISION_RATIONALE_V1 = 8_000;

/** The document is carried opaque and bounded; the host decodes it as a `ViewDocument`. */
export type PluginWorkerViewResultV1 =
  | { schemaVersion: 1; status: "drop"; reason?: string }
  | { schemaVersion: 1; status: "rendered"; document: Record<string, unknown> };

/**
 * The wrapper `WorkerEntrypoint` the kernel generates over the index. Plugin
 * code never implements this; each Plugin exports `tools`, `execute`, and
 * optionally `hooks`, `provides` and `triggers`, and the index adapts.
 */
export interface PluginWorkerEntrypoint {
  health(): Promise<PluginWorkerHealthV1>;
  hook(
    invocation: PluginWorkerHookInvocationV1,
  ): Promise<PluginWorkerHookResultV1>;
  execute(
    invocation: PluginWorkerToolInvocationV1,
  ): Promise<IsolateToolResultV1>;
  /** One model call served by this Plugin's provider contribution (ADR 0032). */
  streamModel(
    invocation: PluginModelInvocationV1,
  ): Promise<PluginWorkerModelResultV1>;
  receiveTrigger(
    invocation: PluginWorkerTriggerInvocationV1,
  ): Promise<PluginWorkerTriggerResultV1>;
  view(
    invocation: PluginWorkerViewInvocationV1,
  ): Promise<PluginWorkerViewResultV1>;
  cardAction(
    invocation: PluginWorkerCardActionInvocationV1,
  ): Promise<PluginWorkerCardActionResultV1>;
  renderCard(
    invocation: PluginWorkerRenderCardInvocationV1,
  ): Promise<PluginWorkerRenderCardResultV1>;
  reviseCard(
    invocation: PluginWorkerReviseCardInvocationV1,
  ): Promise<PluginWorkerReviseCardResultV1>;
}

function record(value: unknown, label: string): Record<string, unknown> {
  return recordV1(value, label);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  exactKeysV1(value, required, optional, label);
}

/**
 * UTF-8 byte length. A trigger's headers and body arrive from the network as
 * bytes, so the bounds they are held to are counted in bytes, not in the
 * UTF-16 code units a JavaScript string reports.
 */
export function pluginWorkerUtf8LengthV1(value: string): number {
  return UTF8.encode(value).length;
}

/**
 * A string held to a bound counted in UTF-8 bytes. A byte is never shorter
 * than a code unit, so the cheap code-unit check rejects first and the encoder
 * only runs on a string that already fits.
 */
function boundedBytes(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  const text = boundedString(value, label, maximum, allowEmpty);
  if (pluginWorkerUtf8LengthV1(text) > maximum) {
    throw new Error(`${label} must be a bounded string`);
  }
  return text;
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function hex(value: unknown, label: string): string {
  const text = boundedString(value, label, 128);
  if (!/^[0-9a-f]+$/.test(text)) throw new Error(`${label} must be hex`);
  return text;
}

function pluginId(value: unknown, label: string): string {
  const id = boundedString(value, label, 64);
  if (!PLUGIN_ID.test(id)) throw new Error(`${label} is invalid`);
  return id;
}

function pluginIds(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > MAX_PLUGINS_V1) {
    throw new Error(`${label} must be a bounded array`);
  }
  const ids = value.map((entry, index) =>
    pluginId(entry, `${label}[${index}]`),
  );
  if (new Set(ids).size !== ids.length) {
    throw new Error(`${label} contains duplicates`);
  }
  return ids;
}

function decodeServices(value: unknown, label: string): PluginServiceV1[] {
  if (!Array.isArray(value) || value.length > 32) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const service = record(entry, itemLabel);
    exactKeys(service, ["name", "version"], itemLabel);
    const name = boundedString(service.name, `${itemLabel}.name`, 64);
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(name)) {
      throw new Error(`${itemLabel}.name is invalid`);
    }
    if (
      !Number.isSafeInteger(service.version) ||
      (service.version as number) < 1
    ) {
      throw new Error(`${itemLabel}.version must be a positive integer`);
    }
    return { name, version: service.version as number };
  });
}

function decodeFailures(
  value: unknown,
  label: string,
): PluginWorkerFailureV1[] {
  if (!Array.isArray(value) || value.length > MAX_PLUGINS_V1) {
    throw new Error(`${label} must be a bounded array`);
  }
  return value.map((entry, index) => {
    const itemLabel = `${label}[${index}]`;
    const failure = record(entry, itemLabel);
    exactKeys(failure, ["pluginId", "reason"], itemLabel);
    return {
      pluginId: pluginId(failure.pluginId, `${itemLabel}.pluginId`),
      reason: boundedString(
        failure.reason,
        `${itemLabel}.reason`,
        MAX_FAILURE_REASON_V1,
      ),
    };
  });
}

export function decodePluginWorkerHealthV1(
  input: unknown,
  label = "plugin worker health",
): PluginWorkerHealthV1 {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", "contractVersion", "plugins"], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (!Array.isArray(value.plugins) || value.plugins.length > MAX_PLUGINS_V1) {
    throw new Error(`${label}.plugins must be a bounded array`);
  }
  const contractVersion = decodeIsolateContractVersionV1(
    value.contractVersion,
    label,
  );
  if (!servedPluginContractVersionsV1().includes(contractVersion)) {
    throw new Error(`${label}.contractVersion is no longer served`);
  }
  // A report entry is decoded on its own so a single Plugin that reports
  // something out of bounds fails only itself: it becomes a not-ok entry
  // carrying the decode error, which the host charges to that Plugin at
  // `health` while its siblings still mount. An entry too broken to even name
  // a Plugin is dropped, and every Plugin that expected it is then missing
  // from the report, which the host also reports one Plugin at a time.
  const plugins: PluginWorkerPluginHealthV1[] = [];
  for (const [index, entry] of value.plugins.entries()) {
    const itemLabel = `${label}.plugins[${index}]`;
    try {
      plugins.push(
        decodePluginHealthEntryV1(entry, contractVersion, itemLabel),
      );
    } catch (error) {
      const named = entryPluginId(entry);
      if (named !== undefined) {
        plugins.push({
          pluginId: named,
          ok: false,
          reason: failureReason(error),
          tools: [],
          hooks: [],
          provides: [],
          consumes: [],
          triggers: [],
          modelProviders: [],
          views: [],
          cards: [],
        });
      }
    }
  }
  if (
    new Set(plugins.map((plugin) => plugin.pluginId)).size !== plugins.length
  ) {
    throw new Error(`${label}.plugins contains duplicate ids`);
  }
  return { schemaVersion: 1, contractVersion, plugins };
}

/** The Plugin an entry names, when the entry names one decodably. */
function entryPluginId(entry: unknown): string | undefined {
  try {
    return pluginId(
      (entry as { pluginId?: unknown }).pluginId,
      "plugin worker health plugin id",
    );
  } catch {
    return undefined;
  }
}

function failureReason(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(
    0,
    MAX_FAILURE_REASON_V1,
  );
}

function decodePluginHealthEntryV1(
  entry: unknown,
  contractVersion: number,
  itemLabel: string,
): PluginWorkerPluginHealthV1 {
  const plugin = record(entry, itemLabel);
  exactKeys(
    plugin,
    [
      "pluginId",
      "ok",
      "tools",
      "hooks",
      "provides",
      "consumes",
      "triggers",
      "modelProviders",
      "views",
      "cards",
    ],
    itemLabel,
    ["reason"],
  );
  if (typeof plugin.ok !== "boolean") {
    throw new Error(`${itemLabel}.ok must be a boolean`);
  }
  if ((plugin.reason !== undefined) === plugin.ok) {
    throw new Error(`${itemLabel}.reason is present exactly when not ok`);
  }
  // The per-plugin tool and hook lists are the single-isolate health report's
  // shape, decoded by the decoder that already knows its bounds.
  const health: IsolateHealthV1 = decodeIsolateHealthV1(
    {
      schemaVersion: 1,
      ok: plugin.ok,
      packageId: plugin.pluginId,
      contractVersion,
      tools: plugin.tools,
      hooks: plugin.hooks,
    },
    itemLabel,
  );
  if (!Array.isArray(plugin.triggers) || plugin.triggers.length > 16) {
    throw new Error(`${itemLabel}.triggers must be a bounded array`);
  }
  const triggers = plugin.triggers.map((trigger, triggerIndex) => {
    const name = boundedString(
      trigger,
      `${itemLabel}.triggers[${triggerIndex}]`,
      64,
    );
    if (!PLUGIN_TRIGGER_NAME.test(name)) {
      throw new Error(`${itemLabel}.triggers[${triggerIndex}] is invalid`);
    }
    return name;
  });
  if (new Set(triggers).size !== triggers.length) {
    throw new Error(`${itemLabel}.triggers contains duplicates`);
  }
  if (
    !Array.isArray(plugin.modelProviders) ||
    plugin.modelProviders.length > MAX_PLUGIN_MODEL_PROVIDERS_V1
  ) {
    throw new Error(`${itemLabel}.modelProviders must be a bounded array`);
  }
  const modelProviders = plugin.modelProviders.map(
    (provider, providerIndex) => {
      const id = boundedString(
        provider,
        `${itemLabel}.modelProviders[${providerIndex}]`,
        64,
      );
      if (!PLUGIN_PROVIDER_ID.test(id)) {
        throw new Error(
          `${itemLabel}.modelProviders[${providerIndex}] is invalid`,
        );
      }
      return id;
    },
  );
  if (new Set(modelProviders).size !== modelProviders.length) {
    throw new Error(`${itemLabel}.modelProviders contains duplicates`);
  }
  if (
    !Array.isArray(plugin.views) ||
    plugin.views.length > MAX_PLUGIN_VIEWS_V1
  ) {
    throw new Error(`${itemLabel}.views must be a bounded array`);
  }
  const views = plugin.views.map((view, viewIndex) => {
    const surfaceId = boundedString(
      view,
      `${itemLabel}.views[${viewIndex}]`,
      128,
    );
    if (!PLUGIN_SURFACE_ID.test(surfaceId)) {
      throw new Error(`${itemLabel}.views[${viewIndex}] is invalid`);
    }
    return surfaceId;
  });
  if (new Set(views).size !== views.length) {
    throw new Error(`${itemLabel}.views contains duplicates`);
  }
  if (
    !Array.isArray(plugin.cards) ||
    plugin.cards.length > MAX_PLUGIN_CARDS_V1
  ) {
    throw new Error(`${itemLabel}.cards must be a bounded array`);
  }
  const cards = plugin.cards.map((card, cardIndex) => {
    const cardLabel = `${itemLabel}.cards[${cardIndex}]`;
    const entry = record(card, cardLabel);
    exactKeys(entry, ["id", "actions"], cardLabel);
    const cardId = boundedString(entry.id, `${cardLabel}.id`, 32);
    if (!PLUGIN_CARD_ID.test(cardId)) {
      throw new Error(`${cardLabel}.id is invalid`);
    }
    if (
      !Array.isArray(entry.actions) ||
      entry.actions.length > MAX_PLUGIN_CARD_ACTIONS_V1
    ) {
      throw new Error(`${cardLabel}.actions must be a bounded array`);
    }
    const actions = entry.actions.map((action, actionIndex) => {
      const name = boundedString(
        action,
        `${cardLabel}.actions[${actionIndex}]`,
        64,
      );
      if (!PLUGIN_CARD_ACTION_NAME.test(name)) {
        throw new Error(`${cardLabel}.actions[${actionIndex}] is invalid`);
      }
      return name;
    });
    if (new Set(actions).size !== actions.length) {
      throw new Error(`${cardLabel}.actions contains duplicates`);
    }
    return { id: cardId, actions };
  });
  if (new Set(cards.map((card) => card.id)).size !== cards.length) {
    throw new Error(`${itemLabel}.cards contains duplicates`);
  }
  return {
    views,
    cards,
    pluginId: pluginId(plugin.pluginId, `${itemLabel}.pluginId`),
    ok: plugin.ok,
    ...(plugin.reason === undefined
      ? {}
      : {
          reason: boundedString(
            plugin.reason,
            `${itemLabel}.reason`,
            MAX_FAILURE_REASON_V1,
          ),
        }),
    tools: health.tools,
    hooks: health.hooks ?? [],
    provides: decodeServices(plugin.provides, `${itemLabel}.provides`),
    consumes: decodeServices(plugin.consumes, `${itemLabel}.consumes`),
    triggers,
    modelProviders,
  };
}

export function decodePluginWorkerHookInvocationV1(
  input: unknown,
  label = "plugin worker hook invocation",
): PluginWorkerHookInvocationV1 {
  const value = record(input, label);
  if (!Object.hasOwn(value, "enabled")) {
    throw new Error(`${label} has invalid fields`);
  }
  const { enabled, ...rest } = value;
  return {
    ...decodeIsolateHookInvocationV1(rest, label),
    enabled: pluginIds(enabled, `${label}.enabled`),
  };
}

export function decodePluginWorkerHookResultV1(
  input: unknown,
  label = "plugin worker hook result",
): PluginWorkerHookResultV1 {
  const value = record(input, label);
  if (!Object.hasOwn(value, "failures")) {
    throw new Error(`${label} has invalid fields`);
  }
  const { failures, ...rest } = value;
  return {
    ...decodeIsolateHookResultV1(rest, label),
    failures: decodeFailures(failures, `${label}.failures`),
  };
}

export function decodePluginWorkerToolInvocationV1(
  input: unknown,
  label = "plugin worker tool invocation",
): PluginWorkerToolInvocationV1 {
  const value = record(input, label);
  if (!Object.hasOwn(value, "pluginId")) {
    throw new Error(`${label} has invalid fields`);
  }
  const { pluginId: id, effectId, ...rest } = value;
  if (
    effectId !== undefined &&
    (typeof effectId !== "string" ||
      effectId.length === 0 ||
      effectId.length > 512)
  ) {
    throw new Error(`${label}.effectId is invalid`);
  }
  return {
    ...decodeIsolateToolInvocationV1(rest, label),
    pluginId: pluginId(id, `${label}.pluginId`),
    ...(effectId === undefined ? {} : { effectId }),
  };
}

export function decodePluginWorkerTriggerInvocationV1(
  input: unknown,
  label = "plugin worker trigger invocation",
): PluginWorkerTriggerInvocationV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "pluginId",
      "trigger",
      "headers",
      "body",
      "botId",
      "sessionId",
      "runId",
      "turnId",
      "generationId",
      "routineId",
      "deadlineMs",
    ],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const trigger = boundedString(value.trigger, `${label}.trigger`, 64);
  if (!PLUGIN_TRIGGER_NAME.test(trigger)) {
    throw new Error(`${label}.trigger is invalid`);
  }
  const headerEntries = Object.entries(
    record(value.headers, `${label}.headers`),
  );
  if (headerEntries.length > MAX_TRIGGER_HEADERS_V1) {
    throw new Error(`${label}.headers exceeds its bound`);
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of headerEntries) {
    // Lowercased on the way in: the provider's casing is not a signal, and a
    // plugin comparing names should not have to guess.
    const lowered = boundedString(name, `${label}.headers`, 256).toLowerCase();
    if (Object.hasOwn(headers, lowered)) {
      throw new Error(`${label}.headers contains duplicate names`);
    }
    headers[lowered] = boundedBytes(
      headerValue,
      `${label}.headers.${name}`,
      MAX_TRIGGER_HEADER_BYTES_V1,
      true,
    );
  }
  const deadlineMs = value.deadlineMs;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    (deadlineMs as number) <= 0 ||
    (deadlineMs as number) > ISOLATE_MAX_DEADLINE_MS
  ) {
    throw new Error(`${label}.deadlineMs is out of range`);
  }
  return {
    schemaVersion: 1,
    pluginId: pluginId(value.pluginId, `${label}.pluginId`),
    trigger,
    headers,
    body: boundedBytes(
      value.body,
      `${label}.body`,
      MAX_TRIGGER_BODY_BYTES_V1,
      true,
    ),
    botId: boundedString(value.botId, `${label}.botId`, 256),
    sessionId: boundedString(value.sessionId, `${label}.sessionId`, 256),
    runId: boundedString(value.runId, `${label}.runId`, 256),
    turnId: boundedString(value.turnId, `${label}.turnId`, 256),
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      256,
    ),
    routineId: boundedString(value.routineId, `${label}.routineId`, 256),
    deadlineMs: deadlineMs as number,
  };
}

export function decodePluginWorkerTriggerResultV1(
  input: unknown,
  label = "plugin worker trigger result",
): PluginWorkerTriggerResultV1 {
  const value = record(input, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status === "drop") {
    exactKeys(value, ["schemaVersion", "status"], label, ["reason"]);
    return {
      schemaVersion: 1,
      status: "drop",
      ...(value.reason === undefined
        ? {}
        : {
            reason: boundedString(
              value.reason,
              `${label}.reason`,
              MAX_FAILURE_REASON_V1,
            ),
          }),
    };
  }
  exactKeys(value, ["schemaVersion", "status", "text"], label);
  if (value.status !== "fire") throw new Error(`${label}.status is invalid`);
  return {
    schemaVersion: 1,
    status: "fire",
    text: boundedBytes(value.text, `${label}.text`, MAX_TRIGGER_BODY_BYTES_V1),
  };
}

/** Messages one Card action may answer with, matching the send's own bound. */
export const MAX_PLUGIN_CARD_ACTION_MESSAGES_V1 = 16;
/** The handler's whole answer, serialized. A card, not a page. */
export const MAX_PLUGIN_CARD_ACTION_BYTES_V1 = 256_000;
/**
 * The line a handler may leave for the Bot's next Turn. The pending-input
 * record it becomes holds a card action's context to the same bound.
 */
export const MAX_PLUGIN_CARD_ACTION_INPUT_V1 = 4_000;
/** The values one draw declares its decision covers, serialized. */
export const MAX_PLUGIN_CARD_COVERS_BYTES_V1 = 256_000;

/**
 * The line a handler leaves for the Bot, held to what the pending-input
 * record reads back: trimmed, non-blank and inside the bound.
 */
function boundedLine(value: unknown, label: string, maximum: number): string {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a bounded string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maximum) {
    throw new Error(`${label} must be a bounded string`);
  }
  return trimmed;
}

export function decodePluginWorkerCardActionResultV1(
  input: unknown,
  label = "plugin worker card action result",
): PluginWorkerCardActionResultV1 {
  const value = record(input, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status === "drop") {
    exactKeys(value, ["schemaVersion", "status"], label, [
      "reason",
      "deliberate",
    ]);
    if (value.deliberate !== undefined && value.deliberate !== true) {
      throw new Error(`${label}.deliberate must be true`);
    }
    return {
      schemaVersion: 1,
      status: "drop",
      ...(value.reason === undefined
        ? {}
        : {
            reason: boundedString(
              value.reason,
              `${label}.reason`,
              MAX_FAILURE_REASON_V1,
            ),
          }),
      ...(value.deliberate === true ? { deliberate: true as const } : {}),
    };
  }
  exactKeys(value, ["schemaVersion", "status", "messages"], label, ["input"]);
  if (value.status !== "rendered") {
    throw new Error(`${label}.status is invalid`);
  }
  return {
    schemaVersion: 1,
    status: "rendered",
    messages: decodeCardMessagesV1(value.messages, label),
    ...(value.input === undefined
      ? {}
      : {
          input: boundedLine(
            value.input,
            `${label}.input`,
            MAX_PLUGIN_CARD_ACTION_INPUT_V1,
          ),
        }),
  };
}

/**
 * The A2UI messages either card call answers with, held to one bound. They
 * are carried opaque here and decoded as A2UI at the fold, which is where the
 * Card's own budgets are.
 */
function decodeCardMessagesV1(
  input: unknown,
  label: string,
): Record<string, unknown>[] {
  if (
    !Array.isArray(input) ||
    input.length === 0 ||
    input.length > MAX_PLUGIN_CARD_ACTION_MESSAGES_V1
  ) {
    throw new Error(
      `${label}.messages must hold 1 to ${MAX_PLUGIN_CARD_ACTION_MESSAGES_V1} entries`,
    );
  }
  const messages = input.map((message, index) =>
    record(message, `${label}.messages[${index}]`),
  );
  let serialized: string;
  try {
    serialized = JSON.stringify(messages);
  } catch {
    throw new Error(`${label}.messages is not JSON`);
  }
  if (
    new TextEncoder().encode(serialized).length >
    MAX_PLUGIN_CARD_ACTION_BYTES_V1
  ) {
    throw new Error(
      `${label}.messages exceeds ${MAX_PLUGIN_CARD_ACTION_BYTES_V1} bytes`,
    );
  }
  return JSON.parse(serialized) as Record<string, unknown>[];
}

export function decodePluginWorkerRenderCardResultV1(
  input: unknown,
  label = "plugin worker render card result",
): PluginWorkerRenderCardResultV1 {
  const value = record(input, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status === "drop") {
    exactKeys(value, ["schemaVersion", "status"], label, [
      "reason",
      "deliberate",
    ]);
    if (value.deliberate !== undefined && value.deliberate !== true) {
      throw new Error(`${label}.deliberate must be true`);
    }
    return {
      schemaVersion: 1,
      status: "drop",
      ...(value.reason === undefined
        ? {}
        : {
            reason: boundedString(
              value.reason,
              `${label}.reason`,
              MAX_FAILURE_REASON_V1,
            ),
          }),
      ...(value.deliberate === true ? { deliberate: true as const } : {}),
    };
  }
  exactKeys(value, ["schemaVersion", "status", "messages"], label, [
    "covers",
    "decision",
  ]);
  if (value.status !== "rendered") {
    throw new Error(`${label}.status is invalid`);
  }
  return {
    schemaVersion: 1,
    status: "rendered",
    messages: decodeCardMessagesV1(value.messages, label),
    ...(value.covers === undefined
      ? {}
      : { covers: decodeCardCoversV1(value.covers, label) }),
    ...(value.decision === undefined
      ? {}
      : { decision: decodeCardDecisionV1(value.decision, label) }),
  };
}

export function decodePluginWorkerReviseCardResultV1(
  input: unknown,
  label = "plugin worker revise card result",
): PluginWorkerReviseCardResultV1 {
  const value = record(input, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status === "drop") {
    exactKeys(value, ["schemaVersion", "status"], label, [
      "reason",
      "deliberate",
    ]);
    if (value.deliberate !== undefined && value.deliberate !== true) {
      throw new Error(`${label}.deliberate must be true`);
    }
    return {
      schemaVersion: 1,
      status: "drop",
      ...(value.reason === undefined
        ? {}
        : {
            reason: boundedString(
              value.reason,
              `${label}.reason`,
              MAX_FAILURE_REASON_V1,
            ),
          }),
      ...(value.deliberate === true ? { deliberate: true as const } : {}),
    };
  }
  if (value.status === "unchanged") {
    exactKeys(value, ["schemaVersion", "status"], label);
    return { schemaVersion: 1, status: "unchanged" };
  }
  exactKeys(value, ["schemaVersion", "status", "covers", "decision"], label, [
    "messages",
  ]);
  if (value.status !== "revised") {
    throw new Error(`${label}.status is invalid`);
  }
  return {
    schemaVersion: 1,
    status: "revised",
    covers: decodeCardCoversV1(value.covers, label),
    decision: decodeCardDecisionV1(value.decision, label),
    ...(value.messages === undefined
      ? {}
      : { messages: decodeCardMessagesV1(value.messages, label) }),
  };
}

/** The words one draw asks its decision in, held to the Approval's own bounds. */
function decodeCardDecisionV1(
  input: unknown,
  label: string,
): PluginCardDecisionV1 {
  const decision = record(input, `${label}.decision`);
  exactKeys(decision, ["action", "risk"], `${label}.decision`, ["rationale"]);
  if (
    decision.risk !== "low" &&
    decision.risk !== "medium" &&
    decision.risk !== "high"
  ) {
    throw new Error(`${label}.decision.risk must be low, medium or high`);
  }
  return {
    action: boundedString(
      decision.action,
      `${label}.decision.action`,
      MAX_PLUGIN_CARD_DECISION_ACTION_V1,
    ),
    risk: decision.risk,
    ...(decision.rationale === undefined
      ? {}
      : {
          rationale: boundedString(
            decision.rationale,
            `${label}.decision.rationale`,
            MAX_PLUGIN_CARD_DECISION_RATIONALE_V1,
          ),
        }),
  };
}

/**
 * The values one draw says its decision covers, held to the same bound the
 * card's own messages are and round-tripped through JSON, so what the kernel
 * digests is exactly what crossed the worker boundary.
 */
function decodeCardCoversV1(
  input: unknown,
  label: string,
): Record<string, unknown> {
  const covers = record(input, `${label}.covers`);
  let serialized: string;
  try {
    serialized = JSON.stringify(covers);
  } catch {
    throw new Error(`${label}.covers is not JSON`);
  }
  if (
    new TextEncoder().encode(serialized).length >
    MAX_PLUGIN_CARD_COVERS_BYTES_V1
  ) {
    throw new Error(
      `${label}.covers exceeds ${MAX_PLUGIN_CARD_COVERS_BYTES_V1} bytes`,
    );
  }
  return JSON.parse(serialized) as Record<string, unknown>;
}

export function decodePluginWorkerViewInvocationV1(
  input: unknown,
  label = "plugin worker view invocation",
): PluginWorkerViewInvocationV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "pluginId",
      "surfaceId",
      "botId",
      "sessionId",
      "runId",
      "turnId",
      "generationId",
      "deadlineMs",
    ],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const surfaceId = boundedString(value.surfaceId, `${label}.surfaceId`, 128);
  if (!PLUGIN_SURFACE_ID.test(surfaceId)) {
    throw new Error(`${label}.surfaceId is invalid`);
  }
  const deadlineMs = value.deadlineMs;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    (deadlineMs as number) <= 0 ||
    (deadlineMs as number) > ISOLATE_MAX_DEADLINE_MS
  ) {
    throw new Error(`${label}.deadlineMs is out of range`);
  }
  return {
    schemaVersion: 1,
    pluginId: pluginId(value.pluginId, `${label}.pluginId`),
    surfaceId,
    botId: boundedString(value.botId, `${label}.botId`, 256),
    sessionId: boundedString(value.sessionId, `${label}.sessionId`, 257),
    runId: boundedString(value.runId, `${label}.runId`, 128),
    turnId: boundedString(value.turnId, `${label}.turnId`, 128),
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      256,
    ),
    deadlineMs: deadlineMs as number,
  };
}

export function decodePluginWorkerViewResultV1(
  input: unknown,
  label = "plugin worker view result",
): PluginWorkerViewResultV1 {
  const value = record(input, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status === "drop") {
    exactKeys(value, ["schemaVersion", "status"], label, ["reason"]);
    return {
      schemaVersion: 1,
      status: "drop",
      ...(value.reason === undefined
        ? {}
        : {
            reason: boundedString(
              value.reason,
              `${label}.reason`,
              MAX_FAILURE_REASON_V1,
            ),
          }),
    };
  }
  exactKeys(value, ["schemaVersion", "status", "document"], label);
  if (value.status !== "rendered") {
    throw new Error(`${label}.status is invalid`);
  }
  const document = record(value.document, `${label}.document`);
  let serialized: string;
  try {
    serialized = JSON.stringify(document);
  } catch {
    throw new Error(`${label}.document is not JSON`);
  }
  if (
    new TextEncoder().encode(serialized).length >
    MAX_PLUGIN_VIEW_DOCUMENT_BYTES_V1
  ) {
    throw new Error(
      `${label}.document exceeds ${MAX_PLUGIN_VIEW_DOCUMENT_BYTES_V1} bytes`,
    );
  }
  return {
    schemaVersion: 1,
    status: "rendered",
    document: JSON.parse(serialized) as Record<string, unknown>,
  };
}
