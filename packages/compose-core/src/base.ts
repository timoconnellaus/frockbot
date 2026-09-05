import { createStub } from "./host";
import type { AnyAction, AnyContextKey, AnyPlugin } from "./definitions";
import type { AnyStubGrant, StubCall, StubGrant } from "./host";

/** The trusted client-side context appended to a method-shaped grant call. */
export type GrantContext = Omit<StubCall<never>, "input">;

/** A method-shaped grant's wire form. Plugin source never writes this shape. */
export interface GrantMethodCall {
  method: string;
  args: Array<unknown>;
}

/** A client-side grant method; its final argument is the trusted call context. */
export type GrantMethod = (...args: Array<any>) => unknown;

/** The method record accepted by {@link defineGrant}. */
export type GrantMethods = Readonly<Record<string, GrantMethod>>;

type MethodsEndingInContext<TMethods extends GrantMethods> = {
  readonly [TMethod in keyof TMethods]: TMethods[TMethod] extends (
    ...args: infer TArgs
  ) => unknown
    ? TArgs extends [...Array<unknown>, GrantContext]
      ? TMethods[TMethod]
      : never
    : never;
};

/** A method-shaped grant, including the type surface declaration generation reads. */
export interface GrantDefinition<
  TName extends string = string,
  TMethods extends GrantMethods = GrantMethods,
> extends StubGrant<GrantMethodCall, unknown> {
  readonly name: TName;
  readonly methods: ReadonlyArray<Extract<keyof TMethods, string>>;
  /** Phantom carrier for the method functions; never populated at runtime. */
  readonly "~methods"?: TMethods;
}

/**
 * Define a named, method-shaped grant and compile it to the low-level stub seam.
 * The last method parameter receives trusted call context and is not exposed to
 * hosted source.
 */
export function defineGrant<
  const TName extends string,
  const TMethods extends GrantMethods,
>(definition: {
  name: TName;
  /** Optional low-level declaration text for grants used outside a generated base. */
  declarations?: string;
  deps?: ReadonlyArray<AnyContextKey>;
  provides?: ReadonlyArray<AnyContextKey>;
  methods: TMethods & MethodsEndingInContext<TMethods>;
}): GrantDefinition<TName, TMethods> {
  const methods: GrantMethods = definition.methods;
  const methodNames = Object.keys(definition.methods) as Array<
    Extract<keyof TMethods, string>
  >;
  const stub = createStub<GrantMethodCall, unknown>({
    name: definition.name,
    // Product declarations are generated from `~methods`. Reusable grants may
    // still carry low-level text when they are granted outside a typed base.
    declarations: definition.declarations ?? "",
    deps: definition.deps,
    provides: definition.provides,
    handler: ({ input, ...context }) => {
      const method = methods[input.method];
      if (typeof method !== "function") {
        throw new Error(
          `"${definition.name}" has no method "${String(input.method)}"`,
        );
      }
      const args = Array.isArray(input.args) ? [...input.args] : [];
      const authoredArity = Math.max(0, method.length - 1);
      while (args.length < authoredArity) args.push(undefined);
      return method(...args, context);
    },
  });
  return Object.assign(stub, {
    name: definition.name,
    methods: methodNames,
  });
}

/** The records retained by a typed product base. */
export interface BaseDefinition<
  TKeys extends Readonly<Record<string, AnyContextKey>>,
  TActions extends Readonly<Record<string, AnyAction>>,
  TSlots extends Readonly<Record<string, unknown>>,
  TGrants extends Readonly<Record<string, AnyStubGrant>>,
  TPlugins extends Readonly<Record<string, AnyPlugin>>,
> {
  readonly keys: TKeys;
  readonly actions: TActions;
  readonly slots: TSlots;
  readonly grants: TGrants;
  readonly plugins: TPlugins;
  /** The trusted plugin catalog, by the same names and identity as `plugins`. */
  readonly catalog: TPlugins;
}

/**
 * Define a product's typed extension surface once. The returned value is both
 * its runtime inventory and the type-level surface declaration generation reads.
 */
export function defineBase<
  const TKeys extends Readonly<Record<string, AnyContextKey>>,
  const TActions extends Readonly<Record<string, AnyAction>>,
  const TSlots extends Readonly<Record<string, unknown>>,
  const TGrants extends Readonly<Record<string, AnyStubGrant>>,
  const TPlugins extends Readonly<Record<string, AnyPlugin>>,
>(definition: {
  keys: TKeys;
  actions: TActions;
  slots: TSlots;
  grants: TGrants;
  plugins: TPlugins;
}): BaseDefinition<TKeys, TActions, TSlots, TGrants, TPlugins> {
  return { ...definition, catalog: definition.plugins };
}
