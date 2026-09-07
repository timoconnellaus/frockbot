// Kernel run-terminal transitions, bound to the Shell Package's run codec.
import { type SessionEvent } from "@frockbot/core/contracts";
import {
  cancelStoredRun as cancelKernelStoredRun,
  completeStoredRun as completeKernelStoredRun,
  failStoredRun as failKernelStoredRun,
  type TerminalPackageRecords,
} from "@frockbot/core/durable";
import {
  storedRunCodecV1,
  type BotTurnCompletion,
} from "./backend-contracts.js";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";

export type {
  RunTerminalKeys,
  RunTerminalStorage,
} from "@frockbot/core/durable";
import type {
  RunTerminalKeys,
  RunTerminalStorage,
} from "@frockbot/core/durable";

export function completeStoredRun(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  result: BotTurnCompletion,
  packageRecords?: TerminalPackageRecords<BotSettingsViewV1>,
): Promise<"completed" | "cancelled" | "superseded"> {
  return completeKernelStoredRun(
    storedRunCodecV1,
    storage,
    keys,
    runId,
    previous,
    result,
    packageRecords,
  );
}

export function failStoredRun(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
  failure: string,
): Promise<
  "failed" | "cancelled" | "superseded" | "preserved-completion" | "missing"
> {
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

/**
 * Settles a stopped run as terminal `cancelled` and clears its active marker.
 * A cancelled run produces no response text, no failure, and no notification.
 */
export function cancelStoredRun(
  storage: RunTerminalStorage,
  keys: RunTerminalKeys,
  runId: string,
  previous: readonly SessionEvent[],
  events: readonly SessionEvent[],
): Promise<"cancelled" | "preserved-completion" | "missing"> {
  return cancelKernelStoredRun(
    storedRunCodecV1,
    storage,
    keys,
    runId,
    previous,
    events,
  );
}
