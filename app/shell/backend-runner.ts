import { sentTextV1 } from "./sent-text.js";
import type {
  AgentEffectAdmission,
  AgentHandle,
} from "@frockbot/core/agent-loop/agent";
import {
  type PersistSessionEvents,
  type SessionEvent,
  type SkillRefV1,
  turnFailureMessage,
  type TurnTypeV1,
  validateToolOccurrenceJournal,
} from "@frockbot/core/contracts";
import type { ShellMountedComposition } from "./backend-composition.js";
import {
  BotTurnExecutionError,
  BotTurnRecoveryRequiredError,
} from "@frockbot/core/durable";
import type { BotTurnCommand, BotTurnCompletion } from "./backend-contracts.js";
import {
  compactionInFlightV1,
  whenCompactionSettledV1,
} from "./compaction-scheduler.js";

export { BotTurnExecutionError, BotTurnRecoveryRequiredError };

function appendedSessionEvents(
  previous: readonly SessionEvent[],
  candidate: readonly SessionEvent[],
): SessionEvent[] {
  if (
    candidate.length < previous.length ||
    previous.some(
      (event, index) =>
        JSON.stringify(event) !== JSON.stringify(candidate[index]),
    )
  ) {
    throw new Error("candidate changed durable session history");
  }
  return structuredClone(candidate.slice(previous.length));
}

/**
 * Classifies one finished Agent handle against the durable history it started
 * from, so every path reaches the same durable terminal or recovery outcome.
 */
function settleBotTurn(
  handle: AgentHandle,
  command: BotTurnCommand,
  previousEvents: readonly SessionEvent[],
): BotTurnCompletion {
  const events = [...handle.agent.session.events];
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
        appendedSessionEvents(previousEvents, events),
      );
    }
    throw new BotTurnExecutionError(
      "Bot turn did not reach a durable terminal state",
      appendedSessionEvents(previousEvents, events),
    );
  }
  if (terminalTurn.outcome !== "completed") {
    throw new BotTurnExecutionError(
      turnFailureMessage(terminalTurn.outcome, terminalTurn.reason),
      appendedSessionEvents(previousEvents, events),
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
    events: appendedSessionEvents(previousEvents, events),
  };
}

function turnExecutionError(
  error: unknown,
  previousEvents: readonly SessionEvent[],
  events: readonly SessionEvent[],
): never {
  if (
    error instanceof BotTurnExecutionError ||
    error instanceof BotTurnRecoveryRequiredError
  ) {
    throw error;
  }
  throw new BotTurnExecutionError(
    error instanceof Error ? error.message : "Bot turn failed",
    appendedSessionEvents(previousEvents, events),
  );
}

export interface ExecuteBotTurnOptions {
  command: BotTurnCommand;
  previousEvents: readonly SessionEvent[];
  /** The mounted Composition for the generation this Turn was pinned to. */
  composition: ShellMountedComposition;
  resume?: boolean;
}

export interface ExecuteDirectToolTurnOptions {
  command: BotTurnCommand & {
    directTool: NonNullable<BotTurnCommand["directTool"]>;
  };
  previousEvents: readonly SessionEvent[];
  composition: ShellMountedComposition;
  admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
  signal: AbortSignal;
}

/**
 * Runs a Package-page tool as one ordinary durable Turn, without a model call.
 * The same Session journal and effect fence make retry/recovery identical to a
 * model-selected tool occurrence.
 */
export async function executeDirectToolTurn(
  options: ExecuteDirectToolTurnOptions,
): Promise<BotTurnCompletion> {
  const { command, composition, previousEvents, admitEffect, signal } = options;
  const session = composition.runtime.agent.agent.session;
  // The tool the page names is a registered first-party tool, called by its
  // own name: the same registry, the same guards and the same durable
  // occurrence a model-selected call goes through.
  const call = {
    id: command.runId,
    name: command.directTool.name,
    input: command.directTool.input,
  };
  try {
    let turnStart = [...session.events].findLast(
      (event) =>
        event.type === "turn/start" &&
        !session.events.some(
          (candidate) =>
            candidate.type === "turn/end" && candidate.turn === event.turn,
        ),
    );
    if (!turnStart || turnStart.type !== "turn/start") {
      const turn = session.nextTurn();
      const messageId = `iframe:${command.runId}`;
      session.appendBatch([
        { type: "input/queued", messageId, text: command.text },
        { type: "turn/start", turn },
        {
          type: "composition/pinned",
          turn,
          generationId: composition.generation.generationId,
          artifactSetHash: composition.generation.artifactSetHash,
        },
        { type: "turn/admission", turn, turnType: "chat" },
        { type: "input/admitted", messageId, turn },
        { type: "step/start", turn, step: 1 },
        { type: "user/message", turn, step: 1, messageId, text: command.text },
        {
          type: "assistant/message",
          turn,
          step: 1,
          requestId: `iframe:${command.runId}`,
          text: "",
          toolCalls: [call],
        },
      ]);
      await session.flush();
      turnStart = session.events.findLast(
        (event) => event.type === "turn/start" && event.turn === turn,
      );
    }
    if (!turnStart || turnStart.type !== "turn/start") {
      throw new Error("Package UI tool Turn has no durable start");
    }
    const turn = turnStart.turn;
    const occurrenceId = `tool:${turn}:1:0`;
    const journal = validateToolOccurrenceJournal(session.events);
    const existing = journal.get(occurrenceId);
    if (!existing) throw new Error("Package UI tool occurrence is unavailable");

    if (!existing.result) {
      const context = {
        botId: composition.runtime.agent.agent.botId,
        agentId: composition.runtime.agent.agent.id,
        sessionId: command.sessionId,
        compositionGenerationId: composition.generation.generationId,
        effectId: occurrenceId,
        toolCall: call,
        turnType: "chat" as const,
        signal,
      };
      const preparation = await composition.runtime.services.tools.prepare(
        call,
        context,
      );
      let result;
      if (!existing.intent) {
        session.append({
          type: "tool/call",
          turn,
          step: 1,
          occurrenceId,
          name: call.name,
          input: call.input,
        });
        await session.flush();
      }
      if (preparation.kind === "denied") {
        result = preparation.result;
      } else {
        // Admission is keyed by effect id, so a call the object had already
        // started is fenced by a later Stop exactly as a new one is.
        if (!(await admitEffect({ kind: "tool", effectId: occurrenceId }))) {
          session.appendBatch([
            {
              type: "tool/result",
              turn,
              step: 1,
              occurrenceId,
              name: call.name,
              content: "Cancelled before tool execution started.",
              isError: true,
              status: "interrupted",
            },
            { type: "step/end", turn, step: 1, outcome: "cancelled" },
            { type: "turn/end", turn, outcome: "cancelled" },
          ]);
          await session.flush();
          throw new Error("Package UI tool effect was fenced by Stop");
        }
        try {
          result = await composition.runtime.services.tools.executePrepared(
            preparation,
            context,
          );
        } catch (error) {
          if (signal.aborted) throw error;
          result = {
            content:
              error instanceof Error ? error.message : "Tool execution failed",
            isError: true,
          };
        }
      }
      session.append({
        type: "tool/result",
        turn,
        step: 1,
        occurrenceId,
        name: call.name,
        content: result.content,
        isError: result.isError,
        status: "completed",
        ...(result.attachments?.length
          ? { attachments: result.attachments }
          : {}),
      });
      await session.flush();
    }
    const hasTerminal = session.events.some(
      (event) => event.type === "turn/end" && event.turn === turn,
    );
    if (!hasTerminal) {
      session.appendBatch([
        { type: "step/end", turn, step: 1, outcome: "completed" },
        { type: "turn/end", turn, outcome: "completed" },
      ]);
      await session.flush();
    }
    return {
      runId: command.runId,
      text: "",
      events: appendedSessionEvents(previousEvents, session.events),
    };
  } finally {
    await composition.dispose();
  }
}

export async function executeBotTurn(
  options: ExecuteBotTurnOptions,
): Promise<BotTurnCompletion> {
  const { command, previousEvents, composition, resume } = options;
  const runtime = composition.runtime;
  try {
    if (resume) runtime.agent.agent.resume();
    else {
      runtime.agent.agent.send({
        text: command.text,
        ...(command.skills ? { skills: command.skills } : {}),
      });
    }
    await runtime.agent.agent.whenIdle();
    return settleBotTurn(runtime.agent, command, previousEvents);
  } catch (error) {
    return turnExecutionError(error, previousEvents, [
      ...runtime.agent.agent.session.events,
    ]);
  } finally {
    // A compaction outlives the Turn that triggered it, and it runs on this
    // Composition's model binding — so the Composition outlives the Turn too,
    // and only by as long as the compaction does. Awaiting the disposal here
    // would put the summariser back in the latency path, which is the whole
    // defect. The next admission aborts anything still running, so this can
    // never stack up.
    if (compactionInFlightV1(command.sessionId)) {
      void whenCompactionSettledV1(command.sessionId).then(
        () => composition.dispose(),
        () => composition.dispose(),
      );
    } else {
      await composition.dispose();
    }
  }
}
