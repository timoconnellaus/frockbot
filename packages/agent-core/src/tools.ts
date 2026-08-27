import { type Context, Service } from "cordis";
import type { ToolCall, ToolSchema } from "./types.js";

export interface ToolExecutionContext {
  sessionId: string;
  signal: AbortSignal;
}

export interface ToolExecutionResult {
  content: string;
  isError: boolean;
}

export interface ToolDefinition extends ToolSchema {
  idempotent?: boolean;
  validate?(input: unknown): boolean;
  execute(
    input: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

export type ToolPreparation =
  | { kind: "ready"; call: ToolCall; idempotent: boolean }
  | { kind: "denied"; call: ToolCall; result: ToolExecutionResult };

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
}
