import { expandToolCallOccurrencesV1 } from "./batch.js";
import { messageEventsV1 } from "./turn-history.js";
import type {
  LlmMessage,
  SessionEvent,
  SessionEventEnvelope,
  SessionEventInput,
  ToolCallOccurrence,
  TurnTypeV1,
} from "./types.js";
import { toolIntentMatches } from "./types.js";
import type {
  ActiveRunJournalV1,
  CommittedContextV1,
  SessionCursorV1,
  SessionSeedV1,
  WorkingContextSelectorV1,
} from "./working-context.js";
import { emptyCommittedContextV1 } from "./working-context.js";

export interface ToolOccurrenceJournalEntry {
  occurrence: ToolCallOccurrence;
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
      for (const occurrence of expandToolCallOccurrencesV1(
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

export type PersistSessionEvents = (
  sessionId: string,
  events: readonly SessionEvent[],
) => Promise<void>;

/**
 * The position of the Session's latest open step, if any.
 *
 * A Session can contain many completed steps, so checking only the final
 * event is not enough: the latest start and latest end must name the same
 * position to say that the step is closed. Returning the position lets each
 * caller retain its own error/status wrapper without repeating either scan.
 */
export function latestOpenStepPositionV1(
  session: Session,
): { turn: number; step: number } | undefined {
  const started = session.activeRunJournal.findLast(
    (event) => event.type === "step/start",
  );
  if (started?.type !== "step/start") return undefined;
  const ended = session.activeRunJournal.findLast(
    (event) => event.type === "step/end",
  );
  if (
    ended?.type === "step/end" &&
    ended.turn === started.turn &&
    ended.step === started.step
  ) {
    return undefined;
  }
  return { turn: started.turn, step: started.step };
}

/**
 * Normalized prompt messages for a contiguous journal.
 *
 * `onlyTurn` keeps one Turn's messages while the tool journal is still
 * validated against the whole journal, so a batch child stays a non-message.
 */
export function normalizedMessagesV1(
  events: readonly SessionEvent[],
  resolveAttachment?: (contentHash: string) => string | undefined,
  onlyTurn?: number,
): LlmMessage[] {
  const messages: LlmMessage[] = [];
  const journal = validateToolOccurrenceJournal(events);
  for (const event of messageEventsV1(events)) {
    if (onlyTurn !== undefined && "turn" in event && event.turn !== onlyTurn) {
      continue;
    }
    if (event.type === "user/message") {
      messages.push({ role: "user", content: event.text });
    } else if (event.type === "assistant/message") {
      messages.push({
        role: "assistant",
        content: event.text,
        toolCalls: event.toolCalls,
        ...(event.providerState ? { providerState: event.providerState } : {}),
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
                const resolved = resolveAttachment?.(attachment.contentHash);
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

/**
 * Seeds a Session from an active-run journal with absolute sequence numbers.
 *
 * The array is not required to start at zero. A gap in `seq` is refused.
 * Callers that have older runs pass those through `context`, not by
 * truncating this array and renumbering it.
 */
function resolveSessionSeedV1(
  sessionId: string,
  seed: SessionSeedV1 | readonly SessionEvent[],
): SessionSeedV1 {
  if (isSessionSeedV1(seed)) return seed;
  return sessionSeedFromJournalV1(sessionId, seed);
}

function isSessionSeedV1(
  seed: SessionSeedV1 | readonly SessionEvent[],
): seed is SessionSeedV1 {
  return !Array.isArray(seed);
}

export function sessionSeedFromJournalV1(
  sessionId: string,
  events: readonly SessionEvent[],
  context: CommittedContextV1 = emptyCommittedContextV1(),
  epoch = 1,
): SessionSeedV1 {
  if (events.length === 0) {
    return {
      cursor: { sessionId, epoch, nextSeq: 0, nextTurn: 1 },
      context,
      journal: { startSeq: 0, events: [] },
    };
  }
  const start = events[0]!.seq;
  for (const [index, event] of events.entries()) {
    if (event.seq !== start + index) {
      throw new Error(
        `session "${sessionId}" active-run journal is not contiguous`,
      );
    }
  }
  let nextTurn = 1;
  for (const event of events) {
    if (event.type === "turn/start") {
      nextTurn = Math.max(nextTurn, event.turn + 1);
    }
  }
  return {
    cursor: {
      sessionId,
      epoch,
      nextSeq: events[events.length - 1]!.seq + 1,
      nextTurn,
    },
    context,
    journal: { startSeq: start, events },
  };
}

/** Most resolved attachments one resident Session holds. */
export const SESSION_ATTACHMENT_CACHE_LIMIT = 4;
/** Largest resolved attachment a Session holds, in base64 characters. */
export const SESSION_ATTACHMENT_MAX_BASE64 = 8_000_000;

export class Session {
  readonly id: string;
  #events: SessionEvent[] = [];
  #epoch: number;
  #nextSeq: number;
  #nextTurn: number;
  #context: CommittedContextV1;
  /** Set when history lives in the projection rather than this journal. */
  #selector?: WorkingContextSelectorV1;
  #disposed = false;
  #persist?: PersistSessionEvents;
  #pendingPersistence: Promise<void> = Promise.resolve();
  /** The first durable write that failed. Every later `flush` reports it. */
  #persistFailure: Error | undefined;
  /**
   * Resolved attachment bytes, keyed by content hash, held only while this
   * Session is resident.
   *
   * A screenshot in the session log would multiply durable storage and prompt
   * size even though the Bot authority pages and chunks large events, so an
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
    seed: SessionSeedV1 | readonly SessionEvent[] = [],
    persist?: PersistSessionEvents,
    selector?: WorkingContextSelectorV1,
  ) {
    this.id = id;
    this.#persist = persist;
    this.#selector = selector;
    const resolved = resolveSessionSeedV1(id, seed);
    if (resolved.cursor.sessionId !== id) {
      throw new Error(
        `session "${id}" was seeded for "${resolved.cursor.sessionId}"`,
      );
    }
    this.#epoch = resolved.cursor.epoch;
    this.#nextSeq = resolved.cursor.nextSeq;
    this.#nextTurn = resolved.cursor.nextTurn;
    this.#context = resolved.context;
    const journal = resolved.journal.events;
    if (journal.length > 0) {
      const start = journal[0]!.seq;
      if (start !== resolved.journal.startSeq) {
        throw new Error(`session "${id}" journal does not start at its cursor`);
      }
      for (const [index, event] of journal.entries()) {
        if (event.seq !== start + index) {
          throw new Error(
            `session "${id}" active-run journal is not contiguous`,
          );
        }
      }
      if (resolved.cursor.nextSeq !== journal[journal.length - 1]!.seq + 1) {
        throw new Error(
          `session "${id}" cursor does not follow its active-run journal`,
        );
      }
      this.#events = structuredClone([...journal]);
    } else if (
      resolved.cursor.nextSeq === 0 &&
      resolved.cursor.nextTurn === 1
    ) {
      this.append({
        type: "session/created",
        createdAt: new Date().toISOString(),
      });
    }
  }

  /**
   * Exact events of the active run.
   *
   * This is not the archive. A prefix or a suffix of older runs is not
   * available here; history is the committed context, and audit reads a range.
   */
  get activeRunJournal(): readonly SessionEvent[] {
    return this.#events;
  }

  get cursor(): SessionCursorV1 {
    return {
      sessionId: this.id,
      epoch: this.#epoch,
      nextSeq: this.#nextSeq,
      nextTurn: this.#nextTurn,
    };
  }

  get committedContext(): CommittedContextV1 {
    return this.#context;
  }

  get workingContextSelector(): WorkingContextSelectorV1 | undefined {
    return this.#selector;
  }

  bindWorkingContext(selector: WorkingContextSelectorV1 | undefined): void {
    this.#selector = selector;
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
      seq: this.#nextSeq + index,
      timestamp,
    })) as SessionEvent[];
    this.#nextSeq += events.length;
    for (const event of events) {
      if (event.type === "turn/start") {
        this.#nextTurn = Math.max(this.#nextTurn, event.turn + 1);
      }
    }
    this.#events.push(...events);
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

  /**
   * Normalized messages of the active-run journal.
   *
   * Committed history is not derived here. Request assembly asks the
   * working-context selector, or reduces this journal when it is the whole
   * resident session.
   */
  deriveMessages(): LlmMessage[] {
    return normalizedMessagesV1(this.#events, (hash) =>
      this.#attachmentBytes.get(hash),
    );
  }

  /** Normalized messages of one Turn in the active-run journal. */
  deriveTurnMessages(turn: number): LlmMessage[] {
    return normalizedMessagesV1(
      this.#events,
      (hash) => this.#attachmentBytes.get(hash),
      turn,
    );
  }

  turnType(turn: number): TurnTypeV1 | "unspecified" {
    for (const event of this.#events) {
      if (event.type === "turn/admission" && event.turn === turn) {
        return event.turnType;
      }
    }
    return "unspecified";
  }

  nextTurn(): number {
    return this.#nextTurn;
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
      if (event.type === "model/response-failed") {
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
  initialSeeds?: Readonly<Record<string, SessionSeedV1>>;
  persistEvents?: PersistSessionEvents;
  selectWorkingContext?: WorkingContextSelectorV1;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private initialSessions: Readonly<Record<string, readonly SessionEvent[]>>;
  private initialSeeds: Readonly<Record<string, SessionSeedV1>>;
  private persistEvents?: PersistSessionEvents;
  private selectWorkingContext?: WorkingContextSelectorV1;
  private preparedSessions = new Map<
    string,
    {
      initialEvents?: readonly SessionEvent[];
      seed?: SessionSeedV1;
      persistEvents?: PersistSessionEvents;
    }
  >();

  constructor(config: SessionStoreConfig = {}) {
    this.initialSessions = config.initialSessions ?? {};
    this.initialSeeds = config.initialSeeds ?? {};
    this.persistEvents = config.persistEvents;
    this.selectWorkingContext = config.selectWorkingContext;
  }

  prepare(
    sessionId: string,
    options: {
      initialEvents?: readonly SessionEvent[];
      seed?: SessionSeedV1;
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
      prepared?.seed ??
        this.initialSeeds[sessionId] ??
        prepared?.initialEvents ??
        this.initialSessions[sessionId] ??
        [],
      prepared?.persistEvents ?? this.persistEvents,
      this.selectWorkingContext,
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

  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.preparedSessions.clear();
  }
}
