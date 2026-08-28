import type { ConnectionView } from "@frockbot/configuration-core";

export type BotCompensationResult = "applied" | "stale";

export function isSettledBotCompensation(
  result: BotCompensationResult,
): boolean {
  return result === "applied" || result === "stale";
}

export function expireAssignmentLease(
  connection: ConnectionView,
  now: number,
): ConnectionView | undefined {
  const metadata = connection.safeMetadata;
  if (
    connection.state !== "reconciliation-required" ||
    metadata.reconciliationOperation !== "assignment" ||
    typeof metadata.assignmentLeaseExpiresAt !== "number" ||
    metadata.assignmentLeaseExpiresAt > now
  ) {
    return undefined;
  }
  const expiredLeaseId = metadata.assignmentLeaseId;
  const {
    reconciliationOperation: _operation,
    assignmentLeaseId: _lease,
    assignmentLeaseExpiresAt: _leaseExpiry,
    ...safeMetadata
  } = metadata;
  if (
    typeof metadata.targetBotId !== "string" ||
    typeof expiredLeaseId !== "string" ||
    typeof metadata.assignmentGeneration !== "string"
  ) {
    return {
      ...connection,
      state: "failed",
      safeMetadata,
      failure: "Bot assignment was interrupted; reconnect to retry",
    };
  }
  return {
    ...connection,
    safeMetadata: {
      ...safeMetadata,
      reconciliationOperation: "assignment",
      assignmentCompensationPending: true,
      assignmentCompensationId: expiredLeaseId,
      assignmentCompensationGeneration: metadata.assignmentGeneration,
      compensationRetryAt: now,
    },
    failure: "Bot assignment was interrupted and can be retried",
  };
}

export function completeAssignmentCompensation(
  connection: ConnectionView,
  compensationId: string,
): ConnectionView | undefined {
  if (Array.isArray(connection.safeMetadata.assignmentCompensations)) {
    const remaining = connection.safeMetadata.assignmentCompensations.filter(
      (candidate) =>
        !candidate ||
        typeof candidate !== "object" ||
        Array.isArray(candidate) ||
        (candidate as Record<string, unknown>).id !== compensationId,
    );
    if (
      remaining.length ===
      connection.safeMetadata.assignmentCompensations.length
    ) {
      return undefined;
    }
    const {
      compensationRetryAt,
      assignmentCompensationPending: _,
      ...safeMetadata
    } = connection.safeMetadata;
    return {
      ...connection,
      safeMetadata: {
        ...safeMetadata,
        assignmentCompensations: remaining,
        ...(remaining.length > 0
          ? {
              assignmentCompensationPending: true,
              compensationRetryAt:
                typeof compensationRetryAt === "number"
                  ? compensationRetryAt
                  : Date.now() + 60_000,
            }
          : {}),
      },
    };
  }
  if (
    connection.safeMetadata.assignmentCompensationPending !== true ||
    connection.safeMetadata.assignmentCompensationId !== compensationId
  ) {
    return undefined;
  }
  const {
    reconciliationOperation: _,
    assignmentLeaseId: __,
    assignmentLeaseExpiresAt: ___,
    assignmentCompensationPending: ____,
    assignmentCompensationId: _____,
    assignmentCompensationGeneration: ______,
    compensationRetryAt: _______,
    ...safeMetadata
  } = connection.safeMetadata;
  if (
    connection.state === "reconciliation-required" &&
    connection.safeMetadata.reconciliationOperation === "assignment"
  ) {
    return {
      ...connection,
      state: "failed",
      safeMetadata,
      failure: "Bot assignment was interrupted; reconnect to retry",
    };
  }
  return { ...connection, safeMetadata };
}
