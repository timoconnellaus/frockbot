import {
  createFoundationRuntimeApplication,
  type FoundationRuntimeApplication,
  FOUNDATION_MODEL,
  FOUNDATION_PROVIDER,
} from "@frockbot/application-foundation";
import {
  AgentRegistry,
  type AgentHandle,
  LlmRegistry,
  type SessionEvent,
  SessionStore,
  SystemPromptRegistry,
  ToolRegistry,
} from "@frockbot/agent-core";
import { AgentLoop } from "@frockbot/agent-loop";
import {
  type ContributionResolver,
  PackageCatalog,
} from "@frockbot/plugin-catalog";
import {
  createRuntimeContributionHost,
  runtimePackageCatalogConfig,
} from "@frockbot/plugin-catalog/runtime";
import {
  createMemoryPlugin,
  type MemoryPluginConfig,
} from "@frockbot/plugin-memory";
import {
  createOpenAICompatiblePlugin,
  type FetchLike,
} from "@frockbot/provider-openai-compatible";
import { Context, type Plugin } from "cordis";

export { FOUNDATION_MODEL, FOUNDATION_PROVIDER };

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

export interface FoundationAgentPackage {
  specifier: string;
  contributionSpecifier: string;
  manifest: unknown;
  plugin: Plugin;
}

export interface FoundationRuntimeOptions {
  sessionId?: string;
  sessionEvents?: readonly SessionEvent[];
  application?: FoundationRuntimeApplication;
  resolveContribution?: ContributionResolver;
  agentPackages?: readonly FoundationAgentPackage[];
  memory?: MemoryPluginConfig;
}

export async function createFoundationRuntime(
  modelConfig?: RuntimeModelConfig,
  options: FoundationRuntimeOptions = {},
): Promise<FoundationRuntime> {
  const sessionId = options.sessionId?.trim() || "barebones";
  const application =
    options.application ?? (await createFoundationRuntimeApplication());
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
  await root.plugin(PackageCatalog, runtimePackageCatalogConfig);

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

  const resolveContribution: ContributionResolver = (specifier) => {
    if (specifier === "@frockbot/plugin-memory/agent" && options.memory) {
      return Promise.resolve({ default: createMemoryPlugin(options.memory) });
    }
    const additional = options.agentPackages?.find(
      (pkg) => pkg.contributionSpecifier === specifier,
    );
    if (additional) return Promise.resolve({ default: additional.plugin });
    return (options.resolveContribution ?? application.resolveContribution)(
      specifier,
    );
  };
  root.packages.registerHost(
    createRuntimeContributionHost(root, resolveContribution),
  );

  const packageIds = application.packages.map(
    (source) => root.packages.install(source).manifest.id,
  );
  const additionalIds = (options.agentPackages ?? []).flatMap((pkg) => {
    if (root.packages.list().some((installed) => installed.specifier === pkg.specifier)) {
      return [];
    }
    return [
      root.packages.install({ specifier: pkg.specifier, manifest: pkg.manifest })
        .manifest.id,
    ];
  });
  for (const packageId of [...packageIds, ...additionalIds]) {
    if (packageId === "memory" && !options.memory) continue;
    await root.packages.enable(packageId);
  }
  await root.plugin(AgentLoop, { maxSteps: 8 });

  const agent = await root.agents.create({ sessionId, provider, model });
  return {
    root,
    agent,
    provider,
    model,
    dispose: () => root.fiber.dispose(),
  };
}
