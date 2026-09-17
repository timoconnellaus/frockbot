import type { ModelBilling } from "../billing/model.js";
// The Shell Package owns the Composition a Turn runs on. First-party code is
// the foundation runtime, ordinary imports in this bundle and never a
// Composition member; every member is untrusted and mounts through the
// `PluginWorkerHost` into the User's one loaded Dynamic Worker with
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
  compositionAppletMemberReachesV1,
  CompositionMountFailureError,
  type CompositionFailurePhaseV1,
  type CompositionGenerationV1,
  type CompositionHost,
  type MountedComposition,
} from "@frockbot/core/durable";
import {
  PluginFatalFailureError,
  PluginWorkerHost,
  type ActivePluginWorker,
  type PluginMountFailureV1,
  type BotIsolateArtifactStore,
  type BotIsolateLimits,
  type BotIsolateLoader,
} from "@frockbot/frock-compose";
import {
  decodeSendToUserPayloadV1,
  type BotCapabilitiesStub,
  type PersistSessionEvents,
  type SessionEvent,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import { recordSendToUserV1 } from "./agent.js";
import {
  bindCardApprovalsV1,
  cardValuesDigestV1,
  type CardApprovalStoreV1,
} from "./cards.js";

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
  /**
   * The Plugins this generation named that the worker refused, each with the
   * phase it failed at. A Plugin fails alone: the generation stays active and
   * its siblings stay mounted, so these never reach `verify()`.
   */
  readonly pluginFailures: readonly PluginMountFailureV1[];
}

/** Everything the Bot Durable Object supplies for isolate members. */
export interface ShellIsolateMountOptions {
  userId: string;
  runId: string;
  turnId: string;
  loader: BotIsolateLoader;
  artifacts: BotIsolateArtifactStore;
  /**
   * The loopback `CAPABILITIES` service binding every Plugin in the worker
   * shares — `ctx.exports.BotCapabilities({ props })` in the Durable Object.
   */
  capabilities: BotCapabilitiesStub;
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
  /** The Plugins this Bot runs; absent means every installed one. */
  enabled?: readonly string[];
  /**
   * The egress loopback the worker's `globalOutbound` is bound to, minted by
   * the Bot Durable Object from the enabled Plugins' declared hosts. Absent
   * leaves the worker with no outbound at all.
   */
  egress?: unknown;
  /**
   * Where every Plugin failure goes (ADR 0026 step 9): a notice, the per-Bot
   * quarantine count, and the verdict. A `fatal` verdict — a locked Plugin's
   * failure — fails the generation's mount, or the hook it was raised in.
   */
  onPluginFailure?(failure: {
    pluginId: string;
    phase: "resolve" | "mount" | "health" | "hook";
    message: string;
  }): Promise<{ fatal: boolean }>;
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
  billing?: ModelBilling;
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
   * How many further effects the run's durable record can still admit. A
   * `batch` asks before it expands, so one that cannot fit is refused rather
   * than overflowing the record mid-dispatch.
   */
  remainingEffectAdmissions?(): Promise<number>;
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
  /**
   * Where the Approvals a Plugin's Card asks for are bound to what they
   * authorize. Absent leaves every card send minting a fresh decision and
   * binding none, which is fail-closed: a capability that requires a binding
   * refuses rather than sending under a decision nobody tied to it.
   */
  cardApprovals?: CardApprovalStoreV1;
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
        billing: options.billing,
        sessionId: options.sessionId,
        sessionEvents: options.sessionEvents,
        composition: {
          generationId: generation.generationId,
          artifactSetHash: generation.artifactSetHash,
        },
        persistSessionEvents: options.persistSessionEvents,
        admitEffect: options.admitEffect,
        ...(options.remainingEffectAdmissions
          ? { remainingEffectAdmissions: options.remainingEffectAdmissions }
          : {}),
        agentPackages: options.agentPackages,
        modelSelection: options.modelSelection,
        systemPromptSection: options.systemPromptSection,
        ...(options.turnType ? { turnType: options.turnType } : {}),
        ...(options.subagentRole ? { subagentRole: options.subagentRole } : {}),
      });
      const active: ActivePluginWorker[] = [];
      const failures: MemberVerificationFailure[] = [];
      const pluginFailures: PluginMountFailureV1[] = [];
      if (generation.members.length > 0) {
        if (!options.isolate) {
          failures.push({
            phase: "mount",
            message: `the generation's plugins need a Plugin worker and this host has no loader`,
          });
        } else {
          const isolate = options.isolate;
          try {
            signal.throwIfAborted();
            const host = new PluginWorkerHost({
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
              // A Plugin's card tool draws a Card the same way the Bot's own
              // `send_to_user` does: the messages are decoded at the seam
              // every payload is decoded at, the Approvals the surface asks
              // for are minted here rather than by the Plugin, and both land
              // on this Turn's log.
              sendCard: async (send) => {
                let payload;
                try {
                  payload = decodeSendToUserPayloadV1(
                    {
                      type: "card",
                      surfaceId: send.surfaceId,
                      messages: send.messages,
                    },
                    `plugin "${send.pluginId}" card`,
                  );
                } catch (error) {
                  return {
                    status: "refused" as const,
                    reason:
                      error instanceof Error ? error.message : String(error),
                  };
                }
                if (payload.type !== "card") {
                  return { status: "refused" as const, reason: "not a card" };
                }
                // What this card is showing, as one content address. It is
                // what the Approval is bound to, so a capability claiming the
                // decision later has to be about the same values the person
                // read rather than about whatever the model names.
                const digest = await cardValuesDigestV1(send.data);
                const approvals = options.cardApprovals;
                const live = await approvals?.live(
                  send.pluginId,
                  send.surfaceId,
                );
                // One draft, one live decision. A redraw of what is already
                // pending keeps that decision; a redraw of *different* values
                // would silently move what the pending decision covers, so it
                // is refused and the card stays exactly as it was.
                if (live && live.digest !== digest) {
                  return {
                    status: "refused" as const,
                    reason: `surface "${send.surfaceId}" has a decision still pending on the values it was drawn with; draw a new card rather than changing what that decision covers`,
                  };
                }
                const reused = live?.approvalIds ?? [];
                const bound = bindCardApprovalsV1(
                  payload.messages,
                  (index) =>
                    reused[index] ?? `card-approval-${crypto.randomUUID()}`,
                  `${send.pluginId}: ${send.cardId}`,
                );
                const tool = `${send.pluginId}_${send.cardId}`;
                const recorded = await recordSendToUserV1(
                  runtime.services.sessions,
                  { ...payload, messages: bound.messages },
                  {
                    sessionId: send.context.sessionId,
                    occurrenceId: send.context.effectId,
                    tool,
                  },
                );
                if (recorded.status !== "sent") {
                  return {
                    status: "refused" as const,
                    reason: recorded.reason,
                  };
                }
                for (const [index, approval] of bound.approvals.entries()) {
                  // A reused decision was already asked for on the Turn that
                  // drew this surface first; asking again would put a second
                  // request for one decision on the log.
                  if (reused.includes(approval.approvalId)) continue;
                  const asked = await recordSendToUserV1(
                    runtime.services.sessions,
                    // Decoded like any other payload before it reaches the
                    // log: the words came off a component a Plugin wrote.
                    decodeSendToUserPayloadV1(
                      { type: "approval", ...approval },
                      `plugin "${send.pluginId}" card approval`,
                    ),
                    {
                      sessionId: send.context.sessionId,
                      // Its own occurrence: one tool call records the Card and
                      // the decisions it asks for, and a retry must be the
                      // same send of each rather than the same send of one.
                      occurrenceId: `${send.context.effectId}:approval:${index}`,
                      tool,
                    },
                  );
                  if (asked.status !== "sent") {
                    return { status: "refused" as const, reason: asked.reason };
                  }
                }
                if (approvals && bound.approvals.length > 0) {
                  await approvals.record({
                    schemaVersion: 1,
                    pluginId: send.pluginId,
                    surfaceId: send.surfaceId,
                    digest,
                    approvalIds: bound.approvals.map(
                      (approval) => approval.approvalId,
                    ),
                    createdAt: new Date().toISOString(),
                  });
                }
                return {
                  status: "sent" as const,
                  approvals: bound.approvals.length,
                };
              },
              recordHookFailure: async (failure) => {
                const session = runtime.services.sessions.get(
                  options.sessionId,
                );
                if (!session) {
                  throw new Error(
                    `session "${options.sessionId}" is unavailable for hook failure recording`,
                  );
                }
                session.append({ type: "package/hook-failed", ...failure });
                await session.flush();
                const verdict = await isolate.onPluginFailure?.({
                  pluginId: failure.packageId,
                  phase: "hook",
                  message: failure.message,
                });
                if (verdict?.fatal) {
                  throw new PluginFatalFailureError(
                    `plugin "${failure.packageId}" is always on for this Bot and failed at ${failure.event}: ${failure.message}`,
                  );
                }
              },
              capabilities: isolate.capabilities,
              compatibilityDate: isolate.compatibilityDate,
              bindingDigest: isolate.bindingDigest,
              ...(isolate.limits ? { limits: isolate.limits } : {}),
              ...(isolate.deadlineMs === undefined
                ? {}
                : { deadlineMs: isolate.deadlineMs }),
              ...(isolate.enabled === undefined
                ? {}
                : { enabled: isolate.enabled }),
              ...(isolate.egress === undefined
                ? {}
                : { egress: isolate.egress }),
            });
            // Mount and health-check are one guarded phase (Worker Loader spike).
            const prepared = await host.mount(generation.members);
            pluginFailures.push(...prepared.failures);
            for (const failure of prepared.failures) {
              const verdict = await isolate.onPluginFailure?.({
                pluginId: failure.pluginId,
                // The host names `bundle` for a module that does not parse;
                // to the count it is a mount that did not happen.
                phase: failure.phase === "bundle" ? "mount" : failure.phase,
                message: failure.message,
              });
              if (verdict?.fatal) {
                throw new PluginFatalFailureError(
                  `plugin "${failure.pluginId}" is always on for this Bot and failed at ${failure.phase}: ${failure.message}`,
                );
              }
            }
            active.push(await prepared.commit());
          } catch (error) {
            failures.push(memberFailure(error));
          }
        }
      }

      // Applet members. Their tools are ordinary tools in this Bot's catalog,
      // pinned to this generation like every other member, and routed to the
      // Applet Durable Object. An Applet contributes no module and no manifest,
      // so there is nothing here to mount, load, or health-check: the
      // instance's own health check ran when its generation was published, and
      // its failure is recorded there. The generation is the User's, so it
      // names every available Applet; this Bot registers only the ones it owns
      // or is shared, as they stood when the generation was resolved (ADR
      // 0027).
      const unregisterApplets: (() => void)[] = [];
      for (const applet of (generation.applets ?? []).filter((member) =>
        compositionAppletMemberReachesV1(member, options.botId),
      )) {
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
        pluginFailures,
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
