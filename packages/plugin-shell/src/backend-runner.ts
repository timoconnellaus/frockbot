import {
  createFoundationRuntime,
  type FoundationAgentPackage,
} from "@frockbot/agent-runtime/runtime";
import { createFoundationRuntimeApplication } from "@frockbot/application-foundation/runtime";
import type { PersistSessionEvents, SessionEvent } from "@frockbot/agent-core";
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";
import type { BotTurnCommand, BotTurnResult } from "./backend-contracts.js";

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
  memory?: MemoryPluginConfig;
  persistSessionEvents?: PersistSessionEvents;
  agentPackages?: readonly FoundationAgentPackage[];
  systemPromptSection?: string;
  resume?: boolean;
}

export async function executeBotTurn(
  options: ExecuteBotTurnOptions,
): Promise<BotTurnResult> {
  const {
    botId,
    command,
    previousEvents,
    memory,
    persistSessionEvents,
    agentPackages,
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
    systemPromptSection,
  });

  try {
    if (resume) runtime.agent.agent.resume();
    else runtime.agent.agent.send(command.text);
    await runtime.agent.agent.whenIdle();
    const events = [...runtime.agent.agent.session.events];
    const currentTurn = events.findLast(
      (event) => event.type === "turn/start",
    )?.turn;
    const terminalTurn = events.findLast(
      (event) => event.type === "turn/end" && event.turn === currentTurn,
    );
    if (!terminalTurn) {
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
    const message = runtime.agent.agent.session.deriveMessages().at(-1);
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
    const events = [...runtime.agent.agent.session.events];
    throw new BotTurnExecutionError(
      error instanceof Error ? error.message : "Bot turn failed",
      appendedSessionEvents(previousEvents, events),
    );
  } finally {
    await runtime.dispose();
  }
}
