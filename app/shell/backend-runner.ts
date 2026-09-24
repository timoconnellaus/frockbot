import { sentTextV1 } from "./sent-text.js";
import type { AgentHandle } from "@frockbot/core/agent-loop/agent";
import {
  type PersistSessionEvents,
  type SessionEvent,
  type SkillRefV1,
  turnFailureMessage,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import type { ShellMountedComposition } from "./backend-composition.js";
import {
  BotTurnExecutionError,
  BotTurnRecoveryRequiredError,
} from "@frockbot/core/durable";
import type { BotTurnCommand, BotTurnCompletion } from "./backend-contracts.js";
import {
  compactionInFlightV1,
  compactionScopeV1,
  whenCompactionSettledV1,
} from "./compaction-scheduler.js";

export { BotTurnExecutionError, BotTurnRecoveryRequiredError };

function journalSuffix(
  seededCount: number,
  journal: readonly SessionEvent[],
  startSeq?: number,
): SessionEvent[] {
  // The admission boundary is an absolute sequence. Events the Session
  // appended while mounting — `session/created` on a new log — belong to
  // this run even though they are already in the journal when execution
  // starts. Slicing them off leaves the suffix past `previousEventCount`.
  if (startSeq !== undefined) {
    const start = journal.findIndex((event) => event.seq >= startSeq);
    const events = start < 0 ? [] : journal.slice(start);
    if (events.length > 0 && events[0]!.seq !== startSeq) {
      throw new Error(`active-run journal is missing sequence ${startSeq}`);
    }
    return structuredClone(events);
  }
  if (journal.length < seededCount) {
    throw new Error("active-run journal lost events it started with");
  }
  return structuredClone(journal.slice(seededCount));
}

/**
 * Classifies one finished Agent handle against the durable history it started
 * from, so every path reaches the same durable terminal or recovery outcome.
 */
function settleBotTurn(
  handle: AgentHandle,
  command: BotTurnCommand,
  seededCount: number,
  startSeq?: number,
): BotTurnCompletion {
  const events = [...handle.agent.session.activeRunJournal];
  const turnStart = events.findLast((event) => event.type === "turn/start");
  const currentTurn =
    turnStart?.type === "turn/start" ? turnStart.turn : undefined;
  const terminalTurn = events.findLast(
    (event) => event.type === "turn/end" && event.turn === currentTurn,
  );
  if (!terminalTurn || terminalTurn.type !== "turn/end") {
    const latestRequest = events.findLast(
      (event) => event.type === "model/request" && event.turn === currentTurn,
    );
    const hasDurableOutcome =
      latestRequest?.type === "model/request" &&
      events.some(
        (event) =>
          (event.type === "assistant/message" ||
            event.type === "model/response-failed") &&
          event.requestId === latestRequest.request.requestId,
      );
    if (hasDurableOutcome) {
      throw new BotTurnRecoveryRequiredError(
        journalSuffix(seededCount, events, startSeq),
      );
    }
    throw new BotTurnExecutionError(
      "Bot turn did not reach a durable terminal state",
      journalSuffix(seededCount, events, startSeq),
    );
  }
  if (terminalTurn.outcome !== "completed") {
    throw new BotTurnExecutionError(
      turnFailureMessage(terminalTurn.outcome, terminalTurn.reason),
      journalSuffix(seededCount, events, startSeq),
    );
  }
  const message = handle.agent.session.deriveMessages().at(-1);
  const assistantText = message?.role === "assistant" ? message.content : "";
  return {
    runId: command.runId,
    text:
      command.turnType === "automation" || command.turnType === "subagent"
        ? assistantText
        : sentTextV1(
            events.filter(
              (event) => "turn" in event && event.turn === currentTurn,
            ),
          ),
    events: journalSuffix(seededCount, events, startSeq),
  };
}

function turnExecutionError(
  error: unknown,
  seededCount: number,
  events: readonly SessionEvent[],
  startSeq?: number,
): never {
  if (
    error instanceof BotTurnExecutionError ||
    error instanceof BotTurnRecoveryRequiredError
  ) {
    throw error;
  }
  throw new BotTurnExecutionError(
    error instanceof Error ? error.message : "Bot turn failed",
    journalSuffix(seededCount, events, startSeq),
  );
}

export interface ExecuteBotTurnOptions {
  command: BotTurnCommand;
  /** The mounted Composition for the generation this Turn was pinned to. */
  composition: ShellMountedComposition;
  resume?: boolean;
  /**
   * Absolute sequence this run was admitted at. The completion suffix starts
   * here, including events appended while the Session was mounted.
   */
  suffixStartSeq?: number;
}

export async function executeBotTurn(
  options: ExecuteBotTurnOptions,
): Promise<BotTurnCompletion> {
  const { command, composition, resume } = options;
  const runtime = composition.runtime;
  const seededCount = runtime.agent.agent.session.activeRunJournal.length;
  try {
    if (resume) runtime.agent.agent.resume();
    else {
      runtime.agent.agent.send({
        text: command.text,
        ...(command.skills ? { skills: command.skills } : {}),
      });
    }
    await runtime.agent.agent.whenIdle();
    return settleBotTurn(
      runtime.agent,
      command,
      seededCount,
      options.suffixStartSeq,
    );
  } catch (error) {
    return turnExecutionError(
      error,
      seededCount,
      [...runtime.agent.agent.session.activeRunJournal],
      options.suffixStartSeq,
    );
  } finally {
    // A compaction outlives the Turn that triggered it, and it runs on this
    // Composition's model binding — so the Composition outlives the Turn too,
    // and only by as long as the compaction does. Awaiting the disposal here
    // would put the summariser back in the latency path, which is the whole
    // defect. Compactions run one at a time, each bounded by its deadline, so
    // these can only stack as deep as that queue.
    const scope = compactionScopeV1(runtime.agent.agent.session);
    if (compactionInFlightV1(command.sessionId, scope)) {
      void whenCompactionSettledV1(command.sessionId, scope).then(
        () => composition.dispose(),
        () => composition.dispose(),
      );
    } else {
      await composition.dispose();
    }
  }
}
