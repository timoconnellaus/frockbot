import { type Context, Service } from "cordis";
import type {
  LlmMessage,
  SessionEvent,
  SessionEventEnvelope,
  SessionEventInput,
} from "./types.js";

declare module "cordis" {
  interface Context {
    sessions: SessionStore;
  }

  interface Events {
    "session/event": (envelope: SessionEventEnvelope) => void;
  }
}

export class Session {
  readonly id: string;
  #events: SessionEvent[] = [];
  #disposed = false;
  #emit: (envelope: SessionEventEnvelope) => void;

  constructor(id: string, emit: (envelope: SessionEventEnvelope) => void) {
    this.id = id;
    this.#emit = emit;
    this.append({
      type: "session/created",
      createdAt: new Date().toISOString(),
    });
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
    return events;
  }

  deriveMessages(): LlmMessage[] {
    const messages: LlmMessage[] = [];
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
        messages.push({
          role: "tool",
          callId: event.callId,
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
    let openTurn: number | undefined;
    let openStep: { turn: number; step: number } | undefined;
    const calls = new Map<
      string,
      Extract<SessionEvent, { type: "tool/call" }>
    >();

    for (const event of this.#events) {
      if (event.type === "turn/start") openTurn = event.turn;
      if (event.type === "turn/end" && openTurn === event.turn)
        openTurn = undefined;
      if (event.type === "step/start")
        openStep = { turn: event.turn, step: event.step };
      if (
        event.type === "step/end" &&
        openStep?.turn === event.turn &&
        openStep.step === event.step
      ) {
        openStep = undefined;
      }
      if (event.type === "tool/call") calls.set(event.call.id, event);
      if (event.type === "tool/result") calls.delete(event.callId);
    }

    const repairs: SessionEventInput[] = [];
    for (const event of calls.values()) {
      repairs.push({
        type: "tool/result",
        turn: event.turn,
        step: event.step,
        callId: event.call.id,
        name: event.call.name,
        content: "Interrupted before a durable result was recorded.",
        isError: true,
        status: "interrupted",
      });
    }
    if (openStep) {
      repairs.push({ type: "step/end", ...openStep, outcome: "interrupted" });
    }
    if (openTurn !== undefined) {
      repairs.push({
        type: "turn/end",
        turn: openTurn,
        outcome: "interrupted",
      });
    }
    return repairs.length > 0 ? this.appendBatch(repairs) : [];
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

export class SessionStore extends Service {
  private sessions = new Map<string, Session>();

  constructor(ctx: Context) {
    super(ctx, "sessions");
  }

  create(sessionId: string): Session {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session "${sessionId}" already exists`);
    }
    const session = new Session(sessionId, (envelope) => {
      this.ctx.emit("session/event", envelope);
    });
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
