import {
  FOUNDATION_MODEL,
  FOUNDATION_PROVIDER,
} from "@frockbot/providers/foundation/runtime";
import {
  type CompositionPinV1,
  LoopHookListV1,
  mountRuntimeFeaturesV1,
  type PersistSessionEvents,
  type RuntimeFeatureV1,
  type SessionEvent,
  SessionStore,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import type {
  AgentHandle,
  AgentOptions,
} from "@frockbot/core/agent-loop/agent";
import { LlmRegistry } from "@frockbot/core/models";
import { SystemPromptRegistry } from "@frockbot/core/prompt";
import { ToolRegistry } from "@frockbot/core/tools";
import { AgentLoop, createAgentLoop } from "@frockbot/core/agent-loop";
import { ComputerRegistry } from "@frockbot/computer/core";
import type { CredentialLeaseRuntime } from "@frockbot/plugin-credentials/user";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
} from "@frockbot/core/durable";
import {
  createOpenAICompatibleFeature,
  type FetchLike,
} from "@frockbot/providers/openai-compatible";

/**
 * Steps (model calls) one Turn may take before the loop gives up. Tool-heavy
 * Turns routinely need dozens; the earlier cap of 8 cut real work short.
 */
// Long tool-driven Turns remain bounded, while a sixty-step workflow can
// complete instead of being interrupted at the former fifty-step ceiling.
const AGENT_LOOP_MAX_STEPS_V1 = 64;

export { FOUNDATION_MODEL, FOUNDATION_PROVIDER };

export interface RuntimeModelConfig {
  baseUrl: string;
  model: string;
  apiKey?: string;
  providerId?: string;
  fetch?: FetchLike;
}

/** Everything a feature may register into, built once per Turn. */
export interface FoundationRuntimeServices {
  readonly sessions: SessionStore;
  readonly systemPrompt: SystemPromptRegistry;
  readonly llm: LlmRegistry;
  readonly tools: ToolRegistry;
  readonly computers: ComputerRegistry;
  readonly hooks: LoopHookListV1;
  /** Set by the credentials feature; read by every feature mounted after it. */
  credentials?: CredentialLeaseRuntime;
}

export type FoundationFeature = RuntimeFeatureV1<FoundationRuntimeServices>;

export interface FoundationRuntime {
  services: FoundationRuntimeServices;
  loop: AgentLoop;
  agent: AgentHandle;
  provider: string;
  model: string;
  dispose(): Promise<void>;
}

/** One feature the host hands a Turn, named so a plan can be read back. */
export interface FoundationAgentPackage {
  id: string;
  feature: FoundationFeature;
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
  /** Mounted before the application's own features, in this order. */
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

/** The generation a runtime with no durable Composition starts on: empty. */
async function bootstrapCompositionPin(): Promise<CompositionPinV1> {
  const generation = await bootstrapGeneration({
    createdAt: new Date(0).toISOString(),
  });
  return {
    generationId: generation.generationId,
    artifactSetHash: generation.artifactSetHash,
  };
}

export async function createFoundationRuntime(
  modelConfig: RuntimeModelConfig | undefined,
  options: FoundationRuntimeOptions,
): Promise<FoundationRuntime> {
  const sessionId = options.sessionId?.trim() || "barebones";
  const hooks = new LoopHookListV1();
  const sessions = new SessionStore({
    initialSessions: options.sessionEvents
      ? { [sessionId]: options.sessionEvents }
      : undefined,
    persistEvents: options.persistSessionEvents,
  });
  const systemPrompt = new SystemPromptRegistry(hooks);
  const llm = new LlmRegistry(hooks);
  const tools = new ToolRegistry(hooks, systemPrompt);
  const services: FoundationRuntimeServices = {
    sessions,
    systemPrompt,
    llm,
    tools,
    computers: new ComputerRegistry(),
    hooks,
  };

  let provider = FOUNDATION_PROVIDER;
  let model = FOUNDATION_MODEL;
  const features: FoundationFeature[] = [];
  const promptSection = options.systemPromptSection?.trim();
  if (promptSection) {
    features.push(({ systemPrompt: prompt }) =>
      prompt.register({ id: "bot-settings", render: () => promptSection }),
    );
  }
  if (modelConfig) {
    provider = modelConfig.providerId ?? "openai-compatible";
    model = modelConfig.model;
    features.push(
      createOpenAICompatibleFeature({
        baseUrl: modelConfig.baseUrl,
        apiKey: modelConfig.apiKey,
        providerId: provider,
        fetch: modelConfig.fetch,
      }),
    );
  }
  // Providers before the consumers that open their capabilities: the host
  // hands them over in mount order, and this runtime composes no list of its
  // own.
  for (const pkg of options.agentPackages ?? []) features.push(pkg.feature);
  const disposeFeatures = await mountRuntimeFeaturesV1(services, features);

  let loop: AgentLoop;
  try {
    loop = createAgentLoop(services, {
      maxSteps: AGENT_LOOP_MAX_STEPS_V1,
      composition: options.composition ?? (await bootstrapCompositionPin()),
    });
  } catch (error) {
    await disposeFeatures();
    throw error;
  }

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
  let agent: AgentHandle;
  try {
    agent = await loop.create(agentOptions);
  } catch (error) {
    await disposeFeatures();
    throw error;
  }
  return {
    services,
    loop,
    agent,
    provider,
    model,
    async dispose() {
      await loop.dispose();
      await disposeFeatures();
    },
  };
}
