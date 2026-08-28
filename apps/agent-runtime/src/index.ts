import { desktopComputerRuntimePackages } from "../../../applications/foundation/src/desktop-runtime.js";

// Desktop-only runtime authority is added outside the Worker-safe application.
import {
  type MemoryPluginConfig,
  type MemoryVector,
  WorkspaceMemoryDocumentStore,
} from "@frockbot/plugin-memory";
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

function cosineSimilarity(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  const length = Math.min(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }
  const denominator = Math.sqrt(leftMagnitude) * Math.sqrt(rightMagnitude);
  return denominator ? dot / denominator : 0;
}

function desktopMemoryConfig(botId: string): MemoryPluginConfig {
  const userId = process.env.FROCKBOT_USER_ID?.trim() || "local-user";
  const providerId =
    process.env.FROCKBOT_COMPUTER_PROVIDER?.trim() || "fly-sprite";
  const vectors = new Map<string, MemoryVector>();
  return {
    ownerId: userId,
    botId,
    createDocuments: async (ctx) => {
      const target = { userId, botId };
      if (!ctx.computers.assignment(target)) {
        ctx.computers.assign(target, providerId);
      }
      const computer = await ctx.computers.open(target);
      if (!computer.workspace) {
        await computer.close();
        throw new Error("The selected Computer does not provide durable files");
      }
      const [agent, global] = await Promise.all([
        computer.workspace.openDirectory({
          namespace: "memory/agent",
          scope: "bot",
          durability: "durable",
        }),
        computer.workspace.openDirectory({
          namespace: "memory/global",
          scope: "user",
          durability: "durable",
        }),
      ]);
      return new WorkspaceMemoryDocumentStore({ agent, global }, () =>
        computer.close(),
      );
    },
    vectorize: {
      upsert: (entries) => {
        for (const entry of entries) vectors.set(entry.id, entry);
        return Promise.resolve();
      },
      query: (vector, options) =>
        Promise.resolve({
          matches: [...vectors.values()]
            .filter((entry) => entry.namespace === options.namespace)
            .map((entry) => ({
              id: entry.id,
              score: cosineSimilarity(vector, entry.values),
              metadata: entry.metadata,
            }))
            .sort((left, right) => right.score - left.score)
            .slice(0, options.topK),
        }),
      deleteByIds: (ids) => {
        for (const id of ids) vectors.delete(id);
        return Promise.resolve();
      },
    },
    embed: (texts) =>
      Promise.resolve(
        texts.map((text) => {
          const vector = Array.from({ length: 32 }, () => 0);
          for (const byte of new TextEncoder().encode(text.toLowerCase())) {
            vector[byte % vector.length] =
              (vector[byte % vector.length] ?? 0) + 1;
          }
          return vector;
        }),
      ),
  };
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
    const botId = process.env.FROCKBOT_BOT_ID?.trim() || "barebones";
    runtime = await createFoundationRuntime(modelConfigFromEnvironment(), {
      botId,
      agentId: process.env.FROCKBOT_AGENT_ID?.trim() || botId,
      sessionId: process.env.FROCKBOT_SESSION_ID?.trim() || "barebones",
      agentPackages: desktopComputerRuntimePackages,
      memory: desktopMemoryConfig(botId),
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
