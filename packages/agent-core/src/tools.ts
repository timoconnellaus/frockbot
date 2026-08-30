import { type Context, Service } from "cordis";
import type { ToolCall, ToolSchema } from "./types.js";

export interface ToolExecutionContext {
  botId: string;
  agentId: string;
  sessionId: string;
  /** Stable durable occurrence identity for provider idempotency and recovery. */
  effectId: string;
  /** Exact durable call; reconciliation fails closed when it is absent. */
  toolCall?: ToolCall;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export type ToolEffectReconciliation =
  | { status: "recovered"; result: ToolExecutionResult }
  | { status: "unavailable"; reason: string };

export interface ToolDefinition extends ToolSchema {
  idempotent?: boolean;
  validate?(input: unknown): boolean;
  execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
  reconcile?(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolEffectReconciliation>;
}

export type ToolPreparation =
  | { kind: "ready"; call: ToolCall; idempotent: boolean }
  | { kind: "denied"; call: ToolCall; result: ToolExecutionResult };

function sameToolCall(left: ToolCall, right: ToolCall): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    JSON.stringify(left.input) === JSON.stringify(right.input)
  );
}

declare module "cordis" {
  interface Context {
    tools: ToolRegistry;
  }

  interface Events {
    "tools/pre-execute": (
      call: ToolCall,
      context: ToolExecutionContext,
      next: () => Promise<ToolPreparation>,
    ) => Promise<ToolPreparation>;
    "tools/execute": (
      call: ToolCall,
      context: ToolExecutionContext,
      next: () => Promise<ToolExecutionResult>,
    ) => Promise<ToolExecutionResult>;
    "tools/post-execute": (
      call: ToolCall,
      result: ToolExecutionResult,
      context: ToolExecutionContext,
      next: () => Promise<ToolExecutionResult>,
    ) => Promise<ToolExecutionResult>;
    "tools/result": (call: ToolCall, result: ToolExecutionResult) => void;
  }
}

export class ToolRegistry extends Service {
  private definitions = new Map<string, ToolDefinition>();

  constructor(ctx: Context) {
    super(ctx, "tools");
  }

  register(definition: ToolDefinition): () => void {
    if (this.definitions.has(definition.name)) {
      throw new Error(`tool "${definition.name}" is already registered`);
    }
    this.definitions.set(definition.name, definition);
    return () => {
      if (this.definitions.get(definition.name) === definition) {
        this.definitions.delete(definition.name);
      }
    };
  }

  schemas(): ToolSchema[] {
    return [...this.definitions.values()].map(
      ({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
      }),
    );
  }

  prepare(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolPreparation> {
    return this.ctx.waterfall("tools/pre-execute", call, context, async () => {
      const definition = this.definitions.get(call.name);
      if (!definition) {
        return {
          kind: "denied",
          call,
          result: { content: `Unknown tool: ${call.name}`, isError: true },
        };
      }
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
    });
  }

  async executePrepared(
    preparation: Extract<ToolPreparation, { kind: "ready" }>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const definition = this.definitions.get(preparation.call.name);
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
    const definition = this.definitions.get(expectedCall.name);
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
      hasExactKeys(result as Record<PropertyKey, unknown>, [
        "content",
        "isError",
      ])
    ) {
      const resultRecord = result as Record<PropertyKey, unknown>;
      if (
        typeof resultRecord.content === "string" &&
        typeof resultRecord.isError === "boolean"
      ) {
        return {
          status: "recovered",
          result: {
            content: resultRecord.content,
            isError: resultRecord.isError,
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
