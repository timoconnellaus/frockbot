import { type Context, Service } from "cordis";
import type {
  LlmMessage,
  SessionEvent,
  SessionEventEnvelope,
  SessionEventInput,
  ToolCall,
} from "./types.js";
import { toolCallOccurrences, toolIntentMatches } from "./types.js";

function expectedToolCalls(
  events: readonly SessionEvent[],
): Map<string, ToolCall> {
  const expected = new Map<string, ToolCall>();
  for (const event of events) {
    if (event.type !== "assistant/message") continue;
    for (const occurrence of toolCallOccurrences(
      event.turn,
      event.step,
      event.toolCalls,
    )) {
      if (expected.has(occurrence.occurrenceId)) {
        throw new Error(
          `tool occurrence "${occurrence.occurrenceId}" has multiple assistant calls`,
        );
      }
      expected.set(occurrence.occurrenceId, occurrence.call);
    }
  }
  return expected;
}

function requireMatchingToolCall(
  expected: ReadonlyMap<string, ToolCall>,
  event: Extract<SessionEvent, { type: "tool/call" | "tool/result" }>,
): ToolCall {
  const call = expected.get(event.occurrenceId);
  if (!call || call.name !== event.name) {
    throw new Error(
      `tool occurrence "${event.occurrenceId}" does not match an assistant call`,
    );
  }
  if (event.type === "tool/call" && !toolIntentMatches(call, event)) {
    throw new Error(
      `tool occurrence "${event.occurrenceId}" input does not match its assistant call`,
    );
  }
  return call;
}

declare module "cordis" {
  interface Context {
    sessions: SessionStore;
  }

  interface Events {
    "session/event": (envelope: SessionEventEnvelope) => void;
  }
}

export type PersistSessionEvents = (
  sessionId: string,
  events: readonly SessionEvent[],
) => Promise<void>;

export class Session {
  readonly id: string;
  #events: SessionEvent[] = [];
  #disposed = false;
  #emit: (envelope: SessionEventEnvelope) => void;
  #persist?: PersistSessionEvents;
  #pendingPersistence: Promise<void> = Promise.resolve();

  constructor(
    id: string,
    emit: (envelope: SessionEventEnvelope) => void,
    initialEvents: readonly SessionEvent[] = [],
    persist?: PersistSessionEvents,
  ) {
    this.id = id;
    this.#emit = emit;
    this.#persist = persist;
    if (initialEvents.length > 0) {
      for (const [index, event] of initialEvents.entries()) {
        if (event.seq !== index) {
          throw new Error(`session "${id}" has a non-contiguous event log`);
        }
      }
      this.#events = structuredClone([...initialEvents]);
    } else {
      this.append({
        type: "session/created",
        createdAt: new Date().toISOString(),
      });
    }
  }

  get events(): readonly SessionEvent[] {
    return this.#events;
  }

  get disposed(): boolean {
    return this.#disposed;
  }

  append(input: SessionEventInput): SessionEvent {
    return this.appendBatch([input])[0];
  }

  appendBatch(inputs: SessionEventInput[]): SessionEvent[] {
    if (this.#disposed) throw new Error(`session "${this.id}" is disposed`);
    const timestamp = new Date().toISOString();
    const events = inputs.map((input, index) => ({
      ...input,
      seq: this.#events.length + index,
      timestamp,
    })) as SessionEvent[];
    this.#events.push(...events);
    for (const event of events) this.#emit({ sessionId: this.id, event });
    if (this.#persist && events.length > 0) {
      const durableEvents = structuredClone(events);
      this.#pendingPersistence = this.#pendingPersistence.then(() =>
        this.#persist?.(this.id, durableEvents),
      );
    }
    return events;
  }

  flush(): Promise<void> {
    return this.#pendingPersistence;
  }

  deriveMessages(): LlmMessage[] {
    const messages: LlmMessage[] = [];
    const expected = expectedToolCalls(this.#events);
    for (const event of this.#events) {
      if (event.type === "user/message") {
        messages.push({ role: "user", content: event.text });
      } else if (event.type === "assistant/message") {
        messages.push({
          role: "assistant",
          content: event.text,
          toolCalls: event.toolCalls,
        });
      } else if (event.type === "tool/result") {
        const call = requireMatchingToolCall(expected, event);
        messages.push({
          role: "tool",
          callId: call.id,
          name: event.name,
          content: event.content,
          isError: event.isError,
        });
      }
    }
    return messages;
  }

  nextTurn(): number {
    let latest = 0;
    for (const event of this.#events) {
      if (event.type === "turn/start") latest = Math.max(latest, event.turn);
    }
    return latest + 1;
  }

  reconcileInterrupted(): SessionEvent[] {
    const repairs = this.interruptionRepairs(true);
    return repairs.length > 0 ? this.appendBatch(repairs) : [];
  }

  reconcileForResume(): SessionEvent[] {
    const repairs = this.interruptionRepairs(false);
    return repairs.length > 0 ? this.appendBatch(repairs) : [];
  }

  private interruptionRepairs(closeTurn: boolean): SessionEventInput[] {
    let openTurn: number | undefined;
    let openStep: { turn: number; step: number } | undefined;
    let openStepHasAssistant = false;
    const calls = new Map<
      string,
      Extract<SessionEvent, { type: "tool/call" }>
    >();
    const unresolvedModelRequests = new Set<string>();
    const expected = expectedToolCalls(this.#events);
    const completedOccurrences = new Set<string>();

    for (const event of this.#events) {
      if (event.type === "turn/start") openTurn = event.turn;
      if (event.type === "turn/end" && openTurn === event.turn)
        openTurn = undefined;
      if (event.type === "step/start") {
        openStep = { turn: event.turn, step: event.step };
        openStepHasAssistant = false;
      }
      if (
        event.type === "step/end" &&
        openStep?.turn === event.turn &&
        openStep.step === event.step
      ) {
        openStep = undefined;
      }
      if (event.type === "tool/call") {
        requireMatchingToolCall(expected, event);
        if (
          calls.has(event.occurrenceId) ||
          completedOccurrences.has(event.occurrenceId)
        ) {
          throw new Error(
            `tool occurrence "${event.occurrenceId}" has duplicate intent`,
          );
        }
        calls.set(event.occurrenceId, event);
      }
      if (event.type === "tool/result") {
        requireMatchingToolCall(expected, event);
        if (!calls.delete(event.occurrenceId)) {
          throw new Error(
            `tool occurrence "${event.occurrenceId}" has a result without intent`,
          );
        }
        completedOccurrences.add(event.occurrenceId);
      }
      if (event.type === "model/request") {
        unresolvedModelRequests.add(event.request.requestId);
      }
      if (event.type === "assistant/message") {
        unresolvedModelRequests.delete(event.requestId);
        if (openStep?.turn === event.turn && openStep.step === event.step) {
          openStepHasAssistant = true;
        }
      }
    }

    const repairs: SessionEventInput[] = [];
    for (const event of calls.values()) {
      repairs.push({
        type: "tool/result",
        turn: event.turn,
        step: event.step,
        occurrenceId: event.occurrenceId,
        name: event.name,
        content: "Interrupted before a durable result was recorded.",
        isError: true,
        status: "interrupted",
      });
    }
    if (
      openStep &&
      unresolvedModelRequests.size === 0 &&
      (closeTurn || !openStepHasAssistant)
    ) {
      repairs.push({ type: "step/end", ...openStep, outcome: "interrupted" });
    }
    if (closeTurn && openTurn !== undefined) {
      repairs.push({
        type: "turn/end",
        turn: openTurn,
        outcome: "interrupted",
      });
    }
    return repairs;
  }

  dispose(): void {
    if (this.#disposed) return;
    this.append({
      type: "session/disposed",
      disposedAt: new Date().toISOString(),
    });
    this.#disposed = true;
  }
}

export interface SessionStoreConfig {
  initialSessions?: Readonly<Record<string, readonly SessionEvent[]>>;
  persistEvents?: PersistSessionEvents;
}

export class SessionStore extends Service {
  private sessions = new Map<string, Session>();
  private initialSessions: Readonly<Record<string, readonly SessionEvent[]>>;
  private persistEvents?: PersistSessionEvents;

  constructor(ctx: Context, config: SessionStoreConfig = {}) {
    super(ctx, "sessions");
    this.initialSessions = config.initialSessions ?? {};
    this.persistEvents = config.persistEvents;
  }

  create(sessionId: string): Session {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session "${sessionId}" already exists`);
    }
    const session = new Session(
      sessionId,
      (envelope) => {
        this.ctx.emit("session/event", envelope);
      },
      this.initialSessions[sessionId],
      this.persistEvents,
    );
    this.sessions.set(sessionId, session);
    return session;
  }

  get(sessionId: string): Session | undefined {
    return this.sessions.get(sessionId);
  }

  list(): Session[] {
    return [...this.sessions.values()];
  }

  disposeSession(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    session.dispose();
    this.sessions.delete(sessionId);
  }

  [Service.init](): () => void {
    return () => {
      for (const session of this.sessions.values()) session.dispose();
      this.sessions.clear();
    };
  }
}
