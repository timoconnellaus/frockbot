import type { ConnectionView } from "@frockbot/configuration-core";

export function claimDependentAssignment(
  connection: ConnectionView,
  botId: string,
  generation: string,
): ConnectionView | undefined {
  if (
    connection.state === "revoking" ||
    connection.state === "revoked" ||
    connection.state === "failed" ||
    connection.safeMetadata.revocationRequested === true
  ) {
    return undefined;
  }
  if (connection.state !== "ready") {
    return undefined;
  }
  const existing = Array.isArray(connection.safeMetadata.dependentAssignments)
    ? connection.safeMetadata.dependentAssignments.filter(
        (candidate) =>
          candidate &&
          typeof candidate === "object" &&
          !Array.isArray(candidate) &&
          typeof (candidate as Record<string, unknown>).botId === "string",
      )
    : [];
  return {
    ...connection,
    safeMetadata: {
      ...connection.safeMetadata,
      dependentAssignments: [
        ...existing.filter(
          (candidate) =>
            (candidate as Record<string, unknown>).botId !== botId ||
            (candidate as Record<string, unknown>).generation !== generation,
        ),
        { botId, generation, status: "pending" },
      ],
    },
  };
}

export function acknowledgeDependentAssignment(
  connection: ConnectionView,
  botId: string,
  generation: string,
): ConnectionView | undefined {
  if (
    connection.state === "revoking" ||
    connection.state === "revoked" ||
    connection.safeMetadata.revocationRequested === true
  ) {
    return undefined;
  }
  const dependencies = Array.isArray(
    connection.safeMetadata.dependentAssignments,
  )
    ? connection.safeMetadata.dependentAssignments
    : [];
  let matched = false;
  const acknowledged = dependencies.map((candidate) => {
    if (
      candidate &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      (candidate as Record<string, unknown>).botId === botId &&
      (candidate as Record<string, unknown>).generation === generation
    ) {
      matched = true;
      return { ...candidate, status: "acknowledged" };
    }
    return candidate;
  });
  if (!matched) return undefined;
  return {
    ...connection,
    safeMetadata: {
      ...connection.safeMetadata,
      dependentAssignments: acknowledged,
    },
  };
}

export function releaseDependentAssignment(
  connection: ConnectionView,
  botId: string,
  generation: string,
): ConnectionView | undefined {
  const dependencies = Array.isArray(
    connection.safeMetadata.dependentAssignments,
  )
    ? connection.safeMetadata.dependentAssignments
    : [];
  const remaining = dependencies.filter(
    (candidate) =>
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      (candidate as Record<string, unknown>).botId !== botId ||
      (candidate as Record<string, unknown>).generation !== generation,
  );
  if (remaining.length === dependencies.length) return undefined;
  return {
    ...connection,
    safeMetadata: {
      ...connection.safeMetadata,
      dependentAssignments: remaining,
    },
  };
}

export function compensateDependentAssignment(
  connection: ConnectionView,
  botId: string,
  generation: string,
): ConnectionView | undefined {
  const dependencies = Array.isArray(
    connection.safeMetadata.dependentAssignments,
  )
    ? connection.safeMetadata.dependentAssignments
    : [];
  const remaining = dependencies.filter(
    (candidate) =>
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate) ||
      (candidate as Record<string, unknown>).botId !== botId ||
      (candidate as Record<string, unknown>).generation !== generation ||
      (candidate as Record<string, unknown>).status !== "pending",
  );
  if (remaining.length === dependencies.length) return undefined;
  return {
    ...connection,
    safeMetadata: {
      ...connection.safeMetadata,
      dependentAssignments: remaining,
    },
  };
}
