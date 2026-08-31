// Kernel run-terminal transitions, bound to the Shell Package's run codec.
import { type SessionEvent } from "@frockbot/kernel-contracts";
import {
  completeStoredRun as completeKernelStoredRun,
  failStoredRun as failKernelStoredRun,
  requireStoredRunReconciliation as requireKernelStoredRunReconciliation,
} from "@frockbot/kernel-do";
import {
  storedRunCodecV1,
  type BotTurnCompletion,
} from "./backend-contracts.js";

export type { RunTerminalKeys, RunTerminalStorage } from "@frockbot/kernel-do";
import type { RunTerminalKeys, RunTerminalStorage } from "@frockbot/kernel-do";

export function completeStoredRun(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  result: BotTurnCompletion,
): Promise<void> {
  return completeKernelStoredRun(
    storedRunCodecV1,
    storage,
    keys,
    runId,
    previous,
    result,
  );
}

export function failStoredRun(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
  failure: string,
): Promise<"failed" | "preserved-completion" | "missing"> {
  return failKernelStoredRun(
    storedRunCodecV1,
    storage,
    keys,
    runId,
    previous,
    events,
    failure,
  );
}

export function requireStoredRunReconciliation(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
  failure: string,
): Promise<void> {
  return requireKernelStoredRunReconciliation(
    storedRunCodecV1,
    storage,
    keys,
    runId,
    previous,
    events,
    failure,
  );
}
