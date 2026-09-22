import {
  BATCH_ADMISSION_RESERVE_V1,
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
  return validateToolOccurrenceJournal(runtime.session.activeRunJournal).get(
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
    await settleV1(
      runtime,
      occurrence,
      {
        content: "Cancelled before tool execution started.",
        isError: true,
      },
      "interrupted",
    );
    signal.throwIfAborted();
  }
}

async function settleV1(
  runtime: LoopRuntime,
  occurrence: ToolCallOccurrence,
  result: ToolExecutionResult,
  status: "completed" | "interrupted",
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
  await settleV1(runtime, occurrence, result, "completed");
  return result;
}

/**
 * One declared call that never reaches a tool: its intent is already in the
 * log, and it is settled here with the reason it was refused. It gets the same
 * pair of durable events a dispatched call gets, but nothing is prepared,
 * admitted or executed for it, because there is no tool to run.
 */
async function refuseSubCallV1(
  runtime: LoopRuntime,
  occurrence: ToolCallOccurrence,
  content: string,
  signal: AbortSignal,
): Promise<undefined> {
  const existing = journalEntryV1(runtime, occurrence.occurrenceId);
  if (existing?.result) return undefined;
  await journalIntentV1(runtime, occurrence, existing, signal);
  await settleV1(runtime, occurrence, { content, isError: true }, "completed");
  return undefined;
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
 * it would outside one. It is the OR of the calls this dispatch ran, not of
 * the journal: `tool/result` does not record `endsTurn`, so a sub-call whose
 * result the journal already holds cannot contribute one on a resume. That is
 * the same shape a top-level call has — `executeToolsV1` skips an occurrence
 * the journal has settled too — and not a batch-specific gap to fix here.
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
    await settleV1(runtime, occurrence, refusal, "completed");
    return refusal;
  }
  const subs = batchSubOccurrencesV1(occurrence);
  // A batch spends one durable admission per call, and a run's record holds a
  // bounded number of them, so a batch that cannot fit is refused whole rather
  // than overflowing the record partway through and failing the Turn. The
  // bound is not `batch`'s: a run has always been able to exhaust it with
  // enough tool calls across enough steps, and a record past it has always
  // failed to decode. What a batch changes is how easily an ordinary Turn
  // reaches it — 25 admissions in one step — and so whether it is worth saying
  // something the model can act on instead of throwing. The
  // budget is not spent to the brim: the step that reads the batch's result
  // needs an admission of its own, so `BATCH_ADMISSION_RESERVE_V1` is held
  // back and the refusal names the number that is true after the reservation —
  // a batch the model can act on. It is never silently truncated, because a
  // model that asked for twelve calls and got eight asked for effects it did
  // not get.
  //
  // What is weighed is what still needs an admission, not what was declared.
  // An admission is keyed by effect id and spent once, so a resume of a batch
  // whose calls were already journalled — and therefore already admitted — must
  // not be charged a second time for work the run has already paid for and
  // performed. A structurally invalid call is not weighed either: it reaches no
  // tool and takes no admission.
  const needed = decoded.filter(
    (sub, index) =>
      sub.kind === "call" &&
      !journalEntryV1(runtime, subs[index]!.occurrenceId)?.intent,
  ).length;
  const remaining = await runtime.options.remainingEffectAdmissions?.();
  const fits =
    remaining === undefined
      ? undefined
      : Math.max(remaining - BATCH_ADMISSION_RESERVE_V1, 0);
  if (fits !== undefined && needed > fits) {
    const reason = `this run can still take ${fits} more tool call(s) and this batch needs ${needed}; issue fewer calls per batch across several steps.`;
    // Every declared call is already an occurrence of this step — the journal
    // derives them from the assistant message, not from what dispatch chose to
    // run — so each one is settled with the reason none of them ran. Refusing
    // to dispatch is the point; leaving the occurrences open would invalidate
    // the step and every later Turn in the conversation.
    for (const [index, sub] of subs.entries()) {
      await refuseSubCallV1(
        runtime,
        sub,
        `batch call ${index} was not run: ${reason}`,
        signal,
      );
    }
    const refusal = { content: `batch was refused: ${reason}`, isError: true };
    await settleV1(runtime, occurrence, refusal, "completed");
    return refusal;
  }
  // Every declared call's intent is journalled here, in declared order, before
  // any of them is prepared, admitted or dispatched. That is why the log holds
  // one row per declared call in declared order: row order is declared order by
  // construction, rather than depending on how many microtasks a given call
  // spends in prepare(). The intent is built from the call the model wrote, not
  // from the prepared one, so journalling it early records nothing different.
  for (const sub of subs) {
    await journalIntentV1(
      runtime,
      sub,
      journalEntryV1(runtime, sub.occurrenceId),
      signal,
    );
  }
  const ordered: number[] = [];
  const concurrent: number[] = [];
  decoded.forEach((sub, index) => {
    // A call that decoded into nothing dispatchable is refused in the chain
    // rather than alongside it, so its result lands in declared order with the
    // other ordered effects.
    (sub.kind === "invalid" ||
    runtime.services.tools.orderedEffect(subs[index]!.call)
      ? ordered
      : concurrent
    ).push(index);
  });
  // Nothing outlives the batch that started it. A sub-call that throws — a
  // fence, an abort — records where it was declared instead of rejecting out
  // from under its siblings, so every dispatched call has settled its own
  // `tool/result` before the batch decides its outcome. Rethrowing while a
  // sibling was still running let that sibling append a result after the Turn
  // had already closed, which invalidates the journal for good.
  const failures = new Map<number, unknown>();
  // The ordered chain is started first and synchronously, so its first call is
  // already in flight when the concurrent ones are dispatched and the two
  // groups overlap in time.
  const chain = (async () => {
    const results: (ToolExecutionResult | undefined)[] = [];
    for (const index of ordered) {
      const sub = decoded[index]!;
      try {
        results.push(
          sub.kind === "invalid"
            ? await refuseSubCallV1(
                runtime,
                subs[index]!,
                `batch call ${index} was refused: ${sub.reason}`,
                signal,
              )
            : await runOccurrenceV1(runtime, subs[index]!, signal),
        );
      } catch (error) {
        failures.set(index, error);
        break;
      }
    }
    return results;
  })();
  const rest = concurrent.map((index) =>
    runOccurrenceV1(runtime, subs[index]!, signal).catch((error: unknown) => {
      failures.set(index, error);
      return undefined;
    }),
  );
  const dispatchedResults = (await Promise.all([chain, ...rest])).flat();
  if (failures.size > 0) {
    // Declared position, not whichever rejected first, so a replay of the same
    // batch fails the Turn the same way it failed the first time.
    const first = Math.min(...failures.keys());
    throw failures.get(first);
  }
  const journal = validateToolOccurrenceJournal(
    runtime.session.activeRunJournal,
  );
  const results: BatchCallReportV1[] = decoded.map((sub, index) => {
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
            attachments: `${attachments.length} of ${produced.length} attachments carried, in declared call order; ${produced.length - attachments.length} dropped.`,
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
  await settleV1(runtime, occurrence, result, "completed");
  return result;
}
