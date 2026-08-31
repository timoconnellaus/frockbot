// The Shell Package owns the Composition a Turn runs on. Until Bot-authored
// Packages land, mounting a generation is the existing Foundation runtime
// construction and verification is a no-op.
import {
  createFoundationRuntime,
  type FoundationAgentPackage,
  type FoundationRuntime,
  type RuntimeModelSelection,
} from "@frockbot/agent-runtime/runtime";
import { createFoundationRuntimeApplication } from "@frockbot/application-foundation/runtime";
import type { ApplicationPlan } from "@frockbot/kernel-composition/compiler";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
  type CompositionHost,
  type MountedComposition,
} from "@frockbot/kernel-composition/generation";
import type { PersistSessionEvents, SessionEvent } from "@frockbot/agent-core";
import type { MemoryPluginConfig } from "@frockbot/plugin-memory";

/** The bootstrap generation for a compiled first-party application. */
export function bootstrapCompositionGeneration(
  plan: ApplicationPlan,
  createdAt: string,
): Promise<CompositionGenerationV1> {
  return bootstrapGeneration(
    plan.packages.map((pkg) => ({
      packageId: pkg.id,
      specifier: pkg.specifier,
      version: pkg.version,
      manifest: pkg.manifest,
    })),
    { createdAt },
  );
}

export interface ShellMountedComposition extends MountedComposition {
  readonly runtime: FoundationRuntime;
}

export interface ShellCompositionMountOptions {
  botId: string;
  sessionId: string;
  sessionEvents: readonly SessionEvent[];
  memory?: MemoryPluginConfig;
  persistSessionEvents?: PersistSessionEvents;
  agentPackages?: readonly FoundationAgentPackage[];
  modelSelection?: RuntimeModelSelection;
  systemPromptSection?: string;
}

export interface ShellCompositionHost extends CompositionHost {
  mount(
    generation: CompositionGenerationV1,
    signal: AbortSignal,
  ): Promise<ShellMountedComposition>;
}

/** Mounts one pinned generation as the Cordis root a single Turn runs on. */
export function createShellCompositionHost(
  options: ShellCompositionMountOptions,
): ShellCompositionHost {
  return {
    async mount(generation, signal) {
      signal.throwIfAborted();
      const runtime = await createFoundationRuntime(undefined, {
        agentId: options.botId,
        sessionId: options.sessionId,
        sessionEvents: options.sessionEvents,
        application: await createFoundationRuntimeApplication(),
        composition: {
          generationId: generation.generationId,
          artifactSetHash: generation.artifactSetHash,
        },
        memory: options.memory,
        persistSessionEvents: options.persistSessionEvents,
        agentPackages: options.agentPackages,
        modelSelection: options.modelSelection,
        systemPromptSection: options.systemPromptSection,
      });
      return {
        generation,
        root: runtime.root,
        runtime,
        // First-party members run in the kernel isolate; there is nothing to
        // health-check until isolate members exist.
        verify: () => Promise.resolve(),
        dispose: () => runtime.dispose(),
      };
    },
  };
}
