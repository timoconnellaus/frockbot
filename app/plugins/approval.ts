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
//  1. **`approvalId` is derived from the Turn's durable occurrence.** One
//     identity for the decision and the occurrence, so a replayed settlement
//     addresses the same intent and never applies it twice.
//  2. **Written before the send.** The record is durable before the card the
//     User sees exists, so there is no window in which somebody could approve
//     something nothing describes.
//  3. **Settled inside the transaction, applied after it.** The decision is
//     recorded in the transaction that records the approval; the generation
//     proposal — a cross-object call — runs after the commit, and is
//     idempotent on what the Composition already holds.
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  SEND_TO_USER_LIMITS_V1,
  pluginCardToolNameV1,
} from "@frockbot/core/contracts";
import type { CompositionMemberV1 } from "@frockbot/core/durable";
import {
  pluginModelProviderDisplayNameV1,
  pluginServedProviderV1,
} from "@frockbot/providers/catalog/definition";
import { deploymentPluginArtifactHashV1 } from "./catalog.js";
import { decodeCompositionMemberV1 } from "@frockbot/core/durable";

export const PLUGIN_INTENT_PREFIX = "plugin:intent:";

export function pluginIntentKeyV1(approvalId: string): string {
  return `${PLUGIN_INTENT_PREFIX}${approvalId}`;
}

/**
 * The approval id one durable occurrence maps to: the run and the Turn's
 * `effectId`. The run is there because effect ids restart in every Session and
 * the intent is keyed across all of this Bot's Sessions. A digest, because an
 * approval id may carry only letters, digits, dot, underscore and dash: it
 * becomes a URL path segment and a durable storage key.
 */
export async function pluginApprovalIdV1(
  runId: string,
  effectId: string,
): Promise<string> {
  const digest = await sha256HexTextV1(`${runId}\u0000${effectId}`);
  return `plugin-${digest.slice(0, 32)}`;
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

/**
 * What applying an approved intent came to. Only an application it survived
 * is recorded: a proposal that threw leaves no outcome, so the approval stays
 * one a retry could still apply rather than a decision closed as failed.
 */
export type PluginIntentOutcomeV1 = {
  status: "applied";
  generationId?: string;
  at: string;
};

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
 *
 * A descriptor may legally name sixty-four tools and thirty-two hosts, so the
 * sentence is held inside the bound the send payload is decoded against: a
 * card longer than that would be a Turn nobody could settle and an approval
 * nobody could answer.
 */
export function pluginApprovalActionV1(
  member: Pick<CompositionMemberV1, "descriptor"> &
    Partial<Pick<CompositionMemberV1, "artifact" | "packageId">>,
  verb: "Run" | "Turn on",
): string {
  const descriptor = member.descriptor;
  const packageId = member.packageId ?? descriptor.id;
  const parts: string[] = [
    `${verb} the Plugin "${descriptor.displayName}" (${descriptor.id}, version ${descriptor.version}) on this Bot.`,
  ];
  // A card is a tool the registry offers under the same name, so the sentence
  // names it: a Plugin whose whole Bot-facing surface is cards would otherwise
  // read as offering nothing at all.
  const offered = [
    ...descriptor.tools.map((tool) => tool.name),
    ...(descriptor.cards ?? []).map((card) =>
      pluginCardToolNameV1(descriptor.id, card.id),
    ),
  ];
  parts.push(
    offered.length === 0
      ? "It offers no tools."
      : `It offers ${offered.join(", ")}.`,
  );
  if (descriptor.hooks.length > 0) {
    parts.push(`It wraps ${descriptor.hooks.join(", ")}.`);
    if (descriptor.hooks.includes("theme/assemble")) {
      parts.push("This Plugin can change how this Bot looks.");
    }
  }
  // A model provider contribution runs when a Bot's model names it, which is
  // not the switch this card asks about — so the card says what it serves and
  // what choosing it means.
  for (const provider of descriptor.modelProviders ?? []) {
    // Whether this Plugin is the one the deployment serves the provider
    // through is the deployment's answer, not the descriptor's: a claim is
    // credential-backed only when this exact Plugin, at the deployment's own
    // artifact, is the one the provider catalog names for it.
    const served = pluginServedProviderV1(provider.id);
    const trusted =
      served !== undefined &&
      served.pluginId === packageId &&
      member.artifact !== undefined &&
      deploymentPluginArtifactHashV1(packageId) === member.artifact.contentHash;
    parts.push(
      trusted
        ? `It provides ${pluginModelProviderDisplayNameV1(provider.id)} models. Choosing one in Models runs it; the deployment sends the request with the Connection's credential attached, and the key never reaches the Plugin.`
        : `It declares the ${provider.id} model provider this deployment does not serve through this Plugin, so it carries no credential and choosing ${provider.id} does not run it.`,
    );
  }
  if (descriptor.grants.length > 0) {
    parts.push(`It is granted ${descriptor.grants.join(", ")}.`);
  }
  // `http` opens two members, not one: the declared hosts and the deployment's
  // own sender. Both are said, because a Plugin that can ask this deployment
  // to mail somebody must never read as reaching nothing.
  const sendsEmail = descriptor.grants.includes("http");
  if (descriptor.network) {
    if ("open" in descriptor.network) {
      parts.push(
        "It reaches the whole network, which means every Plugin on this account can.",
      );
    } else if (descriptor.network.hosts.length > 0) {
      parts.push(`It reaches ${descriptor.network.hosts.join(", ")}.`);
    } else if (!sendsEmail) {
      parts.push("It reaches no host of its own.");
    }
  }
  if (sendsEmail) {
    parts.push(
      "It can ask this deployment to send email on the Bot's behalf, which a person approves message by message.",
    );
  }
  const action = parts.join(" ");
  const limit = SEND_TO_USER_LIMITS_V1.action;
  return action.length <= limit ? action : `${action.slice(0, limit - 1)}…`;
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
