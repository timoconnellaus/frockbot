import type { Store } from "@tanstack/store";
import type { AnyStubGrant, SourceChecker } from "./host";
import type {
  InferInput,
  InferOutput,
  StandardSchemaV1,
} from "./standard-schema";

/**
 * A typed identifier for one value in context. The value's type travels with
 * the key, so nothing has to be declared globally (ADR-0001).
 */
export interface ContextKey<TValue> {
  /** Structural tag. Identity checks never use `instanceof` (I2). */
  readonly type: "compose/context-key";
  readonly name: string;
  /** Phantom carrier for `TValue`; never populated at runtime. */
  readonly "~value"?: TValue;
}

/** Any context key, whatever it carries. */
export type AnyContextKey = ContextKey<unknown>;

/** The value a context key carries. */
export type ValueOf<TKey> =
  TKey extends ContextKey<infer TValue> ? TValue : never;

/**
 * Create a typed context key.
 *
 * @param name - Human-readable name, used in inspection and error messages.
 *
 * @example
 * ```ts
 * const loggerKey = createContextKey<{ log: (m: string) => void }>('logger')
 * ```
 */
export function createContextKey<TValue>(name: string): ContextKey<TValue> {
  return { type: "compose/context-key", name };
}

/**
 * A typed, named notification. Listeners observe it and cannot alter it
 * (ADR-0003). `TAwaited` is `true` when `emit` waits for every listener to
 * settle, and is part of the event's public contract.
 */
export interface EventDefinition<TPayload, TAwaited extends boolean = false> {
  /** Structural tag. */
  readonly type: "compose/event";
  readonly name: string;
  /** Whether `emit` returns a promise that settles with the listeners. */
  readonly awaited: TAwaited;
  /** Phantom carrier for `TPayload`; never populated at runtime. */
  readonly "~payload"?: TPayload;
}

/** Any event definition, whatever it carries and however it dispatches. */
export type AnyEvent = EventDefinition<unknown, boolean>;

/**
 * A function subscribed to an event. Listeners observe and cannot alter
 * anything, so whatever they return is ignored (ADR-0003); a returned promise
 * is only awaited when the event was defined with `{ awaited: true }`.
 */
export type Listener<TPayload> = (payload: TPayload) => unknown;

/**
 * Create a typed event. Without options `emit` is fire-and-forget and returns
 * `void`; with `{ awaited: true }` it returns a promise that settles once every
 * listener has (E4).
 *
 * @example
 * ```ts
 * const started = createEvent<{ id: string }>('timer.started')
 * const flushed = createEvent<void>('cache.flushed', { awaited: true })
 * ```
 */
export function createEvent<TPayload>(
  name: string,
): EventDefinition<TPayload, false>;
export function createEvent<TPayload>(
  name: string,
  options: { awaited: true },
): EventDefinition<TPayload, true>;
export function createEvent<TPayload>(
  name: string,
  options?: { awaited: boolean },
): EventDefinition<TPayload, boolean> {
  return { type: "compose/event", name, awaited: options?.awaited ?? false };
}

/**
 * A named operation a plugin exposes so other plugins can wrap it with
 * middleware (ADR-0003).
 */
export interface ActionDefinition<TInput, TResult> {
  /** Structural tag. */
  readonly type: "compose/action";
  readonly name: string;
  /** Phantom carriers; never populated at runtime. */
  readonly "~input"?: TInput;
  readonly "~result"?: TResult;
}

/** Any action definition, whatever it takes and returns. */
export type AnyAction = ActionDefinition<any, any>;

/** A context key or action that can participate in the dependency graph. */
export type AnyDependency = AnyContextKey | AnyAction;

/** The input an action takes. */
export type InputOf<TAction> =
  TAction extends ActionDefinition<infer TInput, any> ? TInput : never;

/** The result an action produces. */
export type ResultOf<TAction> =
  TAction extends ActionDefinition<any, infer TResult> ? TResult : never;

/** The callable obtained for an action declared in a plugin's deps. */
export type ActionCall<TAction extends AnyAction> = (
  input: InputOf<TAction>,
) => Promise<ResultOf<TAction>>;

/**
 * A function wrapped around an action. It may change the input, change the
 * result, or stop the action by not calling `next`.
 */
export type Middleware<TInput, TResult> = (context: {
  readonly input: TInput;
  readonly next: (input: TInput) => Promise<TResult>;
}) => TResult | Promise<TResult>;

/** The handler an action's owner registers with {@link Instance.defineAction}. */
export type ActionHandler<TInput, TResult> = (
  input: TInput,
) => TResult | Promise<TResult>;

/**
 * Create a typed action. The owner registers a handler for it; anyone may
 * dispatch it or wrap it with middleware.
 *
 * @example
 * ```ts
 * const runTool = createAction<{ name: string; args: unknown }, string>('tools.run')
 * ```
 */
export function createAction<TInput = void, TResult = void>(
  name: string,
): ActionDefinition<TInput, TResult> {
  return { type: "compose/action", name };
}

/** A function that undoes a registration or releases a resource. */
export type Cleanup = () => void | Promise<void>;

/** Where a plugin instance is in its life. */
export type Status = "pending" | "active" | "error" | "removed";

/** The typed view of context a plugin reads through. */
export interface ContextView<TDeps extends ReadonlyArray<AnyDependency>> {
  /**
   * Read a declared dep. Typed from the plugin's `deps`, so reading an
   * undeclared key is a type error (H1). The value is snapshotted before this
   * activation starts, so it remains present after a live dep is withdrawn.
   */
  get: <TKey extends Extract<TDeps[number], AnyContextKey>>(
    key: TKey,
  ) => ValueOf<TKey>;
  /**
   * Read any key, declared or not, returning `undefined` when it is not
   * currently provided by an `active` instance (B4).
   */
  peek: <TValue>(key: ContextKey<TValue>) => TValue | undefined;
}

/**
 * The handle one plugin instance is given. Every registration made through it
 * is owned by the instance and undone when the instance is removed.
 */
export interface Instance<
  TDeps extends ReadonlyArray<AnyDependency> = ReadonlyArray<AnyDependency>,
  TProvides extends ReadonlyArray<AnyDependency> = ReadonlyArray<AnyDependency>,
> {
  /** The id of this instance: the plugin entry's id. */
  readonly id: string;
  /** The client this instance runs in; use it to edit the plugin list (F5). */
  readonly client: Client;
  /**
   * This activation's cancellation signal. It is aborted before cleanup begins,
   * with reason `deactivated`, `removed`, or `failed`.
   */
  readonly signal: AbortSignal;
  /** Read context. */
  readonly context: ContextView<TDeps>;
  /** Get the typed callable for an action declared in this plugin's deps. */
  get: <TAction extends Extract<TDeps[number], AnyAction>>(
    action: TAction,
  ) => ActionCall<TAction>;
  /** Put a value into context under one of the plugin's declared `provides` keys. */
  provide: <TKey extends Extract<TProvides[number], AnyContextKey>>(
    key: TKey,
    value: ValueOf<TKey>,
  ) => void;
  /** Register an undo owned by this instance. Cleanups run in reverse order. */
  cleanup: (fn: Cleanup, label?: string) => void;
  /** Subscribe to an event for the lifetime of this instance. */
  on: <TPayload, TAwaited extends boolean>(
    event: EventDefinition<TPayload, TAwaited>,
    listener: Listener<TPayload>,
  ) => Cleanup;
  /** Emit an event. Returns a promise only for an awaited event (E4). */
  emit: <TPayload, TAwaited extends boolean>(
    event: EventDefinition<TPayload, TAwaited>,
    payload: TPayload,
  ) => TAwaited extends true ? Promise<void> : void;
  /** Own an action: register the handler that runs when nothing intercepts it. */
  defineAction: <TAction extends Extract<TProvides[number], AnyAction>>(
    action: TAction,
    handler: ActionHandler<InputOf<TAction>, ResultOf<TAction>>,
  ) => void;
  /** Wrap an action with middleware for the lifetime of this instance. */
  use: <TInput, TResult>(
    action: ActionDefinition<TInput, TResult>,
    middleware: Middleware<TInput, TResult>,
    options?: { first?: boolean },
  ) => Cleanup;
  /** Run an action through its middleware chain. */
  dispatch: <TInput, TResult>(
    action: ActionDefinition<TInput, TResult>,
    input: TInput,
  ) => Promise<TResult>;
}

/** A unit of contribution, authored once and started by a client. */
export interface Plugin<
  TOptionsInput = undefined,
  TOptions = undefined,
  TDeps extends ReadonlyArray<AnyDependency> = ReadonlyArray<AnyDependency>,
  TProvides extends ReadonlyArray<AnyDependency> = ReadonlyArray<AnyDependency>,
> {
  /** Structural tag. Identity checks never use `instanceof` (I2). */
  readonly type: "compose/plugin";
  readonly name: string;
  readonly deps: TDeps;
  readonly provides: TProvides;
  readonly validator?: StandardSchemaV1<any, any>;
  readonly setup: (
    instance: Instance<TDeps, TProvides>,
    options: TOptions,
  ) => void | Cleanup | Promise<void | Cleanup>;
  /** Phantom carrier for the options a plugin entry accepts. */
  readonly "~optionsInput"?: TOptionsInput;
}

/** Any plugin, whatever its options and keys. */
export type AnyPlugin = Plugin<any, any, any, any>;

/** The options value a plugin entry accepts for a given plugin. */
export type OptionsInputOf<TPlugin> =
  TPlugin extends Plugin<infer TOptionsInput, any, any, any>
    ? TOptionsInput
    : never;

/**
 * Declare a plugin. Options are typed by the `validator`, context reads by
 * `deps`, and `provide` by `provides` — all inferred from the values passed
 * here, with no module augmentation (ADR-0001).
 *
 * @example
 * ```ts
 * const logger = createPlugin({
 *   name: 'logger',
 *   provides: [loggerKey],
 *   setup(instance) {
 *     instance.provide(loggerKey, { log: console.log })
 *   },
 * })
 * ```
 */
export function createPlugin<
  const TDeps extends ReadonlyArray<AnyDependency> = [],
  const TProvides extends ReadonlyArray<AnyDependency> = [],
  TValidator extends StandardSchemaV1<any, any> | undefined = undefined,
>(definition: {
  /** The plugin's name, shown in inspection and error messages. */
  name: string;
  /** Context keys and actions that must be available before an instance can start. */
  deps?: TDeps;
  /** Context keys instances may provide and actions they may own. */
  provides?: TProvides;
  /** A Standard Schema that validates and defaults the options (D1). */
  validator?: TValidator;
  /** Runs once per instance. May be async, and may return a cleanup. */
  setup: (
    instance: Instance<TDeps, TProvides>,
    options: TValidator extends undefined ? undefined : InferOutput<TValidator>,
  ) => void | Cleanup | Promise<void | Cleanup>;
}): Plugin<
  TValidator extends undefined ? undefined : InferInput<TValidator>,
  TValidator extends undefined ? undefined : InferOutput<TValidator>,
  TDeps,
  TProvides
> {
  return {
    type: "compose/plugin",
    name: definition.name,
    deps: (definition.deps ?? []) as TDeps,
    provides: (definition.provides ?? []) as TProvides,
    validator: definition.validator,
    setup: definition.setup,
  };
}

/**
 * One row of the plugin list. Exactly one of `plugin` and `source` must be
 * present: a row either names a plugin or carries plugin source for a host to
 * start.
 */
interface PluginEntryBase<TOptions> {
  /** Stable identity of this row; reconciliation matches on it. */
  id: string;
  /** Options for the instance. */
  options?: TOptions;
  /** `false` is equivalent to the row not being there (F2). Defaults to `true`. */
  enabled?: boolean;
}

/** A plugin-list row that starts an imported plugin object. */
export interface PluginObjectEntry<
  TPlugin extends AnyPlugin = AnyPlugin,
> extends PluginEntryBase<OptionsInputOf<TPlugin>> {
  plugin: TPlugin;
  source?: never;
  host?: never;
  stubs?: never;
}

/** A plugin-list row that starts source code through a host. */
export interface PluginSourceEntry extends PluginEntryBase<unknown> {
  plugin?: never;
  /**
   * Plugin source: an ES module whose default export is the setup function and
   * whose other named exports are the handlers the client may call.
   */
  source: string;
  /** The host to start `source` in. Omitted means the in-process host. */
  host?: string;
  /** The stubs this entry is granted; the only authority its source receives. */
  stubs?: ReadonlyArray<AnyStubGrant>;
}

/** One row of the plugin list, discriminated by `plugin` or `source`. */
export type PluginEntry<TPlugin extends AnyPlugin = AnyPlugin> =
  PluginObjectEntry<TPlugin> | PluginSourceEntry;

/** What inspection reports for one instance (G1). */
export interface InstanceSnapshot {
  /** The instance id: the plugin entry's id. */
  id: string;
  /** The name of the plugin this is an instance of. */
  plugin: string;
  status: Status;
  /** Names of the dep keys not currently provided; empty unless `pending`. */
  missing: Array<string>;
  /** The error, when the status is `error`. */
  error?: unknown;
}

/** One node of an instance's held-resource tree (G2). */
export interface ResourceNode {
  label: string;
  children: Array<ResourceNode>;
}

/** One key currently published in context (G1, devtools). */
export interface ContextSnapshot {
  key: string;
  /** The id of the `active` instance providing it. */
  providedBy: string;
}

/** Something the client caught and carried on from. */
export interface ClientErrorReport {
  /** Where it happened. */
  scope: "cleanup" | "listener" | "reconcile" | "setup";
  instanceId?: string;
  error: unknown;
}

/**
 * The client type. Declared here so {@link Instance} can name it; created by
 * `createClient`.
 */
export interface Client {
  /** The content hash of the generated base declarations used for checks. */
  readonly baseVersion: string;
  /** The source checker configured as client infrastructure, when present. */
  readonly checker: SourceChecker | undefined;
  /** The plugin list. Writing to it reconciles the client (F1, ADR-0002). */
  readonly pluginList: Store<Array<PluginEntry>>;
  /** Every instance with its status and unmet deps (G1, G3). */
  readonly instances: Store<Array<InstanceSnapshot>>;
  /** The context keys currently published, and who provides each. */
  readonly context: Store<Array<ContextSnapshot>>;
  /** Failures the client contained rather than propagated (A7, E3, F3). */
  readonly errors: Store<Array<ClientErrorReport>>;
  /** Replace the whole plugin list and wait for the client to settle. */
  setPluginList: (next: Array<PluginEntry>) => Promise<void>;
  /** Append one entry to the plugin list. */
  addPlugin: <TPlugin extends AnyPlugin>(
    entry: PluginEntry<TPlugin>,
  ) => Promise<void>;
  /** Drop the entry with this id. */
  removePlugin: (id: string) => Promise<void>;
  /** Enable or disable an entry; disabling is equivalent to removal (F2). */
  setEnabled: (id: string, enabled: boolean) => Promise<void>;
  /** Update an entry's options, restarting only that instance (D2, D3). */
  setOptions: (id: string, options: unknown) => Promise<void>;
  /** Resolves once no reconcile or settle pass is outstanding. */
  settled: () => Promise<void>;
  /** Remove every instance, awaiting every cleanup. */
  destroy: () => Promise<void>;
  /** Run an action through its middleware chain. */
  dispatch: <TInput, TResult>(
    action: ActionDefinition<TInput, TResult>,
    input: TInput,
  ) => Promise<TResult>;
  /** Emit an event. Returns a promise only for an awaited event (E4). */
  emit: <TPayload, TAwaited extends boolean>(
    event: EventDefinition<TPayload, TAwaited>,
    payload: TPayload,
  ) => TAwaited extends true ? Promise<void> : void;
  /** Subscribe to an event outside any instance; call the result to unsubscribe. */
  on: <TPayload, TAwaited extends boolean>(
    event: EventDefinition<TPayload, TAwaited>,
    listener: Listener<TPayload>,
  ) => Cleanup;
  /** Wrap an action outside any instance; call the result to remove it. */
  use: <TInput, TResult>(
    action: ActionDefinition<TInput, TResult>,
    middleware: Middleware<TInput, TResult>,
    options?: { first?: boolean },
  ) => Cleanup;
  /** List every instance with its status and unmet deps (G1). */
  inspect: () => Array<InstanceSnapshot>;
  /** The tree of resources an instance currently holds (G2). */
  resources: (instanceId: string) => ResourceNode | undefined;
  /** Read a context key from outside a plugin. */
  getContext: <TValue>(key: ContextKey<TValue>) => TValue | undefined;
  /**
   * Call a named export of an entry started from plugin source, through its
   * host. This is the client side of the boundary, not the hosted side: it is
   * how one plugin reaches another entry's handlers — a **view** calling its
   * plugin's server half — and a hosted plugin reaches it only if a **stub**
   * was granted for it.
   */
  callSource: (id: string, name: string, input?: unknown) => Promise<unknown>;
}
