// The Shell Package owns the Composition a Turn runs on. First-party members
// are the compiled Foundation runtime, mounted in the kernel isolate; members
// carrying an immutable artifact are Bot isolate members, mounted through the
// kernel's `BotIsolateContributionHost` as a loaded Dynamic Worker with
// `globalOutbound` disabled.
import {
  createFoundationRuntime,
  type FoundationAgentPackage,
  type FoundationRuntime,
  type RuntimeModelSelection,
} from "@frockbot/agent-runtime/runtime";
import { createFoundationRuntimeApplication } from "@frockbot/application-foundation/runtime";
import type { AgentEffectAdmission } from "@frockbot/kernel-agent-loop/agent";
import {
  CompositionMountFailureError,
  type CompositionFailurePhaseV1,
} from "@frockbot/kernel-composition/activation";
import type { ApplicationPlan } from "@frockbot/kernel-composition/compiler";
import {
  bootstrapGeneration,
  type CompositionGenerationV1,
  type CompositionHost,
  type CompositionMemberV1,
  type MountedComposition,
} from "@frockbot/kernel-composition/generation";
import {
  BotIsolateContributionHost,
  botIsolatePackageDescriptorV1,
  type BotIsolateArtifactStore,
  type BotIsolateLimits,
  type BotIsolateLoader,
} from "@frockbot/kernel-composition/isolate";
import type { ActiveContribution } from "@frockbot/kernel-composition";
import {
  type BotCapabilitiesStub,
  type PersistSessionEvents,
  type SessionEvent,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";

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

/** Everything the Bot Durable Object supplies for isolate members. */
export interface ShellIsolateMountOptions {
  userId: string;
  runId: string;
  turnId: string;
  loader: BotIsolateLoader;
  artifacts: BotIsolateArtifactStore;
  /** Reads the exact manifest whose hash the member records. */
  manifestFor(member: CompositionMemberV1): Promise<unknown>;
  /**
   * Mints the loopback `CAPABILITIES` service binding for one Package —
   * `ctx.exports.BotCapabilities({ props })` in the Durable Object.
   */
  capabilitiesFor(member: CompositionMemberV1): BotCapabilitiesStub;
  /**
   * Content address of the Bot authority baked into this isolate — Connection
   * ids and generations, model binding, and the Composition generation whose `CAPABILITIES`
   * stub is baked into its `env`. Required: it is what keeps a cached isolate
   * from answering under a stale authority.
   */
  bindingDigest: string;
  compatibilityDate: string;
  limits?: BotIsolateLimits;
  deadlineMs?: number;
}

export interface ShellCompositionMountOptions {
  botId: string;
  sessionId: string;
  sessionEvents: readonly SessionEvent[];
  persistSessionEvents?: PersistSessionEvents;
  agentPackages?: readonly FoundationAgentPackage[];
  modelSelection?: RuntimeModelSelection;
  systemPromptSection?: string;
  /**
   * Durably linearizes each provider or tool effect against Stop immediately
   * before it is used. The Bot Durable Object owns the transaction; the mounted
   * runtime only presents the exact effect identity.
   */
  admitEffect(effect: AgentEffectAdmission): Promise<boolean>;
  /**
   * The turn type the admitted Turn runs on; the mounted Agent trims its tool
   * catalog to it. Absent ⇒ `chat`.
   */
  turnType?: TurnTypeV1;
  /**
   * The subagent role the admitted Turn runs under; the mounted Agent trims
   * its catalog to it as well. Absent ⇒ no role narrowing.
   */
  subagentRole?: string;
  /** Absent when the host cannot load isolates; isolate members then fail verify. */
  isolate?: ShellIsolateMountOptions;
}

export interface ShellCompositionHost extends CompositionHost {
  mount(
    generation: CompositionGenerationV1,
    signal: AbortSignal,
  ): Promise<ShellMountedComposition>;
}

interface MemberVerificationFailure {
  phase: CompositionFailurePhaseV1;
  message: string;
}

function memberFailure(error: unknown): MemberVerificationFailure {
  if (error instanceof CompositionMountFailureError) {
    return { phase: error.phase, message: error.message };
  }
  return {
    phase: "mount",
    message: error instanceof Error ? error.message : String(error),
  };
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
        persistSessionEvents: options.persistSessionEvents,
        admitEffect: options.admitEffect,
        agentPackages: options.agentPackages,
        modelSelection: options.modelSelection,
        systemPromptSection: options.systemPromptSection,
        ...(options.turnType ? { turnType: options.turnType } : {}),
        ...(options.subagentRole ? { subagentRole: options.subagentRole } : {}),
      });

      const isolateMembers = generation.members.filter(
        (member) => member.artifact !== undefined,
      );
      const active: ActiveContribution[] = [];
      const failures: MemberVerificationFailure[] = [];
      for (const member of isolateMembers) {
        if (!options.isolate) {
          failures.push({
            phase: "mount",
            message: `package "${member.packageId}" needs a Bot isolate and this host has no loader`,
          });
          continue;
        }
        const isolate = options.isolate;
        try {
          signal.throwIfAborted();
          const host = new BotIsolateContributionHost({
            loader: isolate.loader,
            artifacts: isolate.artifacts,
            tools: runtime.root.tools,
            loop: runtime.root,
            userId: isolate.userId,
            botId: options.botId,
            sessionId: options.sessionId,
            runId: isolate.runId,
            turnId: isolate.turnId,
            generationId: generation.generationId,
            turnType: options.turnType ?? "chat",
            ...(options.subagentRole === undefined
              ? {}
              : { subagentRole: options.subagentRole }),
            recordHookFailure: async (failure) => {
              const session = runtime.root.sessions.get(options.sessionId);
              if (!session) {
                throw new Error(
                  `session "${options.sessionId}" is unavailable for hook failure recording`,
                );
              }
              session.append({ type: "package/hook-failed", ...failure });
              await session.flush();
            },
            capabilities: isolate.capabilitiesFor(member),
            compatibilityDate: isolate.compatibilityDate,
            bindingDigest: isolate.bindingDigest,
            ...(isolate.limits ? { limits: isolate.limits } : {}),
            ...(isolate.deadlineMs === undefined
              ? {}
              : { deadlineMs: isolate.deadlineMs }),
          });
          // Mount and health-check are one guarded phase (Worker Loader spike).
          const storedManifest = await isolate.manifestFor(member);
          const prepared = await host.prepare(
            await botIsolatePackageDescriptorV1(member, storedManifest),
          );
          if (!prepared) {
            failures.push({
              phase: "resolve",
              message: `package "${member.packageId}" declared no Bot isolate contribution`,
            });
            continue;
          }
          active.push(await prepared.commit());
        } catch (error) {
          failures.push(memberFailure(error));
        }
      }

      const dispose = async () => {
        for (const contribution of active.toReversed()) {
          await contribution.dispose();
        }
        await runtime.dispose();
      };

      return {
        generation,
        root: runtime.root,
        runtime,
        // First-party members run in the kernel isolate and have nothing to
        // health-check; an isolate member that failed to resolve, mount, or
        // answer `health()` surfaces here, carrying the load site it failed at
        // so `activateCompositionV1` records the phase rather than guessing it.
        verify: () => {
          if (failures.length === 0) return Promise.resolve();
          return Promise.reject(
            new CompositionMountFailureError(
              failures[0]!.phase,
              `Composition generation "${generation.generationId}" failed verification: ${failures
                .map((failure) => failure.message)
                .join("; ")}`,
              failures.map((failure) => `${failure.phase}: ${failure.message}`),
            ),
          );
        },
        dispose,
      };
    },
  };
}
