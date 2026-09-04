/**
 * The operator's view of a Bot's durable state: the runs as the authority
 * actually stored them, the Composition generations they pinned, and the
 * failures recorded against those generations.
 *
 * This is deliberately *not* the client run protocol. `run-protocol.ts`
 * projects a transcript for a person reading their conversation: it hides
 * non-visible runs, drops `model/request`, drops tool-call inputs, and
 * collapses anything it cannot show into `run/events-truncated`. Every one of
 * those omissions is the thing an operator needs when the agent loop
 * misbehaves — which prompt went to the model, what the tool was asked to do,
 * why the turn failed, which generation it was admitted under.
 *
 * Nothing here mutates. In particular a debug read never recovers an active
 * run or settles an uncertain effect: a stuck Bot must still be stuck after
 * you have looked at it.
 */

export const BOT_DEBUG_RUN_LIMIT_V1 = 20;
export const BOT_DEBUG_DEFAULT_RUN_LIMIT_V1 = 5;
export const BOT_DEBUG_GENERATION_LIMIT_V1 = 5;
/**
 * The event budget one snapshot spends. Session events carry whole prompts, so
 * a handful of runs can be megabytes; past this the *oldest* events of a run
 * are dropped, because a failure is described by the tail of its log.
 */
export const BOT_DEBUG_EVENT_BYTES_V1 = 512_000;

export interface BotDebugQueryV1 {
  schemaVersion: 1;
  /** One run, always with its events. Omitted: the newest page of runs. */
  runId?: string;
  limit?: number;
  /** A run-index cursor from a previous snapshot's `nextCursor`. */
  before?: string;
  /** Include session events in list mode. Single-run lookups always do. */
  events?: boolean;
}

export interface BotDebugRunV1 {
  runId: string;
  sessionId: string;
  acceptedAt: string;
  status: string;
  phase: string;
  input: string;
  commandFingerprint: string;
  compositionGenerationId: string;
  /** Events the session already held when this run was admitted. */
  previousEventCount: number;
  eventCount: number;
  responseText?: string;
  failure?: string;
  events?: unknown[];
  /** Oldest events dropped to stay inside the snapshot's byte budget. */
  omittedEvents?: number;
}

export interface BotDebugGenerationV1 {
  generationId: string;
  createdAt: string;
  status: string;
  origin: string;
  artifactSetHash: string;
  parentGenerationId?: string;
  memberCount: number;
  failures: unknown[];
  quarantined: boolean;
}

export interface BotDebugSnapshotV1 {
  schemaVersion: 1;
  botId: string;
  capturedAt: string;
  /**
   * A run the object still considers in flight. A run that sits here across
   * two snapshots, with its event tail unchanged, is the signature of a Bot
   * that stopped mid-turn.
   */
  activeRunId?: string;
  composition: {
    currentGenerationId: string;
    currentStatus: string;
    lastKnownGoodGenerationId?: string;
    generations: BotDebugGenerationV1[];
  };
  configuration?: unknown;
  notifications: unknown[];
  runs: BotDebugRunV1[];
  nextCursor?: string;
}

/**
 * A debug query the caller got wrong: an unknown field, a `limit` past the cap.
 * The request is what is bad, not the Bot, so the surface owes a 400 rather
 * than an uncaught failure in the isolate. The name is what carries that
 * across the Durable Object RPC boundary — which keeps an error's `name` and
 * `message` and drops everything else — exactly as `BotTurnRefusedError` does
 * for a refused admission.
 */
export class BotDebugQueryRefusedErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotDebugQueryRefusedErrorV1";
  }
}

/** Whether an error — including one that has crossed RPC — is that refusal. */
export function isBotDebugQueryRefusalV1(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    String((error as { name: unknown }).name) === "BotDebugQueryRefusedErrorV1"
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number, field: string): string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) {
    throw new BotDebugQueryRefusedErrorV1(`debug query ${field} is invalid`);
  }
  return value;
}

export function decodeBotDebugQueryV1(input: unknown): BotDebugQueryV1 {
  if (!isRecord(input)) {
    throw new BotDebugQueryRefusedErrorV1("debug query is invalid");
  }
  if (input.schemaVersion !== 1) {
    throw new BotDebugQueryRefusedErrorV1(
      "debug query schemaVersion is invalid",
    );
  }
  const allowed = new Set([
    "schemaVersion",
    "runId",
    "limit",
    "before",
    "events",
  ]);
  if (!Object.keys(input).every((key) => allowed.has(key))) {
    throw new BotDebugQueryRefusedErrorV1("debug query has invalid fields");
  }
  const query: BotDebugQueryV1 = { schemaVersion: 1 };
  if (input.runId !== undefined) {
    query.runId = boundedString(input.runId, 128, "runId");
  }
  if (input.before !== undefined) {
    query.before = boundedString(input.before, 512, "before");
  }
  if (input.limit !== undefined) {
    if (
      !Number.isSafeInteger(input.limit) ||
      (input.limit as number) < 1 ||
      (input.limit as number) > BOT_DEBUG_RUN_LIMIT_V1
    ) {
      throw new BotDebugQueryRefusedErrorV1(
        `debug query limit must be a whole number from 1 to ${BOT_DEBUG_RUN_LIMIT_V1}`,
      );
    }
    query.limit = input.limit as number;
  }
  if (input.events !== undefined) {
    if (typeof input.events !== "boolean") {
      throw new BotDebugQueryRefusedErrorV1(
        "debug query events must be true or false",
      );
    }
    query.events = input.events;
  }
  return query;
}

/**
 * Keeps the newest events that fit in `budget`, reporting how many older ones
 * were dropped. The tail is what describes a failure, so the head is what goes.
 */
export function boundDebugEventsV1(
  events: readonly unknown[],
  budget: number,
): { events: unknown[]; omittedEvents: number; spent: number } {
  const encoder = new TextEncoder();
  const kept: unknown[] = [];
  let spent = 0;
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const size = encoder.encode(JSON.stringify(events[index]) ?? "").byteLength;
    if (spent + size > budget && kept.length > 0) {
      return { events: kept, omittedEvents: index + 1, spent };
    }
    kept.unshift(events[index]);
    spent += size;
  }
  return { events: kept, omittedEvents: 0, spent };
}
