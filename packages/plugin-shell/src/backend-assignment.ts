import type { OperationReceiptV1 } from "@frockbot/configuration-core";

export interface StoredAssignmentSaga {
  schemaVersion: 1;
  commandId: string;
  commandFingerprint: string;
  userId: string;
  botId: string;
  assignmentId: string;
  connectionId: string;
  generation: string;
  mode?: "assign" | "release";
  supersededAssignmentId?: string;
  supersededConnectionId?: string;
  supersededGeneration?: string;
  phase: "claiming" | "committed";
  deadlineAt: number;
  receipt?: OperationReceiptV1;
}

export type AssignmentSagaSettlement =
  "acknowledged" | "compensated" | "rejected";

export interface AssignmentSagaEffects {
  acknowledge(saga: StoredAssignmentSaga): Promise<boolean>;
  compensate(saga: StoredAssignmentSaga): Promise<void>;
  rejectCommitted(saga: StoredAssignmentSaga): Promise<void>;
}

export async function settleAssignmentSaga(
  saga: StoredAssignmentSaga,
  effects: AssignmentSagaEffects,
): Promise<AssignmentSagaSettlement> {
  if (saga.phase === "claiming") {
    await effects.compensate(saga);
    return "compensated";
  }
  if (await effects.acknowledge(saga)) return "acknowledged";
  await effects.rejectCommitted(saga);
  return "rejected";
}
