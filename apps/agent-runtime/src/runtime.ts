import {
  createFoundationRuntimeApplication,
  type FoundationRuntimeApplication,
  FOUNDATION_MODEL,
  FOUNDATION_PROVIDER,
} from "@frockbot/application-foundation/runtime";
import {
  type CompositionPinV1,
  type PersistSessionEvents,
  type SessionEvent,
  SessionStore,
} from "@frockbot/kernel-contracts";
import {
  type AgentHandle,
  type AgentOptions,
  AgentRegistry,
} from "@frockbot/kernel-agent-loop/agent";
import { LlmRegistry } from "@frockbot/plugin-models";
import { SystemPromptRegistry } from "@frockbot/plugin-prompt";
import { ToolRegistry } from "@frockbot/plugin-tools";
import { AgentLoop } from "@frockbot/kernel-agent-loop";
import { ComputerRegistry } from "@frockbot/computer-core";
import {
  type ContributionResolver,
  PackageCatalog,
  type PackageSource,
} from "@frockbot/kernel-composition";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import {
  createRuntimeContributionHost,
  runtimePackageCatalogConfig,
} from "@frockbot/kernel-composition/runtime";
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

export interface RuntimeModelSelection {
  provider: string;
  model: string;
  connectionId?: string;
  connectionGeneration?: string;
  catalogGeneration?: string;
}

export interface FoundationRuntimeOptions {
  botId?: string;
  agentId?: string;
  sessionId?: string;
  sessionEvents?: readonly SessionEvent[];
  application?: FoundationRuntimeApplication;
  resolveContribution?: ContributionResolver;
  agentPackages?: readonly FoundationAgentPackage[];
  memory?: MemoryPluginConfig;
  persistSessionEvents?: PersistSessionEvents;
  systemPromptSection?: string;
  modelSelection?: RuntimeModelSelection;
  /** The Composition generation this root is pinned to; defaults to bootstrap. */
  composition?: CompositionPinV1;
}

/** The first-party generation a runtime with no durable Composition starts on. */
export async function bootstrapRuntimeGeneration(
  application: FoundationRuntimeApplication,
): Promise<CompositionGenerationV1> {
  return bootstrapGeneration(
    application.plan.packages.map((pkg) => ({
      packageId: pkg.id,
      specifier: pkg.specifier,
      version: pkg.version,
      manifest: pkg.manifest,
    })),
    { createdAt: new Date(0).toISOString() },
  );
}

async function bootstrapCompositionPin(
  application: FoundationRuntimeApplication,
): Promise<CompositionPinV1> {
  const generation = await bootstrapRuntimeGeneration(application);
  return {
    generationId: generation.generationId,
    artifactSetHash: generation.artifactSetHash,
  };
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
    persistEvents: options.persistSessionEvents,
  });
  await root.plugin(SystemPromptRegistry);
  if (options.systemPromptSection?.trim()) {
    const content = options.systemPromptSection.trim();
    const settingsPromptPlugin: Plugin.Function = (ctx) =>
      ctx.systemPrompt.register({ id: "bot-settings", render: () => content });
    settingsPromptPlugin.inject = ["systemPrompt"];
    await root.plugin(settingsPromptPlugin);
  }
  await root.plugin(LlmRegistry);
  await root.plugin(ToolRegistry);
  await root.plugin(AgentRegistry);
  // Provider Packages register adapters before Computer consumers activate.
  await root.plugin(ComputerRegistry);
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
    (source: PackageSource) => root.packages.install(source).manifest.id,
  );
  const additionalIds = (options.agentPackages ?? []).flatMap((pkg) => {
    if (
      root.packages
        .list()
        .some((installed) => installed.specifier === pkg.specifier)
    ) {
      return [];
    }
    return [
      root.packages.install({
        specifier: pkg.specifier,
        manifest: pkg.manifest,
      }).manifest.id,
    ];
  });
  // Provider contributions must mount before consumers that open their capabilities.
  for (const packageId of [...additionalIds, ...packageIds]) {
    if (packageId === "memory" && !options.memory) continue;
    await root.packages.enable(packageId);
  }
  const composition =
    options.composition ?? (await bootstrapCompositionPin(application));
  await root.plugin(AgentLoop, { maxSteps: 8, composition });

  const selection = options.modelSelection;
  if (selection) {
    provider = selection.provider;
    model = selection.model;
  }
  const agentOptions: AgentOptions = {
    botId: options.botId?.trim() || options.agentId?.trim() || sessionId,
    agentId: options.agentId,
    sessionId,
    provider,
    model,
    ...(selection?.connectionId
      ? {
          modelBinding: {
            connectionId: selection.connectionId,
            ...(selection.connectionGeneration
              ? { connectionGeneration: selection.connectionGeneration }
              : {}),
            ...(selection.catalogGeneration
              ? { catalogGeneration: selection.catalogGeneration }
              : {}),
          },
        }
      : {}),
  };
  const agent = await root.agents.create(agentOptions);
  return {
    root,
    agent,
    provider,
    model,
    dispose: () => root.fiber.dispose(),
  };
}
