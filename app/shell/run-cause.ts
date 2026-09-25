import {
  namedRunCauseV1,
  type RunCauseReadersV1,
} from "@frockbot/app/billing/run-cause";
import type { StoredRunCauseV1 } from "@frockbot/core/durable";
import { readRoutineRecordV1 } from "@frockbot/app/routines/bot";
import type { ShellBotStateV1 } from "./backend-state.js";

/** Reads a Turn's cause from this Bot's own runs and Routines. */
export function runCauseReadersV1(state: ShellBotStateV1): RunCauseReadersV1 {
  return {
    // A run that no longer reads is charged to the conversation, not refused:
    // attribution never stops a Turn.
    readRun: (runId) =>
      state.authority.readRunHeader(runId).catch(() => undefined),
  };
}

/** The cause as the ledger records it: this Bot's Routine by its name. */
export function namedRunCauseOfBotV1(
  state: ShellBotStateV1,
  botId: string,
  cause: StoredRunCauseV1,
): Promise<StoredRunCauseV1> {
  return namedRunCauseV1(
    botId,
    cause,
    async (routineId) => (await readRoutineRecordV1(state, routineId))?.name,
  );
}
