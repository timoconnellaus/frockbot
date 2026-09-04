import { exports as workerExports } from "cloudflare:workers";
import { grantStubs } from "./registry";
import {
  facetWrapperEntrypoint,
  facetWrapperSource,
  pluginModule,
  wrapperEntrypoint,
  wrapperModule,
  wrapperSource,
} from "./wrapper";
import { dispatchStubCall, registerStubReentry } from "./loopback";
import { aiAnswerText } from "./ai-answer";
import { performHttpGrant } from "./http";
import type {
  AiTextInput,
  FilesOperation,
  HttpServices,
  ScheduleOperation,
} from "@frockbot/compose-core/grants";
import type {
  Host,
  HostInstance,
  HostStartRequest,
  SourceError,
} from "@frockbot/compose-core";
import type { StubAnswer, StubProps, StubReentry } from "./loopback";
import type { WrapperResult } from "./wrapper";

/** The platform limits every Dynamic Worker this host loads is held to. */
export interface CloudflareLimits {
  /** CPU milliseconds per invocation. */
  cpuMs?: number;
  /** Outgoing requests per invocation; a stub call is one of them. */
  subRequests?: number;
}

/** The small Workers AI binding surface used by the `ai` grant. */
export interface TextAiBinding {
  run: (
    model: string,
    input: {
      messages: Array<{ role: "system" | "user"; content: string }>;
    },
  ) => Promise<unknown>;
}

/** How a client is given a Cloudflare host. */
export interface CloudflareHostOptions {
  /**
   * The Worker Loader binding from the loader Worker's `env`, declared as
   * `worker_loaders` in its Wrangler config.
   */
  loader: WorkerLoader;
  /** The compatibility date every loaded Dynamic Worker runs under. */
  compatibilityDate: string;
  /** Compatibility flags for every loaded Dynamic Worker. */
  compatibilityFlags?: ReadonlyArray<string>;
  /**
   * Platform limits set on every load. Defaults to
   * `{ cpuMs: 200, subRequests: 50 }`.
   */
  limits?: CloudflareLimits;
  /**
   * The client-side wall-clock limit on every `setup`, `call` and `stop`,
   * independent of anything the platform enforces. Defaults to 5000.
   */
  callTimeoutMs?: number;
  /** The name entries use to ask for this host. Defaults to `cloudflare`. */
  name?: string;
  /**
   * Which host a loopback belongs to. Defaults to the host's name; give two
   * hosts in one loader Worker distinct ids.
   */
  hostId?: string;
  /** Base-owned names, origins and credentials available through `http`. */
  services?: HttpServices;
  /** Optional service bindings keyed by the same HTTP service names. */
  serviceBindings?: Readonly<Record<string, Fetcher>>;
  /** Wall-clock deadline for an HTTP grant call. Defaults to 5000 ms. */
  httpTimeoutMs?: number;
  /** Maximum HTTP response body size. Defaults to 1 MiB. */
  httpResponseMaxBytes?: number;
  /** The Worker's `AI` binding used by `ai.text`. */
  ai?: TextAiBinding;
  /** The Worker's R2 bucket used by `files`. */
  files?: R2Bucket;
}

/** Options for a Dynamic Worker mounted as a facet of the current DO. */
export interface FacetHostOptions extends CloudflareHostOptions {
  /** The Durable Object state whose isolated facets hold plugin instances. */
  ctx: DurableObjectState;
  /**
   * Mint an RPC stub for the Durable Object that owns {@link ctx}. Called per
   * use: a stub is bound to the request that created it, and the schedule
   * loopback runs in the facet's request, not the object's.
   */
  self: () => DurableObjectStub;
}

const defaultLimits: Required<CloudflareLimits> = {
  cpuMs: 200,
  subRequests: 50,
};

/** The wrapper's entrypoint, as the client calls it. */
interface WrapperStub {
  setup: () => Promise<WrapperResult>;
  call: (name: string, input: unknown) => Promise<WrapperResult>;
  stop: () => Promise<WrapperResult>;
}

type FacetWrapperStub = Pick<WrapperStub, "setup" | "call">;

/** A facet host whose parent Durable Object forwards its alarm event. */
export interface FacetHost extends Host {
  /** Call only from inside the object: dispatch one re-entered loopback call. */
  stubCall: (props: StubProps, input: unknown) => Promise<StubAnswer>;
  /** Call only from inside the object: apply one facet schedule operation. */
  schedule: (operation: unknown) => Promise<void>;
  /** Call only from inside the object: dispatch every due facet schedule. */
  alarm: () => Promise<void>;
}

interface FacetSchedule {
  at: number;
  handler: string;
  every?: number;
}

const schedulePrefix = "\0compose:schedule:";

const textModel = "@cf/zai-org/glm-5.3-flash" as const;

const string = (value: unknown, what: string): string => {
  if (typeof value !== "string") {
    throw new Error(`@frockbot/compose-cloudflare: ${what} must be a string`);
  }
  return value;
};

const aiText = async (binding: TextAiBinding | undefined, value: unknown) => {
  if (!binding) {
    throw new Error(
      "@frockbot/compose-cloudflare: the ai grant needs an AI binding",
    );
  }
  const call = value as { method?: unknown; args?: Array<unknown> } | null;
  if (call?.method !== "text") {
    throw new Error("@frockbot/compose-cloudflare: unknown ai operation");
  }
  const input = call.args?.[0] as AiTextInput | null;
  if (typeof input?.prompt !== "string") {
    throw new Error("@frockbot/compose-cloudflare: ai.text needs a prompt");
  }
  if (input.system !== undefined && typeof input.system !== "string") {
    throw new Error(
      "@frockbot/compose-cloudflare: ai.text system must be a string",
    );
  }
  const answer = await binding.run(textModel, {
    messages: [
      ...(input.system === undefined
        ? []
        : [{ role: "system" as const, content: input.system }]),
      { role: "user" as const, content: input.prompt },
    ],
  });
  const text = aiAnswerText(answer);
  if (text === undefined) {
    throw new Error(
      "@frockbot/compose-cloudflare: the AI binding returned no text",
    );
  }
  return text;
};

const fileKey = (instanceId: string, value: unknown) =>
  `${instanceId}/${string(value, "file key")}`;

const filesCall = async (
  bucket: R2Bucket | undefined,
  instanceId: string,
  value: unknown,
): Promise<unknown> => {
  if (!bucket) {
    throw new Error(
      "@frockbot/compose-cloudflare: the files grant needs an R2 binding",
    );
  }
  const input = value as FilesOperation | null;
  if (input?.method === "put") {
    const [key, body, options] = input.args;
    const contentType = (options as { contentType?: unknown } | undefined)
      ?.contentType;
    if (contentType !== undefined && typeof contentType !== "string") {
      throw new Error(
        "@frockbot/compose-cloudflare: file contentType must be a string",
      );
    }
    await bucket.put(fileKey(instanceId, key), body as ArrayBuffer, {
      ...(contentType === undefined ? {} : { httpMetadata: { contentType } }),
    });
    return undefined;
  }
  if (input?.method === "get") {
    const found = await bucket.get(fileKey(instanceId, input.args[0]));
    if (!found) return undefined;
    return {
      body: await found.arrayBuffer(),
      ...(found.httpMetadata?.contentType === undefined
        ? {}
        : { contentType: found.httpMetadata.contentType }),
    };
  }
  if (input?.method === "delete") {
    await bucket.delete(fileKey(instanceId, input.args[0]));
    return undefined;
  }
  if (input?.method === "list") {
    const instancePrefix = `${instanceId}/`;
    const prefix = fileKey(instanceId, input.args[0] ?? "");
    const names: Array<string> = [];
    let cursor: string | undefined;
    do {
      const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
      names.push(
        ...page.objects.map((object) =>
          object.key.slice(instancePrefix.length),
        ),
      );
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor);
    return names;
  }
  throw new Error("@frockbot/compose-cloudflare: unknown files operation");
};

const deleteFiles = async (
  bucket: R2Bucket | undefined,
  instanceId: string,
): Promise<void> => {
  if (!bucket) return;
  const prefix = `${instanceId}/`;
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, ...(cursor ? { cursor } : {}) });
    if (page.objects.length) {
      await bucket.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
};

/** The loader Worker's own exports, once it re-exports the loopback. */
interface LoopbackExports {
  ComposeStubLoopback: (options: { props: StubProps }) => Fetcher;
}

/**
 * Build the error the client reports for a failure inside a child isolate, in
 * the shape `sourceErrorOf` reads. A child reports a message and, for anything
 * it raises while running, no frame of its own source — so `line` and `column`
 * are attached only where the runtime named the written module itself, and are
 * absent rather than wrong everywhere else.
 */
function sourceFailure(
  phase: SourceError["phase"],
  message: string,
  at?: { line: number; column: number },
): Error {
  const error = new Error(
    `@frockbot/compose-cloudflare: ${phase} failed \u2014 ${message}`,
  );
  const detail: SourceError = {
    type: "compose/source-error",
    phase,
    message,
    ...(at ?? {}),
  };
  return Object.assign(error, { source: detail });
}

/** The wall-clock limit, distinguishable from anything the isolate said. */
class TimedOut extends Error {}

/**
 * What the runtime says when the Dynamic Worker will not start at all: the
 * written module did not parse, and the whole load failed before the wrapper
 * could run and name the phase itself.
 */
const startupFailure = /^Failed to start Worker:\s*/;

/** The one place a child names a line of the written module. */
const atPluginModule = new RegExp(
  `\\n?\\s*at ${pluginModule.replace(".", "\\.")}:(\\d+):(\\d+)`,
);

/** Read a load-time rejection as the phase, message and place it belongs to. */
function readStartupFailure(cause: unknown): Error {
  const raw = String((cause as { message?: unknown } | null)?.message ?? cause);
  const place = atPluginModule.exec(raw);
  const message = raw
    .replace(startupFailure, "")
    .replace(atPluginModule, "")
    .replace(/^Uncaught /, "")
    .trim();
  const at = place
    ? { line: Number(place[1]), column: Number(place[2]) }
    : undefined;
  return sourceFailure(
    /SyntaxError/.test(message) ? "parse" : "load",
    message,
    at,
  );
}

/** Lowercase hex of the SHA-256 of `text`. */
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The id the isolate is cached under: the instance it belongs to, and a hash of
 * everything that decides what the isolate would do. Re-adding an unchanged
 * plugin lands on the same isolate; changing anything lands on a new one (D2).
 */
async function isolateId(
  request: HostStartRequest,
  hostId: string,
): Promise<string> {
  const grants = JSON.stringify(
    Object.entries(request.stubs)
      .map(([name, stub]) => [name, stub.methods ? [...stub.methods] : null])
      .sort(),
  );
  const content = `${hostId}\0${request.code}\0${JSON.stringify(request.options ?? null)}\0${grants}`;
  return `${request.instanceId}:${await sha256(content)}`;
}

/** The error a wall-clock limit produces, naming the limit that was hit. */
const timedOut = (what: string, ms: number) =>
  new TimedOut(
    `@frockbot/compose-cloudflare: ${what} exceeded the ${ms}ms callTimeoutMs wall-clock limit`,
  );

/**
 * A host that runs written plugins in Cloudflare Dynamic Workers. Create it in
 * the loader Worker, where the client and the kernel run, and hand it the
 * Worker Loader binding.
 *
 * @example
 * ```ts
 * const client = createClient({
 *   plugins: [{ id: 'greeter', source, host: 'cloudflare', stubs: [logStub] }],
 *   hosts: {
 *     cloudflare: createCloudflareHost({
 *       loader: env.LOADER,
 *       compatibilityDate: '2026-05-01',
 *     }),
 *   },
 * })
 * ```
 */
export function createCloudflareHost(options: CloudflareHostOptions): Host {
  const name = options.name ?? "cloudflare";
  const hostId = options.hostId ?? name;
  const timeoutMs = options.callTimeoutMs ?? 5000;
  const limits = { ...defaultLimits, ...options.limits };

  /** Reject once the wall clock says so, whatever the platform is doing. */
  const within = async <T>(what: string, work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            reject(timedOut(what, timeoutMs));
          }, timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  /** Turn one wrapper answer into a value or the client's error. */
  const unwrap = (result: WrapperResult): unknown => {
    if (result.ok) return result.value;
    throw sourceFailure(result.phase ?? "call", result.message ?? "unknown");
  };

  return {
    name,
    async start(request: HostStartRequest): Promise<HostInstance> {
      const stubNames = Object.keys(request.stubs);
      const stubMethods = Object.fromEntries(
        Object.entries(request.stubs).flatMap(([stub, value]) =>
          value.methods ? [[stub, value.methods] as const] : [],
        ),
      );
      const registered = { ...request.stubs };
      const through = async (
        stubName: string,
        input: unknown,
        run: (approved: unknown) => Promise<unknown>,
      ): Promise<unknown> => {
        const approved = await request.stubs[stubName]!(input);
        return await run(approved);
      };
      if ("http" in request.stubs) {
        registered.http = (input: unknown) =>
          through("http", input, (approved) =>
            performHttpGrant(
              {
                services: options.services ?? {},
                bindings: options.serviceBindings,
                timeoutMs: options.httpTimeoutMs,
                maxResponseBytes: options.httpResponseMaxBytes,
              },
              approved,
            ),
          );
      }
      if ("ai" in request.stubs) {
        registered.ai = (input: unknown) =>
          through("ai", input, (approved) => aiText(options.ai, approved));
      }
      if ("files" in request.stubs) {
        registered.files = (input: unknown) =>
          through("files", input, (approved) =>
            filesCall(options.files, request.instanceId, approved),
          );
      }
      const revoke = grantStubs(hostId, request.instanceId, registered);

      const env: Record<string, unknown> = {};
      for (const stub of stubNames) {
        const props: StubProps = {
          hostId,
          instanceId: request.instanceId,
          stub,
        };
        env[stub] = (
          workerExports as unknown as LoopbackExports
        ).ComposeStubLoopback({ props });
      }

      const worker = options.loader.get(
        await isolateId(request, hostId),
        () => ({
          compatibilityDate: options.compatibilityDate,
          ...(options.compatibilityFlags
            ? { compatibilityFlags: [...options.compatibilityFlags] }
            : {}),
          mainModule: wrapperModule,
          modules: {
            [wrapperModule]: wrapperSource(stubNames, stubMethods),
            [pluginModule]: request.code,
          },
          env,
          // Never configurable: a written plugin reaches the outside world
          // through a stub it was granted or not at all (D1).
          globalOutbound: null,
          limits,
        }),
      );

      // One token per start, not per isolate: a warm isolate serves a restart
      // of the same instance, and the restart must run setup again.
      const entrypoint = worker.getEntrypoint(wrapperEntrypoint, {
        props: {
          run: crypto.randomUUID(),
          instanceId: request.instanceId,
          options: request.options,
        },
        limits,
      }) as unknown as WrapperStub;

      /**
       * Ask the wrapper, and read a rejection as a failure to load: the wrapper
       * answers with an envelope for anything it can see, so a rejection means
       * the isolate never got as far as running it.
       */
      const ask = async (
        what: string,
        work: Promise<WrapperResult>,
      ): Promise<unknown> => {
        let answer: WrapperResult;
        try {
          answer = await within(what, work);
        } catch (error) {
          if (error instanceof TimedOut) throw error;
          throw readStartupFailure(error);
        }
        return unwrap(answer);
      };

      let stopped = false;
      try {
        await ask("setup", entrypoint.setup());
      } catch (error) {
        stopped = true;
        revoke();
        if ("files" in request.stubs) {
          await deleteFiles(options.files, request.instanceId);
        }
        throw error;
      }

      const hosted: HostInstance = {
        async call(handler: string, input: unknown): Promise<unknown> {
          if (stopped) {
            throw new Error(
              `@frockbot/compose-cloudflare: instance "${request.instanceId}" has stopped`,
            );
          }
          return await ask(
            `call "${handler}"`,
            entrypoint.call(handler, input),
          );
        },
        async stop(): Promise<void> {
          if (stopped) return;
          stopped = true;
          // Revoke before stopping, so nothing the module's cleanup does can
          // still reach the client — the same order an aborted isolate imposes.
          revoke();
          try {
            await ask("stop", entrypoint.stop());
          } catch {
            // The isolate is being let go either way; a stop that times out or
            // rejects must not hold up the removal that asked for it.
          }
        },
      };
      hosted.destroy = () => deleteFiles(options.files, request.instanceId);
      return hosted;
    },
  };
}

/**
 * Run each written plugin as a Durable Object facet named by its instance id.
 * Aborting a facet stops its code but retains storage; deleting it destroys the
 * storage and is exposed separately to the kernel.
 */
export function createFacetHost(options: FacetHostOptions): FacetHost {
  const name = options.name ?? "cloudflare";
  const hostId = options.hostId ?? name;
  registerStubReentry(hostId, () => options.self() as unknown as StubReentry);
  const timeoutMs = options.callTimeoutMs ?? 5000;
  const limits = { ...defaultLimits, ...options.limits };
  const instances = new Map<
    string,
    { call: (handler: string, input: unknown) => Promise<unknown> }
  >();

  const scheduleKey = (instanceId: string) => `${schedulePrefix}${instanceId}`;

  const schedules = () =>
    options.ctx.storage.list<FacetSchedule>({ prefix: schedulePrefix });

  const rearm = async (): Promise<void> => {
    const values = await schedules();
    let next = Number.POSITIVE_INFINITY;
    for (const schedule of values.values()) {
      if (schedule.at < next) next = schedule.at;
    }
    if (Number.isFinite(next)) await options.ctx.storage.setAlarm(next);
    else await options.ctx.storage.deleteAlarm();
  };

  const changeSchedule = async (
    instanceId: string,
    input: unknown,
  ): Promise<void> => {
    const call = input as ScheduleOperation | null;
    if (call?.method === "cancel") {
      await options.ctx.storage.delete(scheduleKey(instanceId));
      await rearm();
      return;
    }

    let at: unknown;
    let every: number | undefined;
    const handler =
      call?.method === "at" || call?.method === "every"
        ? call.args[1]
        : undefined;
    if (call?.method === "every") {
      const ms = call.args[0];
      if (typeof ms !== "number" || !Number.isFinite(ms) || ms <= 0) {
        throw new Error("@frockbot/compose-core: interval must be >0");
      }
      every = ms;
      at = Date.now() + ms;
    } else if (call?.method === "at") {
      const when = call.args[0];
      at = when instanceof Date ? when.getTime() : when;
    }
    if (
      typeof at !== "number" ||
      !Number.isFinite(at) ||
      typeof handler !== "string" ||
      handler === ""
    ) {
      throw new Error(
        "@frockbot/compose-core: schedule needs a time and named export",
      );
    }
    await options.ctx.storage.put(scheduleKey(instanceId), {
      at,
      handler,
      ...(every === undefined ? {} : { every }),
    } satisfies FacetSchedule);
    await rearm();
  };

  const applySchedule = async (operation: unknown): Promise<void> => {
    const forwarded = operation as {
      instanceId?: unknown;
      input?: unknown;
    } | null;
    if (typeof forwarded?.instanceId !== "string") {
      throw new Error(
        "@frockbot/compose-cloudflare: a schedule operation needs an instance id",
      );
    }
    await changeSchedule(forwarded.instanceId, forwarded.input);
  };

  const within = async <T>(what: string, work: Promise<T>): Promise<T> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(timedOut(what, timeoutMs)),
            timeoutMs,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  };

  const unwrap = (result: WrapperResult): unknown => {
    if (result.ok) return result.value;
    throw sourceFailure(result.phase ?? "call", result.message ?? "unknown");
  };

  return {
    name,
    async start(request: HostStartRequest): Promise<HostInstance> {
      const stubNames = Object.keys(request.stubs);
      const stubMethods = Object.fromEntries(
        Object.entries(request.stubs).flatMap(([stub, value]) =>
          value.methods ? [[stub, value.methods] as const] : [],
        ),
      );
      const previousSchedule = await options.ctx.storage.get<FacetSchedule>(
        scheduleKey(request.instanceId),
      );
      // Every loopback for this host re-enters the object (see
      // registerStubReentry), so the schedule handler is inside it already.
      const registered = { ...request.stubs };
      const through = async (
        stubName: string,
        input: unknown,
        run: (approved: unknown) => Promise<unknown>,
      ): Promise<unknown> => {
        const approved = await request.stubs[stubName]!(input);
        return await run(approved);
      };
      if ("schedule" in request.stubs) {
        registered.schedule = (input: unknown) =>
          through("schedule", input, async (approved) => {
            await applySchedule({
              instanceId: request.instanceId,
              input: approved,
            });
          });
      }
      if ("http" in request.stubs) {
        registered.http = (input: unknown) =>
          through("http", input, (approved) =>
            performHttpGrant(
              {
                services: options.services ?? {},
                bindings: options.serviceBindings,
                timeoutMs: options.httpTimeoutMs,
                maxResponseBytes: options.httpResponseMaxBytes,
              },
              approved,
            ),
          );
      }
      if ("ai" in request.stubs) {
        registered.ai = (input: unknown) =>
          through("ai", input, (approved) => aiText(options.ai, approved));
      }
      if ("files" in request.stubs) {
        registered.files = (input: unknown) =>
          through("files", input, (approved) =>
            filesCall(options.files, request.instanceId, approved),
          );
      }
      const revoke = grantStubs(hostId, request.instanceId, registered);
      const env: Record<string, unknown> = {};
      for (const stub of stubNames) {
        const props: StubProps = {
          hostId,
          instanceId: request.instanceId,
          stub,
        };
        env[stub] = (
          workerExports as unknown as LoopbackExports
        ).ComposeStubLoopback({ props });
      }

      const worker = options.loader.get(
        `facet:${await isolateId(request, hostId)}`,
        () => ({
          compatibilityDate: options.compatibilityDate,
          ...(options.compatibilityFlags
            ? { compatibilityFlags: [...options.compatibilityFlags] }
            : {}),
          mainModule: wrapperModule,
          modules: {
            [wrapperModule]: facetWrapperSource(stubNames, stubMethods),
            [pluginModule]: request.code,
          },
          env,
          globalOutbound: null,
          limits,
        }),
      );
      const facetClass = worker.getDurableObjectClass(facetWrapperEntrypoint, {
        props: {
          instanceId: request.instanceId,
          options: request.options,
        },
        limits,
      });
      // A facet stub is bound to the request that obtained it, and calls arrive
      // on later requests (a press, an alarm): obtain one per use.
      const facet = (): FacetWrapperStub =>
        options.ctx.facets.get(request.instanceId, () => ({
          class: facetClass,
        })) as unknown as FacetWrapperStub;

      const ask = async (
        what: string,
        work: Promise<WrapperResult>,
      ): Promise<unknown> => {
        let answer: WrapperResult;
        try {
          answer = await within(what, work);
        } catch (error) {
          if (error instanceof TimedOut) throw error;
          throw readStartupFailure(error);
        }
        return unwrap(answer);
      };

      // A facet from an earlier life of this object may still be running, with
      // its setup already done against a slot registry and subscriptions this
      // object no longer holds. Start it afresh so its setup runs again here.
      try {
        options.ctx.facets.abort(
          request.instanceId,
          `instance "${request.instanceId}" restarted with its object`,
        );
      } catch {
        // No facet to abort: the ordinary first start.
      }

      let stopped = false;
      try {
        await ask("setup", facet().setup());
      } catch (error) {
        stopped = true;
        revoke();
        // A rejected start never returns a HostInstance, so the kernel has no
        // destroy callback it could retain for a later remove. Delete now to
        // avoid leaving a failed facet (and any partial setup state) behind,
        // but restore the schedule which existed before a failed restart.
        instances.delete(request.instanceId);
        if (previousSchedule) {
          await options.ctx.storage.put(
            scheduleKey(request.instanceId),
            previousSchedule,
          );
        } else {
          await options.ctx.storage.delete(scheduleKey(request.instanceId));
        }
        await rearm();
        if ("files" in request.stubs) {
          await deleteFiles(options.files, request.instanceId);
        }
        options.ctx.facets.delete(request.instanceId);
        throw error;
      }

      const running = {
        call: (handler: string, input: unknown) =>
          ask(`call "${handler}"`, facet().call(handler, input)),
      };
      instances.set(request.instanceId, running);

      return {
        async call(handler: string, input: unknown): Promise<unknown> {
          if (stopped) {
            throw new Error(
              `@frockbot/compose-cloudflare: instance "${request.instanceId}" has stopped`,
            );
          }
          return await running.call(handler, input);
        },
        stop(): Promise<void> {
          if (stopped) return Promise.resolve();
          stopped = true;
          revoke();
          if (instances.get(request.instanceId) === running) {
            instances.delete(request.instanceId);
          }
          options.ctx.facets.abort(
            request.instanceId,
            `instance "${request.instanceId}" stopped`,
          );
          return Promise.resolve();
        },
        async destroy(): Promise<void> {
          await options.ctx.storage.delete(scheduleKey(request.instanceId));
          await rearm();
          await deleteFiles(options.files, request.instanceId);
          options.ctx.facets.delete(request.instanceId);
        },
      };
    },
    schedule: applySchedule,
    stubCall: dispatchStubCall,
    async alarm(): Promise<void> {
      const scheduledAt = Date.now();
      const values = await schedules();
      const due = [...values].filter(
        ([, schedule]) => schedule.at <= scheduledAt,
      );

      for (const [key, schedule] of due) {
        if (schedule.every === undefined) {
          await options.ctx.storage.delete(key);
        } else {
          await options.ctx.storage.put(key, {
            ...schedule,
            at: scheduledAt + schedule.every,
          });
        }
      }

      for (const [key, schedule] of due) {
        const instanceId = key.slice(schedulePrefix.length);
        const instance = instances.get(instanceId);
        if (!instance) continue;
        try {
          await instance.call(schedule.handler, { scheduledAt });
        } catch {
          // The ordinary call path has classified the source failure. Do not
          // reject the parent alarm and ask the platform to retry every due job.
        }
      }

      await rearm();
    },
  };
}
