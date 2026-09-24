// Deciding an approval, inside the Bot Durable Object.
//
// `app/shell/approvals.ts` is the record, the policy and the projection — read
// by the client too. This is the half that writes: the decision, the durable
// input it owes the Bot, the machine command a "yes" releases, and the Turn
// that lets the Bot act on the answer.

import type { BotIdentity } from "@frockbot/core/durable";
import { settleMachineIntentV1 } from "@frockbot/app/machine/approval";
import {
  dispatchApprovedMachineIntentV1,
  machineSeam,
} from "@frockbot/app/machine/bot";
import type { MachineIntentRecordV1 } from "@frockbot/app/machine/intent";
import {
  settlePluginIntentV1,
  type PluginIntentRecordV1,
} from "@frockbot/app/plugins/approval";
import { applyApprovedPluginIntentV1 } from "@frockbot/app/plugins/authoring-bot";
import { enqueuePendingBotInputV1 } from "@frockbot/app/routines/inbox-store";
import {
  approvalKeyV1,
  decodeApprovalRecordV1,
  projectApprovalCardV1,
  trimmableApprovalKeysV1,
  APPROVAL_PREFIX,
  ApprovalNotFoundError,
  type ApprovalDecisionCommandV1,
  type ApprovalDecisionReceiptV1,
  type ApprovalListViewV1,
  type ApprovalRecordV1,
} from "@frockbot/app/shell/approvals";
import {
  cardApprovalBindingKeyV1,
  decodeCardApprovalRecordV1,
  type CardDecisionWordingV1,
} from "@frockbot/app/shell/cards";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { openInputDeliveryTurnV1 } from "../shell/input-delivery.js";

/**
 * What a person changed on a Plugin's card before approving it, as the
 * Plugin that drew the card restated it.
 *
 * The decision a card asks for is bound to the digest of the values it was
 * drawn with (`shell:card-approval:`). A card the person can edit is decided
 * about the values they left in it, so the binding is moved to the digest of
 * those — and the Approval's words with it — in the same transaction that
 * records the decision. There is no instant at which the person has approved
 * one message while the binding still names another.
 */
export interface ApprovalRevisionV1 {
  pluginId: string;
  surfaceId: string;
  /**
   * The digest the binding held when the Plugin was asked. A binding that has
   * moved since was moved by somebody else's answer, and this one is refused
   * rather than written over it.
   */
  from: string;
  /** The digest of what the decision covers now. */
  digest: string;
  /** The words the Approval is recorded with from now on. */
  wording: CardDecisionWordingV1;
}

/**
 * The card's binding moved between the Plugin restating the edit and the
 * decision landing, so the edit no longer describes the card being decided.
 * Nothing is written.
 */
export class ApprovalRevisionConflictError extends Error {
  constructor(approvalId: string) {
    super(
      `approval "${approvalId}" is no longer bound to the values that were edited`,
    );
    this.name = "ApprovalRevisionConflictError";
  }
}

/**
 * Every pending approval this Bot's alarm now owes an expiry, expired in one
 * pass.
 *
 * Exactly once per approval: the write is conditional on the record still
 * being `pending`, so an alarm that fires twice — or fires while a person is
 * clicking Approve — settles on whichever answer got there first and the
 * other is a no-op. The queued input is written in the same transaction as
 * the decision, so the Bot always learns the outcome.
 */
export async function expireDueApprovals(
  state: ShellBotStateV1,
): Promise<void> {
  const stored = await state.ctx.storage.list<unknown>({
    prefix: APPROVAL_PREFIX,
  });
  const now = Date.now();
  for (const value of stored.values()) {
    const approval = decodeApprovalRecordV1(value);
    if (approval.decision !== "pending") continue;
    if (Date.parse(approval.expiresAt) > now) continue;
    await settleApproval(state, approval.approvalId, "expired", "expiry");
  }
}

/**
 * Record one decision, and queue the input it owes the Bot, in one
 * transaction.
 *
 * First write wins. A record that is no longer `pending` is returned exactly
 * as stored, which is what makes the route idempotent: a replayed `POST`, a
 * second click, and an alarm racing a person all answer with the one decision
 * that was actually recorded.
 */
async function settleApproval(
  state: ShellBotStateV1,
  approvalId: string,
  decision: "approved" | "denied" | "expired",
  decidedBy: "user" | "expiry",
  revision?: ApprovalRevisionV1,
): Promise<{
  approval: ApprovalRecordV1;
  status: "recorded" | "replayed";
  /** Present when the card was a machine command's. */
  machineIntent?: MachineIntentRecordV1;
  /** Present when the card was a Plugin publish or enable (ADR 0026). */
  pluginIntent?: PluginIntentRecordV1;
}> {
  const key = approvalKeyV1(approvalId);
  const at = new Date().toISOString();
  return state.ctx.storage.transaction(async (transaction) => {
    const stored = await transaction.get<unknown>(key);
    if (stored === undefined) {
      throw new ApprovalNotFoundError(approvalId);
    }
    const approval = decodeApprovalRecordV1(stored);
    if (approval.decision !== "pending") {
      return { approval, status: "replayed" as const };
    }
    const asked =
      revision === undefined
        ? approval
        : await reviseApprovalV1(transaction, approval, revision);
    const decided: ApprovalRecordV1 = {
      ...asked,
      decision,
      decidedAt: at,
      decidedBy,
    };
    await transaction.put(key, decided);
    // The Bot is owed the outcome whether a person gave it or the clock did:
    // "its outcome is delivered to the Bot's next conversational Turn as
    // durable input", and never an unbounded wait.
    await enqueuePendingBotInputV1(transaction, {
      schemaVersion: 1,
      kind: "approval",
      approvalId,
      decision,
      createdAt: at,
    });
    // Row 49: an approval this Bot asked for may be a command waiting for a
    // machine of the User's. The decision and what it authorized become
    // durable together, so a person can never have approved something whose
    // intent record still says nobody answered. Nothing is dispatched here:
    // a cross-Durable-Object call inside this transaction would make its
    // atomicity a lie.
    const machineIntent = await settleMachineIntentV1(
      transaction,
      approvalId,
      decision,
      at,
    );
    // ADR 0026: or a Plugin waiting to join the Composition and this Bot's
    // enable map. Same rule: settled here, applied after the commit.
    const pluginIntent = await settlePluginIntentV1(
      transaction,
      approvalId,
      decision,
      at,
    );
    return {
      approval: decided,
      status: "recorded" as const,
      ...(machineIntent === undefined ? {} : { machineIntent }),
      ...(pluginIntent === undefined ? {} : { pluginIntent }),
    };
  });
}

/**
 * Moves one card's binding onto the values the person edited it to, and
 * answers the Approval as it now reads. Refuses, writing nothing, when the
 * binding no longer holds this decision or no longer holds what the Plugin
 * was asked to revise.
 */
async function reviseApprovalV1(
  transaction: {
    get<T>(key: string): Promise<T | undefined>;
    put(key: string, value: unknown): Promise<void>;
  },
  approval: ApprovalRecordV1,
  revision: ApprovalRevisionV1,
): Promise<ApprovalRecordV1> {
  const key = cardApprovalBindingKeyV1(revision.pluginId, revision.surfaceId);
  const binding = decodeCardApprovalRecordV1(
    await transaction.get<unknown>(key),
  );
  if (
    !binding?.approvalIds.includes(approval.approvalId) ||
    binding.digest !== revision.from
  ) {
    throw new ApprovalRevisionConflictError(approval.approvalId);
  }
  if (binding.digest !== revision.digest) {
    await transaction.put(key, { ...binding, digest: revision.digest });
  }
  const { rationale: _drawn, ...unworded } = approval;
  return {
    ...unworded,
    action: revision.wording.action,
    risk: revision.wording.risk,
    ...(revision.wording.rationale === undefined
      ? {}
      : { rationale: revision.wording.rationale }),
  };
}

/**
 * The Bot's approvals, newest first. Decided cards are carried beside the
 * pending ones so the card in the transcript can say what was decided rather
 * than going quiet the moment somebody answers it.
 */
export async function listApprovals(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<ApprovalListViewV1> {
  await state.authority.validateIdentity(identity);
  const stored = await state.ctx.storage.list<unknown>({
    prefix: APPROVAL_PREFIX,
  });
  // Retention is enforced on read rather than in the settling transaction,
  // which cannot list. Trimming loses a row and never a fact: the send is
  // still on the durable log of the Turn that made it.
  for (const key of trimmableApprovalKeysV1([...stored.keys()])) {
    await state.ctx.storage.delete(key);
    stored.delete(key);
  }
  const approvals = [...stored.values()]
    .map((value) => decodeApprovalRecordV1(value))
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  return {
    schemaVersion: 1,
    botId: identity.botId,
    approvals: approvals.map((approval) => projectApprovalCardV1(approval)),
    pending: approvals.filter((approval) => approval.decision === "pending")
      .length,
  };
}

/**
 * One decision, from a person. The durable write happens before this answers,
 * so the 200 is a statement about state and not about intent.
 *
 * `revision` is what they changed on the card they decided it on, when they
 * changed something (`app/cards/bot.ts`). It is applied only by the write that
 * records the decision: a replay reads back the answer already given, about
 * the values it was given for.
 */
export async function decideApproval(
  state: ShellBotStateV1,
  identity: BotIdentity,
  approvalId: string,
  command: ApprovalDecisionCommandV1,
  revision?: ApprovalRevisionV1,
): Promise<ApprovalDecisionReceiptV1> {
  await state.authority.validateIdentity(identity);
  const settled = await settleApproval(
    state,
    approvalId,
    command.decision,
    "user",
    revision,
  );
  // Only the write that decided it dispatches — a second click answers
  // `replayed` and reaches no laptop — and only `approved` does. An expiry
  // never gets here at all: it settles through the alarm, which dispatches
  // nothing by construction.
  if (
    settled.status === "recorded" &&
    settled.machineIntent?.decision === "approved"
  ) {
    await dispatchApprovedMachineIntentV1(
      state.ctx.storage,
      settled.machineIntent,
      machineSeam(state, identity),
    );
  }
  // A Plugin approval proposes the generation on the User and switches the
  // Plugin on for this Bot — after the commit, idempotent on what the
  // Composition already holds, so a retry never makes a second generation.
  if (
    settled.status === "recorded" &&
    settled.pluginIntent?.decision === "approved"
  ) {
    await applyApprovedPluginIntentV1(state, identity, settled.pluginIntent);
  }
  // The Bot ended its Turn to ask, so the answer opens the Turn that acts on
  // it. Last, so an approved Plugin is already on when that Turn is admitted.
  // Only the write that decided it opens one, as with dispatch: a replay reads
  // back a decision whose Turn was opened then. The run id carries the Turn
  // that asked, because a Bot may reuse an approval id in a later Turn.
  if (settled.status === "recorded") {
    await openInputDeliveryTurnV1(state, identity, {
      inputId: approvalId,
      key: `approval\u0000${settled.approval.runId}\u0000${approvalId}`,
    });
  }
  return {
    schemaVersion: 1,
    approval: projectApprovalCardV1(settled.approval),
    status: settled.status,
  };
}
