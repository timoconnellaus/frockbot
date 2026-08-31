import type {
  AgentEffectAdmission,
  AgentHandle,
} from "@frockbot/kernel-agent-loop/agent";
import {
  type PersistSessionEvents,
  type SessionEvent,
  turnFailureMessage,
  type TurnTypeV1,
  validateToolOccurrenceJournal,
} from "@frockbot/kernel-contracts";
import type { ShellMountedComposition } from "./backend-composition.js";
import {
  BotTurnExecutionError,
  BotTurnReconciliationRequiredError,
  BotTurnRecoveryRequiredError,
} from "@frockbot/kernel-do";
import type { BotTurnCommand, BotTurnCompletion } from "./backend-contracts.js";

export {
  BotTurnExecutionError,
  BotTurnReconciliationRequiredError,
  BotTurnRecoveryRequiredError,
};

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
 * from. Shared by the Composition-mounted and the resident execution paths, so
 * both reach exactly the same durable terminal, recovery, or reconciliation
 * outcome.
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
    const unresolvedTool = [
      ...validateToolOccurrenceJournal(events).values(),
    ].find((entry) => entry.intent && !entry.result);
    if (unresolvedTool) {
      throw new BotTurnReconciliationRequiredError(
        `Tool effect "${unresolvedTool.occurrence.occurrenceId}" requires reconciliation`,
        appendedSessionEvents(previousEvents, events),
      );
    }
    const reconciliation = events.findLast(
      (event) =>
        event.type === "model/reconciliation-required" &&
        event.turn === currentTurn,
    );
    if (reconciliation?.type === "model/reconciliation-required") {
      throw new BotTurnReconciliationRequiredError(
        reconciliation.reason,
        appendedSessionEvents(previousEvents, events),
      );
    }
    const latestRequest = events.findLast(
      (event) => event.type === "model/request" && event.turn === currentTurn,
    );
    const hasDurableOutcome =
      latestRequest?.type === "model/request" &&
      events.some(
        (event) =>
          (event.type === "assistant/message" ||
            event.type === "model/effect-not-started") &&
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
    // A Turn the Bot ended by speaking through `send_to_user` writes no
    // assistant message at all, so the derived text falls back to the last
    // text payload it sent. Every other payload leaves the text empty and
    // reaches the client as a projected `send/to-user` event instead.
    text: assistantText || lastSentTextV1(events),
    events: appendedSessionEvents(previousEvents, events),
  };
}

/** The last `text` payload the Turn sent, or `""` when it sent none. */
function lastSentTextV1(events: readonly SessionEvent[]): string {
  const sent = events.findLast(
    (event) => event.type === "send/to-user" && event.payload.type === "text",
  );
  return sent?.type === "send/to-user" && sent.payload.type === "text"
    ? sent.payload.text
    : "";
}

function turnExecutionError(
  error: unknown,
  previousEvents: readonly SessionEvent[],
  events: readonly SessionEvent[],
): never {
  if (
    error instanceof BotTurnExecutionError ||
    error instanceof BotTurnReconciliationRequiredError ||
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

export async function executeBotTurn(
  options: ExecuteBotTurnOptions,
): Promise<BotTurnCompletion> {
  const { command, previousEvents, composition, resume } = options;
  const runtime = composition.runtime;
  try {
    if (resume) runtime.agent.agent.resume();
    else runtime.agent.agent.send(command.text);
    await runtime.agent.agent.whenIdle();
    return settleBotTurn(runtime.agent, command, previousEvents);
  } catch (error) {
    turnExecutionError(error, previousEvents, [
      ...runtime.agent.agent.session.events,
    ]);
  } finally {
    await composition.dispose();
  }
}

export interface ExecuteResidentBotTurnOptions {
  botId: string;
  command: BotTurnCommand;
  previousEvents: readonly SessionEvent[];
  persistSessionEvents: PersistSessionEvents;
  beforeStart(): Promise<boolean>;
  admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
  resume?: boolean;
}

export interface ResidentTurnRuntime {
  execute(input: {
    botId: string;
    sessionId: string;
    runId: string;
    previousEvents: readonly SessionEvent[];
    persistSessionEvents: PersistSessionEvents;
    beforeStart(): Promise<boolean>;
    admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
    resume?: boolean;
    text: string;
    turnType: TurnTypeV1;
  }): Promise<AgentHandle>;
}

/**
 * Runs one Turn on the Bot Durable Object's resident Cordis root. The root
 * outlives the Turn, so nothing is disposed here; the durable effect fence and
 * the session persistence are the caller's.
 */
export async function executeResidentBotTurn(
  runtime: ResidentTurnRuntime,
  options: ExecuteResidentBotTurnOptions,
): Promise<BotTurnCompletion> {
  const {
    botId,
    command,
    previousEvents,
    persistSessionEvents,
    beforeStart,
    admitEffect,
    resume,
  } = options;
  let handle: AgentHandle | undefined;
  try {
    handle = await runtime.execute({
      botId,
      sessionId: command.sessionId,
      runId: command.runId,
      previousEvents,
      persistSessionEvents,
      beforeStart,
      admitEffect,
      resume,
      text: command.text,
      turnType: command.turnType ?? "chat",
    });
    return settleBotTurn(handle, command, previousEvents);
  } catch (error) {
    turnExecutionError(
      error,
      previousEvents,
      handle ? [...handle.agent.session.events] : [...previousEvents],
    );
  }
}
