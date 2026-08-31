// The Bot isolate contribution host: mounts one Composition member's
// content-addressed artifact as a Dynamic Worker and registers the tools its
// wrapper reports.
//
// It sits beside `LocalCordisContributionHost` because it is the *other*
// execution host the constitution names — first-party Packages run in the
// kernel isolate, everything else runs in a loaded Worker with
// `globalOutbound` disabled and only Assignment-derived bindings.
//
// Two behaviours come straight from `docs/research/spike-worker-loader-from-do.md`:
// `.get()` never throws, so mount and `health()` are a single guarded phase;
// and a reused loader id silently serves the first code, so the id is nothing
// but the content address of the module set actually mounted.
import {
  decodeIsolateHealthV1,
  decodeIsolateToolResultV1,
  isolateToolSchemaV1,
  ISOLATE_MAX_DEADLINE_MS,
  isolateLoaderIdV1,
  type BotCapabilitiesStub,
  type BotIsolateEntrypoint,
  type IsolateHealthV1,
  type IsolateToolDescriptorV1,
  type IsolateToolInvocationV1,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolRegistration,
} from "@frockbot/kernel-contracts";
import { CompositionMountFailureError } from "./activation.ts";
import { canonicalJson, sha256 } from "./compiler.ts";
import type { CompositionMemberV1 } from "./generation.ts";
import type {
  ActiveContribution,
  ContributionHost,
  PackageDescriptor,
  PreparedContribution,
} from "./index.ts";
import { decodeFrockBotManifest } from "./manifest.ts";
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
  tools: ToolRegistration;
  userId: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  /**
   * The loopback service binding minted with
   * `ctx.exports.BotCapabilities({ props })`. Opaque to the kernel: it only
   * places it in the isolate's `env`.
   */
  capabilities: BotCapabilitiesStub;
  /**
   * A content address of the Assignment-derived bindings this isolate is
   * loaded with. It belongs in the loader id because a loader id is served
   * from cache: the `env` a Bot isolate was first loaded with is the `env` it
   * keeps, so a change in the Bot's Assignments must produce a new isolate or
   * the isolate would keep answering from a revoked authority.
   */
  bindingDigest?: string;
  compatibilityDate: string;
  limits?: BotIsolateLimits;
  /** Per-invocation deadline; `AbortSignal` cannot cross the RPC boundary. */
  deadlineMs?: number;
  /** Verification deadline: an isolate that never answers `health()` fails closed. */
  healthDeadlineMs?: number;
}

export const BOT_ISOLATE_DEFAULT_LIMITS: BotIsolateLimits = {
  cpuMs: 5_000,
  subRequests: 5,
};

export const BOT_ISOLATE_DEFAULT_DEADLINE_MS = 15_000;
export const BOT_ISOLATE_DEFAULT_HEALTH_DEADLINE_MS = 10_000;

/**
 * The content address of what a Bot isolate mounts: the kernel wrapper text,
 * the Package artifact, and the digest of the Assignment-derived bindings it
 * is loaded with. A change to any of the three is a new isolate.
 */
export async function botIsolateModuleSetHashV1(
  artifactContentHash: string,
  bindingDigest = "",
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
 * A Composition member projected onto the descriptor a contribution host
 * consumes. The durable record keeps the member's `manifestHash`, not its
 * manifest, so the projection carries only what the isolate host reads: the
 * Package identity, its specifier, and its immutable artifact.
 */
export function botIsolatePackageDescriptorV1(
  member: CompositionMemberV1,
): PackageDescriptor {
  return {
    specifier: member.specifier,
    manifest: decodeFrockBotManifest({
      schemaVersion: 3,
      id: member.packageId,
      displayName: member.packageId,
      version: member.version,
      compatibility: { frockbot: `^${member.version}` },
      dependencies: {},
      contributions: { runtime: { entry: "./package.js" } },
      permissions: [],
    }),
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
      botId: this.options.botId,
      artifactSetHash: await botIsolateModuleSetHashV1(
        artifact.contentHash,
        this.options.bindingDigest ?? "",
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

    let disposed = false;
    const registered: (() => void)[] = [];
    return {
      kind: this.kind,
      commit: (): Promise<ActiveContribution> => {
        for (const descriptor of health.tools) {
          registered.push(
            this.options.tools.register(
              this.definition(packageId, entrypoint, descriptor),
            ),
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
