// The Plugin worker host: mounts every Plugin a Composition generation names
// as one Dynamic Worker and registers the tools and hooks its health report
// declares.
//
// First-party code is ordinary imports in the kernel isolate; everything else
// runs in one loaded Worker per User with `globalOutbound` disabled and only
// the loopback bindings the Bot's authority grants, and this is what loads it.
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
  isolateToolSchemaV1,
  ISOLATE_CONTRACT_VERSION,
  ISOLATE_MAX_DEADLINE_MS,
  pluginWorkerLoaderIdV1,
  pluginWorkerModuleSetHashV1,
  type BotCapabilitiesStub,
  type BotIsolateEnv,
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
  type PluginWorkerHookInvocationV1,
  type PluginWorkerPluginHealthV1,
  type PluginWorkerToolInvocationV1,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRegistration,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import {
  type PluginDescriptorV1,
  type PluginGrantV1,
} from "@frockbot/core/contracts";
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
 * The grants a host in this deployment can actually honour. `storage`,
 * `files` and `computer` are named in the vocabulary and wait on their hosts;
 * a Plugin declaring one is refused at resolve rather than mounted inert.
 */
const OPEN_PLUGIN_GRANTS_V1: readonly PluginGrantV1[] = [
  "http",
  "schedule",
  "ai",
  "memory",
  "workspace",
];

/** The `WorkerCode` a Plugin worker is loaded from. Structurally the platform's. */
export interface BotIsolateWorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, { js: string }>;
  globalOutbound: null;
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

/** One Plugin the worker could not mount, with the phase it failed at. */
export interface PluginMountFailureV1 {
  pluginId: string;
  phase: CompositionFailurePhaseV1;
  message: string;
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
  /** The loopback `CAPABILITIES` binding, minted by the Bot's Durable Object. */
  capabilities: BotCapabilitiesStub;
  compatibilityDate: string;
  /**
   * Content address of the bindings baked into `env`. Folded into the loader
   * id so a cached worker never answers under stale authority.
   */
  bindingDigest: string;
  limits?: BotIsolateLimits;
  deadlineMs?: number;
  healthDeadlineMs?: number;
}

export const BOT_ISOLATE_DEFAULT_LIMITS: BotIsolateLimits = {
  cpuMs: 5_000,
  subRequests: 5,
};

export const BOT_ISOLATE_DEFAULT_DEADLINE_MS = 15_000;
export const BOT_ISOLATE_DEFAULT_HEALTH_DEADLINE_MS = 10_000;

/** A mounted worker: what it registers on commit, and what it could not mount. */
export interface PreparedPluginWorker {
  /** Plugins the worker mounted and verified, in mount order. */
  readonly mounted: readonly string[];
  readonly failures: readonly PluginMountFailureV1[];
  commit(): Promise<ActivePluginWorker>;
}

export interface ActivePluginWorker {
  dispose(): Promise<void>;
}

interface ResolvedPlugin {
  member: BotIsolateMemberV1;
  source: string;
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
    for (const member of members) {
      const refusal = this.refusal(member);
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

    const resolved: ResolvedPlugin[] = [];
    for (const member of ordered.order) {
      try {
        resolved.push({
          member,
          source: await this.options.artifacts.loadPackageArtifact(
            member.artifact.contentHash,
          ),
        });
      } catch (error) {
        // Site one: the immutable artifact read. A generation whose artifact
        // is gone never resolves, and that is a different repair from a broken
        // one.
        failures.push({
          pluginId: member.packageId,
          phase: "resolve",
          message: `plugin "${member.packageId}" artifact "${member.artifact.contentHash}" is unavailable: ${errorMessage(error)}`,
        });
      }
    }
    if (resolved.length === 0) {
      return {
        mounted: [],
        failures,
        commit: () => Promise.resolve({ dispose: () => Promise.resolve() }),
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
      health = decodePluginWorkerHealthV1(
        await raceDeadline(
          () => entrypoint.health(),
          Math.min(
            this.options.healthDeadlineMs ??
              BOT_ISOLATE_DEFAULT_HEALTH_DEADLINE_MS,
            ISOLATE_MAX_DEADLINE_MS,
          ),
        ),
        "plugin worker health",
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
    const enabled: typeof verified = [];
    const live = new Set<string>();
    for (const entry of verified) {
      const pluginId = entry.member.packageId;
      const broken = (entry.member.descriptor.consumes ?? []).find(
        (service) => {
          const provider = providerOf.get(service.name);
          return provider === undefined || !live.has(provider);
        },
      );
      if (broken) {
        failures.push({
          pluginId,
          phase: "resolve",
          message: `plugin "${pluginId}" consumes "${broken.name}", which "${providerOf.get(broken.name) ?? "no plugin"}" did not mount`,
        });
        continue;
      }
      live.add(pluginId);
      enabled.push(entry);
    }

    let disposed = false;
    const registered: (() => void)[] = [];
    const mounted = enabled.map(({ member }) => member.packageId);
    return {
      mounted,
      failures,
      commit: (): Promise<ActivePluginWorker> => {
        for (const { member, health: plugin } of enabled) {
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
        }
        const declaring = new Map<BotIsolateHookEventNameV1, string[]>();
        for (const { member, health: plugin } of enabled) {
          for (const event of plugin.hooks) {
            declaring.set(event, [
              ...(declaring.get(event) ?? []),
              member.packageId,
            ]);
          }
        }
        for (const [event, plugins] of declaring) {
          registered.push(
            this.registerHook(entrypoint, mounted, plugins, event),
          );
        }
        return Promise.resolve({
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
    if (descriptor.slots && descriptor.slots.length > 0) {
      return `plugin "${pluginId}" declares slots, which open when the settings section lands`;
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
    return undefined;
  }

  private load(
    loaderId: string,
    resolved: readonly ResolvedPlugin[],
  ): BotIsolateLoadedWorker {
    const limits = this.options.limits ?? BOT_ISOLATE_DEFAULT_LIMITS;
    const identity: IsolateIdentityV1 = {
      userId: this.options.userId,
      botId: this.options.botId,
      generationId: this.options.generationId,
      plugins: resolved.map(({ member }) => ({
        pluginId: member.packageId,
        grants: [...member.descriptor.grants],
        consumes: (member.descriptor.consumes ?? []).map(
          (service) => service.name,
        ),
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
        // The constitution's rule, made mechanical: no network except bindings.
        globalOutbound: null,
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
      ISOLATE_MAX_DEADLINE_MS,
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
          deadlineMs,
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
      // The worker as a whole did not answer in time, or answered with a value
      // the kernel cannot decode. The index names a Plugin it skipped itself;
      // here nothing says which one, so every Plugin that wraps this event is
      // charged — for one Plugin, exactly right, and for several, honest.
      const message = errorMessage(error);
      for (const pluginId of declaring) {
        if (!enabled.includes(pluginId)) continue;
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
    } catch {
      // Failure recording is itself an external durability boundary. A
      // broken hook still cannot wedge the loop if that boundary is down.
    }
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
      onAbort = () => reject(signal.reason ?? new Error("aborted"));
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([Promise.resolve().then(work), expiry]).finally(() => {
    if (timer !== undefined) clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}
