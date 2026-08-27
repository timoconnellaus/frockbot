import {
  AgentRegistry,
  type AgentHandle,
  LlmRegistry,
  type LlmProvider,
  type SessionEvent,
  SessionStore,
  SystemPromptRegistry,
  ToolRegistry,
  type ToolDefinition,
} from "@frockbot/agent-core";
import { AgentLoop } from "@frockbot/agent-loop";
import {
  type ContributionResolver,
  LocalCordisContributionHost,
  PackageCatalog,
} from "@frockbot/plugin-catalog";
import clockAgentPlugin from "@frockbot/plugin-clock/agent";
import clockManifest from "@frockbot/plugin-clock/manifest";
import {
  createMemoryPlugin,
  type MemoryPluginConfig,
} from "@frockbot/plugin-memory";
import {
  createOpenAICompatiblePlugin,
  type FetchLike,
} from "@frockbot/provider-openai-compatible";
import { Context, type Plugin } from "cordis";

export const FOUNDATION_PROVIDER = "foundation";
export const FOUNDATION_MODEL = "deterministic-v1";

const foundationProvider: LlmProvider = {
  id: FOUNDATION_PROVIDER,
  async *stream(request, signal) {
    signal.throwIfAborted();
    const latest = request.messages.at(-1);
    if (latest?.role === "tool") {
      const label = latest.name === "echo" ? "Echo" : latest.name;
      yield { type: "text-delta", text: `${label}: ` };
      await Promise.resolve();
      signal.throwIfAborted();
      yield { type: "text-delta", text: latest.content };
      yield { type: "finish", reason: "completed" };
      return;
    }
    const user = request.messages.findLast(
      (message) => message.role === "user",
    );
    const text = user?.role === "user" ? user.content : "";
    if (text.startsWith("/echo ")) {
      yield {
        type: "tool-call",
        call: {
          id: crypto.randomUUID(),
          name: "echo",
          input: { text: text.slice(6) },
        },
      };
      yield { type: "finish", reason: "tool-calls" };
      return;
    }
    yield { type: "text-delta", text: "Cordis runtime: " };
    await Promise.resolve();
    signal.throwIfAborted();
    yield { type: "text-delta", text };
    yield { type: "finish", reason: "completed" };
  },
};

const echoTool: ToolDefinition = {
  name: "echo",
  description: "Return supplied text.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
  },
  idempotent: true,
  validate: (input) =>
    typeof input === "object" &&
    input !== null &&
    typeof (input as { text?: unknown }).text === "string",
  execute: async (input) => ({
    content: (input as { text: string }).text,
    isError: false,
  }),
};

const resolveBuiltInContribution: ContributionResolver = (specifier) => {
  if (specifier === "@frockbot/plugin-clock/agent") {
    return Promise.resolve({ default: clockAgentPlugin });
  }
  return Promise.reject(
    new Error(`unknown built-in contribution: ${specifier}`),
  );
};

export interface RuntimeModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  providerId?: string;
  fetch?: FetchLike;
}

export interface FoundationRuntime {
  root: Context;
  agent: AgentHandle;
  provider: string;
  model: string;
  dispose(): Promise<void>;
}

export interface FoundationRuntimeOptions {
  sessionId?: string;
  sessionEvents?: readonly SessionEvent[];
  resolveContribution?: ContributionResolver;
  memory?: MemoryPluginConfig;
}

export async function createFoundationRuntime(
  modelConfig?: RuntimeModelConfig,
  options: FoundationRuntimeOptions = {},
): Promise<FoundationRuntime> {
  const sessionId = options.sessionId?.trim() || "barebones";
  const root = new Context();
  await root.plugin(SessionStore, {
    initialSessions: options.sessionEvents
      ? { [sessionId]: options.sessionEvents }
      : undefined,
  });
  await root.plugin(SystemPromptRegistry);
  await root.plugin(LlmRegistry);
  await root.plugin(ToolRegistry);
  await root.plugin(AgentRegistry);
  await root.plugin(PackageCatalog, { kinds: ["agent"] });

  const identityPlugin: Plugin.Function = (ctx) =>
    ctx.systemPrompt.register({
      id: "identity",
      render: () => "You are FrockBot running on the custom Cordis agent loop.",
    });
  identityPlugin.inject = ["systemPrompt"];

  const providerPlugin: Plugin.Function = (ctx) =>
    ctx.llm.register(foundationProvider);
  providerPlugin.inject = ["llm"];

  const toolPlugin: Plugin.Function = (ctx) => ctx.tools.register(echoTool);
  toolPlugin.inject = ["tools"];

  await root.plugin(identityPlugin);
  await root.plugin(providerPlugin);
  let provider = FOUNDATION_PROVIDER;
  let model = FOUNDATION_MODEL;
  if (modelConfig) {
    provider = modelConfig.providerId ?? "openai-compatible";
    model = modelConfig.model;
    await root.plugin(
      createOpenAICompatiblePlugin({
        baseUrl: modelConfig.baseUrl,
        apiKey: modelConfig.apiKey,
        providerId: provider,
        fetch: modelConfig.fetch,
      }),
    );
  }
  await root.plugin(toolPlugin);
  if (options.memory) await root.plugin(createMemoryPlugin(options.memory));
  root.packages.registerHost(
    new LocalCordisContributionHost(
      "agent",
      root,
      options.resolveContribution ?? resolveBuiltInContribution,
    ),
  );
  root.packages.install({
    specifier: "@frockbot/plugin-clock",
    manifest: clockManifest,
  });
  await root.packages.enable("clock");
  await root.plugin(AgentLoop, { maxSteps: 8 });

  const agent = await root.agents.create({
    sessionId,
    provider,
    model,
  });
  return {
    root,
    agent,
    provider,
    model,
    dispose: () => root.fiber.dispose(),
  };
}
