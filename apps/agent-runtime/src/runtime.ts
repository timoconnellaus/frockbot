import {
  createFoundationRuntimeApplication,
  type FoundationRuntimeApplication,
  FOUNDATION_MODEL,
  FOUNDATION_PROVIDER,
} from "@frockbot/application-foundation/runtime";
import {
  AgentRegistry,
  type AgentHandle,
  type AgentOptions,
  LlmRegistry,
  type PersistSessionEvents,
  type SessionEvent,
  SessionStore,
  SystemPromptRegistry,
  ToolRegistry,
} from "@frockbot/agent-core";
import { AgentLoop } from "@frockbot/agent-loop";
import { ComputerRegistry } from "@frockbot/computer-core";
import {
  type ContributionResolver,
  PackageCatalog,
  type PackageSource,
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
import { Context, type Fiber, type Plugin } from "cordis";

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

export interface FoundationResidentProjection {
  generation: number;
  agentPackages: readonly FoundationAgentPackage[];
  systemPromptSection?: string;
}

export interface FoundationResidentExecution {
  botId: string;
  sessionId: string;
  previousEvents: readonly SessionEvent[];
  persistSessionEvents: PersistSessionEvents;
  resume?: boolean;
  text: string;
}

export interface FoundationResidentRuntime {
  readonly root: Context;
  readonly generation: number | undefined;
  project(projection: FoundationResidentProjection): Promise<void>;
  execute(execution: FoundationResidentExecution): Promise<AgentHandle>;
  dispose(): Promise<void>;
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
}

async function mountFoundationRuntimeServices(
  root: Context,
  application: FoundationRuntimeApplication,
  options: {
    memory?: MemoryPluginConfig;
    stableAgentPackages?: readonly FoundationAgentPackage[];
  } = {},
): Promise<Fiber[]> {
  const fibers: Fiber[] = [];
  const mounted = async (fiber: Fiber & PromiseLike<Fiber>) => {
    fibers.push(fiber);
    await fiber;
  };
  try {
    await mounted(root.plugin(SessionStore));
    await mounted(root.plugin(SystemPromptRegistry));
    await mounted(root.plugin(LlmRegistry));
    await mounted(root.plugin(ToolRegistry));
    await mounted(root.plugin(AgentRegistry));
    await mounted(root.plugin(ComputerRegistry));
    await mounted(root.plugin(PackageCatalog, runtimePackageCatalogConfig));
    const stablePackages = options.stableAgentPackages ?? [];
    const resolveContribution: ContributionResolver = (specifier) => {
      if (specifier === "@frockbot/plugin-memory/agent" && options.memory) {
        return Promise.resolve({ default: createMemoryPlugin(options.memory) });
      }
      const additional = stablePackages.find(
        (pkg) => pkg.contributionSpecifier === specifier,
      );
      if (additional) return Promise.resolve({ default: additional.plugin });
      return application.resolveContribution(specifier);
    };
    root.packages.registerHost(
      createRuntimeContributionHost(root, resolveContribution),
    );
    const packageIds = application.packages.map(
      (source: PackageSource) => root.packages.install(source).manifest.id,
    );
    const additionalIds = stablePackages.flatMap((pkg) => {
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
    for (const packageId of [...additionalIds, ...packageIds]) {
      if (packageId === "memory" && !options.memory) continue;
      await root.packages.enable(packageId);
    }
    await mounted(root.plugin(AgentLoop, { maxSteps: 8 }));
    return fibers;
  } catch (error) {
    await Promise.allSettled(fibers.reverse().map((fiber) => fiber.dispose()));
    throw error;
  }
}

export async function createFoundationResidentRuntime(
  root: Context,
  options: {
    application?: FoundationRuntimeApplication;
    memory?: MemoryPluginConfig;
    stableAgentPackages?: readonly FoundationAgentPackage[];
  } = {},
): Promise<FoundationResidentRuntime> {
  const application =
    options.application ?? (await createFoundationRuntimeApplication());
  const stableFibers = await mountFoundationRuntimeServices(root, application, {
    memory: options.memory,
    stableAgentPackages: options.stableAgentPackages,
  });
  let generation: number | undefined;
  let dynamicFibers: Fiber[] = [];
  let agent: AgentHandle | undefined;
  let sessionId: string | undefined;
  let activePersist: PersistSessionEvents | undefined;
  let disposed = false;
  let projectionQueue: Promise<void> = Promise.resolve();

  const clearDynamic = async () => {
    const previous = dynamicFibers;
    dynamicFibers = [];
    await Promise.allSettled(
      previous.reverse().map((fiber) => fiber.dispose()),
    );
  };

  const applyProjection = async (
    projection: FoundationResidentProjection,
  ): Promise<void> => {
    if (disposed) throw new Error("resident Bot runtime is disposed");
    if (
      !Number.isSafeInteger(projection.generation) ||
      projection.generation < 0
    ) {
      throw new Error("runtime generation is invalid");
    }
    if (generation === projection.generation) return;
    if (agent?.agent.status === "running") {
      throw new Error("cannot remount a resident runtime during active work");
    }
    await clearDynamic();
    const mounted: Fiber[] = [];
    try {
      if (projection.systemPromptSection?.trim()) {
        const content = projection.systemPromptSection.trim();
        const settingsPromptPlugin: Plugin.Function = (ctx) =>
          ctx.systemPrompt.register({
            id: "bot-settings",
            render: () => content,
          });
        settingsPromptPlugin.inject = ["systemPrompt"];
        const fiber = root.plugin(settingsPromptPlugin);
        mounted.push(fiber);
        await fiber;
      }
      for (const pkg of projection.agentPackages) {
        const fiber = root.plugin(pkg.plugin);
        mounted.push(fiber);
        await fiber;
      }
      dynamicFibers = mounted;
      generation = projection.generation;
    } catch (error) {
      await Promise.allSettled(
        mounted.reverse().map((fiber) => fiber.dispose()),
      );
      generation = undefined;
      throw error;
    }
  };

  return {
    root,
    get generation() {
      return generation;
    },
    async project(projection) {
      const operation = projectionQueue.then(() => applyProjection(projection));
      projectionQueue = operation.catch(() => undefined);
      await operation;
    },
    async execute(execution) {
      if (disposed) throw new Error("resident Bot runtime is disposed");
      if (generation === undefined) {
        throw new Error("resident Bot runtime projection is not applied");
      }
      if (agent) {
        if (sessionId !== execution.sessionId) {
          throw new Error("resident Bot runtime session identity changed");
        }
        const current = agent.agent.session.events;
        if (
          current.length !== execution.previousEvents.length ||
          current.some(
            (event, index) =>
              JSON.stringify(event) !==
              JSON.stringify(execution.previousEvents[index]),
          )
        ) {
          throw new Error(
            "resident Bot runtime history diverged from durable state",
          );
        }
        activePersist = execution.persistSessionEvents;
      } else {
        sessionId = execution.sessionId;
        activePersist = execution.persistSessionEvents;
        const sessionStore = root.sessions as SessionStore & {
          prepare(
            sessionId: string,
            options: {
              initialEvents: readonly SessionEvent[];
              persistEvents: PersistSessionEvents;
            },
          ): () => void;
        };
        const cancelPreparation = sessionStore.prepare(execution.sessionId, {
          initialEvents: execution.previousEvents,
          persistEvents: (id: string, events: readonly SessionEvent[]) => {
            const persist = activePersist;
            return persist ? persist(id, events) : Promise.resolve();
          },
        });
        try {
          agent = await root.agents.create({
            botId: execution.botId,
            agentId: execution.botId,
            sessionId: execution.sessionId,
            provider: FOUNDATION_PROVIDER,
            model: FOUNDATION_MODEL,
          });
        } finally {
          cancelPreparation();
        }
      }
      try {
        if (execution.resume) agent.agent.resume();
        else agent.agent.send(execution.text);
        await agent.agent.whenIdle();
        await agent.agent.session.flush();
        return agent;
      } finally {
        activePersist = undefined;
      }
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      await projectionQueue;
      await clearDynamic();
      await Promise.allSettled(
        stableFibers.reverse().map((fiber) => fiber.dispose()),
      );
    },
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
  await root.plugin(AgentLoop, { maxSteps: 8 });

  const agentOptions: AgentOptions = {
    botId: options.botId?.trim() || options.agentId?.trim() || sessionId,
    agentId: options.agentId,
    sessionId,
    provider,
    model,
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
