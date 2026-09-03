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
  type SkillRefV1,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";
import {
  type AgentEffectAdmission,
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
  createOpenAICompatiblePlugin,
  type FetchLike,
} from "@frockbot/provider-openai-compatible";
import { Context, type Fiber, type Plugin } from "cordis";

/**
 * Steps (model calls) one Turn may take before the loop gives up. Tool-heavy
 * Turns routinely need dozens; the earlier cap of 8 cut real work short.
 */
const AGENT_LOOP_MAX_STEPS_V1 = 50;

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
  runId: string;
  previousEvents: readonly SessionEvent[];
  persistSessionEvents: PersistSessionEvents;
  beforeStart(): Promise<boolean>;
  admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
  resume?: boolean;
  text: string;
  /** The Skills the User invoked with this message; absent means none. */
  skills?: SkillRefV1[];
  /** Absent ⇒ `chat`. The resident Agent is created on this turn type. */
  turnType?: TurnTypeV1;
  /** The subagent role the Agent's catalog is narrowed to; absent ⇒ none. */
  subagentRole?: string;
}

/** Narrow cancellation request bound to one exact resident run. */
export interface FoundationResidentCancellation {
  sessionId: string;
  runId: string;
  reason?: "user" | "shutdown";
}

export interface FoundationResidentRuntime {
  readonly root: Context;
  readonly generation: number | undefined;
  project(projection: FoundationResidentProjection): Promise<void>;
  execute(execution: FoundationResidentExecution): Promise<AgentHandle>;
  /**
   * Cancels the resident Agent only while it executes that exact session and
   * run, so a late Stop can never reach a different run.
   */
  cancel(cancellation: FoundationResidentCancellation): boolean;
  dispose(): Promise<void>;
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
  persistSessionEvents?: PersistSessionEvents;
  systemPromptSection?: string;
  /** Explicit effect adapter for the standalone development/test runtime. */
  admitEffect: AgentOptions["admitEffect"];
  modelSelection?: RuntimeModelSelection;
  /** The Composition generation this root is pinned to; defaults to bootstrap. */
  composition?: CompositionPinV1;
  /** The turn type this root's Agent is mounted on; defaults to `chat`. */
  turnType?: TurnTypeV1;
  /** The subagent role this root's Agent is mounted under; defaults to none. */
  subagentRole?: string;
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

async function mountFoundationRuntimeServices(
  root: Context,
  application: FoundationRuntimeApplication,
  options: {
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
      await root.packages.enable(packageId);
    }
    await mounted(
      root.plugin(AgentLoop, {
        maxSteps: AGENT_LOOP_MAX_STEPS_V1,
        composition: await bootstrapCompositionPin(application),
      }),
    );
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
    stableAgentPackages?: readonly FoundationAgentPackage[];
  } = {},
): Promise<FoundationResidentRuntime> {
  const application =
    options.application ?? (await createFoundationRuntimeApplication());
  const stableFibers = await mountFoundationRuntimeServices(root, application, {
    stableAgentPackages: options.stableAgentPackages,
  });
  let generation: number | undefined;
  let dynamicFibers: Fiber[] = [];
  let agent: AgentHandle | undefined;
  let sessionId: string | undefined;
  let residentTurnType: TurnTypeV1 = "chat";
  let residentSubagentRole: string | undefined;
  let activeRunId: string | undefined;
  let activePersist: PersistSessionEvents | undefined;
  let activeEffectAdmission:
    FoundationResidentExecution["admitEffect"] | undefined;
  let activeExecution: symbol | undefined;
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
      if (activeExecution) {
        throw new Error("resident Bot runtime already has active work");
      }
      const executionOwner = Symbol(execution.runId);
      activeExecution = executionOwner;
      try {
        if (generation === undefined) {
          throw new Error("resident Bot runtime projection is not applied");
        }
        if (agent) {
          if (sessionId !== execution.sessionId) {
            throw new Error("resident Bot runtime session identity changed");
          }
          // The Agent's catalog is trimmed at construction, so a resident one
          // cannot serve a second turn type; a producer of another type mounts
          // its own root rather than silently reusing this catalog.
          if ((execution.turnType ?? "chat") !== residentTurnType) {
            throw new Error("resident Bot runtime turn type changed");
          }
          // The role trims the same catalog the turn type does, so a resident
          // Agent cannot serve a second role either.
          if (execution.subagentRole !== residentSubagentRole) {
            throw new Error("resident Bot runtime subagent role changed");
          }
          // The log is contiguous and kernel-validated, so its length and the
          // identity of its last event settle whether the resident copy is the
          // durable one. Deep-comparing every event cost a full
          // `JSON.stringify` of the whole history on every Turn.
          const current = agent.agent.session.events;
          const residentLast = current.at(-1);
          const durableLast = execution.previousEvents.at(-1);
          const diverged =
            current.length !== execution.previousEvents.length ||
            residentLast?.seq !== durableLast?.seq ||
            residentLast?.timestamp !== durableLast?.timestamp ||
            residentLast?.type !== durableLast?.type;
          if (diverged) {
            // Divergence is a stale resident copy, not a broken Bot: durable
            // state is the authority, so this one is dropped and rebuilt from
            // it. Throwing left the same resident Agent in place, so the next
            // Turn diverged identically and the Bot stayed broken until the
            // object was evicted.
            const stale = agent;
            agent = undefined;
            await stale.dispose();
          }
        }
        if (agent) {
          activePersist = execution.persistSessionEvents;
          activeEffectAdmission = execution.admitEffect;
        } else {
          sessionId = execution.sessionId;
          residentTurnType = execution.turnType ?? "chat";
          residentSubagentRole = execution.subagentRole;
          activePersist = execution.persistSessionEvents;
          activeEffectAdmission = execution.admitEffect;
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
              ...(execution.turnType ? { turnType: execution.turnType } : {}),
              ...(execution.subagentRole
                ? { subagentRole: execution.subagentRole }
                : {}),
              admitEffect: (effect) => {
                const admit = activeEffectAdmission;
                return admit ? admit(effect) : Promise.resolve(false);
              },
            });
          } finally {
            cancelPreparation();
          }
        }
        activeRunId = execution.runId;
        if (!(await execution.beforeStart())) {
          throw new Error("resident Bot execution was durably fenced");
        }
        if (execution.resume) agent.agent.resume();
        else {
          agent.agent.send({
            text: execution.text,
            ...(execution.skills ? { skills: execution.skills } : {}),
          });
        }
        await agent.agent.whenIdle();
        await agent.agent.session.flush();
        return agent;
      } finally {
        if (activeExecution === executionOwner) {
          activePersist = undefined;
          activeEffectAdmission = undefined;
          activeRunId = undefined;
          activeExecution = undefined;
        }
      }
    },
    cancel(cancellation) {
      if (
        disposed ||
        !agent ||
        sessionId !== cancellation.sessionId ||
        activeRunId !== cancellation.runId
      ) {
        return false;
      }
      agent.agent.cancel(cancellation.reason ?? "user");
      return true;
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
  modelConfig: RuntimeModelConfig | undefined,
  options: FoundationRuntimeOptions,
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
    await root.packages.enable(packageId);
  }
  const composition =
    options.composition ?? (await bootstrapCompositionPin(application));
  await root.plugin(AgentLoop, {
    maxSteps: AGENT_LOOP_MAX_STEPS_V1,
    composition,
  });

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
    admitEffect: options.admitEffect,
    ...(options.turnType ? { turnType: options.turnType } : {}),
    ...(options.subagentRole ? { subagentRole: options.subagentRole } : {}),
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
