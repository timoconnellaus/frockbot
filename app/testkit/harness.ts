// A runtime for a feature under test: the real registries, no loop.
import { ComputerRegistry } from "@frockbot/computer/core";
import {
  type AgentRuntimeV1,
  LoopHookListV1,
  mountRuntimeFeaturesV1,
  type RuntimeFeatureV1,
  SessionStore,
  type SessionStoreConfig,
} from "@frockbot/core/contracts";
import type { CredentialLeaseRuntime } from "@frockbot/app/credentials/user";
import { LlmRegistry } from "@frockbot/core/models";
import { SystemPromptRegistry } from "@frockbot/core/prompt";
import { ToolRegistry } from "@frockbot/core/tools";

export interface AgentRuntimeHarness extends AgentRuntimeV1 {
  readonly systemPrompt: SystemPromptRegistry;
  readonly llm: LlmRegistry;
  readonly tools: ToolRegistry;
  readonly computers: ComputerRegistry;
  credentials?: CredentialLeaseRuntime;
  /** Mount one feature; what it registered is undone by `dispose`. */
  mount(feature: RuntimeFeatureV1<AgentRuntimeHarness>): Promise<void>;
  dispose(): Promise<void>;
}

export function createAgentRuntimeHarness(
  options: { sessions?: SessionStoreConfig } = {},
): AgentRuntimeHarness {
  const hooks = new LoopHookListV1();
  const systemPrompt = new SystemPromptRegistry(hooks);
  const cleanups: Array<() => Promise<void>> = [];
  const harness: AgentRuntimeHarness = {
    sessions: new SessionStore(options.sessions),
    systemPrompt,
    llm: new LlmRegistry(hooks),
    tools: new ToolRegistry(hooks, systemPrompt),
    computers: new ComputerRegistry(),
    hooks,
    async mount(feature) {
      cleanups.push(await mountRuntimeFeaturesV1(harness, [feature]));
    },
    async dispose() {
      for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    },
  };
  return harness;
}
