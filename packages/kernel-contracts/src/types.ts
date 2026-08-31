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

export interface ModelBindingSnapshot {
  connectionId: string;
  connectionGeneration?: string;
  catalogGeneration?: string;
}

export interface NormalizedModelRequest {
  requestId: string;
  provider: string;
  model: string;
  system: string;
  messages: LlmMessage[];
  tools: ToolSchema[];
  modelBinding?: ModelBindingSnapshot;
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

/** The Composition generation an admitted Turn is pinned to. */
export interface CompositionPinV1 {
  generationId: string;
  artifactSetHash: string;
}

/**
 * The three Memory tiers a fact can be written to or injected from, named as
 * the session log records them. Bot Memory is the Bot's own; the other two are
 * shared roots sharded per writing Bot.
 */
export type MemoryScopeNameV1 = "bot" | "user" | "project";

export interface SessionEventMap {
  "session/created": { createdAt: string };
  "input/queued": { messageId: string; text: string };
  "input/admitted": { messageId: string; turn: number };
  "input/cancelled": { messageId: string; reason: "user" | "shutdown" };
  "turn/start": { turn: number };
  "composition/pinned": {
    turn: number;
    generationId: string;
    artifactSetHash: string;
  };
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
  /**
   * The Bot recorded the intent to author a Package, before the bundler ran.
   * Constitution, Durable effects: intent is recorded before the effect.
   */
  "package/author-intent": {
    turn: number;
    step: number;
    effectId: string;
    packageId: string;
    sourceHash: string;
  };
  /** The authored artifact and the pending Composition generation it produced. */
  "package/authored": {
    turn: number;
    step: number;
    effectId: string;
    packageId: string;
    version: string;
    contentHash: string;
    generationId: string;
  };
  /**
   * The Skills this Turn loaded as instructions, and the candidates it
   * refused. Constitution, Memory: "the session event log records exactly what
   * was injected, so an injection gap is visible in durable state rather than
   * silently changing the Bot's behavior." A Skill is an instruction, so its
   * injection is recorded on the Turn that used it, with the exact generation
   * — "the exact Skill generation each Turn used is reconstructable".
   */
  "skill/injected": {
    turn: number;
    skills: Array<{
      path: string;
      name: string;
      generationId: string;
      contentHash: string;
    }>;
    refusals: Array<{ path: string; reason: string }>;
  };
  /** The Bot recorded the intent to write a Skill, before the write ran. */
  "skill/write-intent": {
    turn: number;
    step: number;
    effectId: string;
    path: string;
    contentHash: string;
  };
  /** The generation the Skill write produced. */
  "skill/written": {
    turn: number;
    step: number;
    effectId: string;
    path: string;
    generationId: string;
    contentHash: string;
  };
  /**
   * The Memory this Turn injected, and what it left out. Constitution,
   * Memory: "What Memory enters a model request, and when, is Package policy,
   * and the session event log records exactly what was injected, so an
   * injection gap is visible in durable state rather than silently changing
   * the Bot's behavior." `sources` names every Memory file generation the
   * render read; `facts` is every line that reached the prompt; `omissions`
   * names each tier a cap or a failure cut short.
   *
   * `projectId` is `""` for the tiers that have none, so every entry has the
   * same shape and the decoder needs no optional field.
   */
  "memory/injected": {
    turn: number;
    sources: Array<{
      scope: MemoryScopeNameV1;
      projectId: string;
      path: string;
      generationId: string;
      contentHash: string;
    }>;
    facts: Array<{
      scope: MemoryScopeNameV1;
      projectId: string;
      tier: "profile" | "log";
      via: string;
      learnedAt: string;
      text: string;
    }>;
    omissions: Array<{ scope: MemoryScopeNameV1; reason: string }>;
  };
  /** The Bot recorded the intent to change Memory, before the write ran. */
  "memory/write-intent": {
    turn: number;
    step: number;
    effectId: string;
    action: "write" | "forget";
    scope: MemoryScopeNameV1;
    projectId: string;
    tier: "profile" | "log" | "note";
    path: string;
    contentHash: string;
  };
  /** The generation the Memory write produced. */
  "memory/written": {
    turn: number;
    step: number;
    effectId: string;
    action: "write" | "forget";
    scope: MemoryScopeNameV1;
    projectId: string;
    tier: "profile" | "log" | "note";
    path: string;
    generationId: string;
    contentHash: string;
  };
  /** The Bot recorded the intent to change Project membership, before it ran. */
  "memory/project-intent": {
    turn: number;
    step: number;
    effectId: string;
    action: "create" | "join" | "leave";
    projectId: string;
  };
  /** The Project membership the durable authority holds after the change. */
  "memory/project-changed": {
    turn: number;
    step: number;
    effectId: string;
    action: "create" | "join" | "leave";
    projectId: string;
    projects: string[];
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

function memoryScope(value: unknown, label: string): void {
  if (value !== "bot" && value !== "user" && value !== "project") {
    throw new Error(`${label} is invalid`);
  }
}

function memoryTier(value: unknown, label: string): void {
  if (value !== "profile" && value !== "log" && value !== "note") {
    throw new Error(`${label} is invalid`);
  }
}

function memoryAction(value: unknown, label: string): void {
  if (value !== "write" && value !== "forget") {
    throw new Error(`${label} is invalid`);
  }
}

function memoryProjectAction(value: unknown, label: string): void {
  if (value !== "create" && value !== "join" && value !== "leave") {
    throw new Error(`${label} is invalid`);
  }
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

/**
 * The exact v1 decoder for a normalized model request. Exported because the
 * request crosses the Bot isolate boundary inbound — a Bot-authored model
 * adapter composes it — and every inbound value is decoded at its seam.
 */
export function decodeNormalizedModelRequestV1(
  value: unknown,
  label = "normalized model request",
): NormalizedModelRequest {
  requireNormalizedModelRequest(value, label);
  // SAFETY: requireNormalizedModelRequest validated every field exactly.
  return value as NormalizedModelRequest;
}

function requireNormalizedModelRequest(value: unknown, label: string): void {
  const request = eventRecord(value, label);
  requireEventKeys(
    request,
    [
      "requestId",
      "provider",
      "model",
      "system",
      "messages",
      "tools",
      ...(Object.hasOwn(request, "modelBinding") ? ["modelBinding"] : []),
    ],
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
  if (request.modelBinding !== undefined) {
    const binding = eventRecord(request.modelBinding, `${label}.modelBinding`);
    requireEventKeys(
      binding,
      [
        "connectionId",
        ...(Object.hasOwn(binding, "connectionGeneration")
          ? ["connectionGeneration"]
          : []),
        ...(Object.hasOwn(binding, "catalogGeneration")
          ? ["catalogGeneration"]
          : []),
      ],
      `${label}.modelBinding`,
    );
    eventString(binding.connectionId, `${label}.modelBinding.connectionId`);
    if (binding.connectionGeneration !== undefined) {
      eventString(
        binding.connectionGeneration,
        `${label}.modelBinding.connectionGeneration`,
      );
    }
    if (binding.catalogGeneration !== undefined) {
      eventString(
        binding.catalogGeneration,
        `${label}.modelBinding.catalogGeneration`,
      );
    }
  }
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
    case "composition/pinned":
      requireEventKeys(
        event,
        keys("turn", "generationId", "artifactSetHash"),
        "session event",
      );
      turn();
      eventString(event.generationId, "session event.generationId");
      eventString(event.artifactSetHash, "session event.artifactSetHash");
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
    case "package/author-intent":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "packageId", "sourceHash"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.packageId, "session event.packageId");
      eventString(event.sourceHash, "session event.sourceHash");
      break;
    case "package/authored":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "packageId",
          "version",
          "contentHash",
          "generationId",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.packageId, "session event.packageId");
      eventString(event.version, "session event.version");
      eventString(event.contentHash, "session event.contentHash");
      eventString(event.generationId, "session event.generationId");
      break;
    case "skill/injected": {
      requireEventKeys(
        event,
        keys("turn", "skills", "refusals"),
        "session event",
      );
      turn();
      if (!Array.isArray(event.skills) || !Array.isArray(event.refusals)) {
        throw new Error("session event skills and refusals must be arrays");
      }
      event.skills.forEach((skill, index) => {
        const label = `session event.skills[${index}]`;
        const entry = eventRecord(skill, label);
        requireEventKeys(
          entry,
          ["path", "name", "generationId", "contentHash"],
          label,
        );
        eventString(entry.path, `${label}.path`);
        eventString(entry.name, `${label}.name`);
        eventString(entry.generationId, `${label}.generationId`);
        eventString(entry.contentHash, `${label}.contentHash`);
      });
      event.refusals.forEach((refusal, index) => {
        const label = `session event.refusals[${index}]`;
        const entry = eventRecord(refusal, label);
        requireEventKeys(entry, ["path", "reason"], label);
        eventString(entry.path, `${label}.path`);
        eventString(entry.reason, `${label}.reason`);
      });
      break;
    }
    case "skill/write-intent":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "path", "contentHash"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.path, "session event.path");
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "skill/written":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "path", "generationId", "contentHash"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      eventString(event.path, "session event.path");
      eventString(event.generationId, "session event.generationId");
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "memory/injected": {
      requireEventKeys(
        event,
        keys("turn", "sources", "facts", "omissions"),
        "session event",
      );
      turn();
      if (
        !Array.isArray(event.sources) ||
        !Array.isArray(event.facts) ||
        !Array.isArray(event.omissions)
      ) {
        throw new Error(
          "session event sources, facts and omissions must be arrays",
        );
      }
      event.sources.forEach((source, index) => {
        const label = `session event.sources[${index}]`;
        const entry = eventRecord(source, label);
        requireEventKeys(
          entry,
          ["scope", "projectId", "path", "generationId", "contentHash"],
          label,
        );
        memoryScope(entry.scope, `${label}.scope`);
        eventString(entry.projectId, `${label}.projectId`, true);
        eventString(entry.path, `${label}.path`);
        eventString(entry.generationId, `${label}.generationId`);
        eventString(entry.contentHash, `${label}.contentHash`);
      });
      event.facts.forEach((fact, index) => {
        const label = `session event.facts[${index}]`;
        const entry = eventRecord(fact, label);
        requireEventKeys(
          entry,
          ["scope", "projectId", "tier", "via", "learnedAt", "text"],
          label,
        );
        memoryScope(entry.scope, `${label}.scope`);
        eventString(entry.projectId, `${label}.projectId`, true);
        if (entry.tier !== "profile" && entry.tier !== "log") {
          throw new Error(`${label}.tier is invalid`);
        }
        eventString(entry.via, `${label}.via`, true);
        eventString(entry.learnedAt, `${label}.learnedAt`);
        eventString(entry.text, `${label}.text`);
      });
      event.omissions.forEach((omission, index) => {
        const label = `session event.omissions[${index}]`;
        const entry = eventRecord(omission, label);
        requireEventKeys(entry, ["scope", "reason"], label);
        memoryScope(entry.scope, `${label}.scope`);
        eventString(entry.reason, `${label}.reason`);
      });
      break;
    }
    case "memory/write-intent":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "action",
          "scope",
          "projectId",
          "tier",
          "path",
          "contentHash",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      memoryAction(event.action, "session event.action");
      memoryScope(event.scope, "session event.scope");
      eventString(event.projectId, "session event.projectId", true);
      memoryTier(event.tier, "session event.tier");
      eventString(event.path, "session event.path");
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "memory/written":
      requireEventKeys(
        event,
        keys(
          "turn",
          "step",
          "effectId",
          "action",
          "scope",
          "projectId",
          "tier",
          "path",
          "generationId",
          "contentHash",
        ),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      memoryAction(event.action, "session event.action");
      memoryScope(event.scope, "session event.scope");
      eventString(event.projectId, "session event.projectId", true);
      memoryTier(event.tier, "session event.tier");
      eventString(event.path, "session event.path");
      eventString(event.generationId, "session event.generationId");
      eventString(event.contentHash, "session event.contentHash");
      break;
    case "memory/project-intent":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "action", "projectId"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      memoryProjectAction(event.action, "session event.action");
      eventString(event.projectId, "session event.projectId");
      break;
    case "memory/project-changed":
      requireEventKeys(
        event,
        keys("turn", "step", "effectId", "action", "projectId", "projects"),
        "session event",
      );
      turn();
      step();
      eventString(event.effectId, "session event.effectId");
      memoryProjectAction(event.action, "session event.action");
      eventString(event.projectId, "session event.projectId");
      if (!Array.isArray(event.projects)) {
        throw new Error("session event.projects must be an array");
      }
      event.projects.forEach((project, index) =>
        eventString(project, `session event.projects[${index}]`),
      );
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
