// What a Turn that drains a decision is told the decision covered.
//
// The pending input an Approval leaves carries only its id and the answer.
// For most cards that is enough: the Turn that asked is in the conversation
// above. A call a Routine asked about is not — the Routine ran in its own
// Session — and a Routine change was applied by the kernel, not by the Bot.
// So for those two the Turn is told, from the kernel's own record, exactly
// what was covered and what became of it.

import {
  CALL_APPROVAL_ID_PREFIX_V1,
  ROUTINE_APPROVAL_ID_PREFIX_V1,
} from "@frockbot/core/contracts";
import type { PendingBotInputV1 } from "@frockbot/app/routines/inbox";
import {
  callApprovalDeliveryLineV1,
  callApprovalKeyV1,
  decodeCallApprovalIntentV1,
} from "@frockbot/app/supervision/call-approval";
import {
  decodeRoutineIntentRecordV1,
  routineIntentDeliveryLineV1,
  routineIntentKeyV1,
} from "@frockbot/app/routines/approval";

/** Whether the kernel keeps a record of what this decision covered. */
export function approvalHasDeliveryDetailV1(approvalId: string): boolean {
  return (
    approvalId.startsWith(CALL_APPROVAL_ID_PREFIX_V1) ||
    approvalId.startsWith(ROUTINE_APPROVAL_ID_PREFIX_V1)
  );
}

export async function approvalDeliveryDetailsV1(
  storage: { get<T>(key: string): Promise<T | undefined> },
  inputs: readonly PendingBotInputV1[],
): Promise<Map<string, string>> {
  const details = new Map<string, string>();
  for (const input of inputs) {
    if (input.kind !== "approval") continue;
    try {
      if (input.approvalId.startsWith(CALL_APPROVAL_ID_PREFIX_V1)) {
        const stored = await storage.get<unknown>(
          callApprovalKeyV1(input.approvalId),
        );
        if (stored === undefined) continue;
        details.set(
          input.approvalId,
          callApprovalDeliveryLineV1(
            decodeCallApprovalIntentV1(stored),
            input.decision,
          ),
        );
      } else if (input.approvalId.startsWith(ROUTINE_APPROVAL_ID_PREFIX_V1)) {
        const stored = await storage.get<unknown>(
          routineIntentKeyV1(input.approvalId),
        );
        if (stored === undefined) continue;
        details.set(
          input.approvalId,
          routineIntentDeliveryLineV1(decodeRoutineIntentRecordV1(stored)),
        );
      }
    } catch {
      // A record nobody can read leaves the bare decision, as for any card.
    }
  }
  return details;
}
