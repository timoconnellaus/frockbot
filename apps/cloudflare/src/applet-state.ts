// The kernel's authority for one Applet instance.
//
// ADR 0022 decision 2: a Durable Object keyed `<userId>:<appletId>` owns an
// Applet's current code generation, its version history, its failures, its
// viewer sessions, its tool routing, and its deletion — and never its contents.
// The contents live in a **facet** mounted from the Applet's own server
// artifact, loaded through the `APPLETS` Worker Loader binding with
// `globalOutbound: null` and an `env` of exactly `IDENTITY` and `CAPABILITIES`.
//
// Four things here come straight from `docs/research/spike-applet-facets.md`
// and are not free to change:
//
//  1. the loader id includes `appletId`, because the loader freezes the first
//     caller's `env` for an id process-wide (§7);
//  2. a facet cannot set an alarm (§5b), so this object owns the alarm, exposes
//     `scheduleAlarm` on `CAPABILITIES`, and persists the mount input on the
//     synchronous key/value surface so `alarm()` can remount after eviction;
//  3. `facets.get` is lazy and synchronous, so mount and `health()` are one
//     guarded phase and a failure re-`get`s the previous class over the same,
//     untouched storage (§3);
//  4. a facet stub is not serializable (§8), so `invokeTool` and `connect`
//     forward through this object. Only the 101 `Response` and its `webSocket`
//     travel.
import { DurableObject, WorkerEntrypoint } from "cloudflare:workers";
import {
  appletFailureKey,
  appletFailurePrefix,
  appletGenerationKey,
  appletBindingDigestV1,
  appletLoaderIdV1,
  appletStateNameV1,
  APPLET_CONTRACT_V1,
  APPLET_CURRENT_KEY,
  APPLET_FACET_NAME_V1,
  APPLET_GENERATION_PREFIX,
  APPLET_LAST_KNOWN_GOOD_KEY,
  APPLET_MAX_GENERATIONS_V1,
  APPLET_MOUNT_INPUT_KEY,
  decodeAppletFailureV1,
  decodeAppletGenerationV1,
  decodeAppletHealthV1,
  decodeAppletMountInputV1,
  decodeAppletPointerV1,
  type AppletFailurePhaseV1,
  type AppletFailureV1,
  type AppletGenerationV1,
  type AppletMountInputV1,
  type AppletPointerV1,
} from "@frockbot/kernel-do";
import { BOT_ISOLATE_COMPATIBILITY_DATE } from "@frockbot/plugin-shell/backend-isolate";
import {
  decodeRpcEnvelopeV1,
  rpcDecodedValue,
  rpcIdentifier,
  rpcInteger,
  rpcJsonSnapshotV1,
  rpcString,
} from "./durable-rpc.js";

/** The two capabilities an Applet facet holds. Nothing else is in `env`. */
export const APPLET_CAPABILITY_NAMES_V1 = [
  "scheduleAlarm",
  "invokeModel",
] as const;

/** Per-invocation ceiling on an Applet facet, mirroring the Bot isolate's. */
export const APPLET_FACET_LIMITS_V1 = { cpuMs: 5_000, subRequests: 10 };
export const APPLET_HEALTH_DEADLINE_MS = 10_000;
export const APPLET_TOOL_DEADLINE_MS = 15_000;
/** Longest alarm an Applet may ask the kernel to hold for it. */
export const APPLET_MAX_ALARM_DELAY_MS = 7 * 24 * 60 * 60_000;

export interface AppletIdentityV1 {
  userId: string;
  appletId: string;
  generationId: string;
}

export interface AppletCapabilitiesPropsV1 {
  userId: string;
  appletId: string;
  /** This object's own `idFromName`, so the capability can call back into it. */
  stateName: string;
}

export interface AppletStateEnv {
  /** Applet server artifacts, loaded with no egress and a two-key `env`. */
  APPLETS: WorkerLoader;
  /** This object's own namespace: the capability entrypoint calls back in. */
  APPLET_STATES: DurableObjectNamespace<AppletState>;
  /** Immutable, content-addressed artifacts: `packages/<hash>.mjs`. */
  APPLICATION_ARTIFACTS: R2Bucket;
}

interface AppletStateExports {
  AppletCapabilities(options: {
    props: AppletCapabilitiesPropsV1;
  }): AppletCapabilities;
}

/** The facet's RPC surface, as this object calls it. Structural, never typed by us. */
interface AppletFacetStub {
  health(): Promise<unknown>;
  invokeTool(name: string, input: unknown): Promise<unknown>;
  onAlarm?(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

export type AppletMountFailureReasonV1 = {
  phase: AppletFailurePhaseV1;
  message: string;
  diagnostics: string[];
};

export type AppletActivationV1 =
  | { status: "active"; generationId: string; tools: string[] }
  | {
      status: "failed";
      generationId: string;
      reason: string;
      diagnostics: string[];
      /** The generation still resident, if any: a failure never unmounts. */
      residentGenerationId?: string;
    };

/** What `read()` answers: the whole visible state of one Applet. */
export interface AppletStateViewV1 {
  schemaVersion: 1;
  appletId: string;
  current?: AppletPointerV1;
  lastKnownGood?: AppletPointerV1;
  generations: AppletGenerationV1[];
  failures: AppletFailureV1[];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The Durable Object half of a deadline: a race the facet cannot escape. */
function raceDeadline<T>(
  work: () => Promise<T>,
  deadlineMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expiry = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Applet call exceeded ${deadlineMs}ms`)),
      deadlineMs,
    );
  });
  return Promise.race([Promise.resolve().then(work), expiry]).finally(() => {
    clearTimeout(timer);
  });
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The `CAPABILITIES` slot of an Applet facet's `env`.
 *
 * A `ctx.exports` loopback `WorkerEntrypoint`, not an `RpcTarget`: the prior
 * loader spike found an `RpcTarget` in `env` is refused with `DataCloneError`.
 * The surface is deliberately two methods. Self-modification never widens
 * authority, and an Applet holds strictly less than a Bot isolate: no
 * Connections, no Memory, no Workspace, no tools, no notifications.
 */
export class AppletCapabilities extends WorkerEntrypoint<
  AppletStateEnv,
  AppletCapabilitiesPropsV1
> {
  /**
   * The workaround for "Facets currently cannot set alarms": the facet asks the
   * kernel object to hold the alarm, and `AppletState.alarm()` remounts and
   * calls the facet's `onAlarm` hook.
   */
  async scheduleAlarm(delayMs: unknown): Promise<{ status: "scheduled" }> {
    if (
      !Number.isSafeInteger(delayMs) ||
      (delayMs as number) < 0 ||
      (delayMs as number) > APPLET_MAX_ALARM_DELAY_MS
    ) {
      throw new Error("Applet alarm delay is out of range");
    }
    await this.env.APPLET_STATES.get(
      this.env.APPLET_STATES.idFromName(this.ctx.props.stateName),
    ).holdAlarmForFacet({
      schemaVersion: 1,
      delayMs: delayMs as number,
    });
    return { status: "scheduled" };
  }

  /**
   * Model access for an Applet.
   *
   * TODO(model access): the kernel's model resolution is Bot-scoped today — a
   * binding is admitted onto one Bot's Composition generation and leased
   * against that Bot's Connections (`plugin-shell/src/backend-isolate.ts`).
   * An Applet is account-wide and holds no Bot, so there is no admitted binding
   * to resolve against, and inventing one would widen authority. Until the
   * User-level model binding of the Applets plan exists this answers
   * `unavailable`, which is a declared outcome the SDK already handles rather
   * than an exception a Bot author has to catch.
   */
  invokeModel(): Promise<{ status: "unavailable"; reason: string }> {
    return Promise.resolve({
      status: "unavailable",
      reason: "no-bot-context",
    });
  }
}

export class AppletState extends DurableObject<AppletStateEnv> {
  /**
   * The identity this object was addressed under, pinned on first use. An
   * Applet Durable Object answers for exactly one `<userId>:<appletId>`.
   */
  #assertIdentity(userId: string, appletId: string): void {
    const expected = appletStateNameV1(userId, appletId);
    const id = this.env.APPLET_STATES.idFromName(expected);
    if (!id.equals(this.ctx.id)) {
      throw new Error(
        "this Applet Durable Object is the authority for a different Applet",
      );
    }
  }

  // --- mount ---------------------------------------------------------------

  async #load(input: AppletMountInputV1): Promise<WorkerStub> {
    const source = await this.#artifact(input.serverHash);
    const exports = this.ctx.exports as unknown as AppletStateExports;
    const stateName = appletStateNameV1(input.userId, input.appletId);
    return this.env.APPLETS.get(input.loaderId, () =>
      Promise.resolve({
        compatibilityDate: BOT_ISOLATE_COMPATIBILITY_DATE,
        mainModule: "server.js",
        modules: { "server.js": { js: source } },
        // The constitution's rule made mechanical: no network except bindings.
        globalOutbound: null,
        env: {
          IDENTITY: {
            userId: input.userId,
            appletId: input.appletId,
            generationId: input.generationId,
          } satisfies AppletIdentityV1,
          CAPABILITIES: exports.AppletCapabilities({
            props: {
              userId: input.userId,
              appletId: input.appletId,
              stateName,
            },
          }),
        },
        limits: APPLET_FACET_LIMITS_V1,
      }),
    );
  }

  /** Hash-verified read. Mismatched bytes never become code. */
  async #artifact(contentHash: string): Promise<string> {
    const object = await this.env.APPLICATION_ARTIFACTS.get(
      `packages/${contentHash}.mjs`,
    );
    if (!object) {
      throw new Error(`Applet artifact "${contentHash}" is unavailable`);
    }
    const source = await object.text();
    if ((await sha256Hex(source)) !== contentHash) {
      throw new Error(
        `Applet artifact "${contentHash}" failed hash verification`,
      );
    }
    return source;
  }

  /**
   * Mount the facet for one generation. `facets.get` is synchronous and lazy —
   * the loaded code's failures surface on the first RPC — so the caller keeps
   * this inside the same try/catch as `health()`.
   */
  async #facet(input: AppletMountInputV1): Promise<AppletFacetStub> {
    const stub = await this.#load(input);
    // The mount input is durable before the facet is used, so `alarm()` can
    // remount after an eviction that lost every in-memory field.
    this.ctx.storage.kv.put(APPLET_MOUNT_INPUT_KEY, input);
    return this.ctx.facets.get(APPLET_FACET_NAME_V1, () => ({
      class: stub.getDurableObjectClass(
        "Applet",
      ) as DurableObjectClass<undefined>,
      id: APPLET_FACET_NAME_V1,
    })) as unknown as AppletFacetStub;
  }

  /** The mount input for the currently resident generation, if any. */
  #residentMountInput(): AppletMountInputV1 | undefined {
    const stored = this.ctx.storage.kv.get<unknown>(APPLET_MOUNT_INPUT_KEY);
    if (stored === undefined) return undefined;
    try {
      return decodeAppletMountInputV1(stored);
    } catch {
      return undefined;
    }
  }

  /**
   * The digest of what this object hands its facet. Computed here and nowhere
   * else: the object is the authority for the bindings in its facet's `env`,
   * so a caller cannot name a digest for bindings it does not grant.
   */
  #bindingDigest(userId: string): Promise<string> {
    return appletBindingDigestV1({
      userId,
      capabilities: APPLET_CAPABILITY_NAMES_V1,
      contract: APPLET_CONTRACT_V1,
    });
  }

  async #mountInputFor(
    generation: AppletGenerationV1,
    userId: string,
    appletId: string,
  ): Promise<AppletMountInputV1> {
    const bindingDigest = await this.#bindingDigest(userId);
    return decodeAppletMountInputV1({
      schemaVersion: 1,
      userId,
      appletId,
      generationId: generation.generationId,
      loaderId: await appletLoaderIdV1({
        contract: APPLET_CONTRACT_V1,
        appletId,
        serverHash: generation.server.contentHash,
        bindingDigest,
      }),
      serverHash: generation.server.contentHash,
      contract: 1,
    });
  }

  /**
   * The guarded phase: abort the resident facet, mount the candidate, and ask
   * it `health()`. A failure re-`get`s the previous class over the same,
   * untouched storage, so a broken publish leaves the prior Applet resident and
   * working — the constitution's "a generation whose health check fails leaves
   * the prior facet resident".
   */
  async #activate(
    input: AppletMountInputV1,
    declaredTools: readonly string[],
  ): Promise<
    | { status: "active"; tools: string[] }
    | { status: "failed"; failure: AppletMountFailureReasonV1 }
  > {
    const resident = this.#residentMountInput();
    try {
      if (resident) {
        this.ctx.facets.abort(
          APPLET_FACET_NAME_V1,
          new Error(`remounting generation "${input.generationId}"`),
        );
      }
      const facet = await this.#facet(input);
      const health = decodeAppletHealthV1(
        await raceDeadline(() => facet.health(), APPLET_HEALTH_DEADLINE_MS),
        "Applet health",
      );
      const declared = [...declaredTools].toSorted();
      const reported = [...health.tools].toSorted();
      if (
        declared.length !== reported.length ||
        declared.some((name, index) => name !== reported[index])
      ) {
        throw new AppletHealthMismatchError(
          `Applet "${input.appletId}" reported tools that do not match its manifest`,
          [`declared:${declared.join(",")}`, `reported:${reported.join(",")}`],
        );
      }
      return { status: "active", tools: reported };
    } catch (error) {
      // Fail closed onto the previous generation, over the same storage.
      if (resident && resident.generationId !== input.generationId) {
        try {
          this.ctx.facets.abort(
            APPLET_FACET_NAME_V1,
            new Error("restoring the previous Applet generation"),
          );
          await this.#facet(resident);
        } catch {
          // The previous generation is itself unmountable. The failure record
          // below is still written; the Applet is visibly broken, not silently.
          this.ctx.storage.kv.delete(APPLET_MOUNT_INPUT_KEY);
        }
      } else if (!resident) {
        this.ctx.storage.kv.delete(APPLET_MOUNT_INPUT_KEY);
      }
      return {
        status: "failed",
        failure: {
          phase:
            error instanceof AppletHealthMismatchError
              ? "health"
              : errorMessage(error).includes("artifact")
                ? "resolve"
                : "mount",
          message: errorMessage(error).slice(0, 2_048),
          diagnostics:
            error instanceof AppletHealthMismatchError
              ? error.diagnostics
              : [`loader:${input.loaderId}`],
        },
      };
    }
  }

  // --- durable records -----------------------------------------------------

  async #recordFailure(
    appletId: string,
    generationId: string,
    failure: AppletMountFailureReasonV1,
    now: string,
  ): Promise<void> {
    const existing = await this.ctx.storage.list<unknown>({
      prefix: appletFailurePrefix(generationId),
    });
    await this.ctx.storage.put(
      appletFailureKey(generationId, existing.size + 1),
      decodeAppletFailureV1({
        schemaVersion: 1,
        appletId,
        generationId,
        attempt: existing.size + 1,
        phase: failure.phase,
        message: failure.message,
        diagnostics: failure.diagnostics,
        recordedAt: now,
      }),
    );
  }

  async #pointer(key: string): Promise<AppletPointerV1 | undefined> {
    const stored = await this.ctx.storage.get<unknown>(key);
    return stored === undefined ? undefined : decodeAppletPointerV1(stored);
  }

  async #generation(
    generationId: string,
  ): Promise<AppletGenerationV1 | undefined> {
    const stored = await this.ctx.storage.get<unknown>(
      appletGenerationKey(generationId),
    );
    return stored === undefined ? undefined : decodeAppletGenerationV1(stored);
  }

  async #listGenerations(): Promise<AppletGenerationV1[]> {
    const stored = await this.ctx.storage.list<unknown>({
      prefix: APPLET_GENERATION_PREFIX,
    });
    return [...stored.values()].map((value) => decodeAppletGenerationV1(value));
  }

  async #writeGeneration(generation: AppletGenerationV1): Promise<void> {
    await this.ctx.storage.put(
      appletGenerationKey(generation.generationId),
      generation,
    );
  }

  /** Retained generations are bounded; the oldest superseded ones go first. */
  async #pruneGenerations(keep: ReadonlySet<string>): Promise<void> {
    const generations = await this.#listGenerations();
    if (generations.length <= APPLET_MAX_GENERATIONS_V1) return;
    const removable = generations
      .filter((generation) => !keep.has(generation.generationId))
      .sort((left, right) =>
        left.generationId.localeCompare(right.generationId),
      );
    const excess = generations.length - APPLET_MAX_GENERATIONS_V1;
    await this.ctx.storage.delete(
      removable
        .slice(0, excess)
        .map((generation) => appletGenerationKey(generation.generationId)),
    );
  }

  // --- RPC -----------------------------------------------------------------

  /**
   * Publish one generation: record it `pending`, mount it, health-check it, and
   * on success make it current, supersede the previous, and set last-known-good.
   * A failure records a durable failure, marks the generation `failed`, and
   * leaves the prior facet resident.
   */
  async publish(input: unknown): Promise<AppletActivationV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      appletId: rpcString(129),
      generation: rpcDecodedValue,
    });
    return this.#activateGeneration({
      userId: request.userId as string,
      appletId: request.appletId as string,
      generation: decodeAppletGenerationV1(
        rpcJsonSnapshotV1(request.generation),
      ),
      setLastKnownGood: true,
    });
  }

  /**
   * Revert to an already-recorded generation. The same mount path, recorded as
   * its own generation with `origin: "revert"` by the caller — and it never
   * sets last-known-good, because a revert is a pointer move and not evidence
   * that anything newly works.
   */
  async revert(input: unknown): Promise<AppletActivationV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      appletId: rpcString(129),
      generation: rpcDecodedValue,
    });
    return this.#activateGeneration({
      userId: request.userId as string,
      appletId: request.appletId as string,
      generation: decodeAppletGenerationV1(
        rpcJsonSnapshotV1(request.generation),
      ),
      setLastKnownGood: false,
    });
  }

  async #activateGeneration(input: {
    userId: string;
    appletId: string;
    generation: AppletGenerationV1;
    setLastKnownGood: boolean;
  }): Promise<AppletActivationV1> {
    this.#assertIdentity(input.userId, input.appletId);
    const now = new Date().toISOString();
    const generationId = input.generation.generationId;
    // Intent first: the record exists before the artifact is loaded, so an
    // interrupted publish is visible rather than invisible.
    await this.#writeGeneration({ ...input.generation, status: "pending" });
    const mountInput = await this.#mountInputFor(
      input.generation,
      input.userId,
      input.appletId,
    );
    const previous = await this.#pointer(APPLET_CURRENT_KEY);
    const outcome = await this.#activate(
      mountInput,
      input.generation.tools.map((tool) => tool.name),
    );
    if (outcome.status === "failed") {
      await this.#writeGeneration({ ...input.generation, status: "failed" });
      await this.#recordFailure(
        input.appletId,
        generationId,
        outcome.failure,
        now,
      );
      return {
        status: "failed",
        generationId,
        reason: outcome.failure.message,
        diagnostics: outcome.failure.diagnostics,
        ...(previous ? { residentGenerationId: previous.generationId } : {}),
      };
    }
    await this.#writeGeneration({ ...input.generation, status: "active" });
    if (previous && previous.generationId !== generationId) {
      const superseded = await this.#generation(previous.generationId);
      if (superseded && superseded.status === "active") {
        await this.#writeGeneration({ ...superseded, status: "superseded" });
      }
    }
    const pointer: AppletPointerV1 = {
      schemaVersion: 1,
      generationId,
      changedAt: now,
    };
    await this.ctx.storage.put({
      [APPLET_CURRENT_KEY]: pointer,
      ...(input.setLastKnownGood
        ? { [APPLET_LAST_KNOWN_GOOD_KEY]: pointer }
        : {}),
    });
    const lastKnownGood = await this.#pointer(APPLET_LAST_KNOWN_GOOD_KEY);
    await this.#pruneGenerations(
      new Set(
        [generationId, lastKnownGood?.generationId].filter(
          (value): value is string => typeof value === "string",
        ),
      ),
    );
    return { status: "active", generationId, tools: outcome.tools };
  }

  /**
   * Route one Applet tool call to the facet. The facet stub never leaves this
   * object (`DOMDataCloneError: Stubs pointing to Durable Object facets are not
   * serializable`), and the call is bounded exactly like an isolate tool's.
   */
  async invokeTool(input: unknown): Promise<{
    status: "ok" | "error";
    content: string;
  }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      appletId: rpcString(129),
      tool: rpcString(64),
      toolInput: rpcDecodedValue,
    });
    this.#assertIdentity(request.userId as string, request.appletId as string);
    const resident = this.#residentMountInput();
    if (!resident) {
      return {
        status: "error",
        content: `Applet "${request.appletId}" has no active generation`,
      };
    }
    try {
      const facet = await this.#facet(resident);
      const result = await raceDeadline(
        () =>
          facet.invokeTool(
            request.tool as string,
            rpcJsonSnapshotV1(request.toolInput ?? null),
          ),
        APPLET_TOOL_DEADLINE_MS,
      );
      return {
        status: "ok",
        content:
          typeof result === "string"
            ? result.slice(0, 32_000)
            : JSON.stringify(rpcJsonSnapshotV1(result)).slice(0, 32_000),
      };
    } catch (error) {
      return {
        status: "error",
        content: `Applet tool "${request.tool}" failed: ${errorMessage(error)}`,
      };
    }
  }

  /**
   * Forward one verified viewer's WebSocket upgrade into the facet, which does
   * the ordinary hibernation dance. The 101 response and its `webSocket` are
   * the one thing that travels back out through this object.
   */
  /**
   * The object's one HTTP door, and it exists for the socket alone. A 101
   * response carrying a WebSocket travels only over `fetch`; an RPC method
   * returning it does not survive the stub boundary. Everything else on this
   * object is an RPC method.
   */
  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (/^\/api\/applets\/[^/]+\/socket$/.test(url.pathname)) {
      return this.connectViewer(request);
    }
    return new Response("not found", { status: 404 });
  }

  async connectViewer(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const userId = url.searchParams.get("u") ?? "";
    const appletId = url.searchParams.get("a") ?? "";
    try {
      this.#assertIdentity(userId, appletId);
    } catch {
      return new Response("forbidden", { status: 403 });
    }
    const resident = this.#residentMountInput();
    if (!resident) {
      return new Response("this Applet has no active generation", {
        status: 409,
      });
    }
    if (resident.generationId !== (url.searchParams.get("g") ?? "")) {
      // The token names one generation; a publish has moved past it, so the
      // page reloads with a fresh token rather than talking to new code under
      // an old claim.
      return new Response("this Applet has a newer generation", {
        status: 409,
      });
    }
    try {
      const facet = await this.#facet(resident);
      return await facet.fetch(request);
    } catch (error) {
      return new Response(errorMessage(error), { status: 502 });
    }
  }

  /** Called back by `AppletCapabilities` on the facet's behalf. */
  async holdAlarmForFacet(input: unknown): Promise<void> {
    const request = decodeRpcEnvelopeV1(input, {
      delayMs: rpcInteger({ minimum: 0, maximum: APPLET_MAX_ALARM_DELAY_MS }),
    });
    await this.ctx.storage.setAlarm(Date.now() + (request.delayMs as number));
  }

  /**
   * The kernel object owns the alarm and delivers the tick. The mount input is
   * read from durable key/value, so this works after an eviction.
   */
  async alarm(): Promise<void> {
    const resident = this.#residentMountInput();
    if (!resident) return;
    try {
      const facet = await this.#facet(resident);
      await raceDeadline(
        () => facet.onAlarm?.() ?? Promise.resolve(),
        APPLET_TOOL_DEADLINE_MS,
      );
    } catch (error) {
      await this.#recordFailure(
        resident.appletId,
        resident.generationId,
        {
          phase: "mount",
          message: `Applet alarm failed: ${errorMessage(error)}`.slice(
            0,
            2_048,
          ),
          diagnostics: [`loader:${resident.loaderId}`],
        },
        new Date().toISOString(),
      );
    }
  }

  /**
   * Delete the Applet: the facet and all of its storage, this object's own
   * records, and the alarm. Artifacts are immutable content and stay — they are
   * addressed by hash, hold no authority, and other generations may name them.
   */
  async delete(input: unknown): Promise<{ status: "deleted" }> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      appletId: rpcString(129),
    });
    this.#assertIdentity(request.userId as string, request.appletId as string);
    this.ctx.facets.delete(APPLET_FACET_NAME_V1);
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    return { status: "deleted" };
  }

  /** The whole visible state: current, last-known-good, history, failures. */
  async read(input: unknown): Promise<AppletStateViewV1> {
    const request = decodeRpcEnvelopeV1(input, {
      userId: rpcIdentifier,
      appletId: rpcString(129),
    });
    this.#assertIdentity(request.userId as string, request.appletId as string);
    const failures = await this.ctx.storage.list<unknown>({
      prefix: "applet:failure:",
    });
    const current = await this.#pointer(APPLET_CURRENT_KEY);
    const lastKnownGood = await this.#pointer(APPLET_LAST_KNOWN_GOOD_KEY);
    return {
      schemaVersion: 1,
      appletId: request.appletId as string,
      ...(current ? { current } : {}),
      ...(lastKnownGood ? { lastKnownGood } : {}),
      generations: (await this.#listGenerations()).sort((left, right) =>
        left.generationId.localeCompare(right.generationId),
      ),
      failures: [...failures.values()].map((value) =>
        decodeAppletFailureV1(value),
      ),
    };
  }
}

/** A health answer that contradicts the manifest. Its own class so the phase is exact. */
class AppletHealthMismatchError extends Error {
  override readonly name = "AppletHealthMismatchError";
  readonly diagnostics: string[];
  constructor(message: string, diagnostics: string[]) {
    super(message);
    this.diagnostics = diagnostics;
  }
}
