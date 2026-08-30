import type {
  AgentHandle,
  PersistSessionEvents,
  SessionEvent,
} from "@frockbot/agent-core";
import type { BotTurnCommand, BotTurnCompletion } from "./backend-contracts.js";

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

export class BotTurnExecutionError extends Error {
  constructor(
    message: string,
    readonly events: SessionEvent[],
  ) {
    super(message);
    this.name = "BotTurnExecutionError";
  }
}

export class BotTurnReconciliationRequiredError extends Error {
  constructor(
    message: string,
    readonly events: SessionEvent[],
  ) {
    super(message);
    this.name = "BotTurnReconciliationRequiredError";
  }
}

export interface ExecuteBotTurnOptions {
  botId: string;
  command: BotTurnCommand;
  previousEvents: readonly SessionEvent[];
  persistSessionEvents: PersistSessionEvents;
  resume?: boolean;
}

export interface ResidentTurnRuntime {
  execute(input: {
    botId: string;
    sessionId: string;
    previousEvents: readonly SessionEvent[];
    persistSessionEvents: PersistSessionEvents;
    resume?: boolean;
    text: string;
  }): Promise<AgentHandle>;
}

export async function executeResidentBotTurn(
  runtime: ResidentTurnRuntime,
  options: ExecuteBotTurnOptions,
): Promise<BotTurnCompletion> {
  const { botId, command, previousEvents, persistSessionEvents, resume } =
    options;
  let handle: AgentHandle | undefined;
  try {
    handle = await runtime.execute({
      botId,
      sessionId: command.sessionId,
      previousEvents,
      persistSessionEvents,
      resume,
      text: command.text,
    });
    const events = [...handle.agent.session.events];
    const turnStart = events.findLast((event) => event.type === "turn/start");
    const currentTurn =
      turnStart?.type === "turn/start" ? turnStart.turn : undefined;
    const terminalTurn = events.findLast(
      (event) => event.type === "turn/end" && event.turn === currentTurn,
    );
    if (!terminalTurn || terminalTurn.type !== "turn/end") {
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
      throw new BotTurnExecutionError(
        "Bot turn did not reach a durable terminal state",
        appendedSessionEvents(previousEvents, events),
      );
    }
    if (terminalTurn.outcome !== "completed") {
      throw new BotTurnExecutionError(
        `Bot turn ended with outcome ${terminalTurn.outcome}`,
        appendedSessionEvents(previousEvents, events),
      );
    }
    const message = handle.agent.session.deriveMessages().at(-1);
    return {
      runId: command.runId,
      text: message?.role === "assistant" ? message.content : "",
      events: appendedSessionEvents(previousEvents, events),
    };
  } catch (error) {
    if (
      error instanceof BotTurnExecutionError ||
      error instanceof BotTurnReconciliationRequiredError
    ) {
      throw error;
    }
    const events = handle
      ? [...handle.agent.session.events]
      : [...previousEvents];
    throw new BotTurnExecutionError(
      error instanceof Error ? error.message : "Bot turn failed",
      appendedSessionEvents(previousEvents, events),
    );
  }
}
