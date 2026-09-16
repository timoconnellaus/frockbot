import {
  BATCH_TOOL_NAME,
  batchSubOccurrencesV1,
  batchToolOccurrenceId,
  decodeBatchCallsV1,
  TOOL_ATTACHMENT_LIMIT_V1,
  type ToolAttachmentV1,
  type ToolCallOccurrence,
  type ToolExecutionResult,
  type ToolOccurrenceJournalEntry,
  uncertainToolFailureV1,
  validateToolOccurrenceJournal,
} from "@frockbot/core/contracts";
import { EffectAdmissionFencedError } from "./errors.js";
import type { LoopRuntime } from "./runtime.js";

/**
 * Runs every occurrence and reports whether any result ended the Turn. The
 * boolean is per *result*, not per definition: one tool can end a Turn for
 * one payload and not another, and the kernel never inspects which.
 *
 * The occurrence id is the call's idempotency key. It is derived from the
 * Turn, the step and the call's position, so a call re-issued after a crash
 * carries the same key and a tool that honours keys runs its effect once.
 */
export async function executeToolsV1(
  runtime: LoopRuntime,
  occurrences: readonly ToolCallOccurrence[],
  signal: AbortSignal,
): Promise<boolean> {
  let endsTurn = false;
  for (const occurrence of occurrences) {
    signal.throwIfAborted();
    const result =
      occurrence.call.name === BATCH_TOOL_NAME
        ? await runBatchV1(runtime, occurrence, signal)
        : await runOccurrenceV1(runtime, occurrence, signal);
    if (result?.endsTurn === true) endsTurn = true;
  }
  return endsTurn;
}

/** What the journal already holds for an occurrence, if anything. */
function journalEntryV1(
  runtime: LoopRuntime,
  occurrenceId: string,
): ToolOccurrenceJournalEntry | undefined {
  return validateToolOccurrenceJournal(runtime.session.events).get(
    occurrenceId,
  );
}

/**
 * Records the intent to dispatch this occurrence, before anything is
 * dispatched. A Stop that lands between the intent and the dispatch settles
 * the occurrence rather than leaving it open.
 */
async function journalIntentV1(
  runtime: LoopRuntime,
  occurrence: ToolCallOccurrence,
  existing: ToolOccurrenceJournalEntry | undefined,
  signal: AbortSignal,
): Promise<void> {
  const { session } = runtime;
  const { turn, step, occurrenceId, call } = occurrence;
  if (existing?.intent) return;
  session.append({
    type: "tool/call",
    turn,
    step,
    occurrenceId,
    name: call.name,
    input: call.input,
  });
  await session.flush();
  if (signal.aborted) {
    await settleV1(runtime, occurrence, {
      content: "Cancelled before tool execution started.",
      isError: true,
    });
    signal.throwIfAborted();
  }
}

async function settleV1(
  runtime: LoopRuntime,
  occurrence: ToolCallOccurrence,
  result: ToolExecutionResult,
  status: "completed" | "interrupted" = "completed",
): Promise<void> {
  const { turn, step, occurrenceId, call } = occurrence;
  runtime.session.append({
    type: "tool/result",
    turn,
    step,
    occurrenceId,
    name: call.name,
    content: result.content,
    isError: result.isError,
    status,
    ...(result.attachments && result.attachments.length > 0
      ? { attachments: result.attachments }
      : {}),
  });
  await runtime.session.flush();
}

/**
 * One occurrence, prepared, admitted, dispatched and settled. Absent when the
 * journal already holds its result: a replay of a Turn that got this far does
 * not run the effect again.
 *
 * A call declared inside a `batch` reaches this the same way a call the model
 * issued on its own does — same journalling, same admission fence, same
 * per-occurrence key — so the durable log holds one `tool/call` per effect
 * however the model chose to group its calls.
 */
async function runOccurrenceV1(
  runtime: LoopRuntime,
  occurrence: ToolCallOccurrence,
  signal: AbortSignal,
): Promise<ToolExecutionResult | undefined> {
  const { services, session, options } = runtime;
  const { call, occurrenceId } = occurrence;
  const existing = journalEntryV1(runtime, occurrenceId);
  if (existing?.result) return undefined;
  const context = {
    botId: runtime.agent.botId,
    agentId: runtime.agent.id,
    sessionId: session.id,
    effectId: occurrenceId,
    toolCall: call,
    compositionGenerationId: runtime.composition.generationId,
    turnType: runtime.turnType,
    ...(runtime.subagentRole === undefined
      ? {}
      : { subagentRole: runtime.subagentRole }),
    signal,
  };
  const preparation = await services.tools.prepare(call, context);
  signal.throwIfAborted();
  await journalIntentV1(runtime, occurrence, existing, signal);
  let result: ToolExecutionResult;
  if (preparation.kind === "denied") {
    result = preparation.result;
  } else {
    // Re-admitted on every dispatch, including a re-issue of an already
    // journaled intent: admission is keyed by effect id, so a Stop or a
    // supersede still fences a call the evicted Turn had already started.
    if (
      !(await options.admitEffect({
        kind: "tool",
        effectId: occurrenceId,
      }))
    ) {
      await settleV1(
        runtime,
        occurrence,
        {
          content: "Cancelled before tool execution started.",
          isError: true,
        },
        "interrupted",
      );
      throw new EffectAdmissionFencedError(occurrenceId);
    }
    try {
      result = await services.tools.executePrepared(preparation, context);
    } catch (error) {
      if (signal.aborted) throw error;
      const message =
        error instanceof Error ? error.message : "Tool execution failed";
      result = {
        content: preparation.idempotent
          ? message
          : uncertainToolFailureV1(message),
        isError: true,
      };
    }
  }
  await settleV1(runtime, occurrence, result);
  return result;
}

/** One sub-call's durable outcome, kept with the position it was declared at. */
interface BatchCallReportV1 {
  index: number;
  tool: string;
  isError: boolean;
  content: string;
  attachments: readonly ToolAttachmentV1[];
}

/**
 * Runs the calls of one `batch` and reports each result to the model.
 *
 * The batch is expanded here rather than dispatched as a tool, because a call
 * inside one is an effect like any other and the durable log carries one
 * `tool/call` per effect. That invariant is what the audit index, the
 * journal's "already has a result" replay skip and the admission fence all
 * read; a batch that performed its calls privately was invisible to all three.
 * What the model reads is still this one aggregate result.
 *
 * Calls whose tool declares `orderedEffect` do not race each other. Their
 * effect is a position in the conversation — a bubble, a hand-off, an answer —
 * and a person reads those in the order they landed, so they run one after
 * another in the order the model declared them. Landing order is then declared
 * order by construction, which is what lets everything downstream — the wire
 * ordinal, the rendered order, the unread boundary, the push order, the
 * preview, the Turn's answer text — keep reading the log the single way it
 * always has. Every other call is dispatched at once and overlaps the ordered
 * chain, so the parallelism that pays for the batch — slow independent reads
 * and fetches — is untouched.
 *
 * One failure does not abort the rest: the batch exists so the model can spend
 * one inference on several calls, and collapsing the whole batch because the
 * third call was refused would cost it the other two as well. A Stop or a
 * supersede is the exception, because it is not this batch failing: it fences
 * the sub-call it reached exactly as it fences a top-level call, and the
 * Turn's own cancellation settles whatever never started.
 *
 * `endsTurn` is the OR of the sub-results. A `send_to_user` with disposition
 * "finish", a widget, or an approval inside a batch ends the Turn exactly as
 * it would outside one.
 */
async function runBatchV1(
  runtime: LoopRuntime,
  occurrence: ToolCallOccurrence,
  signal: AbortSignal,
): Promise<ToolExecutionResult | undefined> {
  const existing = journalEntryV1(runtime, occurrence.occurrenceId);
  if (existing?.result) return undefined;
  const decoded = decodeBatchCallsV1(occurrence.call.input);
  await journalIntentV1(runtime, occurrence, existing, signal);
  if (typeof decoded === "string") {
    const refusal = {
      content: `batch was refused: ${decoded}`,
      isError: true,
    };
    await settleV1(runtime, occurrence, refusal);
    return refusal;
  }
  const subs = batchSubOccurrencesV1(occurrence);
  const ordered: ToolCallOccurrence[] = [];
  const concurrent: ToolCallOccurrence[] = [];
  for (const sub of subs) {
    (runtime.services.tools.orderedEffect(sub.call)
      ? ordered
      : concurrent
    ).push(sub);
  }
  // The ordered chain is started first and synchronously, so its first call is
  // already in flight when the concurrent ones are dispatched and the two
  // groups overlap in time.
  const chain = (async () => {
    const results: (ToolExecutionResult | undefined)[] = [];
    for (const sub of ordered) {
      results.push(await runOccurrenceV1(runtime, sub, signal));
    }
    return results;
  })();
  const rest = Promise.all(
    concurrent.map((sub) => runOccurrenceV1(runtime, sub, signal)),
  );
  const dispatched = await Promise.allSettled([chain, rest]);
  const fenced = dispatched.find((outcome) => outcome.status === "rejected");
  if (fenced) throw fenced.reason;
  const dispatchedResults = dispatched.flatMap((outcome) =>
    outcome.status === "fulfilled" ? outcome.value : [],
  );
  const journal = validateToolOccurrenceJournal(runtime.session.events);
  const results: BatchCallReportV1[] = decoded.map((sub, index) => {
    if (sub.kind === "invalid") {
      return {
        index,
        tool: sub.tool,
        isError: true,
        content: `batch call ${index} was refused: ${sub.reason}`,
        attachments: [],
      };
    }
    const settled = journal.get(
      batchToolOccurrenceId(occurrence.occurrenceId, index),
    )!.result!;
    return {
      index,
      tool: sub.tool,
      isError: settled.isError,
      content: settled.content,
      attachments: settled.attachments ?? [],
    };
  });
  const failed = results.filter(({ isError }) => isError).length;
  const produced = results.flatMap(({ attachments }) => [...attachments]);
  const attachments = produced.slice(0, TOOL_ATTACHMENT_LIMIT_V1);
  const result: ToolExecutionResult = {
    content: JSON.stringify({
      ran: results.length,
      failed,
      ...(produced.length > attachments.length
        ? {
            attachments: {
              produced: produced.length,
              carried: attachments.length,
              dropped: produced.length - attachments.length,
              note: `One tool result may carry at most ${TOOL_ATTACHMENT_LIMIT_V1} attachments, so only the first ${attachments.length} in declared call order are attached; the rest were dropped. Each result's content still names where its output lives. Ask for at most ${TOOL_ATTACHMENT_LIMIT_V1} attachment-producing calls per batch.`,
            },
          }
        : {}),
      results: results.map(({ index, tool, isError, content }) => ({
        index,
        tool,
        isError,
        content,
      })),
    }),
    // A batch reports every result; the model reads which of them failed.
    isError: false,
    ...(dispatchedResults.some((sub) => sub?.endsTurn === true)
      ? { endsTurn: true }
      : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
  await settleV1(runtime, occurrence, result);
  return result;
}
