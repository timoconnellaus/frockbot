import type {
  BotSettingsViewV1,
  CapabilityAssignmentOperationViewV1,
} from "@frockbot/configuration-core";

/** Projects every durable Assignment operation without requiring catalog state. */
export function projectAssignmentOperations(
  settings: Pick<BotSettingsViewV1, "assignmentOperations"> | undefined,
): CapabilityAssignmentOperationViewV1[] {
  return (settings?.assignmentOperations ?? []).map((operation) =>
    structuredClone(operation),
  );
}

export function assignmentHasPendingOperation(
  operations: readonly CapabilityAssignmentOperationViewV1[],
  assignmentId: string,
): boolean {
  return operations.some(
    (operation) => operation.assignmentId === assignmentId,
  );
}
