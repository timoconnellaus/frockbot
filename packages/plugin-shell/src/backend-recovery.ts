// Kernel run-recovery planning, bound to the Shell Package's run codec.
import type { SessionEvent } from "@frockbot/agent-core";
import {
  planBotRunRecovery as planKernelBotRunRecovery,
  type BotRunRecoveryPlan,
} from "@frockbot/kernel-do";
import { storedRunCodecV1, type StoredRun } from "./backend-contracts.js";

export {
  eventsForFailedRun,
  latestModelRequestJournalState,
  type BotRunRecoveryPlan,
  type ModelRequestJournalState,
} from "@frockbot/kernel-do";

export function planBotRunRecovery(
  run: StoredRun,
  latest: readonly SessionEvent[],
): BotRunRecoveryPlan {
  return planKernelBotRunRecovery(run, latest, storedRunCodecV1);
}
