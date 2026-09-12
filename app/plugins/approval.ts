// The Bot Durable Object's half of a Plugin approval (ADR 0026): intent,
// recorded before anybody is asked.
//
// `plugin_publish` and `plugin_enable` do not make a Plugin run. Each writes
// one of these, asks the User for an approval with a card on the Turn's own
// durable log, and answers the Bot. The Plugin reaches the User's Composition
// and this Bot's enable map only when a person approves, and it is *this*
// record the settlement reads to know what they approved — the pending-input
// preamble carries only an `approvalId` and a decision.
//
// Three properties, the same three the machine command's intent rests on:
//
//  1. **`approvalId` is the Turn's `effectId`, mapped.** One identity for the
//     decision and the Turn's durable occurrence, so a replayed settlement
//     addresses the same intent and never applies it twice.
//  2. **Written before the send.** The record is durable before the card the
//     User sees exists, so there is no window in which somebody could approve
//     something nothing describes.
//  3. **Settled inside the transaction, applied after it.** The decision is
//     recorded in the transaction that records the approval; the generation
//     proposal — a cross-object call — runs after the commit, and is
//     idempotent on what the Composition already holds.
import type { CompositionMemberV1 } from "@frockbot/core/durable";
import { decodeCompositionMemberV1 } from "@frockbot/core/durable";

export const PLUGIN_INTENT_PREFIX = "plugin:intent:";

export function pluginIntentKeyV1(approvalId: string): string {
  return `${PLUGIN_INTENT_PREFIX}${approvalId}`;
}

/**
 * The approval id one Turn's `effectId` maps to. `effectId` is
 * `tool:<turn>:<step>:<ordinal>`, and an approval id may not carry a colon:
 * it becomes a URL path segment and a durable storage key. The mapping is
 * total, deterministic and injective over that format.
 */
export function pluginApprovalIdV1(effectId: string): string {
  const mapped = effectId.replace(/[^a-zA-Z0-9._-]/g, ".");
  return /^[a-zA-Z0-9]/.test(mapped) ? mapped : `p${mapped}`;
}

export type PluginIntentDecisionV1 = "approved" | "denied" | "expired";

/** What the User is asked to allow. */
export type PluginIntentActionV1 =
  | {
      /** A built Plugin, stored, waiting to join the User's Composition. */
      kind: "publish";
      member: CompositionMemberV1;
    }
  | {
      /** A Plugin already in the Composition, not yet running on this Bot. */
      kind: "enable";
      pluginId: string;
    };

export type PluginIntentOutcomeV1 =
  | { status: "applied"; generationId?: string; at: string }
  | { status: "failed"; reason: string; at: string };

export interface PluginIntentRecordV1 {
  schemaVersion: 1;
  approvalId: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  createdAt: string;
  action: PluginIntentActionV1;
  decision?: PluginIntentDecisionV1;
  decidedAt?: string;
  outcome?: PluginIntentOutcomeV1;
}

export class PluginIntentDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginIntentDecodeError";
  }
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_ID = 256;
const MAX_REASON = 1_024;

function record(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new PluginIntentDecodeError(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set([...required, ...optional]);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new PluginIntentDecodeError(
        `${label} has an unexpected key "${key}"`,
      );
    }
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      throw new PluginIntentDecodeError(`${label} is missing "${key}"`);
    }
  }
}

function text(value: unknown, maximum: number, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new PluginIntentDecodeError(`${label} must be a non-empty string`);
  }
  if (value.length > maximum) {
    throw new PluginIntentDecodeError(`${label} exceeds ${maximum} characters`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const stamp = text(value, 64, label);
  if (Number.isNaN(Date.parse(stamp))) {
    throw new PluginIntentDecodeError(`${label} is not a timestamp`);
  }
  return stamp;
}

function decodeAction(input: unknown, label: string): PluginIntentActionV1 {
  const value = record(input, label);
  if (value.kind === "publish") {
    exactKeys(value, ["kind", "member"], [], label);
    let member: CompositionMemberV1;
    try {
      member = decodeCompositionMemberV1(value.member, `${label}.member`);
    } catch (error) {
      throw new PluginIntentDecodeError(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (member.provenance.kind !== "bot") {
      throw new PluginIntentDecodeError(`${label}.member must be Bot-authored`);
    }
    return { kind: "publish", member };
  }
  if (value.kind === "enable") {
    exactKeys(value, ["kind", "pluginId"], [], label);
    const pluginId = text(value.pluginId, 64, `${label}.pluginId`);
    if (!PLUGIN_ID.test(pluginId)) {
      throw new PluginIntentDecodeError(`${label}.pluginId is invalid`);
    }
    return { kind: "enable", pluginId };
  }
  throw new PluginIntentDecodeError(`${label}.kind is invalid`);
}

function decodeOutcome(input: unknown, label: string): PluginIntentOutcomeV1 {
  const value = record(input, label);
  if (value.status === "applied") {
    exactKeys(value, ["status", "at"], ["generationId"], label);
    return {
      status: "applied",
      at: timestamp(value.at, `${label}.at`),
      ...(value.generationId === undefined
        ? {}
        : {
            generationId: text(
              value.generationId,
              MAX_ID,
              `${label}.generationId`,
            ),
          }),
    };
  }
  if (value.status === "failed") {
    exactKeys(value, ["status", "reason", "at"], [], label);
    return {
      status: "failed",
      reason: text(value.reason, MAX_REASON, `${label}.reason`),
      at: timestamp(value.at, `${label}.at`),
    };
  }
  throw new PluginIntentDecodeError(`${label}.status is invalid`);
}

export function decodePluginIntentRecordV1(
  input: unknown,
  label = "plugin intent",
): PluginIntentRecordV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "approvalId",
      "botId",
      "sessionId",
      "runId",
      "turnId",
      "createdAt",
      "action",
    ],
    ["decision", "decidedAt", "outcome"],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new PluginIntentDecodeError(`${label} schemaVersion is unsupported`);
  }
  if (
    value.decision !== undefined &&
    value.decision !== "approved" &&
    value.decision !== "denied" &&
    value.decision !== "expired"
  ) {
    throw new PluginIntentDecodeError(`${label} decision is invalid`);
  }
  return {
    schemaVersion: 1,
    approvalId: text(value.approvalId, MAX_ID, `${label}.approvalId`),
    botId: text(value.botId, MAX_ID, `${label}.botId`),
    sessionId: text(value.sessionId, MAX_ID + 1, `${label}.sessionId`),
    runId: text(value.runId, MAX_ID, `${label}.runId`),
    turnId: text(value.turnId, MAX_ID, `${label}.turnId`),
    createdAt: timestamp(value.createdAt, `${label}.createdAt`),
    action: decodeAction(value.action, `${label}.action`),
    ...(value.decision === undefined
      ? {}
      : { decision: value.decision as PluginIntentDecisionV1 }),
    ...(value.decidedAt === undefined
      ? {}
      : { decidedAt: timestamp(value.decidedAt, `${label}.decidedAt`) }),
    ...(value.outcome === undefined
      ? {}
      : { outcome: decodeOutcome(value.outcome, `${label}.outcome`) }),
  };
}

/** The storage seam a settlement needs: a transaction, or the object's own. */
export interface PluginIntentStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
}

/**
 * Record what a decision means for the Plugin intent it authorized, in the
 * transaction that records the decision itself. Answers `undefined` when the
 * approval was not a Plugin's — the common case — so the caller can treat
 * "not ours" and "nothing to do" identically. A record this module cannot
 * read is left exactly as it is, for the same reason.
 */
export async function settlePluginIntentV1(
  transaction: PluginIntentStorageV1,
  approvalId: string,
  decision: PluginIntentDecisionV1,
  at: string,
): Promise<PluginIntentRecordV1 | undefined> {
  const key = pluginIntentKeyV1(approvalId);
  const stored = await transaction.get<unknown>(key);
  if (stored === undefined) return undefined;
  let intent: PluginIntentRecordV1;
  try {
    intent = decodePluginIntentRecordV1(stored, "stored plugin intent");
  } catch (error) {
    if (error instanceof PluginIntentDecodeError) return undefined;
    throw error;
  }
  // First decision wins. A replayed settlement reads the one already made.
  if (intent.decision !== undefined) return intent;
  const settled: PluginIntentRecordV1 = { ...intent, decision, decidedAt: at };
  await transaction.put(key, settled);
  return settled;
}

/** Record what applying an approved intent came to. Never before a decision. */
export async function recordPluginIntentOutcomeV1(
  storage: PluginIntentStorageV1,
  approvalId: string,
  outcome: PluginIntentOutcomeV1,
): Promise<PluginIntentRecordV1 | undefined> {
  const key = pluginIntentKeyV1(approvalId);
  const stored = await storage.get<unknown>(key);
  if (stored === undefined) return undefined;
  const intent = decodePluginIntentRecordV1(stored, "stored plugin intent");
  if (intent.decision !== "approved" || intent.outcome !== undefined) {
    return intent;
  }
  const settled: PluginIntentRecordV1 = { ...intent, outcome };
  await storage.put(key, settled);
  return settled;
}

/**
 * The card's wording: what the Plugin reaches, in the User's words, so the
 * decision is about what it does and not about a version number.
 */
export function pluginApprovalActionV1(
  member: Pick<CompositionMemberV1, "descriptor">,
  verb: "Run" | "Turn on",
): string {
  const descriptor = member.descriptor;
  const parts: string[] = [
    `${verb} the Plugin "${descriptor.displayName}" (${descriptor.id}, version ${descriptor.version}) on this Bot.`,
  ];
  parts.push(
    descriptor.tools.length === 0
      ? "It offers no tools."
      : `It offers ${descriptor.tools.map((tool) => tool.name).join(", ")}.`,
  );
  if (descriptor.hooks.length > 0) {
    parts.push(`It wraps ${descriptor.hooks.join(", ")}.`);
  }
  if (descriptor.grants.length > 0) {
    parts.push(`It is granted ${descriptor.grants.join(", ")}.`);
  }
  if (descriptor.network) {
    parts.push(
      "open" in descriptor.network
        ? "It reaches the whole network, which means every Plugin on this account can."
        : `It reaches ${descriptor.network.hosts.join(", ")}.`,
    );
  }
  return parts.join(" ");
}

/** Open network or a credentialed Connection is the User's whole account. */
export function pluginApprovalRiskV1(
  member: Pick<CompositionMemberV1, "descriptor">,
): "low" | "medium" | "high" {
  const descriptor = member.descriptor;
  if (descriptor.network && "open" in descriptor.network) return "high";
  if (descriptor.grants.includes("http")) return "high";
  if (descriptor.hooks.length > 0) return "medium";
  return "low";
}
