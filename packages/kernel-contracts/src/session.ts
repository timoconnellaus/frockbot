import { type Context, Service } from "cordis";
import type {
  LlmMessage,
  SessionEvent,
  SessionEventEnvelope,
  SessionEventInput,
} from "./types.js";
import { toolCallOccurrences, toolIntentMatches } from "./types.js";

export interface ToolOccurrenceJournalEntry {
  occurrence: ReturnType<typeof toolCallOccurrences>[number];
  intent?: Extract<SessionEvent, { type: "tool/call" }>;
  result?: Extract<SessionEvent, { type: "tool/result" }>;
}

export function validateToolOccurrenceJournal(
  events: readonly SessionEvent[],
): ReadonlyMap<string, ToolOccurrenceJournalEntry> {
  const journal = new Map<string, ToolOccurrenceJournalEntry>();
  const startedTurns = new Set<number>();
  const startedSteps = new Set<string>();
  let openTurn: number | undefined;
  let openStep:
    { turn: number; step: number; occurrences: Set<string> } | undefined;
  for (const event of events) {
    if (event.type === "turn/start") {
      if (openTurn !== undefined) {
        throw new Error(
          `turn ${event.turn} started while turn ${openTurn} is open`,
        );
      }
      if (startedTurns.has(event.turn)) {
        throw new Error(`turn ${event.turn} started more than once`);
      }
      startedTurns.add(event.turn);
      openTurn = event.turn;
      continue;
    }
    if (event.type === "turn/end") {
      if (openTurn !== event.turn) {
        throw new Error(`turn ${event.turn} ended without its matching start`);
      }
      if (openStep) {
        throw new Error(
          `turn ${event.turn} ended while step ${openStep.step} is open`,
        );
      }
      openTurn = undefined;
      continue;
    }
    if (event.type === "step/start") {
      if (openTurn !== event.turn) {
        throw new Error(
          `step ${event.turn}:${event.step} started outside its open turn`,
        );
      }
      if (openStep) {
        throw new Error(
          `step ${event.turn}:${event.step} started while step ${openStep.turn}:${openStep.step} is open`,
        );
      }
      const key = `${event.turn}:${event.step}`;
      if (startedSteps.has(key)) {
        throw new Error(`step ${key} started more than once`);
      }
      startedSteps.add(key);
      openStep = {
        turn: event.turn,
        step: event.step,
        occurrences: new Set(),
      };
      continue;
    }
    if (event.type === "step/end") {
      if (
        !openStep ||
        openStep.turn !== event.turn ||
        openStep.step !== event.step
      ) {
        throw new Error(
          `step ${event.turn}:${event.step} ended without its matching start`,
        );
      }
      const unsettled = [...openStep.occurrences]
        .map((occurrenceId) => journal.get(occurrenceId)!)
        .find((entry) => !entry.intent || !entry.result);
      if (unsettled) {
        throw new Error(
          `tool occurrence "${unsettled.occurrence.occurrenceId}" was not settled before step end`,
        );
      }
      openStep = undefined;
      continue;
    }
    if (event.type === "assistant/message") {
      if (event.toolCalls.length === 0) continue;
      if (
        !openStep ||
        openStep.turn !== event.turn ||
        openStep.step !== event.step
      ) {
        throw new Error(
          `assistant tool calls for ${event.turn}:${event.step} are outside their open step`,
        );
      }
      for (const occurrence of toolCallOccurrences(
        event.turn,
        event.step,
        event.toolCalls,
      )) {
        if (journal.has(occurrence.occurrenceId)) {
          throw new Error(
            `tool occurrence "${occurrence.occurrenceId}" has multiple assistant calls`,
          );
        }
        journal.set(occurrence.occurrenceId, { occurrence });
        openStep.occurrences.add(occurrence.occurrenceId);
      }
      continue;
    }
    if (event.type !== "tool/call" && event.type !== "tool/result") continue;
    if (
      !openStep ||
      openStep.turn !== event.turn ||
      openStep.step !== event.step
    ) {
      throw new Error(
        `tool occurrence "${event.occurrenceId}" is outside its open step`,
      );
    }
    const entry = journal.get(event.occurrenceId);
    if (
      !entry ||
      entry.occurrence.turn !== event.turn ||
      entry.occurrence.step !== event.step ||
      entry.occurrence.call.name !== event.name
    ) {
      throw new Error(
        `tool occurrence "${event.occurrenceId}" does not match an assistant call`,
      );
    }
    if (event.type === "tool/call") {
      if (!toolIntentMatches(entry.occurrence.call, event)) {
        throw new Error(
          `tool occurrence "${event.occurrenceId}" input does not match its assistant call`,
        );
      }
      if (entry.intent || entry.result) {
        throw new Error(
          `tool occurrence "${event.occurrenceId}" has duplicate intent`,
        );
      }
      entry.intent = event;
      continue;
    }
    if (!entry.intent) {
      throw new Error(
        `tool occurrence "${event.occurrenceId}" has a result without intent`,
      );
    }
    if (entry.result) {
      throw new Error(
        `tool occurrence "${event.occurrenceId}" has duplicate results`,
      );
    }
    entry.result = event;
  }
  return journal;
}

export function validateSettledToolOccurrenceJournal(
  events: readonly SessionEvent[],
): ReadonlyMap<string, ToolOccurrenceJournalEntry> {
  const journal = validateToolOccurrenceJournal(events);
  const unsettled = [...journal.values()].find(
    (entry) => !entry.intent || !entry.result,
  );
  if (unsettled) {
    throw new Error(
      `tool occurrence "${unsettled.occurrence.occurrenceId}" is not durably settled`,
    );
  }
  return journal;
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

/** Most resolved attachments one resident Session holds. */
export const SESSION_ATTACHMENT_CACHE_LIMIT = 4;
/** Largest resolved attachment a Session holds, in base64 characters. */
export const SESSION_ATTACHMENT_MAX_BASE64 = 8_000_000;

export class Session {
  readonly id: string;
  #events: SessionEvent[] = [];
  #disposed = false;
  #emit: (envelope: SessionEventEnvelope) => void;
  #persist?: PersistSessionEvents;
  #pendingPersistence: Promise<void> = Promise.resolve();
  /** The first durable write that failed. Every later `flush` reports it. */
  #persistFailure: Error | undefined;
  /**
   * Resolved attachment bytes, keyed by content hash, held only while this
   * Session is resident.
   *
   * The session event log is one Durable Object value and a screenshot in it
   * would be a durable record that grows past what the object can hold, so an
   * attachment records a Workspace path and a content hash and nothing else.
   * A tool that produced the bytes offers them here, and the request derived
   * while they are still held carries them to a model that can see images. On
   * the far side of an eviction the reference stands alone: the adapter says
   * where the image is rather than showing it, which is the observable
   * outcome, not a silent one.
   */
  #attachmentBytes = new Map<string, string>();

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
      // A chain that has already rejected must still attempt this write.
      // Chaining with `then` alone skipped the callback for the life of the
      // Session — no event was ever written again while the loop carried on
      // in memory — and left the rejection unhandled between an append and
      // the next flush. The failure is remembered instead, and `flush` throws
      // it, so the Turn fails loudly exactly once.
      const pending = this.#pendingPersistence
        .catch(() => undefined)
        .then(() => this.#persist?.(this.id, durableEvents));
      this.#pendingPersistence = pending;
      void pending.catch((error: unknown) => {
        this.#persistFailure ??=
          error instanceof Error ? error : new Error(String(error));
      });
    }
    return events;
  }

  async flush(): Promise<void> {
    await this.#pendingPersistence.catch(() => undefined);
    if (this.#persistFailure) throw this.#persistFailure;
  }

  /**
   * Offers the bytes of one attachment for as long as this Session is
   * resident. Bounded by count and by size: a cache that could grow with the
   * conversation would be durable state wearing a different hat.
   */
  offerAttachmentBytes(contentHash: string, dataBase64: string): void {
    if (!/^[0-9a-f]{64}$/.test(contentHash)) return;
    if (dataBase64.length > SESSION_ATTACHMENT_MAX_BASE64) return;
    this.#attachmentBytes.delete(contentHash);
    this.#attachmentBytes.set(contentHash, dataBase64);
    while (this.#attachmentBytes.size > SESSION_ATTACHMENT_CACHE_LIMIT) {
      const oldest = this.#attachmentBytes.keys().next().value;
      if (oldest === undefined) break;
      this.#attachmentBytes.delete(oldest);
    }
  }

  deriveMessages(): LlmMessage[] {
    const messages: LlmMessage[] = [];
    const journal = validateToolOccurrenceJournal(this.#events);
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
        const call = journal.get(event.occurrenceId)!.occurrence.call;
        messages.push({
          role: "tool",
          callId: call.id,
          name: event.name,
          content: event.content,
          isError: event.isError,
          ...(event.attachments && event.attachments.length > 0
            ? {
                attachments: event.attachments.map((attachment) => {
                  const resolved = this.#attachmentBytes.get(
                    attachment.contentHash,
                  );
                  return resolved === undefined
                    ? attachment
                    : { ...attachment, dataBase64: resolved };
                }),
              }
            : {}),
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
    const unresolvedModelRequests = new Set<string>();
    const journal = validateToolOccurrenceJournal(this.#events);

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
      if (event.type === "model/request") {
        unresolvedModelRequests.add(event.request.requestId);
      }
      if (event.type === "model/effect-not-started") {
        unresolvedModelRequests.delete(event.requestId);
      }
      if (event.type === "assistant/message") {
        unresolvedModelRequests.delete(event.requestId);
        if (openStep?.turn === event.turn && openStep.step === event.step) {
          openStepHasAssistant = true;
        }
      }
    }

    const repairs: SessionEventInput[] = [];
    if (closeTurn) {
      for (const entry of journal.values()) {
        if (!entry.intent || entry.result) continue;
        const event = entry.intent;
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
    }
    // An unresolved model request holds the step open — but only while the run
    // might still resume and let that outcome land. Closing the turn means it
    // never will, and a `turn/end` over an open step is itself invalid: it
    // produced "turn 1 ended while step 1 is open" and left the log as unusable
    // as the open turn it was meant to repair.
    if (
      openStep &&
      (closeTurn
        ? true
        : unresolvedModelRequests.size === 0 && !openStepHasAssistant)
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
  private preparedSessions = new Map<
    string,
    {
      initialEvents?: readonly SessionEvent[];
      persistEvents?: PersistSessionEvents;
    }
  >();

  constructor(ctx: Context, config: SessionStoreConfig = {}) {
    super(ctx, "sessions");
    this.initialSessions = config.initialSessions ?? {};
    this.persistEvents = config.persistEvents;
  }

  prepare(
    sessionId: string,
    options: {
      initialEvents?: readonly SessionEvent[];
      persistEvents?: PersistSessionEvents;
    },
  ): () => void {
    if (this.sessions.has(sessionId) || this.preparedSessions.has(sessionId)) {
      throw new Error(`session "${sessionId}" already exists`);
    }
    this.preparedSessions.set(sessionId, options);
    return () => {
      if (this.preparedSessions.get(sessionId) === options) {
        this.preparedSessions.delete(sessionId);
      }
    };
  }

  create(sessionId: string): Session {
    if (this.sessions.has(sessionId)) {
      throw new Error(`session "${sessionId}" already exists`);
    }
    const prepared = this.preparedSessions.get(sessionId);
    this.preparedSessions.delete(sessionId);
    const session = new Session(
      sessionId,
      (envelope) => {
        this.ctx.emit("session/event", envelope);
      },
      prepared?.initialEvents ?? this.initialSessions[sessionId],
      prepared?.persistEvents ?? this.persistEvents,
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
      this.preparedSessions.clear();
    };
  }
}
