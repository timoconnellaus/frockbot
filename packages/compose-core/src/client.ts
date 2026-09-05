import { Store, batch, shallow } from "@tanstack/store";
import { createAction } from "./definitions";
import {
  inProcessHost,
  sourceError,
  stubCallAction,
  stubDeclarations,
} from "./host";
import type {
  AnyStubGrant,
  Host,
  HostInstance,
  HostStub,
  SourceChecker,
} from "./host";
import type {
  ActionDefinition,
  ActionHandler,
  AnyAction,
  AnyContextKey,
  AnyDependency,
  AnyEvent,
  AnyPlugin,
  Cleanup,
  Client,
  ClientErrorReport,
  ContextKey,
  ContextSnapshot,
  EventDefinition,
  Instance,
  InstanceSnapshot,
  Listener,
  Middleware,
  PluginEntry,
  PluginSourceEntry,
  ResourceNode,
  Status,
} from "./definitions";
import type { StandardSchemaV1 } from "./standard-schema";

/**
 * Reconciling the plugin list is itself an action, so tooling can observe,
 * replace or veto a reconcile through middleware (ADR-0003). Its input is the
 * plugin list about to be applied.
 */
export const reconcileAction: ActionDefinition<
  Array<PluginEntry>,
  void
> = createAction<Array<PluginEntry>, void>("compose.reconcile");

/**
 * Updating an instance's options is an action, so tooling can observe, replace
 * or veto the restart it causes (D3).
 */
export const optionsUpdateAction: ActionDefinition<
  { id: string; options: unknown },
  void
> = createAction<{ id: string; options: unknown }, void>(
  "compose.optionsUpdate",
);

interface Resource {
  label: string;
  cleanup?: Cleanup;
}

/** What the client keeps for one hosted instance while it is running. */
interface HostedRecord {
  instance: Instance;
  grants: ReadonlyArray<AnyStubGrant>;
  hosted?: HostInstance;
  called: boolean;
}

interface InstanceRecord {
  id: string;
  plugin: AnyPlugin;
  /** Set for an entry started from plugin source, with what it was started from. */
  source?: string;
  hostName?: string;
  grants?: ReadonlyArray<AnyStubGrant>;
  optionsInput: unknown;
  options: unknown;
  status: Status;
  phase: "idle" | "setup" | "removing";
  error?: unknown;
  resources: Array<Resource>;
  /** The client view this instance edits through; built on first use (F5). */
  view?: Client;
  provisions: Array<AnyDependency>;
  controller?: AbortController;
  removal?: Promise<void>;
}

interface MiddlewareRegistration {
  fn: Middleware<any, any>;
  owner: InstanceRecord | undefined;
}

interface ListenerRegistration {
  fn: Listener<any>;
  owner: InstanceRecord | undefined;
}

const pathToString = (
  path: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }> | undefined,
): string => {
  if (!path || path.length === 0) return "options";
  const segments = path.map((segment) =>
    typeof segment === "object" ? String(segment.key) : String(segment),
  );
  return `options.${segments.join(".")}`;
};

/** Grants are compared by identity and order; the operator owns the list. */
const sameGrants = (
  a: ReadonlyArray<AnyStubGrant> | undefined,
  b: ReadonlyArray<AnyStubGrant> | undefined,
): boolean => {
  const left = a ?? [];
  const right = b ?? [];
  return (
    left.length === right.length &&
    left.every((grant, index) => grant === right[index])
  );
};

const sameOptions = (a: unknown, b: unknown): boolean => {
  if (Object.is(a, b)) return true;
  if (
    typeof a !== "object" ||
    typeof b !== "object" ||
    a === null ||
    b === null
  ) {
    return false;
  }
  return shallow(a, b);
};

class ClientImpl implements Client {
  readonly baseVersion: string;
  readonly checker: SourceChecker | undefined;
  readonly pluginList: Store<Array<PluginEntry>>;
  readonly instances: Store<Array<InstanceSnapshot>>;
  readonly context: Store<Array<ContextSnapshot>>;
  readonly errors: Store<Array<ClientErrorReport>>;

  #records = new Map<string, InstanceRecord>();
  #published = new Map<AnyDependency, unknown>();
  #claims = new Map<AnyDependency, InstanceRecord>();
  #handlers = new Map<AnyAction, ActionHandler<any, any>>();
  #middleware = new Map<AnyAction, Array<MiddlewareRegistration>>();
  #listeners = new Map<AnyEvent, Array<ListenerRegistration>>();
  #hosts = new Map<string, Host>([[inProcessHost.name, inProcessHost]]);
  #hosted = new Map<string, HostedRecord>();
  #hostDestroyers = new Map<string, Map<string, () => Promise<void>>>();
  #applied: Array<PluginEntry> = [];
  #destroying = false;
  #queue: Promise<unknown> = Promise.resolve();
  #outstanding = 0;
  #nextPass: Promise<void> | undefined;
  #onError: ((report: ClientErrorReport) => void) | undefined;
  #errorLimit: number;

  constructor(options?: {
    baseVersion?: string;
    plugins?: Array<PluginEntry>;
    hosts?: Record<string, Host>;
    checker?: SourceChecker;
    onError?: (report: ClientErrorReport) => void;
    errorLimit?: number;
  }) {
    this.baseVersion = options?.baseVersion ?? "";
    this.checker = options?.checker;
    this.#onError = options?.onError;
    this.#errorLimit = options?.errorLimit ?? 200;
    if (!Number.isInteger(this.#errorLimit) || this.#errorLimit < 0) {
      throw new RangeError(
        "@frockbot/compose-core: errorLimit must be a non-negative integer",
      );
    }
    for (const [name, host] of Object.entries(options?.hosts ?? {})) {
      this.#hosts.set(name, host);
    }
    this.pluginList = new Store<Array<PluginEntry>>(options?.plugins ?? []);
    this.instances = new Store<Array<InstanceSnapshot>>([]);
    this.context = new Store<Array<ContextSnapshot>>([]);
    this.errors = new Store<Array<ClientErrorReport>>([]);

    this.#handlers.set(reconcileAction, (list: Array<PluginEntry>) =>
      this.#applyList(list),
    );
    this.#handlers.set(
      optionsUpdateAction,
      ({ id, options: next }: { id: string; options: unknown }) => {
        this.pluginList.setState((list) =>
          list.map((entry) =>
            entry.id === id ? { ...entry, options: next } : entry,
          ),
        );
      },
    );

    this.#handlers.set(
      stubCallAction,
      ({
        stub,
        instanceId,
        input,
      }: {
        stub: string;
        instanceId: string;
        input: unknown;
      }) => {
        const hosted = this.#hosted.get(instanceId);
        if (!hosted) {
          throw new Error(
            `@frockbot/compose-core: the stubs of instance "${instanceId}" have been revoked`,
          );
        }
        const grant = hosted.grants.find((one) => one.name === stub);
        if (!grant) {
          throw new Error(
            `@frockbot/compose-core: instance "${instanceId}" was not granted a stub named "${stub}"`,
          );
        }
        return grant.handler({
          instanceId,
          input,
          instance: hosted.instance,
          call: (name: string, callInput?: unknown) =>
            this.#callHosted(instanceId, name, callInput),
        });
      },
    );

    this.pluginList.subscribe(() => {
      if (this.pluginList.state !== this.#applied) {
        // Nobody is waiting on this one; the edit helper's promise carries the
        // failure, and a direct store write has no promise to carry it.
        this.#schedule().catch(() => undefined);
      }
    });
    if ((options?.plugins?.length ?? 0) > 0) {
      this.#schedule().catch(() => undefined);
    }
  }

  // ---------------------------------------------------------------- scheduling

  /**
   * Queue a pass. Edits made before the pass starts coalesce into it, so a
   * burst of list edits is applied once, in order, and never interleaves with
   * a pass already running (F4).
   */
  #schedule(): Promise<void> {
    if (this.#nextPass) return this.#nextPass;
    this.#outstanding++;
    const run = this.#queue.then(() => {
      this.#nextPass = undefined;
      return this.#pass();
    });
    this.#queue = run.then(
      () => undefined,
      () => undefined,
    );
    this.#nextPass = run.finally(() => {
      this.#outstanding--;
    });
    return this.#nextPass;
  }

  #editDone(): Promise<void> {
    return this.#schedule();
  }

  async settled(): Promise<void> {
    while (this.#outstanding > 0) await this.#queue;
  }

  async #pass(): Promise<void> {
    const next = this.pluginList.state;
    try {
      if (next === this.#applied) {
        await this.#settle();
        return;
      }
      const applied = { ran: false };
      const previous = this.#applied;
      const handler = this.#handlers.get(reconcileAction)!;
      this.#handlers.set(reconcileAction, async (list: Array<PluginEntry>) => {
        applied.ran = true;
        await this.#applyList(list);
      });
      try {
        await this.#dispatch(reconcileAction, next);
      } finally {
        this.#handlers.set(reconcileAction, handler);
      }
      if (!applied.ran) this.#restore(previous, next);
      else if (this.pluginList.state === next && this.#applied !== next) {
        this.#restore(this.#applied, next);
      }
    } catch (error) {
      this.#report({ scope: "reconcile", error });
      this.#restore(this.#applied, next);
      throw error;
    } finally {
      this.#publish();
    }
  }

  /** Put the list store back to what is actually running, unless it moved on. */
  #restore(list: Array<PluginEntry>, seen: Array<PluginEntry>): void {
    this.#applied = list;
    if (this.pluginList.state === seen) this.pluginList.setState(() => list);
  }

  // ------------------------------------------------------------ reconciliation

  async #applyList(next: Array<PluginEntry>): Promise<void> {
    const seen = new Set<string>();
    for (const entry of next) {
      // Keep runtime validation for untyped callers even though PluginEntry is
      // a discriminated union at compile time.
      const runtimeEntry = entry as {
        plugin?: AnyPlugin;
        source?: unknown;
        stubs?: ReadonlyArray<AnyStubGrant>;
      };
      if (typeof entry.id !== "string" || entry.id === "") {
        throw new Error(
          "@frockbot/compose-core: every plugin entry needs a string id",
        );
      }
      if (seen.has(entry.id)) {
        throw new Error(
          `@frockbot/compose-core: duplicate plugin entry id "${entry.id}"`,
        );
      }
      seen.add(entry.id);
      if (
        (runtimeEntry.plugin === undefined) ===
        (runtimeEntry.source === undefined)
      ) {
        throw new Error(
          `@frockbot/compose-core: entry "${entry.id}" must carry exactly one of a plugin and plugin source`,
        );
      }
      if (runtimeEntry.source === undefined) {
        const plugin = runtimeEntry.plugin as { type?: unknown } | undefined;
        if (plugin?.type !== "compose/plugin") {
          throw new Error(
            `@frockbot/compose-core: entry "${entry.id}" does not hold a plugin created by createPlugin`,
          );
        }
      } else if (typeof runtimeEntry.source !== "string") {
        throw new Error(
          `@frockbot/compose-core: entry "${entry.id}" holds plugin source that is not a string`,
        );
      }
      for (const grant of runtimeEntry.stubs ?? []) {
        if ((grant as { type?: unknown }).type !== "compose/stub") {
          throw new Error(
            `@frockbot/compose-core: entry "${entry.id}" was granted something that is not a stub created by createStub`,
          );
        }
      }
    }

    const desired = new Map(
      next
        .filter((entry) => entry.enabled !== false)
        .map((entry) => [entry.id, entry]),
    );

    for (const record of [...this.#records.values()]) {
      const entry = desired.get(record.id);
      if (
        !entry ||
        !this.#sameShape(entry, record) ||
        !sameOptions(entry.options, record.optionsInput)
      ) {
        await this.#remove(record);
      }
    }

    if (!this.#destroying) {
      for (const entry of this.#applied) {
        if (!seen.has(entry.id)) await this.#destroyHosted(entry.id);
      }
    }

    for (const entry of desired.values()) {
      if (!this.#records.has(entry.id)) await this.#create(entry);
    }

    this.#applied = next;
    await this.#settle();
  }

  /** Whether a running record was started from this entry as it now reads. */
  #sameShape(entry: PluginEntry, record: InstanceRecord): boolean {
    if (record.source === undefined) {
      return entry.source === undefined && entry.plugin === record.plugin;
    }
    return (
      entry.source === record.source &&
      entry.host === record.hostName &&
      sameGrants(entry.stubs, record.grants)
    );
  }

  async #create(entry: PluginEntry): Promise<InstanceRecord> {
    const hosted = entry.source !== undefined;
    const record: InstanceRecord = {
      id: entry.id,
      plugin: hosted ? this.#hostedPlugin(entry) : entry.plugin,
      ...(hosted
        ? {
            source: entry.source,
            hostName: entry.host,
            grants: entry.stubs ?? [],
          }
        : {}),
      optionsInput: entry.options,
      options: undefined,
      status: "pending",
      phase: "idle",
      resources: [],
      provisions: [],
    };
    this.#records.set(record.id, record);
    await this.#validateOptions(record);
    return record;
  }

  async #validateOptions(record: InstanceRecord): Promise<void> {
    const validator: StandardSchemaV1<any, any> | undefined =
      record.plugin.validator;
    if (!validator) {
      record.options = record.optionsInput;
      return;
    }
    const result = await validator["~standard"].validate(record.optionsInput);
    if (result.issues) {
      const message = result.issues
        .map((issue) => `${pathToString(issue.path)}: ${issue.message}`)
        .join("; ");
      record.status = "error";
      record.error = new Error(
        `@frockbot/compose-core: invalid options for "${record.id}" — ${message}`,
      );
      return;
    }
    record.options = result.value;
  }

  // ---------------------------------------------------------- hosted plugins

  /**
   * The plugin a source entry runs as. Its deps and provides are the union of
   * its grants', so a hosted entry sits in the dependency graph like any other
   * instance and every kernel rule applies to it unchanged.
   */
  #hostedPlugin(entry: PluginSourceEntry): AnyPlugin {
    const deps: Array<AnyContextKey> = [];
    const provides: Array<AnyContextKey> = [];
    for (const grant of entry.stubs ?? []) {
      for (const key of grant.deps) if (!deps.includes(key)) deps.push(key);
      for (const key of grant.provides) {
        if (!provides.includes(key)) provides.push(key);
      }
    }
    return {
      type: "compose/plugin",
      name: "hosted",
      deps,
      provides,
      setup: (instance: Instance, options: unknown) =>
        this.#startHosted(entry, instance, options),
    } as AnyPlugin;
  }

  /** Check the source if a checker is provided, then start it in its host. */
  async #startHosted(
    entry: PluginEntry,
    instance: Instance,
    options: unknown,
  ): Promise<void> {
    const hostName = entry.host;
    if (typeof hostName !== "string" || hostName === "") {
      throw new Error(
        `@frockbot/compose-core: source entry "${entry.id}" must name a host explicitly`,
      );
    }
    const host = this.#hosts.get(hostName);
    if (!host) {
      throw new Error(
        `@frockbot/compose-core: entry "${entry.id}" names a host "${hostName}" this client does not have`,
      );
    }
    const grants = entry.stubs ?? [];

    let code = entry.source!;
    const checker = this.checker;
    if (checker) {
      const checked = await checker.check({
        baseVersion: this.baseVersion,
        instanceId: instance.id,
        source: code,
        declarations: stubDeclarations(grants),
        grants: grants.map((grant) => ({
          name: grant.name,
          declarations: grant.declarations,
        })),
      });
      if (typeof checked.code !== "string") {
        const diagnostics = checked.diagnostics ?? [];
        const message =
          diagnostics
            .map((one) =>
              one.line === undefined
                ? one.message
                : `${one.line}:${one.column ?? 0} ${one.message}`,
            )
            .join("; ") || "the source checker rejected this source";
        throw sourceError("check", new Error(message), {
          ...(diagnostics[0]?.line === undefined
            ? {}
            : { line: diagnostics[0].line }),
          ...(diagnostics[0]?.column === undefined
            ? {}
            : { column: diagnostics[0].column }),
          diagnostics,
        });
      }
      code = checked.code;
    }

    const hosted: HostedRecord = { instance, grants, called: false };
    this.#hosted.set(instance.id, hosted);
    // Reverse order, so removal revokes the stubs before it stops the code:
    // a host that aborts an isolate never lets its cleanup call out either.
    instance.cleanup(async () => {
      await hosted.hosted?.stop();
    }, `host(${hostName})`);
    instance.cleanup(() => {
      this.#hosted.delete(instance.id);
    }, "stubs");

    const stubs: Record<string, HostStub> = {};
    for (const grant of grants) {
      // The instance id is in the closure, not in an argument: the plugin holds
      // the callable and can neither read nor forge who it is calling as.
      const stub: HostStub = (input: unknown) =>
        this.#dispatch(stubCallAction, {
          stub: grant.name,
          instanceId: instance.id,
          input,
        });
      if (grant.methods) {
        Object.defineProperty(stub, "methods", { value: grant.methods });
      }
      stubs[grant.name] = stub;
    }

    hosted.hosted = await host.start({
      instanceId: instance.id,
      code,
      options,
      stubs,
    });
    if (hosted.hosted.destroy) {
      let destroyers = this.#hostDestroyers.get(instance.id);
      if (!destroyers) {
        destroyers = new Map();
        this.#hostDestroyers.set(instance.id, destroyers);
      }
      destroyers.set(hostName, hosted.hosted.destroy);
    }
  }

  /** Delete every host's retained state only when the entry itself is gone. */
  async #destroyHosted(instanceId: string): Promise<void> {
    const destroyers = this.#hostDestroyers.get(instanceId);
    this.#hostDestroyers.delete(instanceId);
    for (const destroy of destroyers?.values() ?? []) {
      try {
        await destroy();
      } catch (error) {
        this.#report({ scope: "cleanup", instanceId, error });
      }
    }
  }

  /**
   * Call a named export of a hosted plugin. A rejection from the very first
   * call is a failure to start deferred by the host, so it puts the instance in
   * `error`; once the plugin has answered once, a rejection is just a rejection.
   */
  async #callHosted(
    instanceId: string,
    name: string,
    input: unknown,
  ): Promise<unknown> {
    const hosted = this.#hosted.get(instanceId);
    if (!hosted?.hosted) {
      throw new Error(
        `@frockbot/compose-core: instance "${instanceId}" is not running`,
      );
    }
    const first = !hosted.called;
    hosted.called = true;
    try {
      return await hosted.hosted.call(name, input);
    } catch (error) {
      const record = this.#records.get(instanceId);
      if (first && record && record.status === "active") {
        await this.#fail(record, error);
        this.#publish();
      }
      throw error;
    }
  }

  /** Tear an active instance down and leave it in `error`. */
  async #fail(record: InstanceRecord, error: unknown): Promise<void> {
    this.#setPhase(record, "removing");
    record.controller?.abort("failed");
    const dependents = this.#deactivateDependents(record);
    if (dependents) await dependents;
    await this.#release(record);
    record.status = "error";
    record.error = error;
    record.phase = "idle";
    this.#report({ scope: "setup", instanceId: record.id, error });
  }

  // -------------------------------------------------------------- settle passes

  #missing(record: InstanceRecord): Array<AnyDependency> {
    return record.plugin.deps.filter(
      (dependency: AnyDependency) => !this.#published.has(dependency),
    );
  }

  async #settle(): Promise<void> {
    for (let turn = 0; turn <= this.#records.size + 1; turn++) {
      let changed = false;
      for (const record of [...this.#records.values()]) {
        if (record.status === "active" && this.#missing(record).length > 0) {
          await this.#deactivate(record);
          changed = true;
        }
      }
      for (const record of [...this.#records.values()]) {
        if (
          record.status === "pending" &&
          record.phase === "idle" &&
          this.#missing(record).length === 0
        ) {
          await this.#startRecord(record);
          changed = true;
        }
      }
      if (!changed) break;
    }
    this.#detectCycles();
  }

  /** Name any ring of instances that can only be unblocked by each other (B6). */
  #detectCycles(): void {
    const blocked = [...this.#records.values()].filter(
      (record) => record.status === "pending",
    );
    if (blocked.length === 0) return;
    const providers = new Map<AnyDependency, Array<InstanceRecord>>();
    for (const record of this.#records.values()) {
      if (record.status === "active") continue;
      for (const key of record.plugin
        .provides as ReadonlyArray<AnyDependency>) {
        const list = providers.get(key);
        if (list) list.push(record);
        else providers.set(key, [record]);
      }
    }
    const stack: Array<InstanceRecord> = [];
    const done = new Set<InstanceRecord>();
    const visit = (record: InstanceRecord): void => {
      const at = stack.indexOf(record);
      if (at !== -1) {
        const ring = stack.slice(at);
        const names = [...ring, record].map((member) => member.id).join(" → ");
        const error = new Error(
          `@frockbot/compose-core: circular deps — ${names}`,
        );
        for (const member of ring) {
          member.status = "error";
          member.error = error;
          done.add(member);
        }
        return;
      }
      if (done.has(record)) return;
      stack.push(record);
      for (const key of this.#missing(record)) {
        for (const provider of providers.get(key) ?? []) visit(provider);
      }
      stack.pop();
      done.add(record);
    };
    for (const record of blocked) visit(record);
  }

  async #startRecord(record: InstanceRecord): Promise<void> {
    this.#setPhase(record, "setup");
    const deps = new Map<AnyDependency, unknown>();
    for (const dependency of record.plugin.deps) {
      deps.set(dependency, this.#published.get(dependency));
    }
    const controller = new AbortController();
    record.controller = controller;
    const values = new Map<AnyDependency, unknown>();
    try {
      const result = await record.plugin.setup(
        this.#makeInstance(record, values, deps, controller.signal),
        record.options,
      );
      if (typeof result === "function") {
        record.resources.push({
          label: "setup cleanup",
          cleanup: result,
        });
      }
      if (record.phase !== "setup") return;
      for (const key of record.provisions)
        this.#published.set(key, values.get(key));
      record.status = "active";
      record.error = undefined;
      record.phase = "idle";
    } catch (error) {
      await this.#fail(record, error);
    }
  }

  // ----------------------------------------------------------------- teardown

  async #release(record: InstanceRecord): Promise<void> {
    const resources = record.resources;
    record.resources = [];
    for (let index = resources.length - 1; index >= 0; index--) {
      const resource = resources[index]!;
      try {
        if (resource.cleanup) await resource.cleanup();
      } catch (error) {
        this.#report({ scope: "cleanup", instanceId: record.id, error });
      }
    }
    record.provisions = [];
    record.controller = undefined;
  }

  #setPhase(record: InstanceRecord, phase: InstanceRecord["phase"]): void {
    record.phase = phase;
  }

  /** Deactivate every active consumer of this record, deepest first. */
  #deactivateDependents(record: InstanceRecord): Promise<void> | undefined {
    if (record.provisions.length === 0) return undefined;
    const provided = new Set(record.provisions);
    const dependents = [...this.#records.values()].filter(
      (dependent) =>
        dependent !== record &&
        dependent.status === "active" &&
        dependent.phase === "idle" &&
        dependent.plugin.deps.some((dependency: AnyDependency) =>
          provided.has(dependency),
        ),
    );
    if (dependents.length === 0) return undefined;
    return (async () => {
      for (const dependent of dependents) {
        if (dependent.status === "active" && dependent.phase === "idle") {
          await this.#deactivate(dependent);
        }
      }
    })();
  }

  /** Full cleanup, keeping the record so it can start again later (B2). */
  async #deactivate(record: InstanceRecord): Promise<void> {
    this.#setPhase(record, "removing");
    record.controller?.abort("deactivated");
    const dependents = this.#deactivateDependents(record);
    if (dependents) await dependents;
    await this.#release(record);
    record.status = "pending";
    record.error = undefined;
    record.phase = "idle";
  }

  #remove(record: InstanceRecord): Promise<void> {
    record.removal ??= (async () => {
      this.#setPhase(record, "removing");
      record.controller?.abort("removed");
      const dependents = this.#deactivateDependents(record);
      if (dependents) await dependents;
      await this.#release(record);
      record.status = "removed";
      record.phase = "idle";
      this.#records.delete(record.id);
    })();
    return record.removal;
  }

  // -------------------------------------------------------- the instance handle

  /**
   * The view of the client one instance gets. While that instance's own code is
   * running inside a pass — its `setup` or one of its cleanups, which is what
   * `phase` names — an edit resolves as soon as it is recorded: the caller is
   * already inside the pass that would apply it, and awaiting full settlement
   * from in there would deadlock (F5). At any other time the instance is an
   * ordinary caller — a tool call, a listener, a timer — and its edit resolves
   * when the client has settled, so it can report what its edit did.
   */
  #pluginView(record: InstanceRecord): Client {
    /** Await the edit unless this instance is the pass that would apply it. */
    const edit = (): Promise<void> =>
      record.phase === "idle" ? this.#editDone() : Promise.resolve();
    record.view ??= {
      baseVersion: this.baseVersion,
      checker: this.checker,
      pluginList: this.pluginList,
      instances: this.instances,
      context: this.context,
      errors: this.errors,
      setPluginList: (next: Array<PluginEntry>) => {
        this.pluginList.setState(() => next);
        return edit();
      },
      addPlugin: <TPlugin extends AnyPlugin>(entry: PluginEntry<TPlugin>) => {
        this.pluginList.setState((list) => [...list, entry as PluginEntry]);
        return edit();
      },
      removePlugin: (id: string) => {
        this.pluginList.setState((list) =>
          list.filter((entry) => entry.id !== id),
        );
        return edit();
      },
      setEnabled: (id: string, enabled: boolean) => {
        this.pluginList.setState((list) =>
          list.map((entry) =>
            entry.id === id ? { ...entry, enabled } : entry,
          ),
        );
        return edit();
      },
      setOptions: async (id: string, options: unknown) => {
        await this.#dispatch(optionsUpdateAction, { id, options });
        await edit();
      },
      settled: () =>
        record.phase === "idle" ? this.settled() : Promise.resolve(),
      destroy: () => this.destroy(),
      dispatch: (action, input) => this.#dispatch(action, input),
      emit: ((event: AnyEvent, payload: unknown) =>
        this.#emit(event, payload)) as Client["emit"],
      on: ((event: AnyEvent, listener: Listener<any>) =>
        this.#addListener(event, listener, undefined)) as Client["on"],
      use: ((
        action: AnyAction,
        middleware: Middleware<any, any>,
        options?: { first?: boolean },
      ) =>
        this.#addMiddleware(
          action,
          middleware,
          options,
          undefined,
        )) as Client["use"],
      inspect: () => this.inspect(),
      resources: (instanceId: string) => this.resources(instanceId),
      getContext: (key) => this.getContext(key),
      callSource: (id: string, name: string, input?: unknown) =>
        this.callSource(id, name, input),
    };
    return record.view;
  }

  #makeInstance(
    record: InstanceRecord,
    values: Map<AnyDependency, unknown>,
    deps: Map<AnyDependency, unknown>,
    signal: AbortSignal,
  ): Instance<any, any> {
    // Named, because `client` is a getter and `this` inside it is the instance.
    const owner = this;
    const guard = () => {
      if (record.phase === "removing" || record.status === "removed") {
        throw new Error(
          `@frockbot/compose-core: instance "${record.id}" is being removed; it cannot register anything (A5)`,
        );
      }
    };
    const own = (resource: Resource): Cleanup => {
      guard();
      record.resources.push(resource);
      return () => {
        const at = record.resources.indexOf(resource);
        if (at !== -1) record.resources.splice(at, 1);
        return resource.cleanup?.();
      };
    };

    return {
      id: record.id,
      signal,
      get client(): Client {
        return owner.#pluginView(record);
      },
      context: {
        get: (key: AnyContextKey) => deps.get(key),
        peek: (key: AnyContextKey) => this.#published.get(key),
      },
      get: (action: AnyAction) => deps.get(action),
      provide: (key: AnyContextKey, value: unknown) => {
        guard();
        if (
          !(record.plugin.provides as ReadonlyArray<AnyContextKey>).includes(
            key,
          )
        ) {
          throw new Error(
            `@frockbot/compose-core: "${record.plugin.name}" did not declare "${key.name}" in provides`,
          );
        }
        const claimed = this.#claims.get(key);
        if (claimed && claimed !== record) {
          throw new Error(
            `@frockbot/compose-core: context key "${key.name}" is already provided by "${claimed.id}" (B5)`,
          );
        }
        this.#claims.set(key, record);
        values.set(key, value);
        record.provisions.push(key);
        record.resources.push({
          label: `provide(${key.name})`,
          cleanup: () => {
            this.#claims.delete(key);
            this.#published.delete(key);
            values.delete(key);
          },
        });
      },
      cleanup: (fn: Cleanup, label?: string) => {
        own({ label: label ?? "cleanup", cleanup: fn });
      },
      on: (event: AnyEvent, listener: Listener<any>) => {
        guard();
        return this.#addListener(event, listener, record);
      },
      emit: ((event: AnyEvent, payload: unknown) =>
        this.#emit(event, payload)) as Instance["emit"],
      defineAction: (action: AnyAction, handler: ActionHandler<any, any>) => {
        guard();
        if (
          !(record.plugin.provides as ReadonlyArray<AnyDependency>).includes(
            action,
          )
        ) {
          throw new Error(
            `@frockbot/compose-core: "${record.plugin.name}" did not declare "${action.name}" in provides`,
          );
        }
        if (this.#handlers.has(action)) {
          throw new Error(
            `@frockbot/compose-core: action "${action.name}" already has an owner`,
          );
        }
        this.#claims.set(action, record);
        this.#handlers.set(action, handler);
        values.set(action, (input: unknown) => this.#dispatch(action, input));
        record.provisions.push(action);
        record.resources.push({
          label: `action(${action.name})`,
          cleanup: () => {
            this.#claims.delete(action);
            this.#published.delete(action);
            this.#handlers.delete(action);
            values.delete(action);
          },
        });
      },
      use: (
        action: AnyAction,
        middleware: Middleware<any, any>,
        options?: { first?: boolean },
      ) => {
        guard();
        return this.#addMiddleware(action, middleware, options, record);
      },
      dispatch: (action: AnyAction, input: unknown) =>
        this.#dispatch(action, input),
    } as Instance<any, any>;
  }

  // ------------------------------------------------------- actions and events

  #addMiddleware(
    action: AnyAction,
    fn: Middleware<any, any>,
    options: { first?: boolean } | undefined,
    owner: InstanceRecord | undefined,
  ): Cleanup {
    const registration: MiddlewareRegistration = { fn, owner };
    const list = this.#middleware.get(action) ?? [];
    if (options?.first) list.unshift(registration);
    else list.push(registration);
    this.#middleware.set(action, list);
    const remove = () => {
      const current = this.#middleware.get(action);
      if (!current) return;
      const at = current.indexOf(registration);
      if (at !== -1) current.splice(at, 1);
    };
    if (owner) {
      owner.resources.push({
        label: `middleware(${action.name})`,
        cleanup: remove,
      });
    }
    return remove;
  }

  #addListener(
    event: AnyEvent,
    fn: Listener<any>,
    owner: InstanceRecord | undefined,
  ): Cleanup {
    const registration: ListenerRegistration = { fn, owner };
    const list = this.#listeners.get(event) ?? [];
    list.push(registration);
    this.#listeners.set(event, list);
    const remove = () => {
      const current = this.#listeners.get(event);
      if (!current) return;
      const at = current.indexOf(registration);
      if (at !== -1) current.splice(at, 1);
    };
    if (owner) {
      owner.resources.push({
        label: `listener(${event.name})`,
        cleanup: remove,
      });
    }
    return remove;
  }

  async #dispatch<TInput, TResult>(
    action: ActionDefinition<TInput, TResult>,
    input: TInput,
  ): Promise<TResult> {
    const chain = [...(this.#middleware.get(action) ?? [])];
    const run = async (index: number, value: TInput): Promise<TResult> => {
      const registration = chain[index];
      if (registration) {
        return (await registration.fn({
          input: value,
          next: (nextInput: TInput) => run(index + 1, nextInput),
        })) as TResult;
      }
      const handler = this.#handlers.get(action);
      if (!handler) {
        throw new Error(
          `@frockbot/compose-core: no plugin owns the action "${action.name}"`,
        );
      }
      return (await handler(value)) as TResult;
    };
    return run(0, input);
  }

  #emit(event: AnyEvent, payload: unknown): void | Promise<void> {
    const listeners = [...(this.#listeners.get(event) ?? [])];
    if (!event.awaited) {
      for (const listener of listeners) {
        try {
          const result = listener.fn(payload) as {
            catch?: (onRejected: (error: unknown) => void) => void;
          } | null;
          if (result && typeof result.catch === "function") {
            result.catch((error: unknown) => {
              this.#report({
                scope: "listener",
                instanceId: listener.owner?.id,
                error,
              });
            });
          }
        } catch (error) {
          this.#report({
            scope: "listener",
            instanceId: listener.owner?.id,
            error,
          });
        }
      }
      return undefined;
    }
    return Promise.allSettled(
      listeners.map(async (listener) => {
        try {
          await listener.fn(payload);
        } catch (error) {
          this.#report({
            scope: "listener",
            instanceId: listener.owner?.id,
            error,
          });
        }
      }),
    ).then(() => undefined);
  }

  // ------------------------------------------------------------------- public

  dispatch<TInput, TResult>(
    action: ActionDefinition<TInput, TResult>,
    input: TInput,
  ): Promise<TResult> {
    return this.#dispatch(action, input);
  }

  emit<TPayload, TAwaited extends boolean>(
    event: EventDefinition<TPayload, TAwaited>,
    payload: TPayload,
  ): TAwaited extends true ? Promise<void> : void {
    return this.#emit(event, payload) as TAwaited extends true
      ? Promise<void>
      : void;
  }

  on<TPayload, TAwaited extends boolean>(
    event: EventDefinition<TPayload, TAwaited>,
    listener: Listener<TPayload>,
  ): Cleanup {
    return this.#addListener(event, listener, undefined);
  }

  use<TInput, TResult>(
    action: ActionDefinition<TInput, TResult>,
    middleware: Middleware<TInput, TResult>,
    options?: { first?: boolean },
  ): Cleanup {
    return this.#addMiddleware(
      action as AnyAction,
      middleware,
      options,
      undefined,
    );
  }

  setPluginList(next: Array<PluginEntry>): Promise<void> {
    this.pluginList.setState(() => next);
    return this.#editDone();
  }

  addPlugin<TPlugin extends AnyPlugin>(
    entry: PluginEntry<TPlugin>,
  ): Promise<void> {
    this.pluginList.setState((list) => [...list, entry as PluginEntry]);
    return this.#editDone();
  }

  removePlugin(id: string): Promise<void> {
    this.pluginList.setState((list) => list.filter((entry) => entry.id !== id));
    return this.#editDone();
  }

  setEnabled(id: string, enabled: boolean): Promise<void> {
    this.pluginList.setState((list) =>
      list.map((entry) => (entry.id === id ? { ...entry, enabled } : entry)),
    );
    return this.#editDone();
  }

  async setOptions(id: string, options: unknown): Promise<void> {
    await this.#dispatch(optionsUpdateAction, { id, options });
    return this.#editDone();
  }

  async destroy(): Promise<void> {
    this.#destroying = true;
    this.pluginList.setState(() => []);
    await this.settled();
    for (const record of [...this.#records.values()])
      await this.#remove(record);
    this.#publish();
  }

  inspect(): Array<InstanceSnapshot> {
    return this.instances.state;
  }

  resources(instanceId: string): ResourceNode | undefined {
    const record = this.#records.get(instanceId);
    if (!record) return undefined;
    return {
      label: `${record.plugin.name} (${record.id})`,
      children: record.resources.map((resource) => ({
        label: resource.label,
        children: [],
      })),
    };
  }

  getContext<TValue>(key: ContextKey<TValue>): TValue | undefined {
    return this.#published.get(key) as TValue | undefined;
  }

  callSource(id: string, name: string, input?: unknown): Promise<unknown> {
    return this.#callHosted(id, name, input);
  }

  // ------------------------------------------------------------------ reporting

  #report(report: ClientErrorReport): void {
    this.errors.setState((list) => {
      if (this.#errorLimit === 0) return [];
      return [...list, report].slice(-this.#errorLimit);
    });
    this.#onError?.(report);
  }

  /** Instances in plugin-list order. */
  #orderedRecords(): Array<InstanceRecord> {
    const ordered: Array<InstanceRecord> = [];
    const seen = new Set<InstanceRecord>();
    const push = (record: InstanceRecord) => {
      if (seen.has(record)) return;
      seen.add(record);
      ordered.push(record);
    };
    for (const entry of this.#applied) {
      const record = this.#records.get(entry.id);
      if (record) push(record);
    }
    for (const record of this.#records.values()) push(record);
    return ordered;
  }

  /** One consistent write of every store, at the end of a pass (C2, G3). */
  #publish(): void {
    const instances: Array<InstanceSnapshot> = this.#orderedRecords().map(
      (record) => ({
        id: record.id,
        plugin: record.plugin.name,
        status: record.status,
        missing:
          record.status === "pending"
            ? this.#missing(record).map((key) => key.name)
            : [],
        ...(record.error === undefined ? {} : { error: record.error }),
      }),
    );
    const context: Array<ContextSnapshot> = [...this.#claims.entries()]
      .filter(
        ([dependency]) =>
          dependency.type === "compose/context-key" &&
          this.#published.has(dependency),
      )
      .map(([key, owner]) => ({ key: key.name, providedBy: owner.id }));
    batch(() => {
      this.instances.setState(() => instances);
      this.context.setState(() => context);
    });
  }
}

/**
 * Create a client: the root object that owns a running application — its
 * plugin list, its context, and the lifecycle of every instance.
 *
 * The returned client starts reconciling immediately; `await client.settled()`
 * once before asserting on it.
 *
 * @example
 * ```ts
 * const client = createClient({
 *   plugins: [{ id: 'logger', plugin: loggerPlugin }],
 * })
 * await client.settled()
 * ```
 */
export function createClient(options?: {
  /** Content hash of the generated base declarations. Defaults to empty. */
  baseVersion?: string;
  /** The initial plugin list. */
  plugins?: Array<PluginEntry>;
  /** The source checker to apply to every source entry, regardless of order. */
  checker?: SourceChecker;
  /**
   * Hosts an entry may name, by name. The in-process host is available as
   * `in-process`, but source entries must select every host explicitly.
   */
  hosts?: Record<string, Host>;
  /** Called for every failure the client contained rather than propagated. */
  onError?: (report: ClientErrorReport) => void;
  /** Maximum retained error reports. Defaults to 200; zero retains none. */
  errorLimit?: number;
}): Client {
  return new ClientImpl(options);
}
