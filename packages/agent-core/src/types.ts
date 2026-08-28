export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolSchema {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export type LlmMessage =
  | { role: "user"; content: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | {
      role: "tool";
      callId: string;
      name: string;
      content: string;
      isError: boolean;
    };

export interface NormalizedModelRequest {
  requestId: string;
  provider: string;
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolSchema[];
}

export type LlmStreamEvent =
  | { type: "text-delta"; text: string }
  | { type: "tool-call"; call: ToolCall }
  | { type: "finish"; reason: "completed" | "tool-calls" | "max-tokens" };

export type StepOutcome =
  | "completed"
  | "blocked"
  | "cancelled"
  | "interrupted"
  | "model-error"
  | "tool-error";

export type TurnOutcome = StepOutcome;

export interface SessionEventMap {
  "session/created": { createdAt: string };
  "input/queued": { messageId: string; text: string };
  "input/admitted": { messageId: string; turn: number };
  "input/cancelled": { messageId: string; reason: "user" | "shutdown" };
  "turn/start": { turn: number };
  "step/start": { turn: number; step: number };
  "user/message": {
    turn: number;
    step: number;
    messageId: string;
    text: string;
  };
  "model/request": {
    turn: number;
    step: number;
    request: NormalizedModelRequest;
  };
  "model/reconciliation-required": {
    turn: number;
    step: number;
    requestId: string;
    reason: string;
  };
  "assistant/chunk": {
    turn: number;
    step: number;
    requestId: string;
    text: string;
  };
  "assistant/message": {
    turn: number;
    step: number;
    requestId: string;
    text: string;
    toolCalls: ToolCall[];
  };
  "tool/call": { turn: number; step: number; call: ToolCall };
  "tool/result": {
    turn: number;
    step: number;
    callId: string;
    name: string;
    content: string;
    isError: boolean;
    status: "completed" | "interrupted";
  };
  "step/end": { turn: number; step: number; outcome: StepOutcome };
  "turn/end": { turn: number; outcome: TurnOutcome };
  "session/disposed": { disposedAt: string };
}

export type SessionEventInput<
  T extends keyof SessionEventMap = keyof SessionEventMap,
> = {
  [K in T]: { type: K } & SessionEventMap[K];
}[T];

export type SessionEvent<
  T extends keyof SessionEventMap = keyof SessionEventMap,
> = SessionEventInput<T> & {
  seq: number;
  timestamp: string;
};

export interface SessionEventEnvelope {
  sessionId: string;
  event: SessionEvent;
}
