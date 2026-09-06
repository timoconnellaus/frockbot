import {
  type ToolCallOccurrence,
  type ToolExecutionResult,
  validateToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import {
  EffectAdmissionFencedError,
  ToolEffectReconciliationRequiredError,
} from "./errors.js";
import type { LoopRuntime } from "./runtime.js";

/**
 * Runs every occurrence and reports whether any result ended the Turn. The
 * boolean is per *result*, not per definition: one tool can end a Turn for
 * one payload and not another, and the kernel never inspects which.
 */
export async function executeToolsV1(
  runtime: LoopRuntime,
  occurrences: readonly ToolCallOccurrence[],
  signal: AbortSignal,
): Promise<boolean> {
  const { ctx, session, options } = runtime;
  let endsTurn = false;
  for (const occurrence of occurrences) {
    signal.throwIfAborted();
    const { call, occurrenceId, turn, step } = occurrence;
    const journal = validateToolOccurrenceJournal(session.events);
    const existing = journal.get(occurrenceId);
    if (existing?.result) continue;
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
    const preparation = await ctx.tools.prepare(call, context);
    signal.throwIfAborted();
    if (existing?.intent && preparation.kind !== "ready") {
      throw new ToolEffectReconciliationRequiredError(
        occurrenceId,
        `Tool effect "${occurrenceId}" cannot be reconciled because its definition is unavailable`,
      );
    }
    if (!existing?.intent) {
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
        session.append({
          type: "tool/result",
          turn,
          step,
          occurrenceId,
          name: call.name,
          content: "Cancelled before tool execution started.",
          isError: true,
          status: "interrupted",
        });
        await session.flush();
        signal.throwIfAborted();
      }
    }
    let result: ToolExecutionResult;
    if (existing?.intent) {
      if (preparation.kind !== "ready") {
        throw new ToolEffectReconciliationRequiredError(
          occurrenceId,
          `Tool effect "${occurrenceId}" cannot be reconciled because its definition is unavailable`,
        );
      }
      const reconciliation = await ctx.tools.reconcilePrepared(
        preparation,
        context,
      );
      if (reconciliation.status === "unavailable") {
        throw new ToolEffectReconciliationRequiredError(
          occurrenceId,
          reconciliation.reason,
        );
      }
      result = reconciliation.result;
    } else if (preparation.kind === "denied") {
      result = preparation.result;
      ctx.emit("tools/result", call, result);
    } else {
      if (
        !(await options.admitEffect({
          kind: "tool",
          effectId: occurrenceId,
        }))
      ) {
        session.append({
          type: "tool/result",
          turn,
          step,
          occurrenceId,
          name: call.name,
          content: "Cancelled before tool execution started.",
          isError: true,
          status: "interrupted",
        });
        await session.flush();
        throw new EffectAdmissionFencedError(occurrenceId);
      }
      try {
        result = await ctx.tools.executePrepared(preparation, context);
      } catch (error) {
        if (signal.aborted || !preparation.idempotent) {
          throw new ToolEffectReconciliationRequiredError(
            occurrenceId,
            signal.aborted
              ? `Tool effect "${occurrenceId}" outcome is uncertain after cancellation`
              : `Non-idempotent tool effect "${occurrenceId}" outcome is uncertain`,
          );
        }
        result = {
          content:
            error instanceof Error ? error.message : "Tool execution failed",
          isError: true,
        };
        ctx.emit("tools/result", call, result);
      }
    }
    if (result.endsTurn === true) endsTurn = true;
    session.append({
      type: "tool/result",
      turn,
      step,
      occurrenceId,
      name: call.name,
      content: result.content,
      isError: result.isError,
      status: "completed",
      ...(result.attachments && result.attachments.length > 0
        ? { attachments: result.attachments }
        : {}),
    });
    await session.flush();
  }
  return endsTurn;
}
