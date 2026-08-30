import {
  decodeConnectionDependencyRequirementV1,
  decodeOperationReceiptV1,
  isPublicIdentifier,
  type CapabilityAssignmentView,
  type ConnectionDependencyRequirementV1,
  type OperationReceiptV1,
} from "@frockbot/configuration-core";

export type AssignmentOperationKind = "assigning" | "replacing" | "unassigning";

export type AssignmentSagaPhase =
  "claiming" | "committing" | "acknowledging" | "releasing";

/** Durable Bot-owned coordinator state, separate from its stable Assignment. */
export interface StoredAssignmentSaga {
  schemaVersion: 1;
  commandId: string;
  commandFingerprint: string;
  userId: string;
  botId: string;
  operation: AssignmentOperationKind;
  assignmentId: string;
  generation: string;
  phase: AssignmentSagaPhase;
  target?: Omit<CapabilityAssignmentView, "state">;
  claimDispatched?: boolean;
  acknowledgeDispatched?: boolean;
  releaseDispatched?: boolean;
  targetRequirement?: ConnectionDependencyRequirementV1;
  previous?: CapabilityAssignmentView;
  previousGeneration?: string;
  deadlineAt: number;
  acceptedReceipt: OperationReceiptV1;
  receipt?: OperationReceiptV1;
}

function exact(
  value: Record<PropertyKey, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set<PropertyKey>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Reflect.ownKeys(value).every((key) => allowed.has(key))
  ) {
    throw new Error("Stored Assignment saga has invalid fields");
  }
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !isPublicIdentifier(value)) {
    throw new Error(`Stored Assignment saga ${label} is invalid`);
  }
  return value;
}

export function requireStoredAssignmentSaga(
  input: unknown,
): StoredAssignmentSaga {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("Stored Assignment saga is invalid");
  }
  const value = input as Record<PropertyKey, unknown>;
  exact(
    value,
    [
      "schemaVersion",
      "commandId",
      "commandFingerprint",
      "userId",
      "botId",
      "operation",
      "assignmentId",
      "generation",
      "phase",
      "deadlineAt",
      "acceptedReceipt",
    ],
    [
      "target",
      "targetRequirement",
      "previous",
      "previousGeneration",
      "claimDispatched",
      "acknowledgeDispatched",
      "releaseDispatched",
      "receipt",
    ],
  );
  if (
    value.schemaVersion !== 1 ||
    (value.operation !== "assigning" &&
      value.operation !== "replacing" &&
      value.operation !== "unassigning") ||
    (value.phase !== "claiming" &&
      value.phase !== "committing" &&
      value.phase !== "acknowledging" &&
      value.phase !== "releasing") ||
    typeof value.deadlineAt !== "number" ||
    !Number.isFinite(value.deadlineAt)
  ) {
    throw new Error("Stored Assignment saga is invalid");
  }
  for (const key of [
    "claimDispatched",
    "acknowledgeDispatched",
    "releaseDispatched",
  ] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") {
      throw new Error(`Stored Assignment saga ${key} is invalid`);
    }
  }
  const target = (candidate: unknown, state: boolean) => {
    if (
      !candidate ||
      typeof candidate !== "object" ||
      Array.isArray(candidate)
    ) {
      throw new Error("Stored Assignment saga target is invalid");
    }
    const item = candidate as Record<PropertyKey, unknown>;
    exact(
      item,
      state
        ? ["assignmentId", "packageId", "capabilityId", "state"]
        : ["assignmentId", "packageId", "capabilityId"],
      ["connectionId"],
    );
    if (
      state &&
      item.state !== "enabled" &&
      item.state !== "disabled" &&
      item.state !== "unavailable"
    ) {
      throw new Error("Stored Assignment saga target state is invalid");
    }
    return {
      assignmentId: identifier(item.assignmentId, "assignmentId"),
      packageId: identifier(item.packageId, "packageId"),
      capabilityId: identifier(item.capabilityId, "capabilityId"),
      connectionId:
        item.connectionId === undefined
          ? undefined
          : identifier(item.connectionId, "connectionId"),
      ...(state
        ? { state: item.state as CapabilityAssignmentView["state"] }
        : {}),
    };
  };
  const acceptedReceipt = decodeOperationReceiptV1(value.acceptedReceipt);
  if (
    acceptedReceipt.status !== "pending" ||
    acceptedReceipt.commandId !== value.commandId
  ) {
    throw new Error("Stored Assignment saga accepted receipt is invalid");
  }
  return {
    schemaVersion: 1,
    commandId: identifier(value.commandId, "commandId"),
    commandFingerprint:
      typeof value.commandFingerprint === "string" &&
      value.commandFingerprint.length <= 2_000
        ? value.commandFingerprint
        : (() => {
            throw new Error("Stored Assignment saga fingerprint is invalid");
          })(),
    userId: identifier(value.userId, "userId"),
    botId: identifier(value.botId, "botId"),
    operation: value.operation,
    assignmentId: identifier(value.assignmentId, "assignmentId"),
    generation: identifier(value.generation, "generation"),
    phase: value.phase,
    target:
      value.target === undefined
        ? undefined
        : (target(value.target, false) as Omit<
            CapabilityAssignmentView,
            "state"
          >),
    targetRequirement:
      value.targetRequirement === undefined
        ? undefined
        : decodeConnectionDependencyRequirementV1(value.targetRequirement),
    previous:
      value.previous === undefined
        ? undefined
        : (target(value.previous, true) as CapabilityAssignmentView),
    previousGeneration:
      value.previousGeneration === undefined
        ? undefined
        : identifier(value.previousGeneration, "previousGeneration"),
    claimDispatched: value.claimDispatched as boolean | undefined,
    acknowledgeDispatched: value.acknowledgeDispatched as boolean | undefined,
    releaseDispatched: value.releaseDispatched as boolean | undefined,
    deadlineAt: value.deadlineAt,
    acceptedReceipt,
    receipt:
      value.receipt === undefined
        ? undefined
        : decodeOperationReceiptV1(value.receipt),
  };
}

export function nextAssignmentPhase(
  saga: StoredAssignmentSaga,
  event: "claimed" | "committed" | "acknowledged" | "released",
): StoredAssignmentSaga | undefined {
  if (saga.phase === "claiming" && event === "claimed") {
    return { ...saga, phase: "committing" };
  }
  if (saga.phase === "committing" && event === "committed") {
    if (saga.target?.connectionId) {
      return { ...saga, phase: "acknowledging" };
    }
    if (saga.previous?.connectionId) {
      return { ...saga, phase: "releasing" };
    }
    return undefined;
  }
  if (saga.phase === "acknowledging" && event === "acknowledged") {
    return saga.previous?.connectionId
      ? { ...saga, phase: "releasing" }
      : undefined;
  }
  if (saga.phase === "releasing" && event === "released") return undefined;
  throw new Error(`Assignment saga cannot apply ${event} while ${saga.phase}`);
}
