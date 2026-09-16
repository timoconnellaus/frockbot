import type { ToolCallOccurrence } from "./types.js";
import { toolCallOccurrences } from "./types.js";

export const BATCH_TOOL_NAME = "batch";
/** Most calls one `batch` may carry. */
export const BATCH_MAX_CALLS_V1 = 25;

/**
 * The occurrence id of one call inside a batch: the batch's own id, a dot, and
 * the call's declared position in the batch.
 *
 * A dot rather than a colon, because an approval id may not carry a colon —
 * see `app/plugins/approval.ts`. The separator is the only thing that
 * distinguishes a sub-occurrence from a top-level one, and everything
 * downstream that keys on an effect id — the tool journal's "already has a
 * result" check, and every tool that dedupes its own effect on
 * `context.effectId` — needs the calls in one batch to be distinct. Sharing
 * one id collapsed three sends into one.
 */
export function batchToolOccurrenceId(
  occurrenceId: string,
  subIndex: number,
): string {
  if (!Number.isSafeInteger(subIndex) || subIndex < 0) {
    throw new Error("batch sub-call index is invalid");
  }
  return `${occurrenceId}.${subIndex}`;
}

/**
 * The journalled tool name of a declared call that reached no tool. Every
 * occurrence the log carries is named, and an unusable call is journalled
 * under this one rather than under a tool it never ran — the tool it named,
 * if it named one at all, is in the occurrence's input with the rest of what
 * the model wrote, which is what makes the refusal diagnosable.
 */
export const BATCH_INVALID_CALL_NAME_V1 = "invalid_tool_call";

/**
 * One declared call of a batch: either something to dispatch, or the reason
 * that one call is unusable. An unusable call keeps `raw` — exactly what the
 * model wrote in that slot — so its refusal is diagnosable from the log.
 */
export type BatchSubCallV1 =
  | { kind: "call"; tool: string; arguments: unknown }
  | { kind: "invalid"; tool: string; reason: string; raw: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The calls of one batch, or the reason the batch itself is unusable.
 *
 * The two levels are not the same failure. A batch with no calls array, an
 * empty one, or one past the bound has nothing to run, so the whole call is
 * refused. A single malformed call is that call's own failure: the batch
 * exists so one inference buys several calls, and refusing all of them
 * because the third named no tool costs the model the other two. Such a call
 * is carried through as `invalid` and reported in its own slot, naming what
 * was wrong with it, so the model repairs that call rather than guessing
 * which of the calls was malformed.
 *
 * It is pure, and every reader of a batch — the loop that dispatches it and
 * the journal that derives its occurrences — decodes it here, so what runs
 * and what the durable log says ran cannot drift apart.
 */
export function decodeBatchCallsV1(input: unknown): BatchSubCallV1[] | string {
  if (!isRecord(input)) return "batch requires an object with a calls array";
  const calls = input.calls;
  if (!Array.isArray(calls) || calls.length === 0) {
    return "batch requires a non-empty calls array";
  }
  if (calls.length > BATCH_MAX_CALLS_V1) {
    return `batch carries at most ${BATCH_MAX_CALLS_V1} calls; this one carried ${calls.length}`;
  }
  return calls.map((call) => {
    if (!isRecord(call) || typeof call.tool !== "string" || !call.tool) {
      return {
        kind: "invalid",
        tool: isRecord(call) && typeof call.tool === "string" ? call.tool : "",
        reason: "it needs a tool name",
        raw: call,
      };
    }
    if (call.tool === BATCH_TOOL_NAME) {
      return {
        kind: "invalid",
        tool: call.tool,
        reason: "batch cannot call itself",
        raw: call,
      };
    }
    if (call.arguments !== undefined && !isRecord(call.arguments)) {
      return {
        kind: "invalid",
        tool: call.tool,
        reason: "its arguments must be an object",
        raw: call,
      };
    }
    return { kind: "call", tool: call.tool, arguments: call.arguments ?? {} };
  });
}

/**
 * The occurrences one batch declares, in declared order — one per declared
 * call, whatever became of it.
 *
 * A call inside a batch is a tool occurrence like any other: it is journalled,
 * admitted, executed and settled under its own id, so the audit index, the
 * journal's replay skip and every effect-keyed tool see the effects a batch
 * performs rather than one opaque row. A call that fails structural decoding
 * gets an occurrence too: it dispatches nothing, but it is still something the
 * model asked for, and without a row of its own it would vanish from the
 * transcript entirely once the envelope is drawn as its sub-calls.
 */
export function batchSubOccurrencesV1(
  parent: ToolCallOccurrence,
): ToolCallOccurrence[] {
  if (parent.call.name !== BATCH_TOOL_NAME) return [];
  const decoded = decodeBatchCallsV1(parent.call.input);
  if (typeof decoded === "string") return [];
  return decoded.map((sub, index) => ({
    occurrenceId: batchToolOccurrenceId(parent.occurrenceId, index),
    parentOccurrenceId: parent.occurrenceId,
    turn: parent.turn,
    step: parent.step,
    ordinal: index,
    call: {
      id: `${parent.call.id}.${index}`,
      name: sub.kind === "call" ? sub.tool : BATCH_INVALID_CALL_NAME_V1,
      input: sub.kind === "call" ? sub.arguments : sub.raw,
    },
  }));
}

/**
 * Every occurrence a step's tool calls declare: each call, followed by the
 * sub-calls of a batch. The journal, the recovery check and the cancellation
 * settler all read the same list, so a sub-call cannot be settled by one and
 * unknown to another.
 */
export function expandToolCallOccurrencesV1(
  turn: number,
  step: number,
  calls: readonly { id: string; name: string; input: unknown }[],
): ToolCallOccurrence[] {
  return toolCallOccurrences(turn, step, calls).flatMap((occurrence) => [
    occurrence,
    ...batchSubOccurrencesV1(occurrence),
  ]);
}
