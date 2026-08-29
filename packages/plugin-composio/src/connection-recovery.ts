import type { ConnectionView } from "@frockbot/configuration-core";

export type BotCompensationResult = "applied" | "stale";

export function isSettledBotCompensation(
  result: BotCompensationResult,
): boolean {
  return result === "applied" || result === "stale";
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
  return undefined;
}
