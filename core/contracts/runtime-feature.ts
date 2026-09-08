// How first-party code joins a runtime: a function the app calls with the
// registries it may register into, in an order the app writes down. What it
// registers is undone, in reverse, when the runtime is disposed.
import type { LoopHookListV1 } from "./loop-hooks.js";
import type {
  ModelInvocation,
  ModelProviderRegistration,
} from "./model-invocation.js";
import type {
  PromptAssemblyService,
  PromptSectionRegistration,
} from "./prompt-assembly.js";
import type { SessionStore } from "./session.js";
import type { ToolExecution, ToolRegistration } from "./tool-execution.js";

export type RuntimeCleanupV1 = () => void | Promise<void>;

export type RuntimeFeatureResultV1 =
  void | RuntimeCleanupV1 | readonly RuntimeCleanupV1[];

/**
 * One feature. `Runtime` is whatever slice of the runtime the feature needs —
 * a feature names only the registries it touches, and the app's runtime
 * object satisfies all of them.
 */
export type RuntimeFeatureV1<Runtime> = (
  runtime: Runtime,
) => RuntimeFeatureResultV1 | Promise<RuntimeFeatureResultV1>;

/**
 * Mount features in order. A feature that throws unwinds the ones before it,
 * in reverse, and the error is rethrown.
 */
export async function mountRuntimeFeaturesV1<Runtime>(
  runtime: Runtime,
  features: readonly RuntimeFeatureV1<Runtime>[],
): Promise<() => Promise<void>> {
  const cleanups: RuntimeCleanupV1[] = [];
  const dispose = async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  };
  try {
    for (const feature of features) {
      const result = await feature(runtime);
      if (typeof result === "function") cleanups.push(result);
      else if (Array.isArray(result)) cleanups.push(...result);
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return dispose;
}

/** The registries every Agent-side feature may register into. */
export interface AgentRuntimeV1 {
  readonly sessions: SessionStore;
  readonly systemPrompt: PromptAssemblyService & PromptSectionRegistration;
  readonly llm: ModelInvocation & ModelProviderRegistration;
  readonly tools: ToolExecution & ToolRegistration;
  readonly hooks: LoopHookListV1;
}
