import { desktopComputerRuntimePackages } from "../../../applications/foundation/src/desktop-runtime.js";

// Desktop-only runtime authority is added outside the Worker-safe application.
import {
  isAgentCommand,
  type AgentCommand,
  type AgentEvent,
} from "@frockbot/protocol";
import type { Plugin } from "cordis";
import {
  createFoundationRuntime,
  type FoundationRuntime,
  type RuntimeModelConfig,
} from "./runtime.js";

interface UtilityParentPort {
  on(event: "message", listener: (event: { data: unknown }) => void): void;
  off(event: "message", listener: (event: { data: unknown }) => void): void;
  postMessage(event: AgentEvent): void;
}

const parentPort: UtilityParentPort = (() => {
  const candidate = (
    process as NodeJS.Process & { parentPort?: UtilityParentPort }
  ).parentPort;
  if (!candidate)
    throw new Error("Cordis agent runtime requires an Electron parent port");
  return candidate;
})();

function post(event: AgentEvent): void {
  parentPort.postMessage(event);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// MEMORY IS NOT MOUNTED IN THIS RUNTIME. It used to be, through the Computer's
// named `memoryWriter` seam — the Computer had to be awake for the Bot to read
// its own Memory, which is exactly what "The Agent loop, Memory, Skills,
// Package composition, and Routines function correctly while the Computer is
// hibernated and do not wake it" forbids. Under ADR 0013 the Memory Package
// writes object storage directly, and the surface that backs it is a Durable
// Object binding the hosted backend supplies. This Electron utility runtime is
// a platform shell with no such binding, so it mounts no Memory Package rather
// than reaching a second store: "Desktop and mobile Contributions provide
// optional platform adapters; their absence does not stop Agent execution."

function modelConfigFromEnvironment(): RuntimeModelConfig | undefined {
  const baseUrl = process.env.FROCKBOT_LLM_BASE_URL?.trim();
  const model = process.env.FROCKBOT_LLM_MODEL?.trim();
  if (!baseUrl && !model) return undefined;
  if (!baseUrl || !model) {
    throw new Error(
      "FROCKBOT_LLM_BASE_URL and FROCKBOT_LLM_MODEL must be set together",
    );
  }
  return {
    baseUrl,
    model,
    apiKey: process.env.FROCKBOT_LLM_API_KEY,
    providerId: process.env.FROCKBOT_LLM_PROVIDER_ID?.trim() || undefined,
  };
}

async function start(): Promise<void> {
  let runtime: FoundationRuntime;
  try {
    const botId = process.env.FROCKBOT_BOT_ID?.trim() || "barebones";
    runtime = await createFoundationRuntime(modelConfigFromEnvironment(), {
      botId,
      agentId: process.env.FROCKBOT_AGENT_ID?.trim() || botId,
      sessionId: process.env.FROCKBOT_SESSION_ID?.trim() || "barebones",
      agentPackages: desktopComputerRuntimePackages,
    });
  } catch (error) {
    post({ type: "error", phase: "startup", message: errorMessage(error) });
    return;
  }

  let activeRunId: string | undefined;
  let shuttingDown = false;

  const bridgePlugin: Plugin.Function = (ctx) => {
    const disposers = [
      ctx.on("session/event", ({ event }) => {
        const runId = activeRunId;
        if (!runId) return;
        if (event.type === "assistant/chunk") {
          post({ type: "text-delta", runId, text: event.text });
        } else if (event.type === "tool/call") {
          post({
            type: "tool-start",
            runId,
            toolCallId: event.occurrenceId,
            name: event.name,
            input: event.input,
          });
        } else if (event.type === "tool/result") {
          post({
            type: "tool-end",
            runId,
            toolCallId: event.occurrenceId,
            name: event.name,
            text: event.content,
            isError: event.isError,
          });
        } else if (event.type === "turn/end") {
          activeRunId = undefined;
          post({
            type: "settled",
            runId,
            reason: event.outcome === "cancelled" ? "aborted" : "completed",
          });
        }
      }),
      ctx.on("agent/error", (_agent, error) => {
        const runId = activeRunId;
        activeRunId = undefined;
        post({
          type: "error",
          phase: "run",
          runId,
          message: errorMessage(error),
        });
      }),
    ];

    const onMessage = (message: { data: unknown }) => {
      if (!isAgentCommand(message.data)) {
        post({
          type: "error",
          phase: "run",
          message: "Malformed agent command",
        });
        return;
      }
      const command: AgentCommand = message.data;
      if (command.type === "prompt") {
        if (activeRunId) {
          post({
            type: "error",
            phase: "run",
            runId: command.runId,
            message: "The Cordis agent is already running",
          });
          return;
        }
        activeRunId = command.runId;
        post({ type: "run-started", runId: command.runId });
        try {
          runtime.agent.agent.send(command.text);
        } catch (error) {
          activeRunId = undefined;
          post({
            type: "error",
            phase: "run",
            runId: command.runId,
            message: errorMessage(error),
          });
        }
      } else if (command.type === "abort") {
        if (activeRunId === command.runId) runtime.agent.agent.cancel();
      } else {
        void shutdown();
      }
    };

    parentPort.on("message", onMessage);
    return [...disposers, () => parentPort.off("message", onMessage)];
  };

  async function shutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    await runtime.dispose();
    setImmediate(() => process.exit(0));
  }

  await runtime.root.plugin(bridgePlugin);
  post({
    type: "worker-ready",
    model: { provider: runtime.provider, id: runtime.model },
  });
}

void start();
