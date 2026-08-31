// Importing the augmented module is what merges these declarations into cordis.
import type {} from "cordis";
import type { ToolCall, ToolSchema } from "./types.js";

export interface ToolExecutionContext {
  botId: string;
  agentId: string;
  sessionId: string;
  compositionGenerationId: string;
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

/** The kernel-declared tool execution interface. Implemented by a Package. */
export interface ToolExecution {
  schemas(): ToolSchema[];
  prepare(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolPreparation>;
  executePrepared(
    preparation: Extract<ToolPreparation, { kind: "ready" }>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult>;
}

/** Contributing Packages register tool definitions through this surface. */
export interface ToolRegistration {
  register(definition: ToolDefinition): () => void;
}

declare module "cordis" {
  interface Context {
    tools: ToolExecution & ToolRegistration;
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
