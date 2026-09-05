import type { Cleanup, StandardSchemaV1 } from "@frockbot/compose-core";
import type { Store } from "@tanstack/store";

// ------------------------------------------------------------------ messages

/** One call the model asked for, with the arguments exactly as it issued them. */
export interface ToolCall {
  /** Unique within a session; the tool result quotes it back. */
  id: string;
  /** The name of the tool the model wants to run. */
  name: string;
  /** Raw, unvalidated arguments. Validated by the tool's validator (D3). */
  args: unknown;
}

/** One message the model sees, derived from the session log — never stored. */
export type Message =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: Array<ToolCall> }
  | {
      role: "tool";
      callId: string;
      name: string;
      content: string;
      isError: boolean;
    };

// -------------------------------------------------------------------- tools

/** What a tool run reports back. Failure is a value, never an exception (D3). */
export type ToolOutcome<TResult = unknown> =
  { ok: true; value: TResult } | { ok: false; error: string };

/** What a tool's `execute` is told about the call it is running. */
export interface ToolContext {
  /** The call as the model issued it. */
  call: ToolCall;
  /** Aborted when the turn is cancelled (C5). */
  signal: AbortSignal;
}

/** Whether a call may share a step with its neighbours, or must run alone (D4). */
export type ToolConcurrency = "parallel" | "exclusive";

/** A named, typed capability the model may call. */
export interface ToolDefinition<TArgs, TResult> {
  readonly name: string;
  readonly description: string;
  /** Standard Schema; validates the model's arguments before the tool runs. */
  readonly validator: StandardSchemaV1<any, TArgs>;
  /** The JSON Schema handed to the model. Data for the provider only. */
  readonly parameters: Record<string, unknown>;
  readonly concurrency: ToolConcurrency;
  readonly execute: (
    args: TArgs,
    context: ToolContext,
  ) => TResult | Promise<TResult>;
}

/** Any tool, whatever it takes and returns. */
export type AnyTool = ToolDefinition<any, any>;

/** The arguments a tool takes, inferred from its definition. */
export type ArgsOf<TTool> =
  TTool extends ToolDefinition<infer TArgs, any> ? TArgs : never;

/** The result a tool produces, inferred from its definition. */
export type ResultOfTool<TTool> =
  TTool extends ToolDefinition<any, infer TResult> ? TResult : never;

/** What a model is told a tool looks like. */
export interface ToolSchema {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

/** The registry the `tools` key carries. */
export interface ToolRegistry {
  /** Add a tool; call the returned cleanup to remove it again (C4). */
  register: (tool: AnyTool) => Cleanup;
  /** Every tool registered right now, in registration order. */
  list: () => Array<AnyTool>;
  /** One tool by name, or `undefined` if nothing registers it. */
  get: (name: string) => AnyTool | undefined;
}

// ------------------------------------------------------------------- prompt

/** A piece of system prompt a plugin contributes. */
export interface PromptSection {
  name: string;
  /** Lower sorts earlier; equal orders keep registration order. Defaults to 0. */
  order?: number;
  /** The text, or a function called at assembly time for live content. */
  text: string | (() => string);
}

/** The registry the `prompt` key carries. */
export interface PromptRegistry {
  /** Add a section; call the returned cleanup to remove it again (C3). */
  register: (section: PromptSection) => Cleanup;
  /** Every section registered right now, in assembly order. */
  list: () => Array<PromptSection>;
  /** The assembled system prompt for one step. */
  assemble: () => string;
}

// -------------------------------------------------------------------- model

/** One step's worth of work for the model. Middleware may rewrite it (D1). */
export interface ModelRequest {
  turn: number;
  step: number;
  /** The assembled prompt sections. */
  system: string;
  /** The messages derived from the session log (B2). */
  messages: Array<Message>;
  /** The tools registered at this moment (C4). */
  tools: Array<ToolSchema>;
  /** Provider-specific settings, from the loop's `modelOptions`. */
  options: Record<string, unknown>;
}

/** One piece of a streamed response. */
export type ModelChunk =
  { kind: "text"; text: string } | { kind: "tool-call"; call: ToolCall };

/** What one step produced. A failed step is a value, not an exception (D5). */
export interface ModelResponse {
  text: string;
  toolCalls: Array<ToolCall>;
  /** Set when the step failed; the loop records it and closes the turn. */
  error?: string;
}

/** One vendor or endpoint, registered into the model registry. */
export interface ModelProvider {
  /** Identifies the provider in the registry and in inspection. */
  readonly name: string;
  /** Stream one response. Stops when `signal` aborts. */
  stream: (
    request: ModelRequest,
    signal: AbortSignal,
  ) => AsyncIterable<ModelChunk>;
}

/** The registry the `model` key carries. Stable for the life of the client. */
export interface ModelRegistry {
  /** Add a provider; call the returned cleanup to remove it again (E2). */
  register: (provider: ModelProvider) => Cleanup;
  /** Every provider registered right now, in registration order. */
  list: () => Array<ModelProvider>;
  /** The provider the next turn will use, or `undefined` if none is registered. */
  current: () => ModelProvider | undefined;
  /** Choose the current provider by name; `undefined` restores the default. */
  select: (name: string | undefined) => void;
}

// ------------------------------------------------------------------ session

/** Why a turn or a step stopped. */
export type CloseReason = "complete" | "cancelled" | "error";

/** The fields every session entry carries. */
export interface SessionEntryFields {
  /** Sequence identity within the log; stable across replay and fork. */
  id: string;
  /** When it was appended, in epoch milliseconds. */
  at: number;
  /** The turn it belongs to; `0` before the first turn opens. */
  turn: number;
}

/** One appended fact. A discriminated union: listeners narrow on `kind` (F2). */
export type SessionEntry =
  | ({ kind: "turn-opened" } & SessionEntryFields)
  | ({ kind: "turn-closed"; reason: CloseReason } & SessionEntryFields)
  | ({ kind: "step-opened"; step: number } & SessionEntryFields)
  | ({
      kind: "step-closed";
      step: number;
      reason: CloseReason;
    } & SessionEntryFields)
  | ({ kind: "input"; text: string } & SessionEntryFields)
  | ({ kind: "chunk"; step: number; text: string } & SessionEntryFields)
  | ({
      kind: "assistant";
      step: number;
      text: string;
      toolCalls: Array<ToolCall>;
    } & SessionEntryFields)
  | ({ kind: "tool-call"; step: number; call: ToolCall } & SessionEntryFields)
  | ({
      kind: "tool-result";
      step: number;
      callId: string;
      name: string;
      outcome: ToolOutcome;
    } & SessionEntryFields)
  | ({ kind: "human-tool-call"; call: ToolCall } & SessionEntryFields)
  | ({
      kind: "human-tool-result";
      callId: string;
      name: string;
      outcome: ToolOutcome;
    } & SessionEntryFields)
  | ({
      kind: "error";
      step?: number;
      scope: "model" | "tool" | "loop";
      message: string;
    } & SessionEntryFields);

type WithoutIdentity<TEntry> = TEntry extends SessionEntry
  ? Omit<TEntry, "id" | "at">
  : never;

/** An entry as it is appended: the log assigns `id` and `at` itself. */
export type SessionEntryInput = WithoutIdentity<SessionEntry>;

/** The log the `session` key carries: the source of truth for a conversation. */
export interface SessionLog {
  /** Every entry, newest last; observable without polling (ADR-0002, B4). */
  readonly entries: Store<Array<SessionEntry>>;
  /** Append one fact and return it, with its `id` and `at` filled in. */
  append: (entry: SessionEntryInput) => SessionEntry;
  /** A copy of the log, safe to keep. */
  snapshot: () => Array<SessionEntry>;
  /** The messages for a request, derived from the log (B2). */
  messages: () => Array<Message>;
  /** A copy of the log up to and including a step or turn boundary (B3). */
  fork: (entryId: string) => Array<SessionEntry>;
}

// -------------------------------------------------------------------- agent

/** Whether the agent is between turns or working. */
export type AgentStatus = "idle" | "running";

/** The handle the `agent` key carries. */
export interface Agent {
  /** `idle` or `running`, observable without polling (C7). */
  readonly status: Store<AgentStatus>;
  /** Queue input. Starts a turn when idle, joins the next step otherwise (C1). */
  send: (text: string) => void;
  /** Stop the turn, its request and its tool calls; resolves once idle (C5). */
  cancel: () => Promise<void>;
  /**
   * The **human step**: run one **tool** as a person rather than as the model,
   * through {@link ToolCallInput}'s own action, so every middleware wrapping a
   * tool call sees a click exactly as it sees the model's call. The call and
   * its outcome are appended to the **session**, and the model is told what
   * happened in its next request.
   */
  invoke: (name: string, args?: unknown) => Promise<ToolOutcome>;
  /** Resolves the next time the agent is idle, or at once if it already is. */
  idle: () => Promise<void>;
}

// ------------------------------------------------------------------ actions

/** Who issued a tool call: the model taking a step, or a person on the page. */
export type ToolCallOrigin = "model" | "human";

/** The input of {@link toolCallAction}: the call that was issued (D2). */
export interface ToolCallInput {
  /** The call, with its raw arguments. Middleware may rewrite them. */
  call: ToolCall;
  turn: number;
  step: number;
  /**
   * Where the call came from. Absent means `model`, which is what the loop
   * issues; `human` is a **human step** — `agent.invoke`, outside any turn,
   * against the tools registered right now rather than the turn's world.
   */
  origin?: ToolCallOrigin;
}
