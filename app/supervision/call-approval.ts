// The Approval a refused call waits on, bound to exactly that call.
//
// When call review refuses a call that reaches outside FrockBot, the person
// decides it on an approval card rather than in conversation. What they decide
// about is this record: the tool and the canonical arguments, and the digest
// of the two. Their "yes" is a fact code reads, never a sentence Jev has to
// re-read on the next Turn:
//
//  1. **Recorded before the card.** The intent is durable before the approval
//     send is on the Turn's log, so nobody can approve something nothing
//     describes.
//  2. **Found by digest.** The digest index names the latest decision asked
//     for one exact call, so a repeat of it goes to the card already drawn
//     rather than drawing another, and an approved decision is found when the
//     Bot makes the call again.
//  3. **Spent once.** An approved, unspent decision whose digest equals the
//     call's lets that call run without asking Jev, and is claimed in the same
//     transaction that checks it. Any other arguments are another digest and
//     need another decision.

import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  canonicalJson,
  CALL_APPROVAL_ID_PREFIX_V1,
  type SendToUserApprovalRiskV1,
} from "@frockbot/core/contracts";
import { approvalKeyV1, decodeApprovalRecordV1 } from "../shell/approvals.js";

export const CALL_APPROVAL_PREFIX = "supervision:call-approval:";
export const CALL_APPROVAL_DIGEST_PREFIX = "supervision:call-approval-digest:";
export const CALL_APPROVAL_USE_PREFIX = "supervision:call-approval-used:";

/**
 * The longest arguments a card binds. The person reads them on the card, and
 * the Bot repeats them exactly from its delivery Turn, so a call past this is
 * refused in words instead.
 */
export const CALL_APPROVAL_ARGUMENTS_MAX_V1 = 16_000;

/**
 * How long an approved call may wait to be made. The decision opens a Turn
 * that makes it at once; a day covers that Turn waiting behind others.
 */
export const CALL_APPROVAL_USE_WINDOW_MS_V1 = 24 * 60 * 60 * 1_000;

export function callApprovalKeyV1(approvalId: string): string {
  return `${CALL_APPROVAL_PREFIX}${approvalId}`;
}

export function callApprovalDigestKeyV1(digest: string): string {
  return `${CALL_APPROVAL_DIGEST_PREFIX}${digest}`;
}

export function callApprovalUseKeyV1(approvalId: string): string {
  return `${CALL_APPROVAL_USE_PREFIX}${approvalId}`;
}

/** The arguments as bound: canonical JSON, so key order is not a new call. */
export function callApprovalArgumentsV1(args: unknown): string {
  return canonicalJson(args ?? {});
}

/** What one exact call is: its tool and its canonical arguments. */
export async function callApprovalDigestV1(
  tool: string,
  args: unknown,
): Promise<string> {
  return sha256HexTextV1(`${tool}\u0000${callApprovalArgumentsV1(args)}`);
}

/**
 * The Approval one refused occurrence asks under: the run and the Session,
 * because effect ids restart in every Session and a Routine has its own, and
 * the occurrence, so a replay asks under the same id.
 */
export async function callApprovalIdV1(
  runId: string,
  sessionId: string,
  effectId: string,
): Promise<string> {
  const digest = await sha256HexTextV1(
    `${runId}\u0000${sessionId}\u0000${effectId}`,
  );
  return `${CALL_APPROVAL_ID_PREFIX_V1}${digest.slice(0, 32)}`;
}

/** The call an Approval covers, recorded before the card is drawn. */
export interface CallApprovalIntentV1 {
  schemaVersion: 1;
  approvalId: string;
  digest: string;
  tool: string;
  /** Canonical JSON of the exact arguments. */
  arguments: string;
  /** The Session whose Turn asked. */
  sessionId: string;
  createdAt: string;
}

export class CallApprovalDecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CallApprovalDecodeError";
  }
}

export function decodeCallApprovalIntentV1(
  value: unknown,
  label = "call approval intent",
): CallApprovalIntentV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CallApprovalDecodeError(`${label} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  const keys = [
    "schemaVersion",
    "approvalId",
    "digest",
    "tool",
    "arguments",
    "sessionId",
    "createdAt",
  ];
  for (const key of Object.keys(candidate)) {
    if (!keys.includes(key)) {
      throw new CallApprovalDecodeError(
        `${label} has an unexpected key "${key}"`,
      );
    }
  }
  if (candidate.schemaVersion !== 1) {
    throw new CallApprovalDecodeError(`${label} schemaVersion is unsupported`);
  }
  const text = (key: string, max: number): string => {
    const entry = candidate[key];
    if (typeof entry !== "string" || entry.length === 0 || entry.length > max) {
      throw new CallApprovalDecodeError(`${label}.${key} is invalid`);
    }
    return entry;
  };
  return {
    schemaVersion: 1,
    approvalId: text("approvalId", 128),
    digest: text("digest", 64),
    tool: text("tool", 512),
    arguments: text("arguments", CALL_APPROVAL_ARGUMENTS_MAX_V1),
    sessionId: text("sessionId", 512),
    createdAt: text("createdAt", 64),
  };
}

/**
 * Where the latest decision on one exact call stands.
 *
 * `asked` — the card is on a Turn's log that has not settled yet, so no
 * Approval record exists; `stale` — approved too long ago to be spent.
 */
export type CallApprovalStatusV1 =
  "asked" | "pending" | "approved" | "denied" | "expired" | "spent" | "stale";

export interface CallApprovalStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  transaction<T>(
    run: (transaction: {
      get<T>(key: string): Promise<T | undefined>;
      put(key: string, value: unknown): Promise<void>;
    }) => Promise<T>,
  ): Promise<T>;
}

/** The seam supervision reads and writes call approvals through. */
export interface CallApprovalsV1 {
  /** The latest decision asked for this exact call, and where it stands. */
  find(
    digest: string,
  ): Promise<{ approvalId: string; status: CallApprovalStatusV1 } | undefined>;
  /** Where one decision stands, or `undefined` when nothing was asked. */
  status(approvalId: string): Promise<CallApprovalStatusV1 | undefined>;
  /** Record what a card will ask, before the card is drawn. Idempotent. */
  ask(intent: CallApprovalIntentV1): Promise<void>;
  /**
   * Claim an approved decision for one occurrence. True when this occurrence
   * holds the claim — now, or already, on a replay of the same occurrence.
   */
  spend(approvalId: string, digest: string, effectId: string): Promise<boolean>;
}

async function statusOf(
  read: { get<T>(key: string): Promise<T | undefined> },
  approvalId: string,
  now: number,
): Promise<CallApprovalStatusV1 | undefined> {
  if ((await read.get<unknown>(callApprovalKeyV1(approvalId))) === undefined) {
    return undefined;
  }
  if (
    (await read.get<unknown>(callApprovalUseKeyV1(approvalId))) !== undefined
  ) {
    return "spent";
  }
  const stored = await read.get<unknown>(approvalKeyV1(approvalId));
  if (stored === undefined) return "asked";
  const approval = decodeApprovalRecordV1(stored);
  if (approval.decision !== "approved") return approval.decision;
  const decidedAt = Date.parse(approval.decidedAt ?? "");
  return Number.isNaN(decidedAt) ||
    now - decidedAt > CALL_APPROVAL_USE_WINDOW_MS_V1
    ? "stale"
    : "approved";
}

export function createCallApprovalStoreV1(
  storage: CallApprovalStorageV1,
  now: () => number = Date.now,
): CallApprovalsV1 {
  return {
    async find(digest) {
      const approvalId = await storage.get<string>(
        callApprovalDigestKeyV1(digest),
      );
      if (typeof approvalId !== "string") return undefined;
      const status = await statusOf(storage, approvalId, now());
      return status === undefined ? undefined : { approvalId, status };
    },
    status(approvalId) {
      return statusOf(storage, approvalId, now());
    },
    async ask(intent) {
      await storage.transaction(async (transaction) => {
        const key = callApprovalKeyV1(intent.approvalId);
        if ((await transaction.get<unknown>(key)) === undefined) {
          await transaction.put(key, intent);
        }
        await transaction.put(
          callApprovalDigestKeyV1(intent.digest),
          intent.approvalId,
        );
      });
    },
    async spend(approvalId, digest, effectId) {
      return storage.transaction(async (transaction) => {
        const used = await transaction.get<{ effectId?: string }>(
          callApprovalUseKeyV1(approvalId),
        );
        if (used !== undefined) return used.effectId === effectId;
        const stored = await transaction.get<unknown>(
          callApprovalKeyV1(approvalId),
        );
        if (stored === undefined) return false;
        if (decodeCallApprovalIntentV1(stored).digest !== digest) return false;
        if ((await statusOf(transaction, approvalId, now())) !== "approved") {
          return false;
        }
        await transaction.put(callApprovalUseKeyV1(approvalId), {
          schemaVersion: 1,
          approvalId,
          effectId,
          at: new Date(now()).toISOString(),
        });
        return true;
      });
    },
  };
}

function clipped(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/** One particular as the card shows it. */
function particular(value: unknown): string {
  if (typeof value === "string") return value;
  return JSON.stringify(value) ?? String(value);
}

/**
 * The card's words: what the call will do, in its own particulars. The card
 * is the whole question, so it names every argument, each bounded, and the
 * rationale carries them whole.
 */
export function callApprovalWordingV1(input: {
  tool: string;
  arguments: string;
  productName: string;
  origin: "person" | "background";
  reason:
    "no_authorization" | "arguments_changed" | "policy_requires_confirmation";
  consequence?: number;
}): { action: string; rationale: string; risk: SendToUserApprovalRiskV1 } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.arguments);
  } catch {
    parsed = undefined;
  }
  const lines =
    typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? Object.entries(parsed as Record<string, unknown>).map(
          ([key, value]) => `${key}: ${clipped(particular(value), 240)}`,
        )
      : [clipped(input.arguments, 600)];
  const action = clipped(
    `Run ${input.tool}${lines.length === 0 ? " with nothing else" : ` with ${lines.join("; ")}`}`,
    1_900,
  );
  const why =
    input.origin === "background"
      ? `Your Bot wanted to do this while nobody was there to ask, and it reaches outside ${input.productName}.`
      : input.reason === "arguments_changed"
        ? `It is not quite what you asked for, and it reaches outside ${input.productName}.`
        : input.reason === "policy_requires_confirmation"
          ? `It reaches outside ${input.productName}, and it was not clear you asked for exactly this.`
          : `You did not ask for this, and it reaches outside ${input.productName}.`;
  const rationale = clipped(
    `${why} Approving runs exactly this call once; anything different needs a new decision.\n\nExactly what it runs: ${input.tool} ${input.arguments}`,
    7_900,
  );
  return {
    action,
    rationale,
    risk:
      input.consequence !== undefined && input.consequence >= 2.5
        ? "high"
        : "medium",
  };
}

/**
 * What a Turn that drained the decision is told about the call it covers, so
 * a Bot in the conversation can make a call a Routine asked about.
 */
export function callApprovalDeliveryLineV1(
  intent: CallApprovalIntentV1,
  decision: "approved" | "denied" | "expired",
): string {
  return decision === "approved"
    ? `It covers exactly this call: ${intent.tool} with arguments ${intent.arguments}. Make that call now, once, with exactly those arguments; it runs without being asked again. Anything different needs a new decision.`
    : `It covered ${intent.tool} with arguments ${intent.arguments}. Do not make that call.`;
}
