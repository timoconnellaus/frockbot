// The Bot isolate contribution host: mounts one Composition member's
// content-addressed artifact as a Dynamic Worker and registers the tools its
// wrapper reports.
//
// It sits beside `LocalCordisContributionHost` because it is the *other*
// execution host the constitution names — first-party Packages run in the
// kernel isolate, everything else runs in a loaded Worker with
// `globalOutbound` disabled and only the Bot's authority bindings.
//
// Two behaviours come straight from `docs/research/spike-worker-loader-from-do.md`:
// `.get()` never throws, so mount and `health()` are a single guarded phase;
// and a reused loader id silently serves the first code, so the id is nothing
// but the content address of the module set actually mounted.
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
} from "@frockbot/kernel-contracts";
import type { Context } from "cordis";
import { CompositionMountFailureError } from "./activation.ts";
import { canonicalJson, sha256 } from "./compiler.ts";
import type { CompositionMemberV1 } from "./generation.ts";
import type {
  ActiveContribution,
  ContributionHost,
  PackageDescriptor,
  PreparedContribution,
} from "./index.ts";
import { decodeFrockBotManifest, type FrockBotManifest } from "./manifest.ts";
import {
  BOT_ISOLATE_MAIN_MODULE,
  BOT_ISOLATE_WRAPPER_SOURCE,
  BOT_ISOLATE_WRAPPER_VERSION,
  botIsolateModuleMap,
} from "./isolate-wrapper.ts";

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
  tools: Pick<ToolRegistration, "register">;
  /** The mounted Bot/generation root. Isolate hook listeners live only here. */
  loop: Context;
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
 * The content address of what a Bot isolate mounts: the kernel wrapper text,
 * the Package artifact, and the digest of the Bot authority bindings it
 * is loaded with. A change to any of the three is a new isolate.
 */
export async function botIsolateModuleSetHashV1(
  artifactContentHash: string,
  bindingDigest: string,
): Promise<string> {
  return sha256(
    canonicalJson({
      wrapperVersion: BOT_ISOLATE_WRAPPER_VERSION,
      wrapperHash: await sha256(BOT_ISOLATE_WRAPPER_SOURCE),
      packageHash: artifactContentHash,
      bindingDigest,
    }),
  );
}

/**
 * The durable ceiling a manifest puts on the turn types a Package's tools may
 * be admitted onto (manifest v4, `CapabilityDefinition.admission`). It is the
 * union over the Package's tool Capabilities, because a tool descriptor names
 * no Capability: a Package bounds its tools only when every tool Capability it
 * declares bounds them. Absent means the manifest set no bound.
 */
export function botIsolateAdmissionCeilingV1(
  manifest: FrockBotManifest,
): readonly TurnTypeV1[] | undefined {
  const capabilities = (manifest.configuration?.capabilities ?? []).filter(
    (capability) => capability.kind === "tool",
  );
  if (
    capabilities.length === 0 ||
    capabilities.some((capability) => capability.admission === undefined)
  ) {
    return undefined;
  }
  const turnTypes = new Set<TurnTypeV1>();
  for (const capability of capabilities) {
    for (const turnType of capability.admission?.turnTypes ?? []) {
      turnTypes.add(turnType);
    }
  }
  return [...turnTypes];
}

/**
 * The same durable ceiling on the second dimension: the subagent roles a
 * Package's tools may be offered to. Union over the tool Capabilities, and
 * absent unless *every* one of them names roles — a Package bounds its tools
 * only when it has bounded all of them.
 */
export function botIsolateSubagentRoleCeilingV1(
  manifest: FrockBotManifest,
): readonly string[] | undefined {
  const capabilities = (manifest.configuration?.capabilities ?? []).filter(
    (capability) => capability.kind === "tool",
  );
  if (
    capabilities.length === 0 ||
    capabilities.some(
      (capability) => capability.admission?.subagentRoles === undefined,
    )
  ) {
    return undefined;
  }
  const roles = new Set<string>();
  for (const capability of capabilities) {
    for (const role of capability.admission?.subagentRoles ?? []) {
      roles.add(role);
    }
  }
  return [...roles];
}

/**
 * A Composition member and its stored manifest projected onto the descriptor
 * a contribution host consumes. Hash and identity checks happen here so no
 * mount caller can replace the durable manifest with a synthesized one.
 */
export async function botIsolatePackageDescriptorV1(
  member: CompositionMemberV1,
  storedManifest: unknown,
): Promise<PackageDescriptor> {
  const manifestHash = await sha256(canonicalJson(storedManifest));
  if (manifestHash !== member.manifestHash) {
    throw new Error(
      `package "${member.packageId}" stored manifest failed hash verification`,
    );
  }
  const manifest = decodeFrockBotManifest(storedManifest);
  if (manifest.id !== member.packageId || manifest.version !== member.version) {
    throw new Error(
      `package "${member.packageId}" stored manifest does not match its Composition member`,
    );
  }
  if (manifest.contributions.runtime?.host !== "bot-isolate") {
    throw new Error(
      `package "${member.packageId}" manifest declares no Bot isolate runtime`,
    );
  }
  return {
    specifier: member.specifier,
    manifest,
    ...(member.artifact ? { artifact: member.artifact } : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Mounts an isolate Composition member and registers the tools it reports. */
export class BotIsolateContributionHost implements ContributionHost {
  readonly kind = "bot-isolate" as const;
  private readonly options: BotIsolateHostOptions;

  constructor(options: BotIsolateHostOptions) {
    this.options = options;
  }

  async prepare(
    pkg: PackageDescriptor,
  ): Promise<PreparedContribution | undefined> {
    const artifact = pkg.artifact;
    if (!artifact) return undefined;
    const packageId = pkg.manifest.id;
    const source = await this.loadSource(packageId, artifact.contentHash);
    const loaderId = isolateLoaderIdV1({
      userId: this.options.userId,
      artifactSetHash: await botIsolateModuleSetHashV1(
        artifact.contentHash,
        this.options.bindingDigest,
      ),
    });

    // Mount and health-check are one guarded phase: `.get()` is lazy and never
    // throws, so a broken `package.js` only surfaces on the first RPC.
    let health: IsolateHealthV1;
    let entrypoint: BotIsolateEntrypoint;
    try {
      entrypoint = this.load(loaderId, packageId, source).getEntrypoint();
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
    const declaredTools = (pkg.manifest.tools ?? [])
      .map((tool) => tool.name)
      .toSorted();
    const reportedTools = health.tools.map((tool) => tool.name).toSorted();
    if (
      declaredTools.length !== reportedTools.length ||
      declaredTools.some((name, index) => name !== reportedTools[index])
    ) {
      throw new CompositionMountFailureError(
        "health",
        `package "${packageId}" isolate tools do not match its stored manifest`,
        [
          `declared:${declaredTools.join(",")}`,
          `reported:${reportedTools.join(",")}`,
        ],
      );
    }
    const declaredHooks = (pkg.manifest.hooks ?? []).toSorted();
    const reportedHooks = (health.hooks ?? []).toSorted();
    if (
      declaredHooks.length !== reportedHooks.length ||
      declaredHooks.some((name, index) => name !== reportedHooks[index])
    ) {
      throw new CompositionMountFailureError(
        "health",
        `package "${packageId}" isolate hooks do not match its stored manifest`,
        [
          `declared:${declaredHooks.join(",")}`,
          `reported:${reportedHooks.join(",")}`,
        ],
      );
    }

    let disposed = false;
    const registered: (() => void)[] = [];
    return {
      kind: this.kind,
      commit: (): Promise<ActiveContribution> => {
        // The manifest ceiling is applied at registration, so the catalog the
        // model is offered and the call the loop admits cannot disagree.
        const admissionCeiling = botIsolateAdmissionCeilingV1(pkg.manifest);
        const subagentRoleCeiling = botIsolateSubagentRoleCeilingV1(
          pkg.manifest,
        );
        const options =
          admissionCeiling || subagentRoleCeiling
            ? {
                ...(admissionCeiling ? { admissionCeiling } : {}),
                ...(subagentRoleCeiling ? { subagentRoleCeiling } : {}),
              }
            : undefined;
        for (const descriptor of health.tools) {
          registered.push(
            this.options.tools.register(
              this.definition(packageId, entrypoint, descriptor),
              options,
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
  ): BotIsolateLoadedWorker {
    const limits = this.options.limits ?? BOT_ISOLATE_DEFAULT_LIMITS;
    const identity = {
      botId: this.options.botId,
      generationId: this.options.generationId,
      packageId,
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
    const root = this.options.loop;
    switch (event) {
      case "agent/pre-step":
        return root.on(event, async (agent, _inputs, turn, step, next) => {
          const current = await next();
          if (agent.botId !== this.options.botId) return current;
          return this.invokeHook(
            packageId,
            entrypoint,
            event,
            {
              step: this.stepSnapshot(agent, turn, step),
              inputs: current.kind === "enter" ? current.inputs : _inputs,
              decision: current,
            },
            current,
          );
        });
      case "system-prompt/assemble":
        return root.on(event, async (context, next) => {
          const current = await next();
          return this.invokeHook(
            packageId,
            entrypoint,
            event,
            { context: structuredClone(context), assembly: current },
            current,
          );
        });
      case "agent/message-window":
        return root.on(
          event,
          async (agent, _messages, turn, step, signal, next) => {
            const current = await next();
            if (agent.botId !== this.options.botId) return current;
            return this.invokeHook(
              packageId,
              entrypoint,
              event,
              {
                step: this.stepSnapshot(agent, turn, step),
                messages: current,
              },
              current,
              signal,
            );
          },
        );
      case "agent/tool-exposure":
        return root.on(
          event,
          async (agent, _tools, turn, step, signal, next) => {
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
        );
      case "tools/pre-execute":
        return root.on(event, async (call, context, next) => {
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
        });
      case "tools/post-execute":
        return root.on(event, async (call, _result, context, next) => {
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
        });
      case "agent/step-continuation":
        return root.on(
          event,
          async (agent, _decision, turn, step, signal, next) => {
            const current = await next();
            if (agent.botId !== this.options.botId) return current;
            return this.invokeHook(
              packageId,
              entrypoint,
              event,
              {
                step: this.stepSnapshot(agent, turn, step),
                decision: current,
              },
              current,
              signal,
            );
          },
        );
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
