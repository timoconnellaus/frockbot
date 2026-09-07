// The Bot isolate contribution host: mounts one Composition member's
// content-addressed artifact as a Dynamic Worker and registers the tools its
// wrapper reports.
//
// First-party code is ordinary imports in the kernel isolate; everything else
// runs in a loaded Worker with `globalOutbound` disabled and only the Bot's
// authority bindings, and this is what loads it.
//
// Two loader behaviours are load-bearing here: `.get()` never throws, so mount
// and `health()` are a single guarded phase; and a reused loader id silently
// serves the first code, so the id is nothing but the content address of the
// module set actually mounted.
import {
  decodeBotIsolateHookReplacementV1,
  decodeIsolateHealthV1,
  decodeIsolateHookResultV1,
  decodeIsolateToolResultV1,
  isolateToolSchemaV1,
  ISOLATE_MAX_DEADLINE_MS,
  isolateLoaderIdV1,
  type BotCapabilitiesStub,
  type BotIsolateEntrypoint,
  type BotIsolateHookEventNameV1,
  type IsolateHealthV1,
  type IsolateHookInvocationV1,
  type LoopAgentRuntimeV1,
  type LoopEventPayloadMapV1,
  type LoopHookListV1,
  type LoopEventReturnMapV1,
  type LoopStepSnapshotV1,
  loopToolExecutionContextSnapshotV1,
  type IsolateToolDescriptorV1,
  type IsolateToolInvocationV1,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRegistration,
  type TurnTypeV1,
} from "@frockbot/core/contracts";
import {
  canonicalJson,
  sha256,
  PLUGIN_ACTIONS_V1,
  type PluginActionV1,
  type PluginDescriptorV1,
  type PluginGrantV1,
} from "@frockbot/core/contracts";
import { CompositionMountFailureError } from "@frockbot/core/durable/composition-failure";
import {
  BOT_ISOLATE_MAIN_MODULE,
  BOT_ISOLATE_WRAPPER_SOURCE,
  BOT_ISOLATE_WRAPPER_VERSION,
  botIsolateModuleMap,
} from "./isolate-wrapper.ts";

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

/** What a mounted member holds until the Turn disposes it. */
export interface ActiveContribution {
  dispose(): Promise<void>;
}

export interface PreparedContribution {
  commit(): Promise<ActiveContribution>;
  rollback(): Promise<void>;
}

/**
 * The grants a host actually implements, and the loop seam each action needs.
 *
 * `storage`, `files` and `computer` are names in the vocabulary with nothing
 * behind them yet, and `memory.read`/`memory.write` have no loop seam. A
 * member declaring one is refused at prepare rather than mounted into a
 * surface that would silently do nothing.
 */
const OPEN_PLUGIN_GRANTS_V1: readonly PluginGrantV1[] = [
  "http",
  "schedule",
  "ai",
  "memory",
  "workspace",
];

/** Each action's loop seam. Absent ⇒ declared in the vocabulary, not yet open. */
const PLUGIN_ACTION_HOOKS_V1: Partial<
  Record<PluginActionV1, BotIsolateHookEventNameV1>
> = {
  "context.assemble": "system-prompt/assemble",
  "tools.expose": "agent/tool-exposure",
  "turn.terminate": "agent/turn-stopping",
};

/** `tool.call` is the one action that wraps both halves of a tool call. */
const PLUGIN_TOOL_CALL_HOOKS_V1: readonly BotIsolateHookEventNameV1[] = [
  "tools/pre-execute",
  "tools/post-execute",
];

/** The loop hooks a descriptor's actions add, in vocabulary order. */
export function pluginHookEventsV1(
  actions: readonly PluginActionV1[],
): BotIsolateHookEventNameV1[] {
  const events: BotIsolateHookEventNameV1[] = [];
  for (const action of PLUGIN_ACTIONS_V1) {
    if (!actions.includes(action)) continue;
    if (action === "tool.call") {
      events.push(...PLUGIN_TOOL_CALL_HOOKS_V1);
      continue;
    }
    const event = PLUGIN_ACTION_HOOKS_V1[action];
    if (event) events.push(event);
  }
  return events;
}

/** The `WorkerCode` a Bot isolate is loaded from. Structurally the platform's. */
export interface BotIsolateWorkerCode {
  compatibilityDate: string;
  mainModule: string;
  modules: Record<string, { js: string }>;
  globalOutbound: null;
  env: { IDENTITY: unknown; CAPABILITIES: unknown };
  limits: { cpuMs: number; subRequests: number };
}

export interface BotIsolateLoadedWorker {
  getEntrypoint(name?: string | null): BotIsolateEntrypoint;
}

/** The `worker_loaders` binding, declared structurally so the kernel stays platform-free. */
export interface BotIsolateLoader {
  get(
    id: string,
    callback: () => Promise<BotIsolateWorkerCode>,
  ): BotIsolateLoadedWorker;
}

/** Reads an immutable, content-addressed Package artifact and verifies its hash. */
export interface BotIsolateArtifactStore {
  loadPackageArtifact(contentHash: string): Promise<string>;
}

export interface BotIsolateLimits {
  cpuMs: number;
  subRequests: number;
}

export interface BotIsolateHostOptions {
  loader: BotIsolateLoader;
  artifacts: BotIsolateArtifactStore;
  /** Where the isolate's tools are registered — the kernel's tool surface. */
  tools: Pick<ToolRegistration, "register" | "registerNamespace">;
  /** The Turn's hook list; an isolate's hooks are appended after the app's. */
  hooks: LoopHookListV1;
  userId: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  turnType: TurnTypeV1;
  subagentRole?: string;
  /** Persists a visible failure without letting a broken hook wedge the loop. */
  recordHookFailure(failure: IsolateHookFailureV1): Promise<void>;
  /**
   * The loopback service binding minted with
   * `ctx.exports.BotCapabilities({ props })`. Opaque to the kernel: it only
   * places it in the isolate's `env`.
   */
  capabilities: BotCapabilitiesStub;
  /**
   * A content address of the Bot authority bindings this isolate is
   * loaded with. Required, and part of the loader id, because a loader id is
   * served from cache: the `env` a Bot isolate was first loaded with is the
   * `env` it keeps, so a change in the Bot's Connections must produce a new
   * isolate or the isolate would keep answering from a revoked authority.
   */
  bindingDigest: string;
  compatibilityDate: string;
  limits?: BotIsolateLimits;
  /** Per-invocation deadline; `AbortSignal` cannot cross the RPC boundary. */
  deadlineMs?: number;
  /** Verification deadline: an isolate that never answers `health()` fails closed. */
  healthDeadlineMs?: number;
}

export interface IsolateHookFailureV1 {
  packageId: string;
  event: BotIsolateHookEventNameV1;
  generationId: string;
  message: string;
}

export const BOT_ISOLATE_DEFAULT_LIMITS: BotIsolateLimits = {
  cpuMs: 5_000,
  subRequests: 5,
};

export const BOT_ISOLATE_DEFAULT_DEADLINE_MS = 15_000;
export const BOT_ISOLATE_DEFAULT_HEALTH_DEADLINE_MS = 10_000;

/**
 * The content address of what a Bot isolate mounts: the wrapper text, the
 * Package artifact, the digest of the Bot authority bindings, and the grants
 * baked into its `IDENTITY`. A change to any of them is a new isolate —
 * grants included, because a loader id is served from cache and the `env` an
 * isolate was first loaded with is the `env` it keeps.
 */
export async function botIsolateModuleSetHashV1(
  artifactContentHash: string,
  bindingDigest: string,
  grants: readonly PluginGrantV1[] = [],
): Promise<string> {
  return sha256(
    canonicalJson({
      wrapperVersion: BOT_ISOLATE_WRAPPER_VERSION,
      wrapperHash: await sha256(BOT_ISOLATE_WRAPPER_SOURCE),
      packageHash: artifactContentHash,
      bindingDigest,
      grants: [...grants].sort(),
    }),
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mounts an isolate Composition member and registers the tools it reports. */
export class BotIsolateContributionHost {
  private readonly options: BotIsolateHostOptions;

  constructor(options: BotIsolateHostOptions) {
    this.options = options;
  }

  async prepare(member: BotIsolateMemberV1): Promise<PreparedContribution> {
    const packageId = member.packageId;
    const descriptor = member.descriptor;
    if (descriptor.id !== packageId || descriptor.version !== member.version) {
      throw new CompositionMountFailureError(
        "resolve",
        `package "${packageId}" descriptor does not match its Composition member`,
      );
    }
    // A grant or action the vocabulary names but no host implements yet. The
    // Memory seam opens when Memory becomes an app module (plan step 7); the
    // rest wait on their own hosts. Refused here rather than mounted inert.
    const closedGrants = descriptor.grants.filter(
      (grant) => !OPEN_PLUGIN_GRANTS_V1.includes(grant),
    );
    if (closedGrants.length > 0) {
      throw new CompositionMountFailureError(
        "resolve",
        `package "${packageId}" declares grants this deployment has not opened: ${closedGrants.join(", ")}`,
      );
    }
    const closedActions = descriptor.actions.filter(
      (action) =>
        action !== "tool.call" && PLUGIN_ACTION_HOOKS_V1[action] === undefined,
    );
    if (closedActions.length > 0) {
      throw new CompositionMountFailureError(
        "resolve",
        `package "${packageId}" declares actions with no loop seam yet: ${closedActions.join(", ")}`,
      );
    }
    if (descriptor.slots && descriptor.slots.length > 0) {
      throw new CompositionMountFailureError(
        "resolve",
        `package "${packageId}" declares slots, which open when the Flutter renderer lands`,
      );
    }
    const artifact = member.artifact;
    const source = await this.loadSource(packageId, artifact.contentHash);
    const loaderId = isolateLoaderIdV1({
      userId: this.options.userId,
      artifactSetHash: await botIsolateModuleSetHashV1(
        artifact.contentHash,
        this.options.bindingDigest,
        descriptor.grants,
      ),
    });

    // Mount and health-check are one guarded phase: `.get()` is lazy and never
    // throws, so a broken `package.js` only surfaces on the first RPC.
    let health: IsolateHealthV1;
    let entrypoint: BotIsolateEntrypoint;
    try {
      entrypoint = this.load(
        loaderId,
        packageId,
        source,
        descriptor.grants,
      ).getEntrypoint();
      health = decodeIsolateHealthV1(
        await raceDeadline(
          () => entrypoint.health(),
          Math.min(
            this.options.healthDeadlineMs ??
              BOT_ISOLATE_DEFAULT_HEALTH_DEADLINE_MS,
            ISOLATE_MAX_DEADLINE_MS,
          ),
        ),
        `package "${packageId}" isolate health`,
      );
    } catch (error) {
      // Site two: `LOADER.get` plus the first RPC. `.get()` is lazy, so a
      // broken `package.js` surfaces here and nowhere earlier.
      throw new CompositionMountFailureError(
        "mount",
        `package "${packageId}" failed to mount in its isolate: ${errorMessage(error)}`,
        [`loader:${loaderId}`],
      );
    }
    // Site three: the isolate answered, but failed its declared check.
    if (!health.ok || health.tools.length === 0) {
      throw new CompositionMountFailureError(
        "health",
        `package "${packageId}" reported an unhealthy isolate`,
        [`ok:${health.ok}`, `tools:${health.tools.length}`],
      );
    }
    if (health.packageId !== packageId) {
      throw new CompositionMountFailureError(
        "health",
        `package "${packageId}" isolate reported a different package id`,
        [`reported:${health.packageId}`],
      );
    }
    // The descriptor is the durable declaration; the isolate's health report
    // is what the code actually offers. They have to agree exactly, or the
    // catalog the model reads is not the catalog the Composition pinned.
    const declaredTools = descriptor.tools.map((tool) => tool.name).toSorted();
    const reportedTools = health.tools.map((tool) => tool.name).toSorted();
    if (
      declaredTools.length !== reportedTools.length ||
      declaredTools.some((name, index) => name !== reportedTools[index])
    ) {
      throw new CompositionMountFailureError(
        "health",
        `package "${packageId}" isolate tools do not match its descriptor`,
        [
          `declared:${declaredTools.join(",")}`,
          `reported:${reportedTools.join(",")}`,
        ],
      );
    }
    const declaredHooks = pluginHookEventsV1(descriptor.actions).toSorted();
    const reportedHooks = (health.hooks ?? []).toSorted();
    if (
      declaredHooks.length !== reportedHooks.length ||
      declaredHooks.some((name, index) => name !== reportedHooks[index])
    ) {
      throw new CompositionMountFailureError(
        "health",
        `package "${packageId}" isolate hooks do not match its declared actions`,
        [
          `declared:${declaredHooks.join(",")}`,
          `reported:${reportedHooks.join(",")}`,
        ],
      );
    }

    let disposed = false;
    const registered: (() => void)[] = [];
    return {
      commit: (): Promise<ActiveContribution> => {
        registered.push(
          this.options.tools.registerNamespace({
            name: packageId,
            // Not external. `external` exists to force a human-readable
            // reason onto a call that leaves for a third-party MCP server, and
            // the dispatch guard refuses an external call without
            // `mcpDetails.description`. An isolate-hosted Package is this
            // deployment's own reviewed code reached over no network, and
            // nothing ever told the model to send `mcpDetails` for one — the
            // discovery envelope omits it and the `call_dynamic_tool` blurb
            // says to omit it. So the envelope offered was the envelope
            // refused, and the Applets Package (which ships as a bundled
            // artifact and mounts here) could not be called by chat at all:
            // `applet_create` answered `External namespace "applets" requires
            // mcpDetails.description` every time.
            external: false,
            status: "ready",
          }),
        );
        for (const tool of health.tools) {
          registered.push(
            this.options.tools.register(
              this.definition(packageId, entrypoint, tool),
            ),
          );
        }
        for (const event of health.hooks ?? []) {
          registered.push(this.registerHook(packageId, entrypoint, event));
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
      rollback: () => Promise.resolve(),
    };
  }

  private async loadSource(
    packageId: string,
    contentHash: string,
  ): Promise<string> {
    try {
      return await this.options.artifacts.loadPackageArtifact(contentHash);
    } catch (error) {
      // Site one: the immutable artifact read. A generation whose artifact is
      // gone never resolves, and that is a different repair from a broken one.
      throw new CompositionMountFailureError(
        "resolve",
        `package "${packageId}" artifact "${contentHash}" is unavailable: ${errorMessage(error)}`,
        [`contentHash:${contentHash}`],
      );
    }
  }

  private load(
    loaderId: string,
    packageId: string,
    source: string,
    grants: readonly PluginGrantV1[],
  ): BotIsolateLoadedWorker {
    const limits = this.options.limits ?? BOT_ISOLATE_DEFAULT_LIMITS;
    const identity = {
      userId: this.options.userId,
      botId: this.options.botId,
      generationId: this.options.generationId,
      packageId,
      grants: [...grants],
    };
    return this.options.loader.get(loaderId, () =>
      Promise.resolve({
        compatibilityDate: this.options.compatibilityDate,
        mainModule: BOT_ISOLATE_MAIN_MODULE,
        modules: botIsolateModuleMap(source),
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
    packageId: string,
    entrypoint: BotIsolateEntrypoint,
    event: BotIsolateHookEventNameV1,
  ): () => void {
    const hooks = this.options.hooks;
    // Every hook lets the app's own policy run first and then offers the
    // Bot-authored code the result, fenced to this Bot and this generation.
    switch (event) {
      case "system-prompt/assemble":
        return hooks.add({
          assemblePrompt: async (context, next) => {
            const current = await next();
            return this.invokeHook(
              packageId,
              entrypoint,
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
              packageId,
              entrypoint,
              event,
              { step: this.stepSnapshot(agent, turn, step), tools: current },
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
              packageId,
              entrypoint,
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
              packageId,
              entrypoint,
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
            // A notification, not a waterfall: the isolate is told the Turn is
            // settling and has nothing to replace. `invokeHook` still records
            // a failure and returns, so a slow or broken plugin cannot hold up
            // settlement.
            await this.invokeHook(
              packageId,
              entrypoint,
              event,
              { agent: this.agentSnapshot(agent), turn },
              undefined,
            );
          },
        });
    }
  }

  private async invokeHook<Event extends BotIsolateHookEventNameV1>(
    packageId: string,
    entrypoint: BotIsolateEntrypoint,
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
      const invocation: IsolateHookInvocationV1<Event> = {
        schemaVersion: 1,
        event,
        payload: structuredClone(payload),
        botId: this.options.botId,
        sessionId: this.options.sessionId,
        runId: this.options.runId,
        turnId: this.options.turnId,
        generationId: this.options.generationId,
        deadlineMs,
      };
      const result = decodeIsolateHookResultV1(
        await raceDeadline(
          () => entrypoint.hook(invocation),
          deadlineMs,
          signal,
        ),
        `package "${packageId}" isolate hook result`,
      );
      if (result.status === "unchanged") return original;
      return decodeBotIsolateHookReplacementV1(
        event,
        result.replacement,
        original,
      );
    } catch (error) {
      const message = errorMessage(error).slice(0, 2_048);
      try {
        await this.options.recordHookFailure({
          packageId,
          event,
          generationId: this.options.generationId,
          message,
        });
      } catch {
        // Failure recording is itself an external durability boundary. A
        // broken hook still cannot wedge the loop if that boundary is down.
      }
      return original;
    }
  }

  private definition(
    packageId: string,
    entrypoint: BotIsolateEntrypoint,
    descriptor: IsolateToolDescriptorV1,
  ): ToolDefinition {
    const deadlineMs = Math.min(
      this.options.deadlineMs ?? BOT_ISOLATE_DEFAULT_DEADLINE_MS,
      ISOLATE_MAX_DEADLINE_MS,
    );
    const options = this.options;
    return {
      ...isolateToolSchemaV1(descriptor),
      namespace: packageId,
      idempotent: descriptor.idempotent,
      // A contract v1 isolate declares none, and its tools stay on every turn.
      ...(descriptor.admission ? { admission: descriptor.admission } : {}),
      execute: async (
        input: unknown,
        context: ToolExecutionContext,
      ): Promise<ToolExecutionResult> => {
        const invocation: IsolateToolInvocationV1 = {
          schemaVersion: 1,
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
            `package "${packageId}" isolate result`,
          );
          return { content: result.content, isError: result.isError };
        } catch (error) {
          return {
            content: `Tool "${descriptor.name}" failed in its isolate: ${errorMessage(error)}`,
            isError: true,
          };
        }
      },
    };
  }
}

/** The Durable Object half of the deadline: a race the isolate cannot escape. */
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
      if (signal.aborted) {
        reject(new Error("isolate invocation was cancelled"));
        return;
      }
      onAbort = () => reject(new Error("isolate invocation was cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
  return Promise.race([Promise.resolve().then(work), expiry]).finally(() => {
    clearTimeout(timer);
    if (signal && onAbort) signal.removeEventListener("abort", onAbort);
  });
}
