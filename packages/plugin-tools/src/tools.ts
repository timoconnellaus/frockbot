import { type Context, Service } from "cordis";
import {
  admittedSubagentRolesV1,
  admittedTurnTypesV1,
  isSubagentRoleAdmittedV1,
  type ToolCall,
  type ToolDefinition,
  type ToolEffectReconciliation,
  type ToolExecution,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolGuard,
  type ToolPreparation,
  type ToolRegistrationOptions,
  type ToolSchema,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";

function sameToolCall(left: ToolCall, right: ToolCall): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    JSON.stringify(left.input) === JSON.stringify(right.input)
  );
}

/** One registration: the tool, and the turn types it may ever be offered on. */
interface RegisteredTool {
  definition: ToolDefinition;
  /**
   * The tool's own declaration intersected with its Capability's durable
   * manifest ceiling, resolved once at registration so admission cannot drift
   * between the catalog the model saw and the call the loop admits.
   */
  admitted: readonly TurnTypeV1[];
  /**
   * The second ceiling dimension, resolved the same way and at the same
   * moment: the subagent roles this tool may be offered to. `undefined` is
   * every role — a tool that declares nothing is narrowed by nothing.
   */
  admittedRoles: readonly string[] | undefined;
}

export class ToolRegistry extends Service implements ToolExecution {
  private definitions = new Map<string, RegisteredTool>();
  private guards: ToolGuard[] = [];

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  register(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions,
  ): () => void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`);
    }
    const registered: RegisteredTool = {
      definition,
      admitted: admittedTurnTypesV1(
        definition.admission?.turnTypes,
        options?.admissionCeiling,
      ),
      admittedRoles: admittedSubagentRolesV1(
        definition.admission?.subagentRoles,
        options?.subagentRoleCeiling,
      ),
    };
    this.definitions.set(definition.name, registered);
    return () => {
      if (this.definitions.get(definition.name) === registered) {
        this.definitions.delete(definition.name);
      }
    };
  }

  registeredNames(): string[] {
    return [...this.definitions.keys()].toSorted();
  }

  guard(guard: ToolGuard): () => void {
    this.guards.push(guard);
    return () => {
      const index = this.guards.indexOf(guard);
      if (index >= 0) this.guards.splice(index, 1);
    };
  }

  schemas(admission: {
    turnType: TurnTypeV1;
    subagentRole?: string;
  }): ToolSchema[] {
    return [...this.definitions.values()]
      .filter(
        (registered) =>
          registered.admitted.includes(admission.turnType) &&
          isSubagentRoleAdmittedV1(
            registered.admittedRoles,
            admission.subagentRole,
          ),
      )
      .map(({ definition: { name, description, inputSchema } }) => ({
        name,
        description,
        inputSchema,
      }));
  }

  async prepare(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolPreparation> {
    const prepared = await this.ctx.waterfall(
      "tools/pre-execute",
      call,
      context,
      async () => {
        const registered = this.definitions.get(call.name);
        if (!registered) {
          return {
            kind: "denied",
            call,
            result: { content: `Unknown tool: ${call.name}`, isError: true },
          };
        }
        // Defence in depth: the catalog was already trimmed, so a call that
        // arrives here names a tool the model was never offered.
        if (!registered.admitted.includes(context.turnType)) {
          return {
            kind: "denied",
            call,
            result: {
              content: `Tool is not available on a ${context.turnType} turn: ${call.name}`,
              isError: true,
            },
          };
        }
        // The same defence on the second dimension. A `browserUse` subagent that
        // names `computer_exec` was never offered it, and the ceiling says so
        // here as well as in the catalog.
        if (
          !isSubagentRoleAdmittedV1(
            registered.admittedRoles,
            context.subagentRole,
          )
        ) {
          return {
            kind: "denied",
            call,
            result: {
              content: `Tool is not available to a ${context.subagentRole} subagent: ${call.name}`,
              isError: true,
            },
          };
        }
        const definition = registered.definition;
        if (definition.validate && !definition.validate(call.input)) {
          return {
            kind: "denied",
            call,
            result: {
              content: `Invalid input for tool: ${call.name}`,
              isError: true,
            },
          };
        }
        return {
          kind: "ready",
          call,
          idempotent: definition.idempotent ?? false,
        };
      },
    );
    // A pre-execute listener can add a denial. Once denied, neither a guard
    // nor anything registered later can turn the call back into executable
    // work. Guards themselves return only a reason, so they have no vocabulary
    // with which to lift another guard's denial.
    if (prepared.kind === "denied") return prepared;
    for (const guard of this.guards) {
      const denial = await guard(prepared.call, context);
      if (!denial) continue;
      return {
        kind: "denied",
        call: prepared.call,
        result: { content: denial.reason, isError: true },
      };
    }
    return prepared;
  }

  async executePrepared(
    preparation: Extract<ToolPreparation, { kind: "ready" }>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const definition = this.definitions.get(preparation.call.name)?.definition;
    const initial = await this.ctx.waterfall(
      "tools/execute",
      preparation.call,
      context,
      () => {
        if (!definition) {
          return Promise.resolve({
            content: `Tool became unavailable: ${preparation.call.name}`,
            isError: true,
          });
        }
        return definition.execute(preparation.call.input, context);
      },
    );
    const result = await this.ctx.waterfall(
      "tools/post-execute",
      preparation.call,
      initial,
      context,
      () => Promise.resolve(initial),
    );
    this.ctx.emit("tools/result", preparation.call, result);
    return result;
  }

  /**
   * Settles one durably open effect without exposing provider selection to the
   * Agent loop. Idempotent definitions retry execution with the same effectId;
   * other definitions must retrieve their original result.
   */
  async reconcilePrepared(
    preparation: Extract<ToolPreparation, { kind: "ready" }>,
    context: ToolExecutionContext,
  ): Promise<ToolEffectReconciliation> {
    const expectedCall = context.toolCall;
    if (!expectedCall) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(
          `Tool ${preparation.call.name} has no durable call identity for effect reconciliation`,
          preparation.call.name,
        ),
      };
    }
    if (!sameToolCall(preparation.call, expectedCall)) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(
          `Prepared tool ${preparation.call.name} does not match durable effect ${expectedCall.name}`,
          expectedCall.name,
        ),
      };
    }
    const definition = this.definitions.get(expectedCall.name)?.definition;
    if (!definition) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(
          `Tool ${expectedCall.name} is unavailable for effect reconciliation`,
          expectedCall.name,
        ),
      };
    }
    // Preparation is middleware-visible and therefore cannot be the authority
    // for retry safety. Only the registered definition may declare an effect
    // idempotent.
    if (definition.idempotent === true) {
      try {
        return {
          status: "recovered",
          result: await this.executePrepared(
            { ...preparation, call: expectedCall, idempotent: true },
            context,
          ),
        };
      } catch (error) {
        return {
          status: "unavailable",
          reason: boundedReconciliationReason(error, expectedCall.name),
        };
      }
    }
    if (!definition.reconcile) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(
          `Tool ${expectedCall.name} does not support effect reconciliation`,
          expectedCall.name,
        ),
      };
    }
    try {
      const outcome = normalizedReconciliation(
        await definition.reconcile(expectedCall.input, context),
        expectedCall.name,
      );
      if (outcome.status === "recovered") {
        this.ctx.emit("tools/result", expectedCall, outcome.result);
      }
      return outcome;
    } catch (error) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(error, expectedCall.name),
      };
    }
  }
}

const TOOL_RECONCILIATION_REASON_MAX_BYTES = 512;
const RECONCILIATION_REASON_ENCODER = new TextEncoder();

function ownStringKeys(
  value: Record<PropertyKey, unknown>,
): string[] | undefined {
  const keys = Reflect.ownKeys(value);
  return keys.every((key): key is string => typeof key === "string")
    ? keys.sort()
    : undefined;
}

function hasExactKeys(
  value: Record<PropertyKey, unknown>,
  expected: readonly string[],
): boolean {
  const keys = ownStringKeys(value);
  const sortedExpected = [...expected].sort();
  return (
    keys !== undefined &&
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function normalizedReconciliation(
  input: unknown,
  toolName: string,
): ToolEffectReconciliation {
  if (typeof input !== "object" || input === null) {
    return invalidReconciliation(toolName);
  }
  const record = input as Record<PropertyKey, unknown>;
  if (
    hasExactKeys(record, ["result", "status"]) &&
    record.status === "recovered"
  ) {
    const result = record.result;
    if (
      typeof result === "object" &&
      result !== null &&
      (hasExactKeys(result as Record<PropertyKey, unknown>, [
        "content",
        "isError",
      ]) ||
        hasExactKeys(result as Record<PropertyKey, unknown>, [
          "content",
          "isError",
          "endsTurn",
        ]))
    ) {
      const resultRecord = result as Record<PropertyKey, unknown>;
      if (
        typeof resultRecord.content === "string" &&
        typeof resultRecord.isError === "boolean" &&
        (resultRecord.endsTurn === undefined ||
          typeof resultRecord.endsTurn === "boolean")
      ) {
        return {
          status: "recovered",
          result: {
            content: resultRecord.content,
            isError: resultRecord.isError,
            // A recovered hand-off still ends the Turn it was recorded on.
            ...(resultRecord.endsTurn === undefined
              ? {}
              : { endsTurn: resultRecord.endsTurn }),
          },
        };
      }
    }
  }
  if (
    hasExactKeys(record, ["reason", "status"]) &&
    record.status === "unavailable" &&
    typeof record.reason === "string"
  ) {
    return {
      status: "unavailable",
      reason: boundedReconciliationReason(record.reason, toolName),
    };
  }
  return invalidReconciliation(toolName);
}

function invalidReconciliation(toolName: string): ToolEffectReconciliation {
  return {
    status: "unavailable",
    reason: boundedReconciliationReason(
      `Tool ${toolName} returned an invalid reconciliation outcome`,
      toolName,
    ),
  };
}

function boundedReconciliationReason(error: unknown, toolName: string): string {
  const reason =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Tool effect is not currently retrievable";
  const normalized = reason.trim() || `Tool ${toolName} effect is unavailable`;
  let bounded = "";
  let bytes = 0;
  for (const character of normalized) {
    const characterBytes =
      RECONCILIATION_REASON_ENCODER.encode(character).byteLength;
    if (bytes + characterBytes > TOOL_RECONCILIATION_REASON_MAX_BYTES) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded || `Tool ${toolName} effect is unavailable`;
}
