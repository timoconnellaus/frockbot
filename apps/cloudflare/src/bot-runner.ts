import {
  createFoundationRuntime,
  type FoundationAgentPackage,
} from "@frockbot/agent-runtime/runtime";
import { createFoundationRuntimeApplication } from "@frockbot/application-foundation/runtime";
import type { PersistSessionEvents, SessionEvent } from "@frockbot/agent-core";
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";
import type { BotTurnCommand, BotTurnResult } from "./contracts.js";
import { appendedSessionEvents } from "./durable-session.js";

export class BotTurnExecutionError extends Error {
  constructor(
    message: string,
    readonly events: SessionEvent[],
  ) {
    super(message);
    this.name = "BotTurnExecutionError";
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
    const message = runtime.agent.agent.session.deriveMessages().at(-1);
    return {
      runId: command.runId,
      text: message?.role === "assistant" ? message.content : "",
      events: appendedSessionEvents(previousEvents, events),
    };
  } catch (error) {
    const events = [...runtime.agent.agent.session.events];
    throw new BotTurnExecutionError(
      error instanceof Error ? error.message : "Bot turn failed",
      appendedSessionEvents(previousEvents, events),
    );
  } finally {
    await runtime.dispose();
  }
}
