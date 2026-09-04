// The Bot half of the Audit Package: the projection, and the bounded outbox
// that carries its entries across the Bot/User seam.
//
// The kernel imports no Package, so nothing here is called from `kernel-do`.
// The Bot Durable Object projects a *settled* run — one that has already
// reached a durable terminal state — and hands the entries to a narrow
// `AuditSinkV1` its host constructs, the same shape the Memory Package reaches
// the User Durable Object through.
//
// WHY AN OUTBOX, when the transcript index is fire-and-forget. Because the
// parity item is completeness: GrokBot's `agents/audit-outbox.json` is a
// durable queue of 1028 audited actions (`grokbot-computer.md:193`, `:547`),
// and an audit surface with silent gaps answers no question anybody asks of
// it. So entries are appended to a bounded durable key in the Bot Durable
// Object first and drained after; a drain that fails leaves them pending for
// the next settlement or the alarm the Bot already has. Overflow drops the
// oldest and sets a durable `outbox-truncated` marker the UI shows and a
// rebuild clears — "Failures are observable through durable state" rather than
// a queue that quietly forgets.
//
// It reads the *stored* run rather than the client projection, because the
// client projection drops `call.input` and the argument digest needs the exact
// arguments.
import {
  auditKindForToolV1,
  dynamicToolInputV1,
  resolveDynamicToolNameV1,
} from "./classify.js";
import { auditArgumentDigestV1, auditPreviewV1 } from "./redact.js";
import {
  AUDIT_MAX_OUTBOX_V1,
  decodeAuditOccurrenceIdV1,
  type AuditEntryV1,
  type AuditOutcomeV1,
} from "./shared.js";

/** The User-scoped audit table, as a Bot Durable Object calls it. */
export interface AuditSinkV1 {
  /** Idempotent on `(botId, runId, occurrenceId)`. */
  indexEntries(entries: readonly AuditEntryV1[]): Promise<void>;
}

/**
 * The decoded run this Package reads: the durable events, and nothing else.
 *
 * Structural on purpose, so the Shell Package's stored-run page and a
 * settlement-time lookup satisfy it without either naming this Package.
 */
export interface AuditProjectableRunV1 {
  runId: string;
  status: string;
  events: readonly {
    type: string;
    timestamp?: string;
    occurrenceId?: string;
    name?: string;
    input?: unknown;
    content?: string;
    isError?: boolean;
    status?: string;
  }[];
  /** Used only when an event carries no timestamp of its own. */
  acceptedAt?: string;
}

/** A run is projected once it can no longer change. */
export function isSettledAuditRunV1(run: { status: string }): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled" ||
    // A Turn the User's next message replaced still ran tools, and an audit
    // surface with silent gaps answers no question anybody asks of it.
    run.status === "superseded"
  );
}

/**
 * A tool result that says the effect has not run yet.
 *
 * An approval-gated `machine_exec` answers the model at *queue* time, before
 * anybody has approved anything, and `isError` is false — so the row said `ok`
 * for a command that had not run and might never run. The durable log does not
 * yet know how it ended, which is exactly what `unknown` means.
 */
const AWAITING_APPROVAL =
  /\bnothing has run\b|waiting on the user's approval|awaiting (?:your )?approval|queued for approval/i;

function outcomeFor(
  result: { isError?: boolean; status?: string; content?: string } | undefined,
): AuditOutcomeV1 {
  // No result at all is `unknown`, never `error`. The durable log does not
  // know how the effect ended, and inventing an answer here would be the
  // silent classification the constitution's reconciliation rule forbids.
  if (!result) return "unknown";
  if (result.status === "interrupted") return "interrupted";
  if (result.isError !== true) {
    return AWAITING_APPROVAL.test(result.content ?? "") ? "unknown" : "ok";
  }
  // A tool that declined before doing anything is a refusal, which is a
  // materially different fact from an effect that ran and failed.
  return /\brefus|not allowed|denied|blocked while\b/i.test(
    result.content ?? "",
  )
    ? "refused"
    : "error";
}

/**
 * The audit entries one settled run contributes, in a deterministic order.
 *
 * Determinism is the whole contract, exactly as it is for the transcript
 * index: every field is derived from the run's own durable events and from
 * nothing else, so the entries a Turn writes on settlement and the entries a
 * rebuild writes months later are byte-for-byte identical, and re-projecting a
 * run is a no-op rather than a duplicate.
 */
export async function auditEntriesFromStoredRunV1(
  botId: string,
  run: AuditProjectableRunV1,
): Promise<AuditEntryV1[]> {
  if (!isSettledAuditRunV1(run)) return [];
  const results = new Map<
    string,
    { isError?: boolean; status?: string; content?: string }
  >();
  for (const event of run.events) {
    if (event.type !== "tool/result" || !event.occurrenceId) continue;
    results.set(event.occurrenceId, {
      ...(event.isError === undefined ? {} : { isError: event.isError }),
      ...(event.status === undefined ? {} : { status: event.status }),
      ...(event.content === undefined ? {} : { content: event.content }),
    });
  }
  const entries: AuditEntryV1[] = [];
  for (const event of run.events) {
    if (event.type !== "tool/call") continue;
    const { occurrenceId, name } = event;
    if (!occurrenceId || !name) continue;
    const classification = auditKindForToolV1(name, event.input);
    if (!classification) continue;
    // The row names the tool that ran, not the wrapper it was journalled
    // under, and previews the arguments that tool was actually given.
    const toolName = resolveDynamicToolNameV1(name, event.input);
    const toolInput =
      toolName === name ? event.input : dynamicToolInputV1(event.input);
    let coordinates: { turn: number; step: number; ordinal: number };
    try {
      coordinates = decodeAuditOccurrenceIdV1(occurrenceId);
    } catch {
      // An occurrence id this schema cannot place is an entry with no
      // coordinates; the run is still readable, and a row that lied about
      // where it came from would be worse than its absence.
      continue;
    }
    const result = results.get(occurrenceId);
    const at = event.timestamp ?? run.acceptedAt;
    if (!at) continue;
    entries.push({
      schemaVersion: 1,
      botId,
      runId: run.runId,
      occurrenceId,
      ...coordinates,
      // `plugin-shell` writes `occurrenceId: context.effectId`, so the
      // Computer envelope's `effectId` and this string are the same key.
      effectId: occurrenceId,
      at,
      kind: classification.kind,
      target: classification.target,
      toolName,
      // The digest stays over the exact argument JSON the durable `tool/call`
      // event holds, so a row written months ago still reproduces.
      argumentDigest: await auditArgumentDigestV1(event.input),
      preview: auditPreviewV1(classification.kind, toolName, toolInput),
      outcome: outcomeFor(result),
      ...(result?.content === undefined
        ? {}
        : { bytesOut: new TextEncoder().encode(result.content).byteLength }),
    });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// The outbox.
// ---------------------------------------------------------------------------

/** The durable key the Bot Durable Object's outbox lives under. */
export const AUDIT_OUTBOX_KEY_V1 = "audit:outbox";

/** Exactly the Durable Object storage surface the outbox uses. */
export interface AuditOutboxStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  delete(key: string): Promise<boolean>;
}

export interface AuditOutboxStateV1 {
  pending: number;
  /** Entries were dropped to stay inside the bound; a rebuild clears it. */
  truncated: boolean;
}

interface StoredOutbox {
  schemaVersion: 1;
  entries: AuditEntryV1[];
  truncated: boolean;
}

function decodeStoredOutbox(value: unknown): StoredOutbox {
  if (
    typeof value !== "object" ||
    value === null ||
    (value as StoredOutbox).schemaVersion !== 1 ||
    !Array.isArray((value as StoredOutbox).entries)
  ) {
    return { schemaVersion: 1, entries: [], truncated: false };
  }
  const stored = value as StoredOutbox;
  return {
    schemaVersion: 1,
    entries: stored.entries.slice(0, AUDIT_MAX_OUTBOX_V1),
    truncated: stored.truncated === true,
  };
}

/**
 * A bounded, durable, at-least-once queue of audit entries.
 *
 * At-least-once, never at-most-once: an entry stays in the outbox until the
 * User Durable Object has accepted it, and acceptance is idempotent on
 * `(botId, runId, occurrenceId)`, so a redelivery costs a no-op insert. That
 * pairing is the whole reason a queue is safe here.
 */
export class AuditOutboxV1 {
  private readonly maximum: number;

  constructor(
    private readonly storage: AuditOutboxStorageV1,
    options: { maximum?: number } = {},
  ) {
    this.maximum = options.maximum ?? AUDIT_MAX_OUTBOX_V1;
  }

  private async read(): Promise<StoredOutbox> {
    return decodeStoredOutbox(
      await this.storage.get<unknown>(AUDIT_OUTBOX_KEY_V1),
    );
  }

  private async write(outbox: StoredOutbox): Promise<void> {
    if (outbox.entries.length === 0 && !outbox.truncated) {
      await this.storage.delete(AUDIT_OUTBOX_KEY_V1);
      return;
    }
    await this.storage.put(AUDIT_OUTBOX_KEY_V1, outbox);
  }

  async state(): Promise<AuditOutboxStateV1> {
    const outbox = await this.read();
    return { pending: outbox.entries.length, truncated: outbox.truncated };
  }

  /**
   * Appends entries, dropping the oldest when the bound is reached.
   *
   * Dropping the oldest rather than refusing the newest: an audit surface that
   * stopped recording because it was full would go quiet exactly when a Bot
   * was busiest. The loss is durable and named instead.
   */
  async append(entries: readonly AuditEntryV1[]): Promise<AuditOutboxStateV1> {
    if (entries.length === 0) return this.state();
    const outbox = await this.read();
    const seen = new Set(
      outbox.entries.map(
        (entry) => `${entry.runId}\u0000${entry.occurrenceId}`,
      ),
    );
    for (const entry of entries) {
      const key = `${entry.runId}\u0000${entry.occurrenceId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      outbox.entries.push(entry);
    }
    if (outbox.entries.length > this.maximum) {
      outbox.entries = outbox.entries.slice(
        outbox.entries.length - this.maximum,
      );
      outbox.truncated = true;
    }
    await this.write(outbox);
    return { pending: outbox.entries.length, truncated: outbox.truncated };
  }

  /**
   * Hands everything pending to the sink and clears what it accepted.
   *
   * A throwing sink leaves the outbox exactly as it was: nothing is cleared
   * that was not delivered, which is the only property that makes the queue
   * worth having. The truncation marker survives a drain — it describes what
   * was lost, not what is pending — and only a rebuild clears it.
   */
  async drain(
    sink: AuditSinkV1,
  ): Promise<{ delivered: number; state: AuditOutboxStateV1 }> {
    const outbox = await this.read();
    if (outbox.entries.length === 0) {
      return {
        delivered: 0,
        state: { pending: 0, truncated: outbox.truncated },
      };
    }
    await sink.indexEntries(outbox.entries);
    const delivered = outbox.entries.length;
    const remaining = await this.read();
    // Anything appended while the sink was in flight stays pending.
    const deliveredKeys = new Set(
      outbox.entries.map(
        (entry) => `${entry.runId}\u0000${entry.occurrenceId}`,
      ),
    );
    const next: StoredOutbox = {
      schemaVersion: 1,
      entries: remaining.entries.filter(
        (entry) =>
          !deliveredKeys.has(`${entry.runId}\u0000${entry.occurrenceId}`),
      ),
      truncated: remaining.truncated || outbox.truncated,
    };
    await this.write(next);
    return {
      delivered,
      state: { pending: next.entries.length, truncated: next.truncated },
    };
  }

  /** Clears the truncation marker. Only a completed rebuild may do this. */
  async clearTruncation(): Promise<void> {
    const outbox = await this.read();
    if (!outbox.truncated) return;
    await this.write({ ...outbox, truncated: false });
  }
}
