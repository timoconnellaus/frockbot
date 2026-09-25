// The Plugin worker host: mounts every Plugin a Composition generation names
// as one Dynamic Worker and registers the tools and hooks its health report
// declares.
//
// First-party code is ordinary imports in the kernel isolate; everything else
// runs in one loaded Worker per User with only the loopback bindings the Bot's
// authority grants — `globalOutbound` among them, bound to the egress loopback
// when the enabled Plugins declared network and null when they did not — and
// this is what loads it.
//
// Two loader behaviours are load-bearing here: `.get()` never throws, so mount
// and `health()` are a single guarded phase; and a reused loader id silently
// serves the first code, so the id is nothing but the content address of the
// module set actually mounted.
import {
  decodeBotIsolateHookReplacementV1,
  decodeIsolateToolResultV1,
  decodePluginWorkerHealthV1,
  decodePluginWorkerHookResultV1,
  decodePluginWorkerTriggerResultV1,
  decodePluginWorkerCardActionResultV1,
  decodePluginWorkerRenderCardResultV1,
  decodePluginWorkerViewResultV1,
  isolateToolSchemaV1,
  ISOLATE_CONTRACT_VERSION,
  ISOLATE_MAX_DEADLINE_MS,
  MAX_FAILURE_REASON_V1,
  MAX_TRIGGER_BODY_BYTES_V1,
  pluginWorkerUtf8LengthV1,
  pluginWorkerLoaderIdV1,
  pluginWorkerModuleSetHashV1,
  type BotCapabilitiesStub,
  type BotIsolateEnv,
  type FirstPartySecretRequestV1,
  type BotIsolateHookEventNameV1,
  type IsolateIdentityV1,
  type IsolateToolDescriptorV1,
  type LoopAgentRuntimeV1,
  type LoopEventPayloadMapV1,
  type LoopHookListV1,
  type LoopEventReturnMapV1,
  type LoopStepSnapshotV1,
  loopToolExecutionContextSnapshotV1,
  type PluginWorkerEntrypoint,
  type PluginWorkerHealthV1,
  type PluginWorkerHookInvocationV1,
  type PluginWorkerPluginHealthV1,
  type IsolateToolResultV1,
  type PluginWorkerToolInvocationV1,
  type PluginWorkerTriggerInvocationV1,
  type PluginWorkerTriggerResultV1,
  type PluginWorkerCardActionInvocationV1,
  type PluginWorkerCardActionResultV1,
  type PluginWorkerRenderCardInvocationV1,
  type PluginWorkerViewInvocationV1,
  type PluginWorkerViewResultV1,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRegistration,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import { boundedPromiseCacheV1 } from "@frockbot/core/promise-cache";
import { sha256HexV1 } from "@frockbot/core/crypto";
import {
  cardSurfacePrefixV1,
  decodePluginWorkerModelResultV1,
  pluginCardToolNameV1,
  pluginModelProviderV1,
  validateAgainstJsonSchemaV1,
  PLUGIN_MODEL_PROTOCOL_VERSIONS_V1,
  type PluginCardDecisionV1,
  type PluginCardV1,
  type PluginDescriptorV1,
  type PluginGrantV1,
  type PluginModelInvocationV1,
  type PluginSlotV1,
  type PluginWorkerModelResultV1,
} from "@frockbot/core/contracts";
import { createConcurrencyLimiterV1 } from "@frockbot/core/concurrency";
import {
  CompositionMountFailureError,
  type CompositionFailurePhaseV1,
} from "@frockbot/core/durable/composition-failure";
import {
  PLUGIN_WORKER_INDEX_VERSION,
  PLUGIN_WORKER_MAIN_MODULE,
  pluginWorkerModuleMap,
} from "./plugin-worker-wrapper.ts";

/**
 * What the host needs of a Composition member. Structural, so this package
 * never imports the Durable Object that stores one.
 */
export interface BotIsolateMemberV1 {
  packageId: string;
  version: string;
  artifact: { contentHash: string };
  descriptor: PluginDescriptorV1;
}

/**
 * The grants a host in this deployment can actually honour. `files` and
 * `computer` are named in the vocabulary and wait on their hosts; a Plugin
 * declaring one is refused at resolve rather than mounted inert.
 */
/** The `Identifier` a surface id is, as the Card seam bounds one. */
const CARD_SURFACE_ID_V1 = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

/**
 * The surface id one card draw is minted under. It names the Plugin and the
 * card so a person reading durable state can tell what drew it, and the
 * effect that drew it is what makes it new.
 *
 * Derived from the Session and the effect rather than random for the same
 * reason the card's Approval ids are: a Turn interrupted before its tool
 * result landed re-runs the same call under the same effect, and a freshly
 * minted surface would name a card nobody is looking at while the one in the
 * conversation — which the send deduped under that effect — kept a
 * live-looking button forever. The Session is hashed in because an effect id
 * is only unique inside one Session and every Routine of a Bot has its own,
 * while card records are Bot-wide: two Sessions drawing at the same turn and
 * step would otherwise land on one surface. A hash is what keeps the pair
 * inside the 128 characters the Card seam bounds a surface id to.
 */
async function mintedCardSurfaceIdV1(
  pluginId: string,
  cardId: string,
  sessionId: string,
  effectId: string,
): Promise<string> {
  const unique = (await sha256HexV1(`${sessionId}\n${effectId}`)).slice(0, 24);
  return `${cardSurfacePrefixV1(pluginId, cardId)}${unique}`;
}

const OPEN_PLUGIN_GRANTS_V1: readonly PluginGrantV1[] = [
  "http",
  "schedule",
  "ai",
  "memory",
  "workspace",
  "storage",
  // Opened by the client for a page, never by the worker (ADR 0035).
  "device",
];

/**
 * The slots this deployment draws. `settings.sections` is the Plugin card;
 * `conversation.panel` and `bot.nav` are the page beside the chat and its
 * door (ADR 0034). The rest wait on the surfaces that use them.
 */
const OPEN_PLUGIN_SLOTS_V1: readonly PluginSlotV1[] = [
  "settings.sections",
  "conversation.panel",
  "bot.nav",
];

const PLUGIN_WORKER_HEALTH_CACHE_LIMIT_V1 = 64;
const pluginWorkerHealthCacheV1 = new WeakMap<
  BotIsolateLoader,
  Map<string, Promise<PluginWorkerHealthV1>>
>();

function pluginWorkerHealthV1(
  loader: BotIsolateLoader,
  loaderId: string,
  load: () => Promise<PluginWorkerHealthV1>,
): Promise<PluginWorkerHealthV1> {
  let cache = pluginWorkerHealthCacheV1.get(loader);
  if (!cache) {
    cache = new Map();
    pluginWorkerHealthCacheV1.set(loader, cache);
  }
  // The loader id addresses immutable modules, identities and bindings, so a
  // successful declaration is stable across Turns. Failures remain retryable:
  // an overloaded worker must not poison that generation for its lifetime.
  return boundedPromiseCacheV1(
    cache,
    loaderId,
    PLUGIN_WORKER_HEALTH_CACHE_LIMIT_V1,
    load,
  );
}

/** The `WorkerCode` a Plugin worker is loaded from. Structurally the platform's. */
export interface BotIsolateWorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, { js: string }>;
  globalOutbound: null | unknown;
  env: BotIsolateEnv;
  limits: { cpuMs: number; subRequests: number };
}

export interface BotIsolateLoadedWorker {
  getEntrypoint(name?: string | null): PluginWorkerEntrypoint;
}

/** The `worker_loaders` binding, declared structurally so the kernel stays platform-free. */
export interface BotIsolateLoader {
  get(
    id: string,
    callback: () => Promise<BotIsolateWorkerCode>,
  ): BotIsolateLoadedWorker;
}

/** Reads an immutable, content-addressed Plugin artifact and verifies its hash. */
export interface BotIsolateArtifactStore {
  loadPackageArtifact(contentHash: string): Promise<string>;
}

export interface BotIsolateLimits {
  cpuMs: number;
  subRequests: number;
}

export interface IsolateHookFailureV1 {
  packageId: string;
  event: BotIsolateHookEventNameV1;
  generationId: string;
  message: string;
}

/**
 * A Plugin failure the host must not swallow: a Plugin that cannot be skipped
 * failed, so the Turn fails with it. Raised by `recordHookFailure` and carried
 * out past the catches that keep an ordinary Plugin's failure from wedging the
 * loop.
 */
export class PluginFatalFailureError extends Error {
  readonly name = "PluginFatalFailureError";
}

/**
 * The rejection `raceDeadline` gives when the caller's own signal ended the
 * race, not the Plugin's deadline. A cancelled or expired Turn is not the
 * Plugin failing, so a charge site can tell the two apart at the rejection
 * rather than guessing from a signal that may have aborted afterwards.
 */
export class RaceAbortedError extends Error {
  readonly name = "RaceAbortedError";
}

/** One Plugin the worker could not mount, with the phase it failed at. */
export interface PluginMountFailureV1 {
  pluginId: string;
  phase: CompositionFailurePhaseV1;
  message: string;
}

/**
 * One model provider this deployment serves through a Plugin, and the bytes
 * that serve it (ADR 0032): the Plugin the deployment's provider catalog names
 * for the provider, at its own artifact. It is the deployment's answer and
 * never a member's claim, which is what keeps "this Plugin serves this
 * provider" a fact about content and not about a descriptor.
 */
export interface PluginServedProviderClaimV1 {
  provider: string;
  /** The Plugin the catalog names for the provider. */
  pluginId: string;
  /** The content hash of that Plugin's own artifact. */
  contentHash: string;
}

export interface PluginWorkerHostOptions {
  loader: BotIsolateLoader;
  artifacts: BotIsolateArtifactStore;
  /** Where the worker's tools are registered — the kernel's tool surface. */
  tools: ToolRegistration;
  /** Where the worker's hooks are added — the runtime's loop hook list. */
  hooks: LoopHookListV1;
  userId: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  turnType: TurnTypeV1;
  subagentRole?: string;
  /** Durably records a hook the worker skipped, before the loop continues. */
  recordHookFailure(failure: IsolateHookFailureV1): Promise<void>;
  /**
   * Charges one card draw that failed to the Plugin's health, the way a press
   * that failed is charged (ADR 0030): a throw, a deadline overrun, an
   * unreachable worker and an answer the kernel could not read all count
   * toward quarantine, while a draw that refused in as many words does not.
   * The model still reads the tool error; this is the count beside it.
   */
  recordCardFailure?(failure: PluginCardFailureV1): Promise<void>;
  /**
   * Puts one Card on the Turn's log, exactly as `send_to_user` would. The
   * host has the Plugin worker and the app has the Session, so the send is
   * the app's to record; a host without one registers no card tools, which
   * is what a standalone mount is.
   */
  sendCard?(send: PluginCardSendV1): Promise<PluginCardSendOutcomeV1>;
  /**
   * The loopback `CAPABILITIES` binding, minted by the Bot's Durable Object
   * for this User. Per User, never per Turn: every call carries its scope.
   */
  capabilities: BotCapabilitiesStub;
  /**
   * The worker's `globalOutbound`: a loopback service the Durable Object
   * minted with the hosts the User's enabled Plugins declared, or nothing,
   * which leaves `fetch` refused. Whatever it is, it is baked into `env` and
   * therefore into the binding digest.
   */
  egress?: unknown;
  compatibilityDate: string;
  /**
   * Content address of the bindings baked into `env` — the User and the
   * egress policy. Folded into the loader id so a cached worker never answers
   * under a stale `env`.
   */
  bindingDigest: string;
  limits?: BotIsolateLimits;
  deadlineMs?: number;
  healthDeadlineMs?: number;
  /**
   * The Plugins this Bot runs, out of the ones its User installed. Absent
   * means every mounted Plugin. A Plugin the User installed but this Bot has
   * off is still in the module set — the worker is per User — but registers
   * no tools here and is left out of every hook's enabled list.
   */
  enabled?: readonly string[];
  /**
   * Every model provider this deployment serves through a Plugin, and the
   * Plugin and artifact that may serve each (ADR 0032). It is a property of
   * the deployment, not of a Bot's selection, so every mount supplies it: an
   * account that installed a provider's Plugin still carries it in its
   * Composition while its Bot's model is something else, and only this makes
   * such a member mountable.
   *
   * A member declaring one of these providers is served by it only as that
   * Plugin at that artifact: a claimant whose id or artifact differs — a
   * Plugin a Bot wrote, above all — is refused here, and so is a second
   * claimant, whatever order the generation lists them in. A member declaring
   * a provider this lists none of is refused with the reason. Absent means
   * this deployment opens none to Plugins.
   */
  openModelProviders?: readonly PluginServedProviderClaimV1[];
  /**
   * The one provider this Bot's model selection runs, when it names one the
   * entries above serve. Selection is what runs a provider contribution, not
   * the Bot's plugin switch: a Bot whose model is this provider is served by
   * it whatever the switch says, and the switch's own tools and hooks stay
   * off until it is on. Absent leaves every model contribution unserved.
   */
  selectedModelProvider?: string;
}

/** One model provider contribution this worker mounted and this Bot selected. */
export interface MountedModelProviderV1 {
  pluginId: string;
  providerId: string;
  protocolVersion: number;
}

/** One card draw a Plugin could not answer, charged to its health. */
export interface PluginCardFailureV1 {
  pluginId: string;
  cardId: string;
  message: string;
}

/** One Card a Plugin's card tool asks the app to record on the Turn's log. */
export interface PluginCardSendV1 {
  pluginId: string;
  cardId: string;
  surfaceId: string;
  /**
   * The canonical values this draw says a decision on it would authorize, as
   * the Plugin declared them. The seam binds the Card's Approvals to these,
   * so a decision a person gives covers what the Plugin drew and will act on
   * rather than whatever the model passed to the tool. Absent when the draw
   * declared none, which is only allowed of a card that asks for nothing.
   */
  covers?: Record<string, unknown>;
  /**
   * What the decision this draw asks for is recorded as, as the Plugin stated
   * it. Absent when the draw asks for none; a draw that puts an
   * `ApprovalActions` on the card and states none is refused at the seam.
   */
  decision?: PluginCardDecisionV1;
  /** The A2UI messages the Plugin drew, still undecoded. */
  messages: Record<string, unknown>[];
  /**
   * The Approvals the kernel has *already* recorded for this draw, in the
   * order the surface's `ApprovalActions` are to be bound to them (ADR 0030
   * step 7).
   *
   * It is present only on a draw the kernel itself asked for: the locked
   * first-party cards, where the decision is the one the old `approval`
   * payload put on the log under the id the Bot chose. Binding to it rather
   * than minting keeps an existing Bot's own `approvalId` — the id its
   * Machine command, its Plugin intent and its next Turn's durable input are
   * all keyed by — the id the card decides. Absent everywhere else, where the
   * seam mints, which is what stops a Plugin naming a decision.
   */
  approvalIds?: readonly string[];
  /**
   * The secret request the kernel asked this draw to carry the field for.
   * Present only on the locked first-party draw of a `secret-request`; the
   * seam refuses a `SecretField` on any draw without it.
   */
  secretRequest?: FirstPartySecretRequestV1;
  context: ToolExecutionContext;
}

/**
 * Whether the send landed. A refusal is the tool result the Bot reads, and
 * `approvals` is how many decisions the Card asked the kernel to record: a
 * Card that asks for one ends the Turn, exactly as an approval send does.
 */
export type PluginCardSendOutcomeV1 =
  { status: "sent"; approvals: number } | { status: "refused"; reason: string };

/** What one caller asks a card to be drawn with. */
export interface PluginCardDrawRequestV1 {
  data: Record<string, unknown>;
  /** A surface this card already drew, to update it in place. */
  surfaceId?: string;
  /** See `PluginCardSendV1.approvalIds`: the kernel's own, never a Plugin's. */
  approvalIds?: readonly string[];
  /** See `PluginCardSendV1.secretRequest`: the kernel's own, never a Plugin's. */
  secretRequest?: FirstPartySecretRequestV1;
}

/**
 * How one draw ended, in the four kinds the caller has to tell apart: it
 * landed; the Plugin refused it in as many words; the Plugin broke; or the
 * seam would not record it. The card's tool turns each into a sentence for
 * the model, and the Shell's first-party seam turns each into the fallback
 * line the person reads.
 */
export type PluginCardDrawOutcomeV1 =
  | { status: "drawn"; surfaceId: string; approvals: number }
  | { status: "dropped"; reason: string }
  | { status: "failed"; reason: string }
  | { status: "refused"; reason: string };

export const BOT_ISOLATE_DEFAULT_LIMITS: BotIsolateLimits = {
  cpuMs: 5_000,
  subRequests: 5,
};

export const BOT_ISOLATE_DEFAULT_DEADLINE_MS = 15_000;

/**
 * What the Durable Object's race allows on top of the chain's own budget, so
 * a chain that spends every millisecond it was given still gets its answer —
 * including the Plugins it named as skipped — back before the race fires.
 */
export const PLUGIN_WORKER_HOOK_RACE_MARGIN_MS = 250;

export const BOT_ISOLATE_DEFAULT_HEALTH_DEADLINE_MS = 10_000;

/** A mounted worker: what it registers on commit, and what it could not mount. */
export interface PreparedPluginWorker {
  /** Plugins the worker mounted and verified, in mount order. */
  readonly mounted: readonly string[];
  readonly failures: readonly PluginMountFailureV1[];
  commit(): Promise<ActivePluginWorker>;
}

export interface ActivePluginWorker {
  /**
   * The model provider contributions this Bot's selection runs, each served
   * by a Plugin this worker verified and mounted (ADR 0032). Empty when the
   * selection names no provider a mounted Plugin serves.
   */
  readonly modelProviders: readonly MountedModelProviderV1[];
  /**
   * One model call, served by the Plugin that declared the provider. The
   * answer carries its events as an NDJSON byte stream, bounded by the
   * invocation's silence allowance. A Plugin this worker did not verify, or
   * that does not serve the provider, is refused before the worker is
   * reached.
   */
  streamModel(
    invocation: PluginModelInvocationV1,
  ): Promise<PluginWorkerModelResultV1>;
  /**
   * Delivers an app-owned trigger to one Plugin. Only a Plugin this worker
   * verified and enabled runs: the index knows nothing of the host's verified
   * set, so the gate lives here, and a trigger naming any other Plugin is
   * dropped with the reason rather than thrown.
   */
  deliverTrigger(
    invocation: PluginWorkerTriggerInvocationV1,
  ): Promise<PluginWorkerTriggerResultV1>;
  /**
   * Renders one of a Plugin's declared views (ADR 0026 step 9's
   * `settings.sections` slot). Gated like a trigger: only a verified and
   * enabled Plugin renders, and any other answer is a drop with its reason.
   */
  renderView(
    invocation: PluginWorkerViewInvocationV1,
  ): Promise<PluginWorkerViewResultV1>;
  /**
   * Runs one Card action a renderer named `plugin/<pluginId>/<action>` (ADR
   * 0030). Gated like a view, and answered with the A2UI messages the kernel
   * folds into the Card; a handler that throws or overruns is a drop and the
   * Card is left as it was.
   */
  cardAction(
    invocation: PluginWorkerCardActionInvocationV1,
  ): Promise<PluginWorkerCardActionResultV1>;
  /**
   * Draws one of a Plugin's declared cards outside the Bot's tool registry.
   *
   * The Shell's send seam is the caller: the five first-party payload members
   * are locked Plugins now, and an old `send_to_user` member is mapped onto
   * one of them here (ADR 0030 step 7). It is the very same draw the card's
   * tool makes — the same schema check, the same minted surface, the same
   * `renderCard`, the same send — so first-party is not a shorter path.
   */
  drawCard(
    pluginId: string,
    cardId: string,
    request: PluginCardDrawRequestV1,
    context: ToolExecutionContext,
  ): Promise<PluginCardDrawOutcomeV1>;
  /**
   * Runs one declared tool outside any Turn: a control on a Plugin's settings
   * section is the User's own click, so the call is made here rather than
   * through the Bot's tool registry. Gated like a view; a tool the Plugin's
   * health report did not list is refused before the worker is reached.
   */
  executeTool(
    invocation: PluginWorkerToolInvocationV1,
  ): Promise<IsolateToolResultV1>;
  /**
   * Assembles this Bot's look outside any Turn. `theme/assemble` is not a
   * loop event: `_select` never waits on it, and the Agent loop never fires
   * it. A Plugin that throws or answers with a document the kernel refuses
   * is skipped and the last good document is kept.
   */
  assembleTheme(
    payload: LoopEventPayloadMapV1["theme/assemble"],
    original: LoopEventReturnMapV1["theme/assemble"],
  ): Promise<LoopEventReturnMapV1["theme/assemble"]>;
  dispose(): Promise<void>;
}

interface ResolvedPlugin {
  member: BotIsolateMemberV1;
  source: string;
}

function pluginIdentityV1(member: BotIsolateMemberV1): {
  grants: string[];
  consumes: string[];
} {
  return {
    grants: [...member.descriptor.grants],
    consumes: (member.descriptor.consumes ?? []).map((service) => service.name),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Mount order: a Plugin after every Plugin whose service it consumes, and
 * otherwise the order the generation listed them. A Plugin whose need no
 * sibling meets, or that sits in a cycle, is left out and named, and the rest
 * still mount.
 *
 * `alreadyExcluded` names Plugins the caller has already failed and named. They
 * are still read as providers, so a Plugin consuming their services is told the
 * provider did not mount rather than that nothing provides the service.
 */
export function pluginMountOrderV1(
  members: readonly BotIsolateMemberV1[],
  alreadyExcluded: ReadonlySet<string> = new Set(),
): {
  order: BotIsolateMemberV1[];
  failures: PluginMountFailureV1[];
} {
  const failures: PluginMountFailureV1[] = [];
  const providers = new Map<
    string,
    { member: BotIsolateMemberV1; version: number }
  >();
  for (const member of members) {
    if (alreadyExcluded.has(member.packageId)) continue;
    for (const service of member.descriptor.provides ?? []) {
      const existing = providers.get(service.name);
      if (existing) {
        failures.push({
          pluginId: member.packageId,
          phase: "resolve",
          message: `plugin "${member.packageId}" provides "${service.name}", which "${existing.member.packageId}" already provides`,
        });
        continue;
      }
      providers.set(service.name, { member, version: service.version });
    }
  }
  // An already-failed Plugin fills only the services no mountable sibling
  // claims, so it never displaces a live provider or earns a duplicate failure
  // on top of the one it already has.
  for (const member of members) {
    if (!alreadyExcluded.has(member.packageId)) continue;
    for (const service of member.descriptor.provides ?? []) {
      if (providers.has(service.name)) continue;
      providers.set(service.name, { member, version: service.version });
    }
  }
  const excluded = new Set([
    ...alreadyExcluded,
    ...failures.map((failure) => failure.pluginId),
  ]);
  const needs = new Map<string, BotIsolateMemberV1[]>();
  for (const member of members) {
    if (excluded.has(member.packageId)) continue;
    const upstream: BotIsolateMemberV1[] = [];
    for (const service of member.descriptor.consumes ?? []) {
      const provider = providers.get(service.name);
      if (!provider) {
        failures.push({
          pluginId: member.packageId,
          phase: "resolve",
          message: `plugin "${member.packageId}" consumes "${service.name}", which no installed plugin provides`,
        });
        excluded.add(member.packageId);
        break;
      }
      if (excluded.has(provider.member.packageId)) {
        // The Kahn pass below names this as consuming from a Plugin that did
        // not mount, which is the true reason whatever else the provider
        // declared.
        upstream.push(provider.member);
        continue;
      }
      if (provider.version !== service.version) {
        failures.push({
          pluginId: member.packageId,
          phase: "resolve",
          message: `plugin "${member.packageId}" consumes "${service.name}" version ${service.version}, but "${provider.member.packageId}" provides version ${provider.version}`,
        });
        excluded.add(member.packageId);
        break;
      }
      upstream.push(provider.member);
    }
    if (!excluded.has(member.packageId)) needs.set(member.packageId, upstream);
  }
  // Kahn's algorithm over the listed order, so an unconstrained Plugin keeps
  // its place. A consumer of an excluded Plugin is excluded in turn.
  const order: BotIsolateMemberV1[] = [];
  const placed = new Set<string>();
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const member of members) {
      const id = member.packageId;
      if (placed.has(id) || excluded.has(id)) continue;
      const upstream = needs.get(id) ?? [];
      if (upstream.some((dependency) => excluded.has(dependency.packageId))) {
        failures.push({
          pluginId: id,
          phase: "resolve",
          message: `plugin "${id}" consumes a service from a plugin that did not mount`,
        });
        excluded.add(id);
        progressed = true;
        continue;
      }
      if (upstream.every((dependency) => placed.has(dependency.packageId))) {
        order.push(member);
        placed.add(id);
        progressed = true;
      }
    }
  }
  // What is left when Kahn stalls is a cycle plus whatever hangs off it. Only
  // a Plugin that can reach itself is in the cycle; the rest simply consume a
  // service from a Plugin that could not be ordered.
  const stalled = members.filter(
    (member) =>
      !placed.has(member.packageId) && !excluded.has(member.packageId),
  );
  const stalledIds = new Set(stalled.map((member) => member.packageId));
  const inCycle = (start: string): boolean => {
    const seen = new Set<string>();
    const pending = (needs.get(start) ?? []).map(
      (dependency) => dependency.packageId,
    );
    while (pending.length > 0) {
      const id = pending.pop()!;
      if (id === start) return true;
      if (seen.has(id) || !stalledIds.has(id)) continue;
      seen.add(id);
      for (const dependency of needs.get(id) ?? []) {
        pending.push(dependency.packageId);
      }
    }
    return false;
  };
  for (const member of stalled) {
    const id = member.packageId;
    failures.push({
      pluginId: id,
      phase: "resolve",
      message: inCycle(id)
        ? `plugin "${id}" consumes a service in a cycle`
        : `plugin "${id}" consumes a service from a plugin that did not mount`,
    });
  }
  return { order, failures };
}

/** Mounts a generation's Plugins as one worker and registers what they report. */
export class PluginWorkerHost {
  private readonly options: PluginWorkerHostOptions;

  constructor(options: PluginWorkerHostOptions) {
    this.options = options;
  }

  async mount(
    members: readonly BotIsolateMemberV1[],
  ): Promise<PreparedPluginWorker> {
    const failures: PluginMountFailureV1[] = [];
    const refused = new Set<string>();
    // One provider, one contribution, and it is the deployment's own. What
    // may serve a provider is the deployment's compiled claim, judged by the
    // member's own id and artifact bytes — never by who claimed it first, so
    // the generation's package-id order cannot hand a provider to a
    // Bot-written claimant. A Plugin that fails reserves nothing.
    const open = new Map(
      (this.options.openModelProviders ?? []).map((claim) => [
        claim.provider,
        claim,
      ]),
    );
    const claimed = new Set<string>();
    for (const member of members) {
      const providers = member.descriptor.modelProviders ?? [];
      let untrusted: { id: string; servedBy: string } | undefined;
      for (const provider of providers) {
        const claim = open.get(provider.id);
        if (
          claim !== undefined &&
          (member.packageId !== claim.pluginId ||
            member.artifact.contentHash !== claim.contentHash)
        ) {
          untrusted = { id: provider.id, servedBy: claim.pluginId };
          break;
        }
      }
      const claimedAlready =
        untrusted === undefined
          ? providers.find((provider) => claimed.has(provider.id))
          : undefined;
      const refusal =
        untrusted !== undefined
          ? `plugin "${member.packageId}" claims model provider "${untrusted.id}", which this deployment serves only through the Plugin "${untrusted.servedBy}" at its own artifact`
          : claimedAlready === undefined
            ? this.refusal(member)
            : `plugin "${member.packageId}" serves model provider "${claimedAlready.id}", which an earlier plugin in this generation already serves`;
      // Only a Plugin that mounts reserves its provider: a refused claimant —
      // a Bot's own code above all — must not be able to take the provider
      // away from the deployment's own Plugin by claiming it first.
      if (refusal === undefined) {
        for (const provider of providers) claimed.add(provider.id);
      }
      if (!refusal) continue;
      failures.push({
        pluginId: member.packageId,
        phase: "resolve",
        message: refusal,
      });
      refused.add(member.packageId);
    }
    // A refused Plugin still counts as the provider of its services, so its
    // consumers are told the provider did not mount.
    const ordered = pluginMountOrderV1(members, refused);
    failures.push(...ordered.failures);

    // The artifacts are immutable objects addressed by content hash, so
    // reading them is order-independent and they are read together: one round
    // trip per member, in sequence, is mount latency nobody gets back. The
    // mount order itself is unchanged — `ordered.order` still decides it, and
    // a member whose artifact is missing still fails in its own place.
    const inFlight = createConcurrencyLimiterV1();
    const sources = await Promise.all(
      ordered.order.map((member) =>
        inFlight(() =>
          this.options.artifacts.loadPackageArtifact(
            member.artifact.contentHash,
          ),
        ).then(
          (source) => ({ source, error: undefined }),
          (error: unknown) => ({ source: undefined, error }),
        ),
      ),
    );
    const resolved: ResolvedPlugin[] = [];
    for (const [index, member] of ordered.order.entries()) {
      const { source, error } = sources[index]!;
      if (source === undefined) {
        // Site one: the immutable artifact read. A generation whose artifact
        // is gone never resolves, and that is a different repair from a broken
        // one.
        failures.push({
          pluginId: member.packageId,
          phase: "resolve",
          message: `plugin "${member.packageId}" artifact "${member.artifact.contentHash}" is unavailable: ${errorMessage(error)}`,
        });
        continue;
      }
      resolved.push({ member, source });
    }
    if (resolved.length === 0) {
      return {
        mounted: [],
        failures,
        commit: () =>
          Promise.resolve({
            modelProviders: [],
            streamModel: (invocation: PluginModelInvocationV1) =>
              Promise.resolve<PluginWorkerModelResultV1>({
                schemaVersion: 1,
                status: "refused",
                reason: `plugin "${invocation.pluginId}" did not mount in this generation`,
              }),
            deliverTrigger: (invocation: PluginWorkerTriggerInvocationV1) =>
              Promise.resolve(droppedTrigger(invocation.pluginId)),
            renderView: (invocation: PluginWorkerViewInvocationV1) =>
              Promise.resolve<PluginWorkerViewResultV1>({
                schemaVersion: 1,
                status: "drop",
                reason: `plugin "${invocation.pluginId}" did not mount in this generation`,
              }),
            cardAction: (invocation: PluginWorkerCardActionInvocationV1) =>
              Promise.resolve<PluginWorkerCardActionResultV1>({
                schemaVersion: 1,
                status: "drop",
                reason: `plugin "${invocation.pluginId}" did not mount in this generation`,
              }),
            drawCard: (pluginId: string) =>
              Promise.resolve<PluginCardDrawOutcomeV1>({
                status: "refused",
                reason: `plugin "${pluginId}" did not mount in this generation`,
              }),
            executeTool: (invocation: PluginWorkerToolInvocationV1) =>
              Promise.resolve<IsolateToolResultV1>({
                schemaVersion: 1,
                content: `plugin "${invocation.pluginId}" did not mount in this generation`,
                isError: true,
              }),
            assembleTheme: (_payload, original) => Promise.resolve(original),
            dispose: () => Promise.resolve(),
          }),
      };
    }

    const loaderId = pluginWorkerLoaderIdV1({
      userId: this.options.userId,
      moduleSetHash: await pluginWorkerModuleSetHashV1({
        contractVersion: ISOLATE_CONTRACT_VERSION,
        indexVersion: PLUGIN_WORKER_INDEX_VERSION,
        members: resolved.map(({ member }) => ({
          pluginId: member.packageId,
          contentHash: member.artifact.contentHash,
          ...pluginIdentityV1(member),
        })),
        bindingDigest: this.options.bindingDigest,
      }),
    });

    // Mount and health-check are one guarded phase: `.get()` is lazy and never
    // throws, so a broken module only surfaces on the first RPC.
    let entrypoint: PluginWorkerEntrypoint;
    let health;
    try {
      entrypoint = this.load(loaderId, resolved).getEntrypoint();
      health = await pluginWorkerHealthV1(
        this.options.loader,
        loaderId,
        async () =>
          decodePluginWorkerHealthV1(
            await raceDeadline(
              () => entrypoint.health(),
              Math.min(
                this.options.healthDeadlineMs ??
                  BOT_ISOLATE_DEFAULT_HEALTH_DEADLINE_MS,
                ISOLATE_MAX_DEADLINE_MS,
              ),
            ),
            "plugin worker health",
          ),
      );
    } catch (error) {
      // Site two: `LOADER.get` plus the first RPC. A module that does not
      // parse fails the whole worker here, because the index imports every
      // module and cannot say which one broke.
      throw new CompositionMountFailureError(
        "mount",
        `the plugin worker failed to mount (plugins: ${resolved
          .map(({ member }) => member.packageId)
          .join(", ")}): ${errorMessage(error)}`,
        resolved.map(({ member }) => `plugin:${member.packageId}`),
      );
    }
    if (health.contractVersion !== ISOLATE_CONTRACT_VERSION) {
      throw new CompositionMountFailureError(
        "health",
        `the plugin worker speaks contract ${health.contractVersion}, not ${ISOLATE_CONTRACT_VERSION}`,
      );
    }

    const verified: {
      member: BotIsolateMemberV1;
      health: PluginWorkerPluginHealthV1;
    }[] = [];
    for (const { member } of resolved) {
      const reported = health.plugins.find(
        (plugin) => plugin.pluginId === member.packageId,
      );
      const mismatch = reported
        ? this.healthMismatch(member.descriptor, reported)
        : `plugin "${member.packageId}" is missing from the worker's health report`;
      if (mismatch) {
        failures.push({
          pluginId: member.packageId,
          phase: "health",
          message: mismatch,
        });
        continue;
      }
      verified.push({ member, health: reported! });
    }

    // A Plugin excluded at `health` still has its module in the index, so a
    // consumer mounted after it would be handed its services. Drop those
    // consumers too, naming the provider that did not survive; mount order
    // already puts every provider ahead of its consumers.
    const providerOf = new Map<string, string>();
    for (const member of ordered.order) {
      for (const service of member.descriptor.provides ?? []) {
        providerOf.set(service.name, member.packageId);
      }
    }
    const surviving: typeof verified = [];
    const live = new Set<string>();
    for (const entry of verified) {
      const pluginId = entry.member.packageId;
      const broken = (entry.member.descriptor.consumes ?? []).find(
        (service) => !live.has(providerOf.get(service.name)!),
      );
      if (broken) {
        failures.push({
          pluginId,
          phase: "health",
          message: `plugin "${pluginId}" consumes "${broken.name}", which "${providerOf.get(broken.name)}" did not mount`,
        });
        continue;
      }
      live.add(pluginId);
      surviving.push(entry);
    }

    let disposed = false;
    const registered: (() => void)[] = [];
    const mounted = surviving.map(({ member }) => member.packageId);
    // The model provider contributions this Bot's selection runs. They are
    // chosen from what mounted and survived — never from the Bot's switch,
    // because selecting a provider is the decision that runs it — and only
    // for the one provider the selection named.
    const selectedProvider = this.options.selectedModelProvider;
    const modelProviders: MountedModelProviderV1[] =
      selectedProvider === undefined
        ? []
        : surviving.flatMap(({ member }) => {
            const provider = pluginModelProviderV1(
              member.descriptor,
              selectedProvider,
            );
            return provider === undefined
              ? []
              : [
                  {
                    pluginId: member.packageId,
                    providerId: provider.id,
                    protocolVersion: provider.protocolVersion,
                  },
                ];
          });
    // Of the Plugins that mounted and survived, this Bot runs the ones its
    // own enable map allows. The others stay in the worker — it is per User
    // — but register no tools here and are left out of every hook's list.
    const enabledHere = this.options.enabled;
    const running = surviving.filter(
      ({ member }) =>
        enabledHere === undefined || enabledHere.includes(member.packageId),
    );
    const enabled = running.map(({ member }) => member.packageId);
    return {
      mounted,
      failures,
      commit: (): Promise<ActivePluginWorker> => {
        for (const { member, health: plugin } of running) {
          registered.push(
            this.options.tools.registerNamespace({
              name: member.packageId,
              // Not external: `external` exists to force a human-readable
              // reason onto a call that leaves for a third-party MCP server.
              // A Plugin is this account's own code reached over no network.
              external: false,
              status: "ready",
            }),
          );
          for (const tool of plugin.tools) {
            registered.push(
              this.options.tools.register(
                this.definition(member.packageId, entrypoint, tool),
              ),
            );
          }
          // One tool per declared card, in the same namespace as the Plugin's
          // own tools: a card is something the Bot asks this Plugin to draw.
          for (const card of member.descriptor.cards ?? []) {
            const definition = this.cardDefinition(
              member.packageId,
              entrypoint,
              card,
            );
            if (definition)
              registered.push(this.options.tools.register(definition));
          }
        }
        const declaring = new Map<BotIsolateHookEventNameV1, string[]>();
        for (const { member, health: plugin } of running) {
          for (const event of plugin.hooks) {
            declaring.set(event, [
              ...(declaring.get(event) ?? []),
              member.packageId,
            ]);
          }
        }
        for (const [event, plugins] of declaring) {
          registered.push(
            this.registerHook(entrypoint, enabled, plugins, event),
          );
        }
        return Promise.resolve({
          modelProviders,
          streamModel: async (
            invocation: PluginModelInvocationV1,
          ): Promise<PluginWorkerModelResultV1> => {
            const refuse = (reason: string): PluginWorkerModelResultV1 => ({
              schemaVersion: 1,
              status: "refused",
              reason: reason.slice(0, MAX_FAILURE_REASON_V1),
            });
            if (disposed) {
              return refuse(
                "the plugin worker for this generation is no longer mounted",
              );
            }
            const serving = modelProviders.find(
              (provider) => provider.pluginId === invocation.pluginId,
            );
            if (!serving || !live.has(invocation.pluginId)) {
              return refuse(
                `plugin "${invocation.pluginId}" did not mount in this generation`,
              );
            }
            if (invocation.provider !== serving.providerId) {
              return refuse(
                `plugin "${invocation.pluginId}" serves "${serving.providerId}", not "${invocation.provider}"`,
              );
            }
            const deadlineMs = Math.min(
              invocation.deadlineMs,
              ISOLATE_MAX_DEADLINE_MS - PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
            );
            try {
              return decodePluginWorkerModelResultV1(
                await raceDeadline(
                  () => entrypoint.streamModel({ ...invocation, deadlineMs }),
                  deadlineMs + PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
                ),
                `plugin "${invocation.pluginId}" model result`,
              );
            } catch (error) {
              return refuse(errorMessage(error));
            }
          },
          deliverTrigger: async (
            invocation: PluginWorkerTriggerInvocationV1,
          ): Promise<PluginWorkerTriggerResultV1> => {
            if (disposed) {
              return droppedTrigger(
                invocation.pluginId,
                "the plugin worker for this generation is no longer mounted",
              );
            }
            if (!live.has(invocation.pluginId)) {
              return droppedTrigger(invocation.pluginId);
            }
            // The worker gets the whole budget the caller asked for, less the
            // margin the host keeps for the answer's return trip, so a trigger
            // that spends its budget still answers before the race fires.
            const deadlineMs = Math.min(
              invocation.deadlineMs,
              ISOLATE_MAX_DEADLINE_MS - PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
            );
            try {
              const raw = await raceDeadline(
                () => entrypoint.receiveTrigger({ ...invocation, deadlineMs }),
                deadlineMs + PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
              );
              const oversized = firedTextBytes(raw) > MAX_TRIGGER_BODY_BYTES_V1;
              if (oversized) {
                return droppedTrigger(
                  invocation.pluginId,
                  `plugin "${invocation.pluginId}" fired a trigger body over the ${MAX_TRIGGER_BODY_BYTES_V1} byte limit`,
                );
              }
              return decodePluginWorkerTriggerResultV1(
                raw,
                `plugin "${invocation.pluginId}" trigger result`,
              );
            } catch (error) {
              return droppedTrigger(invocation.pluginId, errorMessage(error));
            }
          },
          renderView: async (
            invocation: PluginWorkerViewInvocationV1,
          ): Promise<PluginWorkerViewResultV1> => {
            const drop = (reason: string): PluginWorkerViewResultV1 => ({
              schemaVersion: 1,
              status: "drop",
              reason: reason.slice(0, MAX_FAILURE_REASON_V1),
            });
            if (disposed) {
              return drop(
                "the plugin worker for this generation is no longer mounted",
              );
            }
            if (!live.has(invocation.pluginId)) {
              return drop(
                `plugin "${invocation.pluginId}" did not mount in this generation`,
              );
            }
            const deadlineMs = Math.min(
              invocation.deadlineMs,
              ISOLATE_MAX_DEADLINE_MS - PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
            );
            try {
              const raw = await raceDeadline(
                () => entrypoint.view({ ...invocation, deadlineMs }),
                deadlineMs + PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
              );
              return decodePluginWorkerViewResultV1(
                raw,
                `plugin "${invocation.pluginId}" view result`,
              );
            } catch (error) {
              return drop(errorMessage(error));
            }
          },
          cardAction: async (
            invocation: PluginWorkerCardActionInvocationV1,
          ): Promise<PluginWorkerCardActionResultV1> => {
            const drop = (reason: string): PluginWorkerCardActionResultV1 => ({
              schemaVersion: 1,
              status: "drop",
              reason: reason.slice(0, MAX_FAILURE_REASON_V1),
            });
            if (disposed) {
              return drop(
                "the plugin worker for this generation is no longer mounted",
              );
            }
            if (!live.has(invocation.pluginId)) {
              return drop(
                `plugin "${invocation.pluginId}" did not mount in this generation`,
              );
            }
            const deadlineMs = Math.min(
              invocation.deadlineMs,
              ISOLATE_MAX_DEADLINE_MS - PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
            );
            try {
              const raw = await raceDeadline(
                () => entrypoint.cardAction({ ...invocation, deadlineMs }),
                deadlineMs + PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
              );
              return decodePluginWorkerCardActionResultV1(
                raw,
                `plugin "${invocation.pluginId}" card action result`,
              );
            } catch (error) {
              return drop(errorMessage(error));
            }
          },
          drawCard: async (
            pluginId: string,
            cardId: string,
            request: PluginCardDrawRequestV1,
            context: ToolExecutionContext,
          ): Promise<PluginCardDrawOutcomeV1> => {
            if (disposed) {
              return {
                status: "refused",
                reason:
                  "the plugin worker for this generation is no longer mounted",
              };
            }
            // Off the Bot's own running set, not the mounted one: a Plugin
            // this Bot does not run draws nothing here either, and a card it
            // does not declare is not a card.
            const card = running
              .find((candidate) => candidate.member.packageId === pluginId)
              ?.member.descriptor.cards?.find(
                (candidate) => candidate.id === cardId,
              );
            if (!card) {
              return {
                status: "refused",
                reason: `plugin "${pluginId}" draws no card "${cardId}" for this Bot`,
              };
            }
            return this.drawCard(pluginId, entrypoint, card, request, context);
          },
          executeTool: async (
            invocation: PluginWorkerToolInvocationV1,
          ): Promise<IsolateToolResultV1> => {
            const refuse = (content: string): IsolateToolResultV1 => ({
              schemaVersion: 1,
              content: content.slice(0, MAX_FAILURE_REASON_V1),
              isError: true,
            });
            if (disposed) {
              return refuse(
                "the plugin worker for this generation is no longer mounted",
              );
            }
            const entry = surviving.find(
              (candidate) => candidate.member.packageId === invocation.pluginId,
            );
            if (!entry) {
              return refuse(
                `plugin "${invocation.pluginId}" did not mount in this generation`,
              );
            }
            if (
              !entry.health.tools.some((tool) => tool.name === invocation.tool)
            ) {
              return refuse(
                `plugin "${invocation.pluginId}" declares no tool "${invocation.tool}"`,
              );
            }
            const deadlineMs = Math.min(
              invocation.deadlineMs,
              ISOLATE_MAX_DEADLINE_MS - PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
            );
            try {
              const raw = await raceDeadline(
                () => entrypoint.execute({ ...invocation, deadlineMs }),
                deadlineMs + PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
              );
              return decodeIsolateToolResultV1(
                raw,
                `plugin "${invocation.pluginId}" tool result`,
              );
            } catch (error) {
              return refuse(
                `Tool "${invocation.tool}" failed in its plugin: ${errorMessage(error)}`,
              );
            }
          },
          assembleTheme: async (payload, original) => {
            if (disposed) return original;
            const plugins = declaring.get("theme/assemble") ?? [];
            if (plugins.length === 0) return original;
            return this.invokeHook(
              entrypoint,
              enabled,
              plugins,
              "theme/assemble",
              payload,
              original,
            );
          },
          dispose: () => {
            if (disposed) return Promise.resolve();
            disposed = true;
            for (const unregister of registered.toReversed()) unregister();
            return Promise.resolve();
          },
        });
      },
    };
  }

  private refusal(member: BotIsolateMemberV1): string | undefined {
    const descriptor = member.descriptor;
    const pluginId = member.packageId;
    if (descriptor.id !== pluginId || descriptor.version !== member.version) {
      return `plugin "${pluginId}" descriptor does not match its Composition member`;
    }
    // A plugin built against a contract this deployment no longer serves is
    // disabled here with the reason, never rebuilt silently.
    if (
      descriptor.contractVersion !== ISOLATE_CONTRACT_VERSION &&
      descriptor.contractVersion !== ISOLATE_CONTRACT_VERSION - 1
    ) {
      return `plugin "${pluginId}" was built against contract ${descriptor.contractVersion}, which this deployment no longer serves`;
    }
    const closedGrants = descriptor.grants.filter(
      (grant) => !OPEN_PLUGIN_GRANTS_V1.includes(grant),
    );
    if (closedGrants.length > 0) {
      return `plugin "${pluginId}" declares grants this deployment has not opened: ${closedGrants.join(", ")}`;
    }
    const closedSlots = [
      ...(descriptor.slots ?? []),
      ...(descriptor.views ?? []).map((view) => view.slot),
    ].filter((slot) => !OPEN_PLUGIN_SLOTS_V1.includes(slot));
    if (closedSlots.length > 0) {
      return `plugin "${pluginId}" declares slots this deployment has not opened: ${[...new Set(closedSlots)].join(", ")}`;
    }
    const open = new Set(
      (this.options.openModelProviders ?? []).map((claim) => claim.provider),
    );
    const closedProviders = (descriptor.modelProviders ?? []).filter(
      (provider) => !open.has(provider.id),
    );
    if (closedProviders.length > 0) {
      return `plugin "${pluginId}" serves model providers this deployment does not open to plugins: ${closedProviders
        .map((provider) => provider.id)
        .join(", ")}`;
    }
    const unserved = (descriptor.modelProviders ?? []).find(
      (provider) =>
        !PLUGIN_MODEL_PROTOCOL_VERSIONS_V1.includes(provider.protocolVersion),
    );
    if (unserved) {
      return `plugin "${pluginId}" serves model provider "${unserved.id}" over protocol ${unserved.protocolVersion}, which this deployment does not serve`;
    }
    return undefined;
  }

  private healthMismatch(
    descriptor: PluginDescriptorV1,
    reported: PluginWorkerPluginHealthV1,
  ): string | undefined {
    const pluginId = descriptor.id;
    if (!reported.ok) {
      return `plugin "${pluginId}" failed to mount in the worker: ${reported.reason}`;
    }
    const declaredTools = descriptor.tools.map((tool) => tool.name).toSorted();
    const reportedTools = reported.tools.map((tool) => tool.name).toSorted();
    if (
      declaredTools.length !== reportedTools.length ||
      declaredTools.some((name, index) => name !== reportedTools[index])
    ) {
      return `plugin "${pluginId}" tools do not match its declared tools (declared:${declaredTools.join(",")} reported:${reportedTools.join(",")})`;
    }
    const declaredHooks = [...descriptor.hooks].toSorted();
    const reportedHooks = [...reported.hooks].toSorted();
    if (
      declaredHooks.length !== reportedHooks.length ||
      declaredHooks.some((name, index) => name !== reportedHooks[index])
    ) {
      return `plugin "${pluginId}" hooks do not match its declared hooks (declared:${declaredHooks.join(",")} reported:${reportedHooks.join(",")})`;
    }
    const declaredProvides = (descriptor.provides ?? [])
      .map((service) => service.name)
      .toSorted();
    const reportedProvides = reported.provides
      .map((service) => service.name)
      .toSorted();
    if (
      declaredProvides.length !== reportedProvides.length ||
      declaredProvides.some((name, index) => name !== reportedProvides[index])
    ) {
      return `plugin "${pluginId}" services do not match its declared provides (declared:${declaredProvides.join(",")} reported:${reportedProvides.join(",")})`;
    }
    const declaredTriggers = (descriptor.triggers ?? [])
      .map((trigger) => trigger.name)
      .toSorted();
    const reportedTriggers = [...reported.triggers].toSorted();
    if (
      declaredTriggers.length !== reportedTriggers.length ||
      declaredTriggers.some((name, index) => name !== reportedTriggers[index])
    ) {
      return `plugin "${pluginId}" triggers do not match its declared triggers (declared:${declaredTriggers.join(",")} reported:${reportedTriggers.join(",")})`;
    }
    // A card and the actions it owns, as one comparable line each: a press
    // names no card, so a module owning an action the descriptor puts on
    // another card — or on no card at all — would route a press to a handler
    // the descriptor never said owned it.
    const cardLine = (card: { id: string; actions: readonly string[] }) =>
      `${card.id}(${[...card.actions].toSorted().join("|")})`;
    const declaredCards = (descriptor.cards ?? [])
      .map((card) =>
        cardLine({
          id: card.id,
          actions: card.actions.map((action) => action.name),
        }),
      )
      .toSorted();
    const reportedCards = reported.cards.map(cardLine).toSorted();
    if (
      declaredCards.length !== reportedCards.length ||
      declaredCards.some((name, index) => name !== reportedCards[index])
    ) {
      return `plugin "${pluginId}" cards do not match its declared cards (declared:${declaredCards.join(",")} reported:${reportedCards.join(",")})`;
    }
    const declaredViews = (descriptor.views ?? [])
      .map((view) => view.surfaceId)
      .toSorted();
    const reportedViews = [...reported.views].toSorted();
    if (
      declaredViews.length !== reportedViews.length ||
      declaredViews.some((name, index) => name !== reportedViews[index])
    ) {
      return `plugin "${pluginId}" views do not match its declared views (declared:${declaredViews.join(",")} reported:${reportedViews.join(",")})`;
    }
    // A provider the descriptor declares and the module does not serve would
    // mount a contribution whose one method is missing; the reverse would run
    // provider code the descriptor, the card and the User never saw.
    const declaredProviders = (descriptor.modelProviders ?? [])
      .map((provider) => provider.id)
      .toSorted();
    const reportedProviders = [...reported.modelProviders].toSorted();
    if (
      declaredProviders.length !== reportedProviders.length ||
      declaredProviders.some((name, index) => name !== reportedProviders[index])
    ) {
      return `plugin "${pluginId}" model providers do not match its declared model providers (declared:${declaredProviders.join(",")} reported:${reportedProviders.join(",")})`;
    }
    return undefined;
  }

  private load(
    loaderId: string,
    resolved: readonly ResolvedPlugin[],
  ): BotIsolateLoadedWorker {
    const limits = this.options.limits ?? BOT_ISOLATE_DEFAULT_LIMITS;
    // Nothing per Turn or per Bot: the worker is one per User, and a loader
    // id is served with the `env` it was first loaded with.
    const identity: IsolateIdentityV1 = {
      userId: this.options.userId,
      plugins: resolved.map(({ member }) => ({
        pluginId: member.packageId,
        ...pluginIdentityV1(member),
      })),
    };
    return this.options.loader.get(loaderId, () =>
      Promise.resolve({
        compatibilityDate: this.options.compatibilityDate,
        mainModule: PLUGIN_WORKER_MAIN_MODULE,
        modules: pluginWorkerModuleMap(
          resolved.map(({ member, source }) => ({
            pluginId: member.packageId,
            source,
          })),
        ),
        // The constitution's rule, made mechanical: no network except what
        // the egress loopback admits, and none at all without one.
        globalOutbound: (this.options.egress ?? null) as null,
        env: { IDENTITY: identity, CAPABILITIES: this.options.capabilities },
        limits,
      }),
    );
  }

  private agentSnapshot(agent: LoopAgentRuntimeV1) {
    return {
      botId: agent.botId,
      agentId: agent.id,
      sessionId: agent.session.id,
      status: agent.status,
    } as const;
  }

  private stepSnapshot(
    agent: LoopAgentRuntimeV1,
    turn: number,
    step: number,
  ): LoopStepSnapshotV1 {
    return {
      ...this.agentSnapshot(agent),
      compositionGenerationId: this.options.generationId,
      turn,
      step,
      turnType: this.options.turnType,
      ...(this.options.subagentRole === undefined
        ? {}
        : { subagentRole: this.options.subagentRole }),
    };
  }

  private registerHook(
    entrypoint: PluginWorkerEntrypoint,
    enabled: readonly string[],
    declaring: readonly string[],
    event: BotIsolateHookEventNameV1,
  ): () => void {
    const hooks = this.options.hooks;
    // Every hook lets the app's own policy run first and then offers the
    // Plugins the result, fenced to this Bot and this generation.
    switch (event) {
      case "system-prompt/assemble":
        return hooks.add({
          assemblePrompt: async (context, next) => {
            const current = await next();
            return this.invokeHook(
              entrypoint,
              enabled,
              declaring,
              event,
              { context: structuredClone(context), assembly: current },
              current,
            );
          },
        });
      case "agent/tool-exposure":
        return hooks.add({
          toolExposure: async (agent, _tools, turn, step, signal, next) => {
            const current = await next();
            if (agent.botId !== this.options.botId) return current;
            return this.invokeHook(
              entrypoint,
              enabled,
              declaring,
              event,
              { step: this.stepSnapshot(agent, turn, step), tools: current },
              current,
              signal,
            );
          },
        });
      case "agent/request":
        return hooks.add({
          request: async (agent, _request, turn, step, signal, next) => {
            const current = await next();
            if (agent.botId !== this.options.botId) return current;
            return this.invokeHook(
              entrypoint,
              enabled,
              declaring,
              event,
              { step: this.stepSnapshot(agent, turn, step), request: current },
              current,
              signal,
            );
          },
        });
      case "tools/pre-execute":
        return hooks.add({
          prepareTool: async (call, context, next) => {
            const current = await next();
            if (
              context.botId !== this.options.botId ||
              context.compositionGenerationId !== this.options.generationId
            ) {
              return current;
            }
            return this.invokeHook(
              entrypoint,
              enabled,
              declaring,
              event,
              {
                call,
                context: loopToolExecutionContextSnapshotV1(context),
                preparation: current,
              },
              current,
              context.signal,
            );
          },
        });
      case "tools/post-execute":
        return hooks.add({
          toolResult: async (call, _result, context, next) => {
            const current = await next();
            if (
              context.botId !== this.options.botId ||
              context.compositionGenerationId !== this.options.generationId
            ) {
              return current;
            }
            return this.invokeHook(
              entrypoint,
              enabled,
              declaring,
              event,
              {
                call,
                context: loopToolExecutionContextSnapshotV1(context),
                result: current,
              },
              current,
              context.signal,
            );
          },
        });
      case "agent/turn-stopping":
        return hooks.add({
          turnStopping: async (agent, turn) => {
            if (agent.botId !== this.options.botId) return;
            // A notification, not a waterfall: the Plugins are told the Turn is
            // settling and have nothing to replace. `invokeHook` still records
            // a failure and returns, so a slow or broken Plugin cannot hold up
            // settlement.
            await this.invokeHook(
              entrypoint,
              enabled,
              declaring,
              event,
              { agent: this.agentSnapshot(agent), turn },
              undefined,
            );
          },
        });
      case "theme/assemble":
        // Not a loop event. `assembleTheme` on the active worker is the
        // only caller; registering a listener here would never fire.
        return () => {};
    }
  }

  private async invokeHook<Event extends BotIsolateHookEventNameV1>(
    entrypoint: PluginWorkerEntrypoint,
    enabled: readonly string[],
    declaring: readonly string[],
    event: Event,
    payload: LoopEventPayloadMapV1[Event],
    original: LoopEventReturnMapV1[Event],
    signal?: AbortSignal,
  ): Promise<LoopEventReturnMapV1[Event]> {
    const deadlineMs = Math.min(
      this.options.deadlineMs ?? BOT_ISOLATE_DEFAULT_DEADLINE_MS,
      ISOLATE_MAX_DEADLINE_MS - PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
    );
    try {
      const invocation: PluginWorkerHookInvocationV1<Event> = {
        schemaVersion: 1,
        event,
        payload: structuredClone(payload),
        botId: this.options.botId,
        sessionId: this.options.sessionId,
        runId: this.options.runId,
        turnId: this.options.turnId,
        generationId: this.options.generationId,
        deadlineMs,
        enabled: [...enabled],
      };
      const result = decodePluginWorkerHookResultV1(
        await raceDeadline(
          () => entrypoint.hook(invocation),
          deadlineMs + PLUGIN_WORKER_HOOK_RACE_MARGIN_MS,
          signal,
        ),
        "plugin worker hook result",
      );
      for (const failure of result.failures) {
        await this.recordFailure(failure.pluginId, event, failure.reason);
      }
      if (result.status === "unchanged") return original;
      return decodeBotIsolateHookReplacementV1(
        event,
        result.replacement,
        original,
      );
    } catch (error) {
      if (error instanceof PluginFatalFailureError) throw error;
      // The worker as a whole did not answer in time, or answered with a value
      // the kernel cannot decode. The index names a Plugin it skipped itself;
      // here nothing says which one, so every Plugin that wraps this event is
      // charged — for one Plugin, exactly right, and for several, honest.
      const message = errorMessage(error);
      // `declaring` is built from `enabled` at commit, so it is a subset.
      for (const pluginId of declaring) {
        await this.recordFailure(pluginId, event, message);
      }
      return original;
    }
  }

  private async recordFailure(
    pluginId: string,
    event: BotIsolateHookEventNameV1,
    message: string,
  ): Promise<void> {
    try {
      await this.options.recordHookFailure({
        packageId: pluginId,
        event,
        generationId: this.options.generationId,
        message: message.slice(0, 2_048),
      });
    } catch (error) {
      // Failure recording is itself an external durability boundary. A
      // broken hook still cannot wedge the loop if that boundary is down —
      // except when it answers that this Plugin cannot be skipped, which is
      // the Turn's verdict and not a recording failure at all.
      if (error instanceof PluginFatalFailureError) throw error;
    }
  }

  /**
   * One card's tool. The Bot sends the values; the kernel validates them
   * against the card's declared schema, mints the surface id unless the Bot
   * is updating a surface it already drew, has the Plugin draw the surface,
   * and records the send on the Turn's log. The Plugin never names a surface,
   * which is what stops one Plugin's card drawing over another's.
   */
  /**
   * One draw of one card, whoever asked for it.
   *
   * The card's tool is one caller; the Shell's own send seam is the other,
   * because the five first-party cards are locked Plugins and an old
   * `send_to_user` member is mapped onto one of them (ADR 0030 step 7). Both
   * go through this: the values are validated against the card's declared
   * schema, the surface id is the kernel's, the Plugin draws, and the send is
   * recorded by the app. Nothing about the first-party path is shorter than
   * the path a customisation takes.
   */
  private async drawCard(
    pluginId: string,
    entrypoint: PluginWorkerEntrypoint,
    card: PluginCardV1,
    request: PluginCardDrawRequestV1,
    context: ToolExecutionContext,
  ): Promise<PluginCardDrawOutcomeV1> {
    const sendCard = this.options.sendCard;
    if (!sendCard) {
      return {
        status: "refused",
        reason: "this host records no sends, so no card can be drawn",
      };
    }
    const deadlineMs = Math.min(
      this.options.deadlineMs ?? BOT_ISOLATE_DEFAULT_DEADLINE_MS,
      ISOLATE_MAX_DEADLINE_MS,
    );
    const options = this.options;
    try {
      validateAgainstJsonSchemaV1(request.data, card.dataSchema, "data");
    } catch (error) {
      return { status: "refused", reason: errorMessage(error) };
    }
    // Only a surface this card itself minted may be named again. Without
    // this the model could hand over another Plugin's surface id and draw
    // over its card, because a card record carries no owner of its own.
    if (
      request.surfaceId !== undefined &&
      (!CARD_SURFACE_ID_V1.test(request.surfaceId) ||
        !request.surfaceId.startsWith(cardSurfacePrefixV1(pluginId, card.id)))
    ) {
      return {
        status: "refused",
        reason: "surfaceId is not a surface this card drew",
      };
    }
    const surfaceId =
      request.surfaceId ??
      (await mintedCardSurfaceIdV1(
        pluginId,
        card.id,
        context.sessionId,
        context.effectId,
      ));
    const invocation: PluginWorkerRenderCardInvocationV1 = {
      schemaVersion: 1,
      pluginId,
      cardId: card.id,
      surfaceId,
      data: request.data,
      botId: options.botId,
      sessionId: context.sessionId,
      runId: options.runId,
      turnId: options.turnId,
      generationId: context.compositionGenerationId,
      deadlineMs,
    };
    // A draw that threw, overran, reached no worker or answered
    // undecodably is charged to the Plugin exactly as a press is; the
    // charge is beside the tool error, never instead of it.
    const chargeDraw = async (message: string): Promise<void> => {
      try {
        await options.recordCardFailure?.({
          pluginId,
          cardId: card.id,
          message,
        });
      } catch {
        // Recording a failure must not be what fails the draw.
      }
    };
    let rendered;
    try {
      rendered = decodePluginWorkerRenderCardResultV1(
        await raceDeadline(
          () => entrypoint.renderCard(invocation),
          deadlineMs,
          context.signal,
        ),
        `plugin "${pluginId}" render card result`,
      );
    } catch (error) {
      const message = errorMessage(error);
      // A Turn the person stopped, or one that ran out of time, is not
      // the Plugin failing; only its own deadline overrun is.
      if (!(error instanceof RaceAbortedError)) await chargeDraw(message);
      return { status: "failed", reason: message };
    }
    if (rendered.status !== "rendered") {
      const reason = rendered.reason ?? "the plugin refused";
      // A draw that refused in as many words is not a draw that broke.
      if (rendered.deliberate !== true) await chargeDraw(reason);
      return { status: "dropped", reason };
    }
    const outcome = await sendCard({
      pluginId,
      cardId: card.id,
      surfaceId,
      ...(rendered.covers === undefined ? {} : { covers: rendered.covers }),
      ...(rendered.decision === undefined
        ? {}
        : { decision: rendered.decision }),
      ...(request.approvalIds === undefined
        ? {}
        : { approvalIds: request.approvalIds }),
      ...(request.secretRequest === undefined
        ? {}
        : { secretRequest: request.secretRequest }),
      messages: rendered.messages,
      context,
    });
    if (outcome.status !== "sent") {
      return { status: "refused", reason: outcome.reason };
    }
    return { status: "drawn", surfaceId, approvals: outcome.approvals };
  }

  private cardDefinition(
    pluginId: string,
    entrypoint: PluginWorkerEntrypoint,
    card: PluginCardV1,
  ): ToolDefinition | undefined {
    const sendCard = this.options.sendCard;
    if (!sendCard) return undefined;
    const name = pluginCardToolNameV1(pluginId, card.id);
    return {
      name,
      description: `${card.description} Draws the "${card.displayName}" card in the conversation. Pass the surfaceId of a card you already drew to update it in place; leave it out to draw a new one.`,
      inputSchema: {
        type: "object",
        properties: {
          data: structuredClone(card.dataSchema),
          surfaceId: {
            type: "string",
            description:
              "The surface of a card you already drew, to update it in place.",
          },
        },
        required: ["data"],
        additionalProperties: false,
      },
      namespace: pluginId,
      // A card is a bubble in the conversation, and two of them are read in
      // the order they landed in.
      orderedEffect: true,
      execute: async (
        input: unknown,
        context: ToolExecutionContext,
      ): Promise<ToolExecutionResult> => {
        const request = (input ?? {}) as {
          data?: unknown;
          surfaceId?: unknown;
        };
        if (
          request.surfaceId !== undefined &&
          typeof request.surfaceId !== "string"
        ) {
          return {
            content: `${name} was refused: surfaceId is not a surface this card drew`,
            isError: true,
          };
        }
        const outcome = await this.drawCard(
          pluginId,
          entrypoint,
          card,
          {
            data: request.data as Record<string, unknown>,
            ...(request.surfaceId === undefined
              ? {}
              : { surfaceId: request.surfaceId }),
          },
          context,
        );
        if (outcome.status === "refused") {
          return {
            content: `${name} was refused: ${outcome.reason}`,
            isError: true,
          };
        }
        if (outcome.status === "failed") {
          return {
            content: `${name} failed in its plugin: ${outcome.reason}`,
            isError: true,
          };
        }
        if (outcome.status === "dropped") {
          return {
            content: `${name} drew nothing: ${outcome.reason}`,
            isError: true,
          };
        }
        if (outcome.approvals > 0) {
          return {
            content: `The "${card.displayName}" card is in the conversation as surface "${outcome.surfaceId}", asking the user to decide. This Turn is over; their decision arrives as input on a later Turn.`,
            isError: false,
            endsTurn: true,
          };
        }
        return {
          content: `The "${card.displayName}" card is in the conversation as surface "${outcome.surfaceId}". Call ${name} again with that surfaceId to update it.`,
          isError: false,
        };
      },
    };
  }

  private definition(
    pluginId: string,
    entrypoint: PluginWorkerEntrypoint,
    descriptor: IsolateToolDescriptorV1,
  ): ToolDefinition {
    const deadlineMs = Math.min(
      this.options.deadlineMs ?? BOT_ISOLATE_DEFAULT_DEADLINE_MS,
      ISOLATE_MAX_DEADLINE_MS,
    );
    const options = this.options;
    return {
      ...isolateToolSchemaV1(descriptor),
      namespace: pluginId,
      idempotent: descriptor.idempotent,
      ...(descriptor.admission ? { admission: descriptor.admission } : {}),
      execute: async (
        input: unknown,
        context: ToolExecutionContext,
      ): Promise<ToolExecutionResult> => {
        const invocation: PluginWorkerToolInvocationV1 = {
          schemaVersion: 1,
          pluginId,
          tool: descriptor.name,
          input: input ?? null,
          botId: options.botId,
          sessionId: context.sessionId,
          runId: options.runId,
          turnId: options.turnId,
          generationId: context.compositionGenerationId,
          deadlineMs,
        };
        try {
          // `AbortSignal` cannot cross the RPC boundary, so the deadline is
          // carried in the invocation and raced again on this side.
          const raw = await raceDeadline(
            () => entrypoint.execute(invocation),
            deadlineMs,
            context.signal,
          );
          const result = decodeIsolateToolResultV1(
            raw,
            `plugin "${pluginId}" tool result`,
          );
          return { content: result.content, isError: result.isError };
        } catch (error) {
          return {
            content: `Tool "${descriptor.name}" failed in its plugin: ${errorMessage(error)}`,
            isError: true,
          };
        }
      },
    };
  }
}

/**
 * How many UTF-8 bytes a fired trigger body is, or zero for anything that is
 * not a fire. The worker returns what the Plugin produced whole; the bound is
 * the Durable Object's, so the caller is told which Plugin overran it and by
 * what limit rather than reading a body truncated mid-sentence.
 */
function firedTextBytes(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  const result = value as { status?: unknown; text?: unknown };
  if (result.status !== "fire" || typeof result.text !== "string") return 0;
  return pluginWorkerUtf8LengthV1(result.text);
}

/** The one statement of what a caller is told when no live Plugin answers. */
function droppedTrigger(
  pluginId: string,
  reason?: string,
): PluginWorkerTriggerResultV1 {
  return {
    schemaVersion: 1,
    status: "drop",
    reason: (
      reason ?? `plugin "${pluginId}" did not mount in this generation`
    ).slice(0, MAX_FAILURE_REASON_V1),
  };
}

/** The Durable Object half of the deadline: a race the worker cannot escape. */
export function raceDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number,
  signal?: AbortSignal,
): Promise<T> {
  if (
    !Number.isSafeInteger(deadlineMs) ||
    deadlineMs <= 0 ||
    deadlineMs > ISOLATE_MAX_DEADLINE_MS
  ) {
    return Promise.reject(
      new Error("isolate invocation deadline is out of range"),
    );
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () =>
        reject(
          new Error(
            `isolate invocation exceeded its deadline of ${deadlineMs}ms`,
          ),
        ),
      deadlineMs,
    );
    if (signal) {
      onAbort = () =>
        reject(
          new RaceAbortedError(
            signal.reason === undefined
              ? "aborted"
              : errorMessage(signal.reason),
          ),
        );
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([Promise.resolve().then(work), expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}
