// The Shell Package owns the Composition a Turn runs on. First-party code is
// the foundation runtime, ordinary imports in this bundle and never a
// Composition member; every member is untrusted and mounts through
// `BotIsolateContributionHost` as a loaded Dynamic Worker with
// `globalOutbound` disabled.
import {
  createFoundationRuntime,
  type FoundationAgentPackage,
  type FoundationRuntime,
  type RuntimeModelSelection,
} from "@frockbot/app/agent-runtime";
import type { AgentEffectAdmission } from "@frockbot/core/agent-loop/agent";
import {
  bootstrapGeneration,
  CompositionMountFailureError,
  type CompositionFailurePhaseV1,
  type CompositionGenerationV1,
  type CompositionHost,
  type CompositionMemberV1,
  type MountedComposition,
} from "@frockbot/core/durable";
import {
  BotIsolateContributionHost,
  type ActiveContribution,
  type BotIsolateArtifactStore,
  type BotIsolateLimits,
  type BotIsolateLoader,
} from "@frockbot/frock-compose";
import {
  type BotCapabilitiesStub,
  type PersistSessionEvents,
  type SessionEvent,
  type TurnTypeV1,
} from "@frockbot/core/contracts";

/**
 * The generation a Bot starts on: empty.
 *
 * Nothing first-party is a member any more, so a Bot that has installed and
 * authored nothing composes nothing. This is also why a release no longer
 * proposes a generation per Bot to follow the deployment: there is nothing in
 * a generation for a deploy to change.
 */
export function bootstrapCompositionGeneration(
  createdAt: string,
): Promise<CompositionGenerationV1> {
  return bootstrapGeneration({ createdAt });
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
  /**
   * Mints the loopback `CAPABILITIES` service binding for one Package —
   * `ctx.exports.BotCapabilities({ props })` in the Durable Object.
   */
  capabilitiesFor(member: CompositionMemberV1): BotCapabilitiesStub;
  /**
   * Content address of the User-enabled bindings this isolate is granted — the
   * enabled set *and* the Composition generation whose `CAPABILITIES` stub is
   * baked into its `env`. Required: it is what keeps a cached isolate from
   * answering under stale authority.
   */
  bindingDigest: string;
  compatibilityDate: string;
  limits?: BotIsolateLimits;
  deadlineMs?: number;
}

/**
 * How an Applet member's tools reach their instance.
 *
 * The Applet Durable Object forwards to the facet; a facet stub is not
 * serializable and never leaves that object, so this is a call, never a stub.
 * Absent when the Bot Durable Object has no Applet binding: an Applet member's
 * tools are then simply not registered, exactly as an isolate member fails
 * without a loader.
 *
 * `generationId` is the Applet generation this Turn's Composition pinned, and
 * it is not decoration: the Applet Durable Object runs that generation or
 * refuses the call. Without it a publish landing mid-Turn would
 * execute new code behind the schema and provenance the model was shown.
 */
export interface ShellAppletMountOptions {
  invokeTool(request: {
    appletId: string;
    generationId: string;
    tool: string;
    input: unknown;
  }): Promise<{ status: "ok" | "error"; content: string }>;
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
  /** Absent when the host cannot reach Applet instances. */
  applets?: ShellAppletMountOptions;
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

/** Mounts one pinned generation as the runtime a single Turn runs on. */
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
      const active: ActiveContribution[] = [];
      const failures: MemberVerificationFailure[] = [];
      for (const member of generation.members) {
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
            tools: runtime.services.tools,
            hooks: runtime.services.hooks,
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
              const session = runtime.services.sessions.get(options.sessionId);
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
          active.push(await (await host.prepare(member)).commit());
        } catch (error) {
          failures.push(memberFailure(error));
        }
      }

      // Applet members. Their tools are ordinary tools in this Bot's catalog,
      // pinned to this generation like every other member, and routed to the
      // Applet Durable Object. An Applet contributes no module and no manifest,
      // so there is nothing here to mount, load, or health-check: the
      // instance's own health check ran when its generation was published, and
      // its failure is recorded there.
      const unregisterApplets: (() => void)[] = [];
      for (const applet of generation.applets ?? []) {
        if (!options.applets) {
          failures.push({
            phase: "resolve",
            message: `Applet "${applet.appletId}" needs an Applet binding and this host has none`,
          });
          continue;
        }
        const routing = options.applets;
        for (const tool of applet.tools) {
          unregisterApplets.push(
            runtime.services.tools.register({
              name: tool.name,
              // Provenance travels into the catalog the model reads, so a Bot
              // can tell an Applet's tool from a Package's.
              description: `${tool.description} (Applet "${applet.appletId}", generation ${applet.generationId})`,
              inputSchema: tool.inputSchema,
              idempotent: false,
              execute: async (input) => {
                const outcome = await routing.invokeTool({
                  appletId: applet.appletId,
                  // The pin the description above advertises, carried into the
                  // call so the instance executes it or refuses.
                  generationId: applet.generationId,
                  tool: tool.name,
                  input: input ?? null,
                });
                return {
                  content: outcome.content,
                  isError: outcome.status === "error",
                };
              },
            }),
          );
        }
      }

      const dispose = async () => {
        for (const unregister of unregisterApplets.toReversed()) unregister();
        for (const contribution of active.toReversed()) {
          await contribution.dispose();
        }
        await runtime.dispose();
      };

      return {
        generation,
        runtime,
        // A member that failed to resolve, mount, or answer `health()`
        // surfaces here, carrying the load site it failed at so
        // `activateCompositionV1` records the phase rather than guessing it.
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
