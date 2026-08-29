export interface ToolCall {
  id: string;
  name: string;
  input: unknown;
}

export interface ToolCallOccurrence {
  occurrenceId: string;
  turn: number;
  step: number;
  ordinal: number;
  call: ToolCall;
}

export function toolOccurrenceId(
  turn: number,
  step: number,
  ordinal: number,
): string {
  if (
    !Number.isSafeInteger(turn) ||
    turn <= 0 ||
    !Number.isSafeInteger(step) ||
    step <= 0 ||
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0
  ) {
    throw new Error("tool occurrence coordinates are invalid");
  }
  return `tool:${turn}:${step}:${ordinal}`;
}

export function toolCallOccurrences(
  turn: number,
  step: number,
  calls: readonly ToolCall[],
): ToolCallOccurrence[] {
  return calls.map((call, ordinal) => ({
    occurrenceId: toolOccurrenceId(turn, step, ordinal),
    turn,
    step,
    ordinal,
    call,
  }));
}

export function toolIntentMatches(
  call: ToolCall,
  intent: { name: string; input: unknown },
): boolean {
  if (call.name !== intent.name) return false;
  try {
    return JSON.stringify(call.input) === JSON.stringify(intent.input);
  } catch {
    return false;
  }
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
  "model/effect-not-started": {
    turn: number;
    step: number;
    requestId: string;
    reason: string;
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
  "tool/call": {
    turn: number;
    step: number;
    occurrenceId: string;
    name: string;
    input: unknown;
  };
  "tool/result": {
    turn: number;
    step: number;
    occurrenceId: string;
    name: string;
    content: string;
    isError: boolean;
    status: "completed" | "interrupted";
  };
  "step/end": { turn: number; step: number; outcome: StepOutcome };
  "turn/end": { turn: number; outcome: TurnOutcome };
  "session/disposed": { disposedAt: string };
}

function eventRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function requireEventKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  if (
    Object.keys(value).length !== keys.length ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function eventString(
  value: unknown,
  label: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw new Error(`${label} must be a string`);
  }
  return value;
}

function eventTimestamp(value: unknown, label: string): string {
  const timestamp = eventString(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`${label} must be a timestamp`);
  }
  return timestamp;
}

function eventInteger(value: unknown, label: string, minimum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${label} must be an integer`);
  }
  return value as number;
}

function requireJsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 32) throw new Error(`${label} is too deeply nested`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) requireJsonValue(entry, label, depth + 1);
    return;
  }
  const record = eventRecord(value, label);
  for (const entry of Object.values(record)) {
    requireJsonValue(entry, label, depth + 1);
  }
}

function requireToolCall(value: unknown, label: string): void {
  const call = eventRecord(value, label);
  requireEventKeys(call, ["id", "name", "input"], label);
  eventString(call.id, `${label}.id`);
  eventString(call.name, `${label}.name`);
  requireJsonValue(call.input, `${label}.input`);
}

function requireLlmMessage(value: unknown, label: string): void {
  const message = eventRecord(value, label);
  const role = eventString(message.role, `${label}.role`);
  if (role === "user") {
    requireEventKeys(message, ["role", "content"], label);
    eventString(message.content, `${label}.content`, true);
    return;
  }
  if (role === "assistant") {
    requireEventKeys(message, ["role", "content", "toolCalls"], label);
    eventString(message.content, `${label}.content`, true);
    if (!Array.isArray(message.toolCalls)) {
      throw new Error(`${label}.toolCalls must be an array`);
    }
    message.toolCalls.forEach((call, index) =>
      requireToolCall(call, `${label}.toolCalls[${index}]`),
    );
    return;
  }
  if (role === "tool") {
    requireEventKeys(
      message,
      ["role", "callId", "name", "content", "isError"],
      label,
    );
    eventString(message.callId, `${label}.callId`);
    eventString(message.name, `${label}.name`);
    eventString(message.content, `${label}.content`, true);
    if (typeof message.isError !== "boolean") {
      throw new Error(`${label}.isError must be a boolean`);
    }
    return;
  }
  throw new Error(`${label}.role is invalid`);
}

function requireToolSchema(value: unknown, label: string): void {
  const tool = eventRecord(value, label);
  requireEventKeys(tool, ["name", "description", "inputSchema"], label);
  eventString(tool.name, `${label}.name`);
  eventString(tool.description, `${label}.description`, true);
  const schema = eventRecord(tool.inputSchema, `${label}.inputSchema`);
  requireJsonValue(schema, `${label}.inputSchema`);
}

function requireNormalizedModelRequest(value: unknown, label: string): void {
  const request = eventRecord(value, label);
  requireEventKeys(
    request,
    ["requestId", "provider", "model", "system", "messages", "tools"],
    label,
  );
  eventString(request.requestId, `${label}.requestId`);
  eventString(request.provider, `${label}.provider`);
  eventString(request.model, `${label}.model`);
  eventString(request.system, `${label}.system`, true);
  if (!Array.isArray(request.messages) || !Array.isArray(request.tools)) {
    throw new Error(`${label} messages and tools must be arrays`);
  }
  request.messages.forEach((message, index) =>
    requireLlmMessage(message, `${label}.messages[${index}]`),
  );
  request.tools.forEach((tool, index) =>
    requireToolSchema(tool, `${label}.tools[${index}]`),
  );
}

const SESSION_EVENT_COMMON_KEYS = ["type", "seq", "timestamp"] as const;

export function decodeSessionEvent(input: unknown): SessionEvent {
  const event = eventRecord(input, "session event");
  const type = eventString(event.type, "session event.type");
  eventInteger(event.seq, "session event.seq", 0);
  eventTimestamp(event.timestamp, "session event.timestamp");
  const keys = (...specific: string[]) => [
    ...SESSION_EVENT_COMMON_KEYS,
    ...specific,
  ];
  const turn = () => eventInteger(event.turn, "session event.turn", 1);
  const step = () => eventInteger(event.step, "session event.step", 1);
  const text = () => eventString(event.text, "session event.text", true);
  const requestId = () =>
    eventString(event.requestId, "session event.requestId");
  switch (type) {
    case "session/created":
      requireEventKeys(event, keys("createdAt"), "session event");
      eventTimestamp(event.createdAt, "session event.createdAt");
      break;
    case "input/queued":
      requireEventKeys(event, keys("messageId", "text"), "session event");
      eventString(event.messageId, "session event.messageId");
      text();
      break;
    case "input/admitted":
      requireEventKeys(event, keys("messageId", "turn"), "session event");
      eventString(event.messageId, "session event.messageId");
      turn();
      break;
    case "input/cancelled":
      requireEventKeys(event, keys("messageId", "reason"), "session event");
      eventString(event.messageId, "session event.messageId");
      if (event.reason !== "user" && event.reason !== "shutdown") {
        throw new Error("session event.reason is invalid");
      }
      break;
    case "turn/start":
      requireEventKeys(event, keys("turn"), "session event");
      turn();
      break;
    case "step/start":
      requireEventKeys(event, keys("turn", "step"), "session event");
      turn();
      step();
      break;
    case "user/message":
      requireEventKeys(
        event,
        keys("turn", "step", "messageId", "text"),
        "session event",
      );
      turn();
      step();
      eventString(event.messageId, "session event.messageId");
      text();
      break;
    case "model/request":
      requireEventKeys(event, keys("turn", "step", "request"), "session event");
      turn();
      step();
      requireNormalizedModelRequest(event.request, "session event.request");
      break;
    case "model/effect-not-started":
    case "model/reconciliation-required":
      requireEventKeys(
        event,
        keys("turn", "step", "requestId", "reason"),
        "session event",
      );
      turn();
      step();
      requestId();
      eventString(event.reason, "session event.reason");
      break;
    case "assistant/chunk":
      requireEventKeys(
        event,
        keys("turn", "step", "requestId", "text"),
        "session event",
      );
      turn();
      step();
      requestId();
      text();
      break;
    case "assistant/message":
      requireEventKeys(
        event,
        keys("turn", "step", "requestId", "text", "toolCalls"),
        "session event",
      );
      turn();
      step();
      requestId();
      text();
      if (!Array.isArray(event.toolCalls)) {
        throw new Error("session event.toolCalls must be an array");
      }
      event.toolCalls.forEach((call, index) =>
        requireToolCall(call, `session event.toolCalls[${index}]`),
      );
      break;
    case "tool/call":
      requireEventKeys(
        event,
        keys("turn", "step", "occurrenceId", "name", "input"),
        "session event",
      );
      turn();
      step();
      eventString(event.occurrenceId, "session event.occurrenceId");
      eventString(event.name, "session event.name");
      requireJsonValue(event.input, "session event.input");
      break;
    case "tool/result":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "occurrenceId",
          "name",
          "content",
          "isError",
          "status",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.occurrenceId, "session event.occurrenceId");
      eventString(event.name, "session event.name");
      eventString(event.content, "session event.content", true);
      if (typeof event.isError !== "boolean") {
        throw new Error("session event.isError must be a boolean");
      }
      if (event.status !== "completed" && event.status !== "interrupted") {
        throw new Error("session event.status is invalid");
      }
      break;
    case "step/end":
      requireEventKeys(event, keys("turn", "step", "outcome"), "session event");
      turn();
      step();
      if (
        ![
          "completed",
          "blocked",
          "cancelled",
          "interrupted",
          "model-error",
          "tool-error",
        ].includes(event.outcome as string)
      ) {
        throw new Error("session event.outcome is invalid");
      }
      break;
    case "turn/end":
      requireEventKeys(event, keys("turn", "outcome"), "session event");
      turn();
      if (
        ![
          "completed",
          "blocked",
          "cancelled",
          "interrupted",
          "model-error",
          "tool-error",
        ].includes(event.outcome as string)
      ) {
        throw new Error("session event.outcome is invalid");
      }
      break;
    case "session/disposed":
      requireEventKeys(event, keys("disposedAt"), "session event");
      eventTimestamp(event.disposedAt, "session event.disposedAt");
      break;
    default:
      throw new Error("session event.type is invalid");
  }
  // SAFETY: the exhaustive variant switch validates every SessionEvent field.
  return event as unknown as SessionEvent;
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
