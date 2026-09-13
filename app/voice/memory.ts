// What the voice session remembers between calls.
//
// The account's shared Memory (`app/memory/`) is what every Bot reads and
// writes. This is a second, smaller thing that only the spoken session owns:
// how this person wants voice conversations to work, what is still open
// between them, and a rolling handover from the last few calls. It is separate
// on purpose — "keep your answers short" is a fact about talking to the voice
// assistant, not a fact about the account that every Bot should act on.
//
// Three kinds, three lifetimes:
//
// - **durable** — preferences and facts that hold until the person corrects
//   them. Nothing expires them and nothing evicts them: they change by
//   explicit operations only, so a summary that forgets to mention one does
//   not delete it, and a full memory refuses the new fact out loud rather
//   than quietly dropping an old one.
// - **ongoing** — an open question, an undecided thing, a topic left
//   unfinished. Removed when it resolves, is cancelled, or is superseded.
// - **recent** — the handover, and anything asked for within a timeframe.
//   Dated by the *turn* that produced it, gone at its own expiry or after
//   fourteen days, whichever is first.
//
// Two rules run through all of it.
//
// **Provenance.** Every operation names the turn it came from and takes that
// turn's own time. A model cannot date a fact, and reading an old
// conversation again cannot make what it held look like today.
//
// **Order.** Each entry carries the call and the turn that wrote it, and a
// removal leaves a tombstone carrying the same. A write is refused when
// something newer already stands where it would go — so a summary that
// arrives after the conversation that corrected it cannot undo the
// correction, and re-reading an old conversation cannot resurrect a fact the
// person has since dropped. That holds wherever the two sides name the same
// thing: an id already in the record, or one a later summary chooses again.
// A correction to a fact nobody has written down yet has no id to agree on,
// so the fence it leaves is best-effort; what keeps that case right is the
// end-of-call instruction, which dates what is remembered and says plainly
// that an older turn is never permission to write a newer fact back.
//
// Source material is not copied here. The ledger's turn records are the
// source, and a call with unfinished memory work keeps its turns out of the
// ledger's retention sweep; a job is a few dozen bytes saying where the
// reading got to.
//
// Everything is pure over a key-value surface (the Durable Object's own
// storage, the same one the ledger uses), so it is tested in bun.
import { refuseMemorySecretV1 } from "@frockbot/app/memory/secrets";
import type { VoiceLedgerStorageV1 } from "./ledger.js";

export const VOICE_MEMORY_RECORD_KEY_V1 = "voice:memory:record";
export const VOICE_MEMORY_JOB_PREFIX_V1 = "voice:memory:job:";
/**
 * Where the removal fences live, one record per removed thing. A fence that
 * unread source could still argue with is never dropped, so the list has no
 * ceiling — and a list with no ceiling must not share a storage value with
 * the memory it fences, or a long backlog eventually makes that value
 * unwritable and memory stops accepting anything at all.
 *
 * The key is the thing fenced, never a position in a list. A write that fails
 * part way through then leaves every other fence exactly as it was, and the
 * only value it could have overwritten is the same fact's own older fence.
 */
export const VOICE_MEMORY_FORGOTTEN_PREFIX_V1 = "voice:memory:forgotten:";

/** How long a handover line stays before it drops off, expiry or no expiry. */
export const VOICE_MEMORY_RECENT_DAYS_V1 = 14;
/**
 * How many durable facts and open items memory holds. This is a *write*
 * bound: past it a new fact is refused and said to be refused, because a
 * preference the person stated must not vanish because a later one arrived.
 */
export const VOICE_MEMORY_MAX_DURABLE_V1 = 60;
export const VOICE_MEMORY_MAX_ONGOING_V1 = 30;
/** Handover lines kept; the only kind an age or a count may drop. */
export const VOICE_MEMORY_MAX_RECENT_V1 = 30;
/** Removals remembered, so an old reading cannot bring one back. */
export const VOICE_MEMORY_MAX_TOMBSTONES_V1 = 200;
/** Removals the end-of-call instruction shows, newest last. */
export const VOICE_MEMORY_INSTRUCTION_DROPPED_V1 = 10;

export const VOICE_MEMORY_MAX_TEXT_CHARS_V1 = 240;
export const VOICE_MEMORY_MAX_OPERATIONS_V1 = 24;
/** Characters of model output read before the stream is abandoned. */
export const VOICE_MEMORY_MAX_OUTPUT_CHARS_V1 = 20_000;

/**
 * Turns one model call reads. A longer call is not truncated: it is extracted
 * in as many calls as it takes, each advancing a durable cursor, so a request
 * made in the tenth minute is read exactly like one made in the first.
 */
export const VOICE_MEMORY_CHUNK_TURNS_V1 = 40;
/** Unsummarised calls one finalization reads alongside its own. */
export const VOICE_MEMORY_MAX_CARRIED_CALLS_V1 = 2;
/** Turns of an unsummarised call the next conversation's prompt shows. */
export const VOICE_MEMORY_CONTINUITY_TURNS_V1 = 6;
/**
 * Attempts at one chunk. Only an answer that arrived whole and could not be
 * read is tried again; a request whose outcome is unknown is never repeated,
 * whatever this says.
 */
export const VOICE_MEMORY_MAX_ATTEMPTS_V1 = 3;
/** An applied job is kept this long, so a repeated end is still a no-op. */
export const VOICE_MEMORY_JOB_RETENTION_MS_V1 = 7 * 24 * 60 * 60_000;

/**
 * Said when a model call was issued and its outcome is unknown — the request
 * failed after it left, or the object was evicted before the answer arrived.
 * A gateway model request carries no idempotency key, so it is never
 * re-issued: the turns stay in the ledger and the next call's finalization
 * reads them.
 */
export const VOICE_MEMORY_UNCERTAIN_FAILURE_V1 =
  "the memory update was sent and its outcome is unknown; it is not repeated";

export type VoiceMemoryKindV1 = "durable" | "ongoing" | "recent";

/**
 * Where a write sits in the account's spoken history: which call, and which
 * turn inside it. Two facts written in the same millisecond still have an
 * order, and a clock that moved backwards does not reorder them.
 */
export interface VoiceMemoryStampV1 {
  /** The call's start, in epoch milliseconds. */
  sequence: number;
  /** The turn's place in that call, from one. */
  turn: number;
}

export function compareVoiceMemoryStampV1(
  left: VoiceMemoryStampV1,
  right: VoiceMemoryStampV1,
): number {
  return left.sequence === right.sequence
    ? left.turn - right.turn
    : left.sequence - right.sequence;
}

/** One remembered line. `at` is its source turn's time, never a read's. */
export interface VoiceMemoryEntryV1 {
  id: string;
  text: string;
  at: string;
  /** When it stops applying, for something asked for within a timeframe. */
  expiresAt?: string;
  sourceCallId: string;
  sourceTurnId: string;
  stamp: VoiceMemoryStampV1;
}

/** What was removed, and when, so an older reading cannot write it back. */
export interface VoiceMemoryTombstoneV1 {
  kind: VoiceMemoryKindV1;
  id: string;
  at: string;
  stamp: VoiceMemoryStampV1;
}

export interface VoiceMemoryRecordV1 {
  schemaVersion: 1;
  durable: VoiceMemoryEntryV1[];
  ongoing: VoiceMemoryEntryV1[];
  recent: VoiceMemoryEntryV1[];
  forgotten: VoiceMemoryTombstoneV1[];
  updatedAt?: string;
}

/** How long something asked for "within a timeframe" holds. */
export type VoiceMemoryHorizonV1 = "today" | "week";

/** Every operation names the source turn it came from. */
interface VoiceMemoryOperationBaseV1 {
  source: string;
}

export type VoiceMemoryOperationV1 = VoiceMemoryOperationBaseV1 &
  (
    | { kind: "durable/add"; id: string; text: string }
    | { kind: "durable/remove"; id: string }
    | { kind: "ongoing/add"; id: string; text: string }
    | { kind: "ongoing/remove"; id: string }
    /**
     * `until` is an enum and never a date. Whoever writes it — the spoken
     * tool or the end-of-call update — says only how long, and the applier
     * works out when from the source turn's own time and the person's
     * timezone. A model is not given a clock.
     */
    | { kind: "recent/add"; text: string; until?: VoiceMemoryHorizonV1 }
    | { kind: "recent/remove"; id: string }
  );

export interface VoiceMemoryUpdateV1 {
  operations: VoiceMemoryOperationV1[];
  /** Operations dropped by validation, in words the log can carry. */
  refusals: string[];
  /** The output could not be read at all, so nothing about it is known. */
  malformed: boolean;
}

export function emptyVoiceMemoryRecordV1(): VoiceMemoryRecordV1 {
  return {
    schemaVersion: 1,
    durable: [],
    ongoing: [],
    recent: [],
    forgotten: [],
  };
}

function clip(text: string, max: number): string {
  const line = text.replace(/\s+/g, " ").trim();
  return line.length <= max ? line : `${line.slice(0, max - 1)}…`;
}

/**
 * Anything the person or a Bot wrote, made safe to sit inside a tagged section
 * of the spoken prompt. Without it a transcript holding `</voice-memory>` ends
 * the block early and whatever follows it is read as prompt.
 */
export function escapeVoiceTagV1(text: string): string {
  return text.replace(/[<>]/g, (c) => (c === "<" ? "&lt;" : "&gt;"));
}

/** A recent line's identity is its own words, so re-recording it is a no-op. */
export function voiceMemoryTextKeyV1(text: string): string {
  const slug = text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug || "line";
}

function validId(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const id = value.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 48);
  return /^[a-z0-9][a-z0-9-]*$/.test(id) ? id : undefined;
}

/**
 * When something asked for within a timeframe stops applying.
 *
 * Only two horizons, and both are computed here from the person's own clock:
 * "today" ends at the end of their local day, "week" seven days on. A model
 * cannot supply a date, and "just for today" must stop tomorrow rather than
 * in a fortnight.
 */
export function voiceMemoryHorizonEndV1(
  horizon: VoiceMemoryHorizonV1,
  now: Date,
  timezone: string | undefined,
): string {
  if (horizon === "week") {
    return new Date(now.getTime() + 7 * 24 * 60 * 60_000).toISOString();
  }
  try {
    // The person's own midnight, not UTC's: "today" in Sydney is not today
    // in London, and the session already knows which one they are in. The
    // next calendar midnight is found rather than a fixed number of hours
    // added, because the day a clock change falls in is not 24 hours long.
    const format = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone ?? "UTC",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    const wallAt = (instant: number): number => {
      const parts = format.formatToParts(new Date(instant));
      const field = (type: string) =>
        Number(parts.find((part) => part.type === type)?.value ?? "0");
      return Date.UTC(
        field("year"),
        field("month") - 1,
        field("day"),
        field("hour"),
        field("minute"),
        field("second"),
      );
    };
    const offsetAt = (instant: number): number =>
      wallAt(instant) - Math.floor(instant / 1000) * 1000;
    const midnight =
      wallAt(now.getTime()) - (wallAt(now.getTime()) % 86_400_000) + 86_400_000;
    // Two passes: the first from the offset in force now, the second from the
    // offset in force at the candidate, which is what settles a clock change.
    // Where the clock changes at midnight itself that local time never
    // happens, and the first candidate is the instant the new day begins.
    const first = midnight - offsetAt(now.getTime());
    const second = midnight - offsetAt(first);
    const end = wallAt(second) === midnight ? second : first;
    return new Date(end).toISOString();
  } catch {
    return new Date(now.getTime() + 24 * 60 * 60_000).toISOString();
  }
}

/**
 * Reads what the model answered with. Untrusted in every direction: the
 * envelope may not be JSON, the operations may be anything, a fact may hold a
 * credential, and the source it names may not exist. Everything it cannot make
 * sense of is refused by name rather than guessed at, one bad operation never
 * costs the good ones, and output that is not an update at all is reported as
 * malformed rather than as an empty update — the two mean different things to
 * the job that asked.
 */
export function decodeVoiceMemoryUpdateV1(raw: string): VoiceMemoryUpdateV1 {
  const malformed = (reason: string): VoiceMemoryUpdateV1 => ({
    operations: [],
    refusals: [reason],
    malformed: true,
  });
  const text = raw.slice(0, VOICE_MEMORY_MAX_OUTPUT_CHARS_V1);
  // Models fence JSON in markdown however firmly they are told not to.
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return malformed("the update was not JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(start, end + 1));
  } catch {
    return malformed("the update was not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return malformed("the update was not an object");
  }
  const list = (parsed as { operations?: unknown }).operations;
  if (!Array.isArray(list)) {
    return malformed("the update carried no operations");
  }
  const refusals: string[] = [];
  if (list.length > VOICE_MEMORY_MAX_OPERATIONS_V1) {
    refusals.push(
      `only the first ${VOICE_MEMORY_MAX_OPERATIONS_V1} operations were read`,
    );
  }
  const operations: VoiceMemoryOperationV1[] = [];
  for (const item of list.slice(0, VOICE_MEMORY_MAX_OPERATIONS_V1)) {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      refusals.push("an operation was not an object");
      continue;
    }
    const value = item as Record<string, unknown>;
    const kind = typeof value.kind === "string" ? value.kind : "";
    const id = validId(value.id);
    const source =
      typeof value.source === "string" ? value.source.trim().slice(0, 200) : "";
    const sentence = clip(
      typeof value.text === "string" ? value.text : "",
      VOICE_MEMORY_MAX_TEXT_CHARS_V1,
    );
    if (!source) {
      // A fact with no turn behind it has no time and no provenance, and the
      // model must not be allowed to supply either.
      refusals.push(`${clip(kind, 40) || "an operation"} named no source turn`);
      continue;
    }
    const needsText =
      kind === "durable/add" || kind === "ongoing/add" || kind === "recent/add";
    if (needsText) {
      if (!sentence) {
        refusals.push(`${kind} carried no text`);
        continue;
      }
      // The same rule Memory holds: a credential is refused, not redacted.
      const secret = refuseMemorySecretV1(sentence);
      if (secret) {
        refusals.push(secret.reason);
        continue;
      }
    }
    switch (kind) {
      case "durable/add":
      case "ongoing/add":
        operations.push({
          kind,
          id: id ?? voiceMemoryTextKeyV1(sentence),
          text: sentence,
          source,
        });
        break;
      case "durable/remove":
      case "ongoing/remove":
      case "recent/remove":
        if (!id) {
          refusals.push(`${kind} named nothing to remove`);
          continue;
        }
        operations.push({ kind, id, source });
        break;
      case "recent/add": {
        // Only the two horizons, and only as words. Anything else — a date,
        // a duration, a month — is dropped rather than interpreted.
        const until =
          value.until === "today" || value.until === "week"
            ? value.until
            : undefined;
        if (value.until !== undefined && until === undefined) {
          refusals.push(
            "recent/add named a timeframe that is not today or week",
          );
        }
        operations.push({
          kind: "recent/add",
          text: sentence,
          source,
          ...(until ? { until } : {}),
        });
        break;
      }
      default:
        refusals.push(`unknown operation ${clip(kind, 40) || "(none)"}`);
    }
  }
  return { operations, refusals, malformed: false };
}

// ---------------------------------------------------------------------------
// Applying

/** One turn an operation may be grounded in. */
export interface VoiceMemorySourceTurnV1 {
  /** The ledger's turn id; what an operation's `source` must name. */
  id: string;
  /** Its place in its call, from one: half of the ordering stamp. */
  ordinal: number;
  /** The call it belongs to, which is not always the call being summarised. */
  callId: string;
  /** The call's start in epoch milliseconds: the other half of the stamp. */
  sequence: number;
  /** When the turn was admitted: the date any fact from it carries. */
  at: string;
  said: string;
  answered?: string;
}

export interface VoiceMemoryApplyInputV1 {
  operations: readonly VoiceMemoryOperationV1[];
  /** The turns the operations may name. An operation naming another is refused. */
  sources: readonly VoiceMemorySourceTurnV1[];
  /** The person's own zone, so "today" ends at their midnight and not UTC's. */
  timezone?: string;
  /**
   * The oldest place in session order that unread source still sits at. A
   * removal fence at or after it is kept whatever the count, because the
   * conversation that could write the fact back has not been read yet.
   */
  fence?: VoiceMemoryStampV1;
}

export interface VoiceMemoryApplyResultV1 {
  record: VoiceMemoryRecordV1;
  /** Operations that were read but not acted on, by name. */
  skipped: string[];
  /** Operations that changed the record. */
  changed: number;
}

function stampOf(turn: VoiceMemorySourceTurnV1): VoiceMemoryStampV1 {
  return { sequence: turn.sequence, turn: turn.ordinal };
}

/**
 * Holds the removal fences to their count, oldest first — but only the ones
 * nothing can still argue with.
 *
 * A fence older than every unread conversation can never be needed again: for
 * it to matter, some unread turn would have to sit before it in session order,
 * and by definition none does. A fence at or after that point is kept even
 * past the cap, because dropping it is what lets a stale summary write a
 * corrected fact back.
 *
 * So the cap is a soft one and the list has no ceiling. What keeps that from
 * becoming a storage problem is where the fences live: `VoiceMemoryLedgerV1`
 * writes each one as its own record, never inside the record it fences.
 */
function trimVoiceMemoryTombstonesV1(
  forgotten: readonly VoiceMemoryTombstoneV1[],
  fence: VoiceMemoryStampV1 | undefined,
): VoiceMemoryTombstoneV1[] {
  let over = forgotten.length - VOICE_MEMORY_MAX_TOMBSTONES_V1;
  if (over <= 0) return [...forgotten];
  const kept: VoiceMemoryTombstoneV1[] = [];
  for (const tombstone of forgotten) {
    const prunable =
      fence === undefined ||
      compareVoiceMemoryStampV1(tombstone.stamp, fence) < 0;
    if (over > 0 && prunable) {
      over -= 1;
      continue;
    }
    kept.push(tombstone);
  }
  return kept;
}

function forgottenAfter(
  record: VoiceMemoryRecordV1,
  kind: VoiceMemoryKindV1,
  id: string,
  stamp: VoiceMemoryStampV1,
): boolean {
  return record.forgotten.some(
    (tombstone) =>
      tombstone.kind === kind &&
      tombstone.id === id &&
      compareVoiceMemoryStampV1(tombstone.stamp, stamp) > 0,
  );
}

/**
 * Folds one update into the record. Total and idempotent: applying the same
 * operations twice leaves the same record, and nothing here throws.
 */
export function applyVoiceMemoryUpdateV1(
  record: VoiceMemoryRecordV1,
  input: VoiceMemoryApplyInputV1,
): VoiceMemoryApplyResultV1 {
  const sources = new Map(input.sources.map((turn) => [turn.id, turn]));
  const skipped: string[] = [];
  let changed = 0;
  let next: VoiceMemoryRecordV1 = { ...record };
  let newest = record.updatedAt ?? "";

  const add = (
    kind: VoiceMemoryKindV1,
    entry: VoiceMemoryEntryV1,
    cap: number,
  ): void => {
    const list = next[kind];
    if (forgottenAfter(next, kind, entry.id, entry.stamp)) {
      // They dropped this after the conversation being read said it.
      skipped.push(`${kind} ${entry.id} was dropped more recently`);
      return;
    }
    const existing = list.find((item) => item.id === entry.id);
    if (
      existing &&
      compareVoiceMemoryStampV1(existing.stamp, entry.stamp) > 0
    ) {
      skipped.push(`${kind} ${entry.id} is already newer`);
      return;
    }
    if (!existing && list.length >= cap) {
      // Nothing is evicted to make room: a fact the person stated stays until
      // they retract it, and the refusal is visible instead.
      skipped.push(
        `${kind} memory is full at ${cap}; ${entry.id} was not added and nothing was dropped`,
      );
      return;
    }
    if (existing) {
      const same =
        existing.text === entry.text &&
        existing.at === entry.at &&
        existing.expiresAt === entry.expiresAt &&
        existing.sourceTurnId === entry.sourceTurnId;
      if (same) return;
      next = {
        ...next,
        [kind]: list.map((item) => (item.id === entry.id ? entry : item)),
      };
    } else {
      next = { ...next, [kind]: [...list, entry] };
    }
    changed += 1;
  };

  const remove = (
    kind: VoiceMemoryKindV1,
    id: string,
    turn: VoiceMemorySourceTurnV1,
  ): void => {
    const stamp = stampOf(turn);
    const existing = next[kind].find((item) => item.id === id);
    if (existing && compareVoiceMemoryStampV1(existing.stamp, stamp) > 0) {
      skipped.push(`${kind} ${id} is newer than the request to drop it`);
      return;
    }
    // The tombstone goes in whether or not the entry was there: a removal
    // read out of order still has to fence the write that would undo it.
    // One fence per thing, holding the latest removal of it — a fence only
    // ever refuses what is older than itself, so the newer of two says
    // everything the older did.
    const prior = next.forgotten.find(
      (tombstone) => tombstone.kind === kind && tombstone.id === id,
    );
    const fence =
      prior && compareVoiceMemoryStampV1(prior.stamp, stamp) > 0
        ? prior
        : { kind, id, at: turn.at, stamp };
    next = {
      ...next,
      [kind]: next[kind].filter((item) => item.id !== id),
      forgotten: [
        ...next.forgotten.filter(
          (tombstone) => !(tombstone.kind === kind && tombstone.id === id),
        ),
        fence,
      ],
    };
    if (existing) changed += 1;
  };

  for (const operation of input.operations) {
    const turn = sources.get(operation.source);
    if (!turn) {
      skipped.push(
        `${operation.kind} named a turn that is not in this conversation`,
      );
      continue;
    }
    if (turn.at > newest) newest = turn.at;
    const entry = (text: string, expiresAt?: string): VoiceMemoryEntryV1 => ({
      id: "",
      text,
      at: turn.at,
      ...(expiresAt ? { expiresAt } : {}),
      sourceCallId: turn.callId,
      sourceTurnId: turn.id,
      stamp: stampOf(turn),
    });
    switch (operation.kind) {
      case "durable/add":
        add(
          "durable",
          { ...entry(operation.text), id: operation.id },
          VOICE_MEMORY_MAX_DURABLE_V1,
        );
        break;
      case "durable/remove":
        remove("durable", operation.id, turn);
        break;
      case "ongoing/add":
        add(
          "ongoing",
          { ...entry(operation.text), id: operation.id },
          VOICE_MEMORY_MAX_ONGOING_V1,
        );
        break;
      case "ongoing/remove":
        remove("ongoing", operation.id, turn);
        break;
      case "recent/add": {
        const id = voiceMemoryTextKeyV1(operation.text);
        const existing = next.recent.find((item) => item.id === id);
        if (existing && existing.sourceTurnId === turn.id) {
          // Reading the same turn again is not the person saying it again.
          skipped.push(`recent ${id} was already recorded`);
          break;
        }
        if (
          existing &&
          compareVoiceMemoryStampV1(existing.stamp, stampOf(turn)) >= 0
        ) {
          // Carried forward from an older conversation: it keeps its date.
          skipped.push(`recent ${id} already has a newer telling`);
          break;
        }
        add(
          "recent",
          {
            ...entry(
              operation.text,
              // Dated here, from the turn that asked for it: "just for today"
              // means the day they said it on, whenever this runs.
              operation.until
                ? voiceMemoryHorizonEndV1(
                    operation.until,
                    new Date(turn.at),
                    input.timezone,
                  )
                : undefined,
            ),
            id,
          },
          Number.POSITIVE_INFINITY,
        );
        break;
      }
      case "recent/remove":
        remove("recent", operation.id, turn);
        break;
    }
  }
  return {
    record: {
      ...next,
      forgotten: trimVoiceMemoryTombstonesV1(next.forgotten, input.fence),
      ...(newest ? { updatedAt: newest } : {}),
    },
    skipped,
    changed,
  };
}

/**
 * Drops handover lines at their own expiry, past their fourteen days, or
 * beyond their count.
 *
 * Only the handover. Durable facts and open items are never dropped here:
 * they leave memory when the person says so and at no other time.
 */
export function pruneVoiceMemoryV1(
  record: VoiceMemoryRecordV1,
  now: Date,
): VoiceMemoryRecordV1 {
  const cutoff = now.getTime() - VOICE_MEMORY_RECENT_DAYS_V1 * 24 * 60 * 60_000;
  const fresh = record.recent.filter(
    (item) =>
      Date.parse(item.at) >= cutoff &&
      (!item.expiresAt || Date.parse(item.expiresAt) > now.getTime()),
  );
  return {
    ...record,
    recent:
      fresh.length <= VOICE_MEMORY_MAX_RECENT_V1
        ? fresh
        : [...fresh]
            .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
            .slice(0, VOICE_MEMORY_MAX_RECENT_V1)
            .reverse(),
  };
}

/** True when the record holds nothing worth putting in a prompt. */
export function voiceMemoryIsEmptyV1(record: VoiceMemoryRecordV1): boolean {
  return (
    record.durable.length === 0 &&
    record.ongoing.length === 0 &&
    record.recent.length === 0
  );
}

/**
 * What a spoken "forget that" names.
 *
 * The person says it in their own words, so an id is tried first and then the
 * words themselves. It is deliberately literal — a containment match on
 * normalised text — because a fuzzy one would drop things they did not mean;
 * nothing matching is an ordinary answer the assistant says out loud.
 */
export function matchVoiceMemoryV1(
  record: VoiceMemoryRecordV1,
  wanted: string,
): { kind: VoiceMemoryKindV1; id: string }[] {
  const id = voiceMemoryTextKeyV1(wanted);
  const needle = wanted.toLowerCase().replace(/\s+/g, " ").trim();
  const hit = (entry: VoiceMemoryEntryV1) =>
    entry.id === id ||
    entry.id === wanted.trim() ||
    (needle.length >= 4 &&
      entry.text.toLowerCase().replace(/\s+/g, " ").includes(needle));
  return [
    ...record.durable
      .filter(hit)
      .map((entry) => ({ kind: "durable" as const, id: entry.id })),
    ...record.ongoing
      .filter(hit)
      .map((entry) => ({ kind: "ongoing" as const, id: entry.id })),
    ...record.recent
      .filter(hit)
      .map((entry) => ({ kind: "recent" as const, id: entry.id })),
  ];
}

/**
 * What a correction drops when it names the thing it is replacing.
 *
 * By id and by id alone. `replaces` is an id — the tool says so and the
 * end-of-call instruction lists the ids to correct — and a correction is a
 * deletion, so it never matches on wording: "the morning" would take the
 * open question about the morning standup along with the preference about
 * morning calls, and nothing would say out loud that it had gone. The id as
 * stored is tried first, so an id the prompt listed lands exactly as listed;
 * then the same normalisation a spoken id would need.
 *
 * When the record holds no such id the name itself is fenced in all three
 * kinds. Nothing matching usually means the conversation that stated the old
 * fact has not been summarised yet, and the removal has to be on record
 * before that summary lands or it writes the contradiction back.
 *
 * The fence from that second case is best-effort: it only refuses the later
 * summary if the summary happens to choose the same id for the fact that the
 * person's own words slug to. Nothing here can make two independent model
 * calls agree on a name. The end-of-call instruction carries the weight
 * instead: it shows what is remembered with its times, what has been dropped
 * since, and says that these turns being older is never a reason to write a
 * remembered fact back.
 */
export function voiceMemoryCorrectionTargetsV1(
  record: VoiceMemoryRecordV1,
  replaces: string,
): { kind: VoiceMemoryKindV1; id: string }[] {
  const exact = replaces.trim();
  const id = voiceMemoryTextKeyV1(replaces);
  const named = (entry: VoiceMemoryEntryV1) =>
    entry.id === exact || entry.id === id;
  const matched: { kind: VoiceMemoryKindV1; id: string }[] = [
    ...record.durable
      .filter(named)
      .map((entry) => ({ kind: "durable" as const, id: entry.id })),
    ...record.ongoing
      .filter(named)
      .map((entry) => ({ kind: "ongoing" as const, id: entry.id })),
    ...record.recent
      .filter(named)
      .map((entry) => ({ kind: "recent" as const, id: entry.id })),
  ];
  if (matched.length > 0) return matched;
  return [
    { kind: "durable", id },
    { kind: "ongoing", id },
    { kind: "recent", id },
  ];
}

// ---------------------------------------------------------------------------
// Rendering

/**
 * The memory section of the spoken system prompt.
 *
 * Everything the record holds is rendered. The bounds are on what may be
 * *written* — a fact past the cap is refused out loud — so there is nothing
 * stored that the assistant cannot see: a preference silently below a render
 * cut would be remembered and never acted on, which is worse than not having
 * kept it.
 */
export function renderVoiceMemoryLinesV1(
  record: VoiceMemoryRecordV1,
  options: { carried?: readonly VoiceMemorySourceTurnV1[] } = {},
): string[] {
  const lines: string[] = [];
  if (!voiceMemoryIsEmptyV1(record)) {
    lines.push("<voice-memory>");
    lines.push("What you remember from your previous conversations:");
    const durable = record.durable;
    if (durable.length > 0) {
      lines.push("Keep to these:");
      for (const entry of durable) {
        lines.push(
          `- (${escapeVoiceTagV1(entry.id)}) ${escapeVoiceTagV1(entry.text)}`,
        );
      }
    }
    const ongoing = record.ongoing;
    if (ongoing.length > 0) {
      lines.push("Still open:");
      for (const entry of ongoing) {
        lines.push(
          `- (${escapeVoiceTagV1(entry.id)}) ${escapeVoiceTagV1(entry.text)} [since ${day(entry.at)}]`,
        );
      }
    }
    const recent = record.recent;
    if (recent.length > 0) {
      lines.push("Recently:");
      for (const entry of recent) {
        lines.push(
          `- ${day(entry.at)}: ${escapeVoiceTagV1(entry.text)}${
            entry.expiresAt ? ` [until ${day(entry.expiresAt)}]` : ""
          }`,
        );
      }
    }
    lines.push(
      "These are dated notes, not live state. Never claim what a Bot is doing from them.",
    );
    lines.push("</voice-memory>");
  }
  const carried = options.carried ?? [];
  if (carried.length > 0) {
    lines.push("<last-conversation>");
    lines.push("The end of your previous conversation with them:");
    for (const turn of carried) {
      lines.push(
        `- ${day(turn.at)} they said: ${escapeVoiceTagV1(clip(turn.said, 240))}`,
      );
      if (turn.answered) {
        lines.push(
          `  you answered: ${escapeVoiceTagV1(clip(turn.answered, 240))}`,
        );
      }
    }
    lines.push("</last-conversation>");
  }
  return lines;
}

function day(at: string): string {
  return at.slice(0, 10);
}

/**
 * Where something sits in this person's spoken history, for the end-of-call
 * request: the time it was admitted, and the stamp that orders it. A day is
 * not enough there — a correction and the turn it corrects are usually the
 * same calendar day, and the model is being asked which came first.
 */
function moment(at: string, stamp: VoiceMemoryStampV1): string {
  return `${at}, call ${stamp.sequence} turn ${stamp.turn}`;
}

/**
 * What the finalization asks for, appended after the conversation.
 *
 * The ids it lists are read at the moment the request is made, not at the
 * moment the call started, so an update written since — by the person's own
 * "forget that", or by a chunk already folded in — is what the model sees.
 *
 * What is remembered is dated, and what has been dropped since is listed, so
 * the conversation being read is placed against it: these turns can be older
 * than the record, and an older turn is never a reason to write a newer fact
 * back. The stamps refuse that deterministically whenever the ids agree; this
 * is what makes them agree when the person corrected something in their own
 * words and no id was ever cited.
 */
export function renderVoiceMemoryInstructionV1(input: {
  turns: readonly VoiceMemorySourceTurnV1[];
  record: VoiceMemoryRecordV1;
  progress: { from: number; total: number };
}): string {
  const lines = [
    "[end of conversation]",
    "That conversation is over. Do not speak. Reply with JSON and nothing else, recording what you should remember for the next one.",
    '{"operations":[{"kind":"durable/add","id":"short-slug","text":"...","source":"<turn id>"}]}',
    "Kinds:",
    "- durable/add, durable/remove — how this person wants spoken conversations to work, and facts about them that stay true until they say otherwise. Add one only when they said it. Correct one by issuing durable/add again under the same id. Use durable/remove when they asked you to forget it, or when what they said replaced it.",
    "- ongoing/add, ongoing/remove — a question left open, a decision not made, work not finished. Remove it under the same id once it is resolved, cancelled or replaced.",
    '- recent/add — at most three short lines about what this conversation was, so the next one can pick it up. For something they asked for within a timeframe ("just for today", "while I\'m away this week"), use recent/add with "until":"today" or "until":"week" — never a date of your own, and never durable/add. A request with a timeframe is never a standing preference.',
    "Every operation must carry `source`: the id of the turn below that the person said it in. An operation without one is discarded.",
    "Rules: record only what the person said or asked for, never your own guesses and never a Bot's status. Do not re-record anything already remembered below. Never record a password, key or token. Ids are lowercase words joined by hyphens. At most " +
      `${VOICE_MEMORY_MAX_OPERATIONS_V1} operations, each under ${VOICE_MEMORY_MAX_TEXT_CHARS_V1} characters.`,
    "This conversation may be older than what you already remember: every line below carries the time it was admitted and the call and turn that ordered it, and the turns you may cite carry the same. Compare those, not the calendar day. If a turn says something that a newer remembered line already changed — in different words, or under a name you would have chosen differently — leave the remembered line alone and record nothing for it. Record a change only where these turns are this person's own later word on it.",
    'If there is nothing worth remembering, answer {"operations":[]}.',
  ];
  const remembered = [
    ...input.record.durable.map(
      (entry) =>
        `- durable (${entry.id}) ${entry.text} [said ${moment(entry.at, entry.stamp)}]`,
    ),
    ...input.record.ongoing.map(
      (entry) =>
        `- ongoing (${entry.id}) ${entry.text} [since ${moment(entry.at, entry.stamp)}]`,
    ),
    // The handover too, and what already has an end on it: without this the
    // same "just for today" gets recorded again every call, and the one that
    // is already there looks like something nobody asked for.
    ...input.record.recent.map(
      (entry) =>
        `- recent (${entry.id}) ${entry.text} [said ${moment(entry.at, entry.stamp)}]${
          entry.expiresAt ? ` [until ${day(entry.expiresAt)}]` : ""
        }`,
    ),
  ];
  lines.push(
    remembered.length > 0
      ? "What you already remember, with the ids to correct or remove:"
      : "You remember nothing yet.",
  );
  lines.push(...remembered);
  // A fence stays on record after its id is re-added, because it is what
  // refuses a stale summary that writes the old text back. Showing it here as
  // well would put the same fact under "remembered" and "dropped" at once.
  const live = new Set(
    (["durable", "ongoing", "recent"] as const).flatMap((kind) =>
      input.record[kind].map((entry) => `${kind} ${entry.id}`),
    ),
  );
  const dropped = [...input.record.forgotten]
    .filter((tombstone) => !live.has(`${tombstone.kind} ${tombstone.id}`))
    .sort((left, right) => compareVoiceMemoryStampV1(left.stamp, right.stamp))
    .slice(-VOICE_MEMORY_INSTRUCTION_DROPPED_V1);
  if (dropped.length > 0) {
    lines.push("What they have since dropped or replaced, and when:");
    for (const tombstone of dropped) {
      lines.push(
        `- ${tombstone.kind} (${tombstone.id}) [dropped ${moment(tombstone.at, tombstone.stamp)}]`,
      );
    }
  }
  lines.push(
    "The turns you may cite, oldest first, each with when it was said:",
  );
  for (const turn of input.turns) {
    lines.push(
      `- ${turn.id} [${moment(turn.at, { sequence: turn.sequence, turn: turn.ordinal })}]: ${clip(turn.said, 160)}`,
    );
  }
  if (input.progress.total > input.turns.length) {
    lines.push(
      `(This is part of a longer conversation: turns ${
        input.progress.from + 1
      }–${input.progress.from + input.turns.length} of ${
        input.progress.total
      }. The rest is read separately; record only what these turns hold.)`,
    );
  }
  return lines.join("\n");
}

/**
 * The finalization request, as messages.
 *
 * `prefix` is the system message the call itself last sent, kept so a provider
 * that caches prompt prefixes has something to match. Only that message is
 * shared with the call's own requests: the turns below it are the whole
 * conversation rather than the twelve the live prompt carried, and the
 * instruction is new. A cache hit on the system message alone is the honest
 * bound here, and nothing depends on getting one.
 */
export function renderVoiceMemoryRequestMessagesV1(input: {
  system?: string;
  turns: readonly VoiceMemorySourceTurnV1[];
  record: VoiceMemoryRecordV1;
  progress: { from: number; total: number };
}): { role: "system" | "user" | "assistant"; content: string }[] {
  const messages: { role: "system" | "user" | "assistant"; content: string }[] =
    [];
  if (input.system) messages.push({ role: "system", content: input.system });
  for (const turn of input.turns) {
    messages.push({ role: "user", content: turn.said });
    if (turn.answered) {
      messages.push({ role: "assistant", content: turn.answered });
    }
  }
  messages.push({
    role: "user",
    content: renderVoiceMemoryInstructionV1({
      turns: input.turns,
      record: input.record,
      progress: input.progress,
    }),
  });
  return messages;
}

// ---------------------------------------------------------------------------
// The durable job

export type VoiceMemoryJobStateV1 =
  "pending" | "spending" | "applied" | "failed";

/**
 * One ended call's memory work.
 *
 * It holds no source. The ledger's turn records are the source, and a call
 * with a job that is not `applied` keeps its turns out of the ledger's
 * retention sweep, so nothing has to be copied to be safe — and a call long
 * enough to exceed a storage value cannot exist.
 */
export interface VoiceMemoryJobV1 {
  schemaVersion: 1;
  callId: string;
  /** The call's start in epoch milliseconds: session order, durably. */
  sequence: number;
  createdAt: string;
  state: VoiceMemoryJobStateV1;
  /** Turns of this call already folded into memory; the rest are still owed. */
  cursor: number;
  /** Attempts at the chunk that starts at `cursor`. */
  attempts: number;
  /** Written before the model request leaves, so an eviction is not ambiguous. */
  spentAt?: string;
  settledAt?: string;
  failure?: string;
  /** The call's own last system prompt, so the request repeats it. */
  system?: string;
}

export interface VoiceMemoryChunkV1 {
  job: VoiceMemoryJobV1;
  turns: VoiceMemorySourceTurnV1[];
  from: number;
  to: number;
  total: number;
  /**
   * How many turns each call in this window has altogether, its own and every
   * carried one. A carried call is only finished when its cursor reaches its
   * own total — a long one read forty turns at a time is resumed, not retired
   * because a later call happened to read its opening.
   */
  totals: { callId: string; total: number }[];
}

/** Reads one call's admitted turns. The ledger is the only implementation. */
export type VoiceMemorySourceReaderV1 = (
  callId: string,
) => Promise<VoiceMemorySourceTurnV1[]>;

/**
 * The voice session's own memory, over the Durable Object's storage.
 *
 * Every mutation runs through one chain. A Durable Object runs one thread,
 * but an `await` inside a read-modify-write is still a place where the
 * hang-up handler, an abandoned-call alarm and a spoken `remember` can
 * interleave — so they are serialized here rather than hoped about. The chain
 * is also what makes claiming a job a claim: of two finalizations racing for
 * the same call, only one leaves `claimChunk` holding it.
 */
export class VoiceMemoryLedgerV1 {
  #queue: Promise<unknown> = Promise.resolve();

  constructor(private readonly storage: VoiceLedgerStorageV1) {}

  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    // A failure must not poison the chain for everything behind it.
    this.#queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  async read(): Promise<VoiceMemoryRecordV1> {
    return this.compose(await this.readForgotten());
  }

  /** The stored fences, one per removed thing, in key order. */
  private async readForgotten(): Promise<Map<string, VoiceMemoryTombstoneV1>> {
    return this.storage.list<VoiceMemoryTombstoneV1>({
      prefix: VOICE_MEMORY_FORGOTTEN_PREFIX_V1,
    });
  }

  /**
   * The record as the pure applier and the prompt want it: fences included,
   * oldest first. The keys sort by what was fenced rather than by when, so
   * the order the rest of the code reads in is put back here.
   */
  private async compose(
    fences: Map<string, VoiceMemoryTombstoneV1>,
  ): Promise<VoiceMemoryRecordV1> {
    const stored = await this.storage.get<VoiceMemoryRecordV1>(
      VOICE_MEMORY_RECORD_KEY_V1,
    );
    return {
      ...(stored ?? emptyVoiceMemoryRecordV1()),
      forgotten: [...fences.values()]
        .filter((fence) => fence !== undefined)
        .sort((left, right) =>
          compareVoiceMemoryStampV1(left.stamp, right.stamp),
        ),
    };
  }

  /**
   * Writes the fences, one record per fenced thing, and says which keys the
   * new list occupies. Only a fence that changed is written, and the only
   * value a write can replace is that same thing's older fence — so a failure
   * part way through leaves every fence already committed still standing.
   */
  private async writeForgotten(
    before: Map<string, VoiceMemoryTombstoneV1>,
    forgotten: readonly VoiceMemoryTombstoneV1[],
  ): Promise<Set<string>> {
    const keys = new Set<string>();
    for (const fence of forgotten) {
      const key = forgottenKey(fence.kind, fence.id);
      keys.add(key);
      const existing = before.get(key);
      if (existing && JSON.stringify(existing) === JSON.stringify(fence)) {
        continue;
      }
      await this.storage.put(key, fence);
    }
    return keys;
  }

  /**
   * Folds operations in and prunes in one step. The tools the person drives
   * and the background finalization both come through here, so a spoken
   * "forget that" and a summary cannot disagree about the rules or about who
   * wrote last.
   */
  async apply(
    input: VoiceMemoryApplyInputV1 & { now: Date },
  ): Promise<VoiceMemoryApplyResultV1> {
    return this.serial(async () => {
      // Source that has not been read yet is the only thing that can write a
      // forgotten fact back, so the oldest of it is where the removal fences
      // stop being disposable. That is the oldest unsummarised job and also
      // the call being spoken, which has no job at all until it ends.
      const unread = [
        (await this.unsummarisedJobs()).at(0)?.sequence,
        ...input.sources.map((turn) => turn.sequence),
      ].filter((sequence): sequence is number => sequence !== undefined);
      const before = await this.readForgotten();
      const result = applyVoiceMemoryUpdateV1(await this.compose(before), {
        ...input,
        ...(unread.length > 0
          ? { fence: { sequence: Math.min(...unread), turn: 0 } }
          : {}),
      });
      const pruned = pruneVoiceMemoryV1(result.record, input.now);
      // Fences first, then the memory they fence, and only then the fences
      // the new list no longer holds. A failure between the steps leaves a
      // removal recorded against an entry that is still there — the person
      // hears that the write failed and says it again — where the other order
      // would drop the entry and lose the fence that keeps a stale summary
      // from writing it back.
      const written = await this.writeForgotten(before, pruned.forgotten);
      await this.storage.put(VOICE_MEMORY_RECORD_KEY_V1, {
        ...pruned,
        forgotten: [],
      });
      for (const key of before.keys()) {
        if (!written.has(key)) await this.storage.delete(key);
      }
      return { ...result, record: pruned };
    });
  }

  // -- jobs -----------------------------------------------------------------

  async readJob(callId: string): Promise<VoiceMemoryJobV1 | undefined> {
    return this.storage.get<VoiceMemoryJobV1>(jobKey(callId));
  }

  async jobs(): Promise<VoiceMemoryJobV1[]> {
    const rows = await this.storage.list<VoiceMemoryJobV1>({
      prefix: VOICE_MEMORY_JOB_PREFIX_V1,
    });
    return [...rows.values()].sort(
      (left, right) => left.sequence - right.sequence,
    );
  }

  /**
   * Records the intent to summarise one ended call, before the call record
   * that named it is deleted. Idempotent by call id: the hang-up, the socket
   * close and the abandoned-call alarm all land here, and only the first
   * writes anything.
   *
   * `system` is the call's own last system message, if the object still holds
   * it. An eviction loses it, and the request then goes without a prefix —
   * that costs a possible cache hit and nothing else.
   */
  async createJob(input: {
    callId: string;
    sequence: number;
    system?: string;
    at: Date;
  }): Promise<{ status: "created" | "existing"; job: VoiceMemoryJobV1 }> {
    return this.serial(async () => {
      const existing = await this.readJob(input.callId);
      if (existing) return { status: "existing" as const, job: existing };
      const system = input.system?.slice(0, 16_000);
      const job: VoiceMemoryJobV1 = {
        schemaVersion: 1,
        callId: input.callId,
        sequence: input.sequence,
        createdAt: input.at.toISOString(),
        state: "pending",
        cursor: 0,
        attempts: 0,
        ...(system ? { system } : {}),
      };
      await this.storage.put(jobKey(input.callId), job);
      return { status: "created" as const, job };
    });
  }

  /**
   * Claims the next chunk and records the spend before the request leaves.
   *
   * Only one caller can hold a job: the claim is the `pending` → `spending`
   * transition, made inside the chain, so a duplicate end notification finds
   * nothing to claim and makes no second model call. A call whose turns have
   * all been read — or that never had any — is finished here rather than
   * spending anything.
   */
  async claimChunk(input: {
    callId: string;
    at: Date;
    read: VoiceMemorySourceReaderV1;
  }): Promise<VoiceMemoryChunkV1 | undefined> {
    return this.serial(async () => {
      const job = await this.readJob(input.callId);
      if (!job || job.state !== "pending") return undefined;
      if (job.attempts >= VOICE_MEMORY_MAX_ATTEMPTS_V1) return undefined;
      const own = await input.read(job.callId);
      const totals = [{ callId: job.callId, total: own.length }];
      // Earlier calls nobody finished are read with this one — the newest of
      // them first, since a call that finishes leaves the `failed` set and the
      // backlog still drains completely. Within the window that is read, the
      // turns stay in the order they happened, so nothing it held is lost.
      const carried: VoiceMemorySourceTurnV1[] = [];
      // Only calls that have given up on their own. A `pending` one still has
      // its own scheduled path, and reading it here as well would put two
      // finalizations over one call's source at once.
      const earlier = (await this.jobs())
        .filter(
          (other) =>
            other.callId !== job.callId &&
            other.sequence < job.sequence &&
            other.state === "failed",
        )
        .slice(-VOICE_MEMORY_MAX_CARRIED_CALLS_V1);
      for (const other of earlier) {
        const turns = await input.read(other.callId);
        totals.push({ callId: other.callId, total: turns.length });
        carried.push(...turns.slice(other.cursor));
      }
      const turns = [...carried, ...own.slice(job.cursor)];
      if (turns.length === 0) {
        await this.storage.put(jobKey(input.callId), {
          ...job,
          state: "applied",
          cursor: own.length,
          settledAt: input.at.toISOString(),
        });
        return undefined;
      }
      const claimed: VoiceMemoryJobV1 = {
        ...job,
        state: "spending",
        attempts: job.attempts + 1,
        spentAt: input.at.toISOString(),
      };
      await this.storage.put(jobKey(input.callId), claimed);
      const window = turns.slice(0, VOICE_MEMORY_CHUNK_TURNS_V1);
      const ownRead = window.filter((turn) => turn.callId === job.callId);
      return {
        job: claimed,
        turns: window,
        from: job.cursor,
        // Where this chunk actually reaches in its own call, as an ordinal
        // rather than a count added to the cursor.
        to:
          ownRead.length > 0
            ? Math.max(...ownRead.map((turn) => turn.ordinal))
            : job.cursor,
        total: own.length,
        totals,
      };
    });
  }

  /**
   * The request left and did not come back with an answer we can read as a
   * whole. It is not repeated: a gateway model request has no idempotency
   * key, so a retry may pay twice for a call that already ran. The job is
   * failed, its turns stay in the ledger, and the next call reads them.
   */
  async abandonChunk(callId: string, failure: string, at: Date): Promise<void> {
    await this.serial(async () => {
      const job = await this.readJob(callId);
      if (!job || job.state !== "spending") return;
      await this.storage.put(jobKey(callId), {
        ...job,
        state: "failed",
        failure,
        settledAt: at.toISOString(),
      });
    });
  }

  /**
   * The answer arrived whole and could not be read as an update. That is a
   * completed call with a known outcome, so asking again is a new, deliberate
   * request rather than a possible second payment for the same one — bounded
   * by the attempt count.
   */
  async retryChunk(
    callId: string,
    failure: string,
    at: Date,
  ): Promise<boolean> {
    return this.serial(async () => {
      const job = await this.readJob(callId);
      if (!job || job.state !== "spending") return false;
      const exhausted = job.attempts >= VOICE_MEMORY_MAX_ATTEMPTS_V1;
      await this.storage.put(jobKey(callId), {
        ...job,
        state: exhausted ? "failed" : "pending",
        failure,
        settledAt: at.toISOString(),
      });
      return !exhausted;
    });
  }

  /**
   * Applies one chunk's update and advances the cursor past the turns of this
   * call that it read. Turns carried from an earlier call are not consumed
   * here: that call's own job advances when it is read.
   */
  async applyChunk(input: {
    callId: string;
    chunk: VoiceMemoryChunkV1;
    update: VoiceMemoryUpdateV1;
    timezone?: string;
    at: Date;
  }): Promise<
    | { status: "applied"; done: boolean; skipped: string[] }
    | { status: "stale" }
  > {
    const job = await this.readJob(input.callId);
    if (!job || job.state !== "spending" || job.cursor !== input.chunk.from) {
      return { status: "stale" };
    }
    const result = await this.apply({
      operations: input.update.operations,
      sources: input.chunk.turns,
      ...(input.timezone ? { timezone: input.timezone } : {}),
      now: input.at,
    });
    return this.serial(async () => {
      const current = await this.readJob(input.callId);
      if (!current || current.state !== "spending") {
        return { status: "stale" as const };
      }
      // Earlier calls read alongside this one advance by exactly what this
      // chunk read of them, and are finished only when their own source runs
      // out. A long carried call read forty turns at a time keeps the rest.
      const seen = new Set<string>();
      let carriedLeft = false;
      for (const turn of input.chunk.turns) {
        if (turn.callId === input.callId || seen.has(turn.callId)) continue;
        seen.add(turn.callId);
        const other = await this.readJob(turn.callId);
        if (!other || other.state === "applied") continue;
        // The highest turn of that call this chunk covered, not a count added
        // to whatever the cursor says now: absolute, so two readers that
        // overlap settle on the same place instead of each adding their own
        // length and stepping over source neither of them read.
        const covered = Math.max(
          ...input.chunk.turns
            .filter((item) => item.callId === turn.callId)
            .map((item) => item.ordinal),
        );
        const cursor = Math.max(other.cursor, covered);
        const total =
          input.chunk.totals.find((item) => item.callId === turn.callId)
            ?.total ?? cursor;
        if (cursor < total) carriedLeft = true;
        await this.storage.put(jobKey(turn.callId), {
          ...other,
          // Its own state is left alone until it is done: a failed carried
          // call must not become claimable again and spend a second time.
          ...(cursor >= total ? { state: "applied" as const } : {}),
          cursor,
          settledAt: input.at.toISOString(),
        });
      }
      // This call is finished when its own turns are read *and* nothing it
      // carried has turns left: otherwise it goes round again and reads them,
      // rather than leaving them for whenever the next conversation happens.
      const done = input.chunk.to >= input.chunk.total && !carriedLeft;
      await this.storage.put(jobKey(input.callId), {
        ...current,
        state: done ? "applied" : "pending",
        cursor: input.chunk.to,
        attempts: 0,
        settledAt: input.at.toISOString(),
      });
      return { status: "applied" as const, done, skipped: result.skipped };
    });
  }

  /**
   * On waking: a job that was mid-request when the object went away has an
   * unknown outcome. It is recorded as failed and never re-issued; its turns
   * stay in the ledger for the next call's finalization to read.
   */
  async failUncertainJobs(at: Date): Promise<string[]> {
    const failed: string[] = [];
    for (const job of await this.jobs()) {
      if (job.state !== "spending") continue;
      await this.abandonChunk(
        job.callId,
        VOICE_MEMORY_UNCERTAIN_FAILURE_V1,
        at,
      );
      failed.push(job.callId);
    }
    return failed;
  }

  /** Jobs with work left that has not exhausted its attempts. */
  async pendingJobs(): Promise<VoiceMemoryJobV1[]> {
    return (await this.jobs()).filter(
      (job) =>
        job.state === "pending" && job.attempts < VOICE_MEMORY_MAX_ATTEMPTS_V1,
    );
  }

  /**
   * Calls whose turns nothing has finished folding into memory. Their turns
   * are protected from the ledger's retention sweep, and they are never
   * deleted for being old or for having been overtaken: source that was
   * admitted and not yet read is not disposable.
   */
  async unsummarisedJobs(): Promise<VoiceMemoryJobV1[]> {
    return (await this.jobs()).filter((job) => job.state !== "applied");
  }

  /**
   * The tail of the previous call, when its finalization has not landed yet.
   *
   * This is temporary continuity, not memory: the next conversation must not
   * open blank because a background summary is still in flight or failed. It
   * is bounded, it keeps each turn's own time, and it disappears the moment
   * the finalization it belongs to applies.
   */
  async carriedContinuity(
    read: VoiceMemorySourceReaderV1,
    limit = VOICE_MEMORY_CONTINUITY_TURNS_V1,
  ): Promise<VoiceMemorySourceTurnV1[]> {
    const newestJob = (await this.unsummarisedJobs()).at(-1);
    if (!newestJob) return [];
    const turns = await read(newestJob.callId);
    return turns.slice(newestJob.cursor).slice(-limit);
  }

  /**
   * Drops jobs whose work is finished and whose retention has passed. An
   * unfinished job is never dropped: its call's turns are the only record of
   * what was said, and being old is not a reason to lose them.
   */
  async retireJobs(at: Date): Promise<string[]> {
    return this.serial(async () => {
      const retired: string[] = [];
      for (const job of await this.jobs()) {
        if (job.state !== "applied") continue;
        if (
          at.getTime() - Date.parse(job.createdAt) >
          VOICE_MEMORY_JOB_RETENTION_MS_V1
        ) {
          await this.storage.delete(jobKey(job.callId));
          retired.push(job.callId);
        }
      }
      return retired;
    });
  }
}

function jobKey(callId: string): string {
  return `${VOICE_MEMORY_JOB_PREFIX_V1}${callId}`;
}

function forgottenKey(kind: VoiceMemoryKindV1, id: string): string {
  return `${VOICE_MEMORY_FORGOTTEN_PREFIX_V1}${kind}:${id}`;
}
