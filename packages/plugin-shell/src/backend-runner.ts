import {
  createFoundationRuntime,
  type FoundationAgentPackage,
  type RuntimeModelSelection,
} from "@frockbot/agent-runtime/runtime";
import { createFoundationRuntimeApplication } from "@frockbot/application-foundation/runtime";
import type { PersistSessionEvents, SessionEvent } from "@frockbot/agent-core";
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";
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

export class BotTurnRecoveryRequiredError extends Error {
  constructor(readonly events: SessionEvent[]) {
    super("Bot turn has a durable outcome settlement pending");
    this.name = "BotTurnRecoveryRequiredError";
  }
}

export interface ExecuteBotTurnOptions {
  botId: string;
  command: BotTurnCommand;
  previousEvents: readonly SessionEvent[];
  memory?: MemoryPluginConfig;
  persistSessionEvents?: PersistSessionEvents;
  agentPackages?: readonly FoundationAgentPackage[];
  modelSelection?: RuntimeModelSelection;
  systemPromptSection?: string;
  resume?: boolean;
}

export async function executeBotTurn(
  options: ExecuteBotTurnOptions,
): Promise<BotTurnCompletion> {
  const {
    botId,
    command,
    previousEvents,
    memory,
    persistSessionEvents,
    agentPackages,
    modelSelection,
    systemPromptSection,
    resume,
  } = options;
  const runtime = await createFoundationRuntime(undefined, {
    agentId: botId,
    sessionId: command.sessionId,
    sessionEvents: previousEvents,
    application: await createFoundationRuntimeApplication(),
    memory,
    persistSessionEvents,
    agentPackages,
    modelSelection,
    systemPromptSection,
  });

  try {
    if (resume) runtime.agent.agent.resume();
    else runtime.agent.agent.send(command.text);
    await runtime.agent.agent.whenIdle();
    const events = [...runtime.agent.agent.session.events];
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
        `Bot turn ended with outcome ${terminalTurn.outcome}`,
        appendedSessionEvents(previousEvents, events),
      );
    }
    const message = runtime.agent.agent.session.deriveMessages().at(-1);
    return {
      runId: command.runId,
      text: message?.role === "assistant" ? message.content : "",
      events: appendedSessionEvents(previousEvents, events),
    };
  } catch (error) {
    if (
      error instanceof BotTurnExecutionError ||
      error instanceof BotTurnReconciliationRequiredError ||
      error instanceof BotTurnRecoveryRequiredError
    ) {
      throw error;
    }
    const events = [...runtime.agent.agent.session.events];
    throw new BotTurnExecutionError(
      error instanceof Error ? error.message : "Bot turn failed",
      appendedSessionEvents(previousEvents, events),
    );
  } finally {
    await runtime.dispose();
  }
}
