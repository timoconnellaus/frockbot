import { createAction } from "./definitions";
import type {
  ActionDefinition,
  AnyContextKey,
  Cleanup,
  Instance,
} from "./definitions";

/**
 * The environment a plugin's code executes in. The in-process host ships here
 * and is the reference every other host is measured against; an isolation
 * library is its own package (ADR-0004).
 */
export interface Host {
  /** The name entries use to ask for this host. */
  readonly name: string;
  /** Load plugin source, hand it its stubs, and run its setup. */
  start: (request: HostStartRequest) => Promise<HostInstance>;
}

/** Everything a host is told in order to start one hosted plugin. */
export interface HostStartRequest {
  /** The hosted instance's id; it rides on every stub call the instance makes. */
  readonly instanceId: string;
  /** The code to start: what the source checker produced, or the source itself. */
  readonly code: string;
  /** The instance's validated options; structured-clone-safe. */
  readonly options: unknown;
  /** The stubs the operator granted, already bound to this instance. */
  readonly stubs: Readonly<Record<string, HostStub>>;
}

/** One instance-bound stub callable, with optional method-shape metadata. */
export interface HostStub {
  (input: unknown): Promise<unknown>;
  readonly methods?: ReadonlyArray<string>;
}

/** One started hosted plugin, as the client sees it. */
export interface HostInstance {
  /** Call one of the plugin source's named exports. */
  call: (name: string, input: unknown) => Promise<unknown>;
  /** Stop the instance; resolves only once the host has released it. */
  stop: () => Promise<void>;
  /** Permanently delete state the host kept for this entry, if it has any. */
  destroy?: () => Promise<void>;
}

/** One host-local grant value created for an in-process hosted instance. */
export interface InProcessGrantInstance {
  /** The object or callable exposed as `stubs.<name>` to written source. */
  readonly value: unknown;
  /** Begin activation-only work after the written plugin's setup succeeds. */
  ready?: () => void | Promise<void>;
  /** Release activation-only work while retaining state for a restart. */
  stop?: () => void | Promise<void>;
  /** Roll back state created by a start whose setup failed. */
  failed?: () => void | Promise<void>;
  /** Permanently remove state when the plugin entry is removed. */
  destroy?: () => void | Promise<void>;
}

/** Context used by a host-local grant factory. */
export interface InProcessGrantContext {
  readonly instanceId: string;
  /** Dispatch this grant's operation through `stubCallAction`. */
  invoke: (input: unknown) => Promise<unknown>;
  /** Call a named export of the current source activation. */
  call: (name: string, input?: unknown) => Promise<unknown>;
}

/** A named grant implementation supplied to {@link createInProcessHost}. */
export interface InProcessGrant {
  start: (
    context: InProcessGrantContext,
  ) => InProcessGrantInstance | Promise<InProcessGrantInstance>;
}

/** What a stub handler is given when a hosted plugin calls it. */
export interface StubCall<TInput = unknown> {
  /**
   * The hosted instance that made this call. The host attaches it where the
   * plugin's code cannot read or forge it.
   */
  readonly instanceId: string;
  /** What the hosted plugin passed; structured-clone-safe. */
  readonly input: TInput;
  /** The hosted instance's client-side handle; registrations here are its own. */
  readonly instance: Instance;
  /** Call one of the hosted plugin's named exports, back through its host. */
  readonly call: (name: string, input?: unknown) => Promise<unknown>;
}

/** The client-side implementation of one stub. */
export type StubHandler<TInput, TOutput> = (
  call: StubCall<TInput>,
) => TOutput | Promise<TOutput>;

/**
 * One capability an entry may be granted. The provider of the capability
 * authors it once — including the `.d.ts` text a written plugin is checked
 * against — and the operator decides which entries receive it.
 */
export interface StubGrant<TInput = any, TOutput = any> {
  /** Structural tag. Identity checks never use `instanceof`. */
  readonly type: "compose/stub";
  /** The name this stub appears under in the plugin's `stubs` object. */
  readonly name: string;
  /** The declarations a plugin holding this stub is checked against and shown. */
  readonly declarations: string;
  /** Method names a host exposes as a plain object instead of one callable. */
  readonly methods?: ReadonlyArray<string>;
  /** Context keys the handler needs; they become the hosted entry's deps. */
  readonly deps: ReadonlyArray<AnyContextKey>;
  /** Context keys the handler may provide through `call.instance.provide`. */
  readonly provides: ReadonlyArray<AnyContextKey>;
  readonly handler: StubHandler<TInput, TOutput>;
}

/** Any stub grant, whatever it takes and returns. */
export type AnyStubGrant = StubGrant<any, any>;

/**
 * Create a stub grant: the async callable through which a hosted plugin reaches
 * one thing on the client side, and the only way authority crosses a host
 * boundary.
 *
 * @example
 * ```ts
 * const logStub = createStub({
 *   name: 'log',
 *   declarations: 'declare const log: (message: string) => Promise<void>',
 *   handler: ({ input, instanceId }) => console.log(instanceId, input),
 * })
 * ```
 */
export function createStub<TInput = unknown, TOutput = unknown>(definition: {
  /** The name the hosted plugin reaches it by. */
  name: string;
  /** `.d.ts` text for this stub; entries concatenate their grants' text. */
  declarations: string;
  /** Context keys the handler needs before the hosted entry can start. */
  deps?: ReadonlyArray<AnyContextKey>;
  /** Context keys the handler may provide on the hosted instance's behalf. */
  provides?: ReadonlyArray<AnyContextKey>;
  /** What runs, client-side, when the hosted plugin calls this stub. */
  handler: StubHandler<TInput, TOutput>;
}): StubGrant<TInput, TOutput> {
  return {
    type: "compose/stub",
    name: definition.name,
    declarations: definition.declarations,
    deps: definition.deps ?? [],
    provides: definition.provides ?? [],
    handler: definition.handler,
  };
}

/**
 * The declarations an entry's plugin source is checked against and its author
 * is shown: the text of its grants, in grant order.
 */
export function stubDeclarations(
  grants: ReadonlyArray<AnyStubGrant> | undefined,
): string {
  return (grants ?? []).map((grant) => grant.declarations).join("\n");
}

/**
 * Every call a hosted plugin makes through a stub is a dispatch of this action,
 * carrying the calling instance's id, so client-side middleware can approve,
 * log or refuse the call per instance (ADR-0003).
 */
export const stubCallAction: ActionDefinition<
  { stub: string; instanceId: string; input: unknown },
  unknown
> = createAction<{ stub: string; instanceId: string; input: unknown }, unknown>(
  "compose.stubCall",
);

/** One thing a source checker has to say about the source it was given. */
export interface SourceDiagnostic {
  message: string;
  line?: number;
  column?: number;
}

/** What a source checker returns. */
export interface SourceCheckResult {
  /** The code to start. Absent means the source must not be started. */
  code?: string;
  /** What to report; carried into the entry's error when `code` is absent. */
  diagnostics?: Array<SourceDiagnostic>;
}

/**
 * Client infrastructure consulted before a host is asked to start plugin
 * source. It is both the checker and the compiler: what it returns as `code`
 * is what the host starts.
 */
export interface SourceChecker {
  check: (request: {
    /** Content hash of the generated base declarations for this check. */
    baseVersion: string;
    /** The entry whose source this is. */
    instanceId: string;
    /** The source as written. */
    source: string;
    /** The declarations derived from the entry's granted stubs. */
    declarations: string;
    /**
     * The same declarations, still attributed to the grant each came from, in
     * grant order. A checker that has to name the stubs — to give the plugin's
     * `stubs` object a type, say — needs the names as well as the text.
     */
    grants: ReadonlyArray<{ name: string; declarations: string }>;
  }) => SourceCheckResult | Promise<SourceCheckResult>;
  /**
   * The full text this checker compiles against for a grant set, when it
   * derives more than the concatenated grant text — a base declaration file, a
   * synthesized `stubs` type. A composer shows the model this when it is
   * present, so what the model is shown is what the check uses (D8); a checker
   * that compiles the grant text as given omits it, and `stubDeclarations` is
   * the answer.
   */
  declarations?: (
    grants: ReadonlyArray<{ name: string; declarations: string }>,
  ) => string;
  /**
   * The named exports of a module of plugin source, with the type of each one
   * where the checker can recover it. Optional and additive: it lets one piece
   * of source be described to another — a **view** checked against the named
   * exports of its plugin's server half, say — without core knowing what either
   * of them is for. A checker that cannot recover exports omits it, and
   * whatever asked falls back to what it would have declared anyway. Recovery
   * may be asynchronous when the checker loads its compiler lazily.
   */
  exports?: (request: {
    /** The source to read the exports of, as written. */
    source: string;
    /** The declarations that source itself compiles against, in grant order. */
    grants: ReadonlyArray<{ name: string; declarations: string }>;
  }) => ReadonlyArray<SourceExport> | Promise<ReadonlyArray<SourceExport>>;
}

/** One named export of plugin source, as a {@link SourceChecker} recovered it. */
export interface SourceExport {
  /** The export name. The default export is the setup function; it is not one. */
  name: string;
  /** The printed type, when the checker could recover one. */
  type?: string;
}

/** What the client knows about a failure to start or call plugin source. */
export interface SourceError {
  /** Structural tag. */
  readonly type: "compose/source-error";
  /** Which step failed. */
  readonly phase: "check" | "parse" | "load" | "setup" | "call";
  readonly message: string;
  readonly line?: number;
  readonly column?: number;
  /** Everything a source checker said, when the check is what failed. */
  readonly diagnostics?: Array<SourceDiagnostic>;
}

/**
 * Read the source-error detail attached to an error the client reported, if the
 * error came from plugin source.
 *
 * @example
 * ```ts
 * const [snapshot] = client.inspect()
 * sourceErrorOf(snapshot.error)?.line
 * ```
 */
export function sourceErrorOf(error: unknown): SourceError | undefined {
  const detail = (error as { source?: SourceError } | null | undefined)?.source;
  return detail?.type === "compose/source-error" ? detail : undefined;
}

/** Build an error carrying {@link SourceError} detail. */
export function sourceError(
  phase: SourceError["phase"],
  cause: unknown,
  extra?: {
    line?: number;
    column?: number;
    diagnostics?: Array<SourceDiagnostic>;
  },
): Error {
  const detailed = (cause as { message?: unknown } | null | undefined)?.message;
  const message =
    typeof detailed === "string" ? detailed : `${cause as string | number}`;
  const error = new Error(
    `@frockbot/compose-core: ${phase} failed — ${message}`,
  );
  const detail: SourceError = {
    type: "compose/source-error",
    phase,
    message,
    ...(extra?.line === undefined ? {} : { line: extra.line }),
    ...(extra?.column === undefined ? {} : { column: extra.column }),
    ...(extra?.diagnostics ? { diagnostics: extra.diagnostics } : {}),
  };
  Object.assign(error, { source: detail, cause });
  return error;
}

const moduleUrlMarker = "data:text/javascript";

/** The first frame naming the evaluated module, as `{ line, column }`. */
function locationOf(error: unknown): { line?: number; column?: number } {
  const stack = (error as { stack?: unknown } | null | undefined)?.stack;
  if (typeof stack !== "string") return {};
  for (const frame of stack.split("\n")) {
    if (!frame.includes(moduleUrlMarker)) continue;
    const at = /:(\d+):(\d+)\)?\s*$/.exec(frame);
    if (at) return { line: Number(at[1]), column: Number(at[2]) };
  }
  return {};
}

/** The URL a source string is evaluated as. */
const moduleUrl = (code: string): string =>
  `${moduleUrlMarker};charset=utf-8,${encodeURIComponent(code)}`;

/**
 * Evaluate a module URL without letting Bun's test bundler rewrite a dynamic
 * specifier into a module containing the URL string. A runtime that forbids
 * source evaluation rejects the lazily-created importer and is reported by
 * `canEvaluate` below.
 */
const evaluate = (url: string): Promise<Record<string, unknown>> => {
  const importer = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<Record<string, unknown>>;
  return importer(url);
};

let evaluatorWorks: boolean | undefined;
let inProcessHostSequence = 0;

/**
 * Whether this runtime can evaluate a module built from a string at all,
 * decided by evaluating a trivial one. workerd cannot, which is why the
 * in-process host reports source entries there rather than appearing to work;
 * the probe is only paid once, and only after an evaluation has failed.
 */
async function canEvaluate(): Promise<boolean> {
  if (evaluatorWorks === undefined) {
    try {
      await evaluate(moduleUrl("export default 0"));
      evaluatorWorks = true;
    } catch {
      evaluatorWorks = false;
    }
  }
  return evaluatorWorks;
}

/**
 * Pass a value across the boundary the way a wire would. Anything a remote host
 * could not carry fails here too, so a written plugin that works in-process
 * works everywhere, and nothing passes here that could not cross a wire.
 */
function transfer(value: unknown, what: string): unknown {
  if (typeof structuredClone !== "function") return value;
  try {
    return structuredClone(value);
  } catch {
    throw new Error(
      `@frockbot/compose-core: ${what} is not structured-clone-safe; only plain data crosses a host boundary`,
    );
  }
}

/**
 * The in-process host: it ships in core, runs plugin source in the client's own
 * process, and presents it with the same interface a remote host does — stubs
 * that are async in both directions and carry only structured-clone-safe
 * values. A written plugin runs unchanged here and in an isolate.
 *
 * @example
 * ```ts
 * await client.addPlugin({ id: 'greeter', source, stubs: [logStub] })
 * ```
 */
export function createInProcessHost(options?: {
  /** Host-local grant implementations, keyed by their stub name. */
  grants?: Readonly<Record<string, InProcessGrant>>;
  /** The name entries use to select this host. Defaults to `in-process`. */
  name?: string;
}): Host {
  const hostIdentity = inProcessHostSequence++;
  let activation = 0;
  const destroyers = new Map<
    string,
    Map<string, NonNullable<InProcessGrantInstance["destroy"]>>
  >();
  return {
    name: options?.name ?? "in-process",
    async start(request: HostStartRequest): Promise<HostInstance> {
      let stopped = false;
      let namespace: Record<string, unknown> | undefined;
      const stubs: Record<string, unknown> = {};
      const local: Array<{ name: string; grant: InProcessGrantInstance }> = [];
      for (const [name, stub] of Object.entries(request.stubs)) {
        const invoke = async (input: unknown): Promise<unknown> => {
          if (stopped) {
            throw new Error(
              `@frockbot/compose-core: stub "${name}" was revoked when instance "${request.instanceId}" stopped`,
            );
          }
          const result = await stub(transfer(input, `stub "${name}" input`));
          return transfer(result, `stub "${name}" result`);
        };
        const provider = options?.grants?.[name];
        if (!provider) {
          stubs[name] = stub.methods
            ? Object.freeze(
                Object.assign(
                  Object.create(null) as Record<string, unknown>,
                  Object.fromEntries(
                    stub.methods.map((method) => [
                      method,
                      (...args: Array<unknown>) => invoke({ method, args }),
                    ]),
                  ),
                ),
              )
            : invoke;
          continue;
        }
        const started = await provider.start({
          instanceId: request.instanceId,
          invoke,
          call: async (handler, input) => {
            const member = namespace?.[handler];
            if (typeof member !== "function") {
              throw new Error(`plugin source has no export named "${handler}"`);
            }
            return await (member as (value: unknown) => unknown)(input);
          },
        });
        local.push({ name, grant: started });
        stubs[name] = started.value;
      }

      try {
        // Bun treats a data URL fragment as JavaScript source and infers a
        // loader from the URL suffix. A trailing `.js` comment both busts the
        // module cache and preserves the JavaScript loader and line numbers.
        namespace = await evaluate(
          moduleUrl(
            `${request.code}\n// frockbot-compose-${hostIdentity}-${activation++}.js`,
          ),
        );
      } catch (error) {
        await Promise.all(local.map(({ grant }) => grant.failed?.()));
        if (!(await canEvaluate())) {
          throw sourceError(
            "load",
            new Error(
              "the in-process host cannot evaluate plugin source in this runtime: it does not allow a module to be built from a string; name a host that can",
            ),
          );
        }
        const errorNames = [
          (error as { name?: string } | null)?.name,
          ...(
            ((error as { errors?: unknown } | null)?.errors as
              Array<{ name?: string }> | undefined) ?? []
          ).map((nested) => nested?.name),
        ];
        const phase = errorNames.some(
          (name) => name === "SyntaxError" || name === "BuildMessage",
        )
          ? "parse"
          : "load";
        throw sourceError(phase, error, locationOf(error));
      }

      const setup = namespace.default;
      if (typeof setup !== "function") {
        await Promise.all(local.map(({ grant }) => grant.failed?.()));
        throw sourceError(
          "load",
          new Error("plugin source must export a default setup function"),
        );
      }

      let moduleCleanup: Cleanup | undefined;
      try {
        const result: unknown = await (
          setup as (argument: unknown) => unknown | Promise<unknown>
        )({
          id: request.instanceId,
          options: transfer(request.options, "options"),
          stubs,
        });
        if (typeof result === "function") moduleCleanup = result as Cleanup;
        await Promise.all(local.map(({ grant }) => grant.ready?.()));
        for (const { name, grant } of local) {
          if (!grant.destroy) continue;
          let byGrant = destroyers.get(request.instanceId);
          if (!byGrant) {
            byGrant = new Map();
            destroyers.set(request.instanceId, byGrant);
          }
          byGrant.set(name, grant.destroy);
        }
      } catch (error) {
        await Promise.all(local.map(({ grant }) => grant.failed?.()));
        throw sourceError("setup", error, locationOf(error));
      }

      const hosted: HostInstance = {
        async call(name: string, input: unknown): Promise<unknown> {
          if (stopped) {
            throw new Error(
              `@frockbot/compose-core: instance "${request.instanceId}" has stopped`,
            );
          }
          const handler = namespace[name];
          if (typeof handler !== "function") {
            throw sourceError(
              "call",
              new Error(`plugin source has no export named "${name}"`),
            );
          }
          try {
            const result: unknown = await (
              handler as (argument: unknown) => unknown
            )(transfer(input, `call "${name}" input`));
            return transfer(result, `call "${name}" result`);
          } catch (error) {
            throw sourceError("call", error, locationOf(error));
          }
        },
        async stop(): Promise<void> {
          if (stopped) return;
          stopped = true;
          await Promise.all(local.map(({ grant }) => grant.stop?.()));
          await moduleCleanup?.();
        },
      };
      if (destroyers.has(request.instanceId)) {
        hosted.destroy = async () => {
          const retained = destroyers.get(request.instanceId);
          destroyers.delete(request.instanceId);
          await Promise.all(
            [...(retained?.values() ?? [])].map((destroy) => destroy()),
          );
        };
      }
      return hosted;
    },
  };
}

/** The default in-process host, with no host-local named grants. */
export const inProcessHost: Host = createInProcessHost();
