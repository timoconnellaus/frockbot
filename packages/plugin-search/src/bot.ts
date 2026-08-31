// The Bot half of the Search Package: the projection, and the sink it writes to.
//
// The kernel imports no Package, so nothing here is called from `kernel-do`.
// The Bot Durable Object projects a *settled* run — one that has already
// reached a durable terminal state — through the narrow `SearchSinkV1` binding
// its host constructs, exactly as the Memory Package reaches the User Durable
// Object through `MEMORY_PROJECTS` (`plugin-shell/src/backend-memory.ts`).
//
// Projection happens after settlement, never before it, so a failed index
// write loses nothing: the run is already durable in the Bot Durable Object,
// and `rebuildSearchIndex` reconstructs every row this call would have made.
import { boundSearchBodyV1, type SearchRowV1 } from "./shared.js";

/**
 * The User-scoped index, as a Bot Durable Object calls it.
 *
 * `indexRows` is idempotent on `(botId, runId, seq)`, which is what lets the
 * caller treat it as fire-and-forget: a retried Turn, a resumed Turn, and a
 * rebuild all converge on the same rows.
 */
export interface SearchSinkV1 {
  indexRows(rows: readonly SearchRowV1[]): Promise<void>;
}

/**
 * The decoded run projection this Package reads.
 *
 * Structural on purpose: it is satisfied by both the wire `ClientRunV1` the
 * Shell Package emits and the `ClientRun` its decoder returns, so the rows a
 * Turn writes on settlement and the rows a rebuild reads back out of the run
 * list come from one function rather than two that must agree.
 */
export interface SearchProjectableRunV1 {
  runId: string;
  admittedAt?: string;
  input: string;
  status:
    | "running"
    | "completed"
    | "failed"
    | "cancelled"
    | "reconciliation-required";
  events: readonly {
    type: string;
    call?: { id: string; name: string };
    callId?: string;
    content?: string;
  }[];
  /**
   * The settled assistant text. The wire DTO carries it as
   * `outcome.text` and the decoded client value as `responseText`; both are
   * read here so a Turn's settlement-time projection and a rebuild's cannot
   * diverge on which shape they happened to be handed.
   */
  responseText?: string;
  outcome?: { type: string; text?: string };
}

function assistantText(run: SearchProjectableRunV1): string | undefined {
  if (run.responseText !== undefined) return run.responseText;
  return run.outcome?.type === "completed" ? run.outcome.text : undefined;
}

/** A run is projected once it can no longer change. */
export function isSettledSearchRunV1(run: {
  status: SearchProjectableRunV1["status"];
}): boolean {
  return (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "cancelled"
  );
}

/**
 * The rows one settled run contributes, in a deterministic order.
 *
 * Determinism is the whole contract: `seq` is derived from the run's own
 * projection and from nothing else, so the rows a Turn writes on settlement
 * and the rows a rebuild writes months later are byte-for-byte identical, and
 * re-projecting a run is a no-op rather than a duplicate.
 *
 * Body text only. Never a model request, never the Composition snapshot, never
 * Memory — Memory has its own search, and a request is not conversation.
 */
export function searchRowsFromClientRunV1(
  botId: string,
  run: SearchProjectableRunV1,
): SearchRowV1[] {
  // A run with no admission time cannot be ordered against the others, and the
  // index orders by it; a row it cannot place is one it does not keep.
  if (!isSettledSearchRunV1(run) || !run.admittedAt) return [];
  const rows: SearchRowV1[] = [];
  const at = run.admittedAt;
  const push = (kind: SearchRowV1["kind"], body: string): void => {
    const bounded = boundSearchBodyV1(body).trim();
    if (bounded.length === 0) return;
    rows.push({
      botId,
      runId: run.runId,
      seq: rows.length,
      kind,
      at,
      body: bounded,
    });
  };
  push("user", run.input);
  // Tool text is indexed but excluded from default results: a tool result can
  // carry credentials-adjacent output, so reading it back is an explicit
  // `kinds` opt-in rather than something a stray query surfaces.
  const results = new Map<string, string>();
  for (const event of run.events) {
    if (event.type === "tool/result" && event.callId) {
      results.set(event.callId, event.content ?? "");
    }
  }
  for (const event of run.events) {
    if (event.type !== "tool/call" || !event.call) continue;
    const result = results.get(event.call.id);
    push("tool", result ? `${event.call.name}\n${result}` : event.call.name);
  }
  const answer = run.status === "completed" ? assistantText(run) : undefined;
  if (answer) push("assistant", answer);
  return rows;
}
