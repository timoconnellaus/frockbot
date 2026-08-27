import { flySpriteRuntimePackage } from "../../../applications/foundation/src/desktop-runtime.js";

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
    runtime = await createFoundationRuntime(modelConfigFromEnvironment(), {
      agentId: process.env.FROCKBOT_AGENT_ID?.trim() || "barebones",
      sessionId: process.env.FROCKBOT_SESSION_ID?.trim() || "barebones",
      agentPackages: [flySpriteRuntimePackage],
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
            toolCallId: event.call.id,
            name: event.call.name,
            input: event.call.input,
          });
        } else if (event.type === "tool/result") {
          post({
            type: "tool-end",
            runId,
            toolCallId: event.callId,
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
