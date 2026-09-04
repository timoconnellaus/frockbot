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
  compositionArtifactSetHashV1,
  compositionGenerationIdV1,
  decodeCompositionGenerationV1,
  type CompositionGenerationV1,
  type CompositionHost,
  type CompositionMemberV1,
  type CompositionStore,
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
      // A first-party member the application declared an artifact for loads
      // through the isolate host, not the application's Contribution table.
      ...(pkg.artifact ? { artifact: pkg.artifact } : {}),
    })),
    { createdAt },
  );
}

/** The audit line a deployment-following generation carries. */
export const DEPLOYMENT_FOLLOW_SUMMARY_V1 =
  "Updated the built-in Packages to this deployment's";

/**
 * Resolve the deployment's built-in Packages into this Bot's next generation.
 *
 * A first-party member's manifest and artifact live in the compiled
 * application, keyed by hash. A deploy that changes one of them (2026-09-05:
 * the Applets list page) leaves every pinned generation naming a manifest this
 * deployment no longer ships, and every Turn of every Bot fails to mount. A
 * built-in member is the deployment's to update, never the Bot's, so before a
 * Turn is admitted the Bot's first-party members are brought up to the
 * application's, as a new generation with the old one as its parent. Members
 * the Bot or its User put in are carried over exactly as they are; Applet
 * members stay pinned; a deployment that changes nothing proposes nothing.
 *
 * Only the manifest and the artifact decide. A version string that moved with
 * a release while both stayed the same mounts exactly as before, and a
 * generation per Bot per release would eat the User's retention quota for
 * nothing.
 */
export async function resolveDeploymentCompositionV1(options: {
  plan: ApplicationPlan;
  composition: Pick<CompositionStore, "current" | "propose">;
  now?: Date;
}): Promise<CompositionGenerationV1 | undefined> {
  const current = await options.composition.current();
  const createdAt = (options.now ?? new Date()).toISOString();
  const deployed = await bootstrapCompositionGeneration(
    options.plan,
    createdAt,
  );
  const shipped = new Map(
    deployed.members.map((member) => [member.packageId, member]),
  );
  const members: CompositionMemberV1[] = [];
  let changed = false;
  for (const member of current.members) {
    if (member.provenance.kind !== "first-party") {
      members.push(member);
      continue;
    }
    const replacement = shipped.get(member.packageId);
    shipped.delete(member.packageId);
    if (!replacement) {
      // The deployment no longer ships it; nothing could mount it anyway.
      changed = true;
      continue;
    }
    if (
      replacement.manifestHash !== member.manifestHash ||
      replacement.artifact?.contentHash !== member.artifact?.contentHash
    ) {
      changed = true;
      members.push(replacement);
    } else {
      members.push(member);
    }
  }
  for (const added of shipped.values()) {
    changed = true;
    members.push(added);
  }
  if (!changed) return undefined;
  const ordered = members.sort((left, right) =>
    left.packageId.localeCompare(right.packageId),
  );
  const applets = current.applets ?? [];
  const artifactSetHash = await compositionArtifactSetHashV1(ordered, applets);
  const generation = decodeCompositionGenerationV1({
    schemaVersion: 1,
    generationId: compositionGenerationIdV1(createdAt, artifactSetHash),
    artifactSetHash,
    parentGenerationId: current.generationId,
    summary: DEPLOYMENT_FOLLOW_SUMMARY_V1,
    createdAt,
    origin: { kind: "bootstrap" },
    members: ordered,
    ...(applets.length === 0 ? {} : { applets }),
    status: "pending",
  });
  await options.composition.propose(generation, { pin: true });
  return generation;
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
   * Content address of the User-enabled bindings this isolate is granted — the
   * enabled set *and* the Composition generation whose `CAPABILITIES` stub is
   * baked into its `env`. Required: it is what keeps a cached isolate from
   * answering under stale authority (ADR 0019).
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
 * serializable and never leaves that object, so this is a call, never a stub
 * (`docs/research/spike-applet-facets.md` §8). Absent when the Bot Durable
 * Object has no Applet binding: an Applet member's tools are then simply not
 * registered, exactly as an isolate member fails without a loader.
 */
export interface ShellAppletMountOptions {
  invokeTool(request: {
    appletId: string;
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
  /** Called after the loop has flushed `turn/end`; errors are non-fatal. */
  onTurnStopping?(input: {
    turn: number;
    events: readonly SessionEvent[];
  }): Promise<void>;
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
      const disposeTurnStopping = options.onTurnStopping
        ? runtime.root.on("agent/turn-stopping", async (agent, turn) => {
            try {
              await options.onTurnStopping!({
                turn,
                events: structuredClone(agent.session.events),
              });
            } catch {
              // Accounting is a durable projection. Its own outbox exposes a
              // gap; it can never turn a completed model response into a
              // failed conversation Turn.
            }
          })
        : undefined;

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

      // Applet members. Their tools are ordinary tools in this Bot's catalog
      // (ADR 0022 decision 4), pinned to this generation like every other
      // member, and routed to the Applet Durable Object. An Applet contributes
      // no module and no manifest, so there is nothing here to mount, load, or
      // health-check: the instance's own health check ran when its generation
      // was published, and its failure is recorded there.
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
            runtime.root.tools.register({
              name: tool.name,
              // Provenance travels into the catalog the model reads, so a Bot
              // can tell an Applet's tool from a Package's.
              description: `${tool.description} (Applet "${applet.appletId}", generation ${applet.generationId})`,
              inputSchema: tool.inputSchema,
              idempotent: false,
              execute: async (input) => {
                const outcome = await routing.invokeTool({
                  appletId: applet.appletId,
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
        disposeTurnStopping?.();
        for (const unregister of unregisterApplets.toReversed()) unregister();
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
