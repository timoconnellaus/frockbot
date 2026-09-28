// The Bot Durable Object's half of a Routine change the person approves:
// the intent written before the card, and the change applied after the
// decision commits (`app/routines/approval.ts` has the record and the rules).

import type { BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { userConfigurationV1 } from "@frockbot/app/settings/bot";
import {
  connectionTriggersFromUserV1,
  executeRoutineCommand,
  pluginTriggerIndexFromUserV1,
  type BotRoutinesTurn,
} from "./bot.js";
import {
  recordRoutineIntentOutcomeV1,
  routineApprovalIdV1,
  routineIntentKeyV1,
  type RoutineIntentRecordV1,
} from "./approval.js";
import type { RoutineCommandV1 } from "./shared.js";

/**
 * Record the change a Turn asks the person to approve, before the card.
 * Keyed by the Turn's run and occurrence, so a replayed call finds the intent
 * it already wrote and asks under the same id.
 */
export async function askRoutineApprovalV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  turn: BotRoutinesTurn,
  request: { command: RoutineCommandV1; effectId: string },
): Promise<{ approvalId: string }> {
  const approvalId = await routineApprovalIdV1(turn.runId, request.effectId);
  const key = routineIntentKeyV1(approvalId);
  await state.ctx.storage.transaction(async (transaction) => {
    if ((await transaction.get<unknown>(key)) !== undefined) return;
    await transaction.put(key, {
      schemaVersion: 1,
      approvalId,
      botId: identity.botId,
      sessionId: turn.sessionId,
      runId: turn.runId,
      turnId: turn.turnId,
      createdAt: new Date().toISOString(),
      command: request.command,
    } satisfies RoutineIntentRecordV1);
  });
  return { approvalId };
}

/**
 * Apply an approved change, after the decision committed. It is written with
 * the Bot that proposed it as its writer and the Approval recorded on the
 * Routine, so the prompt fires as the person's. The command id is the one the
 * Turn minted, so a retry replays the receipt rather than writing twice; what
 * it came to is recorded once, for the Turn the decision opens.
 */
export async function applyApprovedRoutineIntentV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  intent: RoutineIntentRecordV1,
): Promise<void> {
  if (intent.decision !== "approved" || intent.outcome !== undefined) return;
  const at = () => new Date().toISOString();
  try {
    const user = userConfigurationV1(state, identity);
    await executeRoutineCommand(
      state,
      identity,
      intent.command,
      {
        kind: "bot",
        botId: intent.botId,
        sessionId: intent.sessionId,
        turnId: intent.turnId,
      },
      connectionTriggersFromUserV1(user),
      pluginTriggerIndexFromUserV1(user),
      { approvalId: intent.approvalId },
    );
    await recordRoutineIntentOutcomeV1(state.ctx.storage, intent.approvalId, {
      status: "applied",
      at: at(),
    });
  } catch (error) {
    await recordRoutineIntentOutcomeV1(state.ctx.storage, intent.approvalId, {
      status: "failed",
      at: at(),
      detail: (error instanceof Error ? error.message : String(error)).slice(
        0,
        1_000,
      ),
    });
  }
}
