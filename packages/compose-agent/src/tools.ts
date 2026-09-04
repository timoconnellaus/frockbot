import { createPlugin } from "@frockbot/compose-core";
import { optionsSchema } from "@frockbot/compose-tools";
import { toolsKey } from "./keys";
import type {
  Cleanup,
  InferOutput,
  Middleware,
  StandardSchemaV1,
} from "@frockbot/compose-core";
import type {
  AnyTool,
  ToolCall,
  ToolCallInput,
  ToolConcurrency,
  ToolContext,
  ToolDefinition,
  ToolOutcome,
  ToolRegistry,
} from "./types";

/**
 * Run a tool's validator over the arguments the model issued. Issues become an
 * error outcome the model can read, never a thrown exception (D3).
 */
export async function validateArgs<TArgs>(
  tool: ToolDefinition<TArgs, any>,
  args: unknown,
): Promise<ToolOutcome<TArgs>> {
  const result = await tool.validator["~standard"].validate(args);
  if (result.issues) {
    const problems = result.issues.map((issue) => issue.message).join("; ");
    return {
      ok: false,
      error: `invalid arguments for tool "${tool.name}": ${problems}`,
    };
  }
  return { ok: true, value: result.value };
}

/**
 * Declare a tool. The argument type comes from the `validator` and the result
 * type from `execute`, so both travel with the definition and neither the loop,
 * middleware nor a test needs a cast (ADR-0001, F1).
 *
 * @example
 * ```ts
 * const search = createTool({
 *   name: 'search',
 *   description: 'Search the index',
 *   validator: v.object({ query: v.string() }),
 *   parameters: { type: 'object', properties: { query: { type: 'string' } } },
 *   execute: ({ query }) => lookup(query),
 * })
 * ```
 */
export function createTool<
  TValidator extends StandardSchemaV1<any, any>,
  TReturn,
>(definition: {
  /** The name the model calls. Unique within a registry. */
  name: string;
  /** What the tool does, shown to the model. */
  description: string;
  /** Standard Schema; validates the model's arguments before `execute` runs. */
  validator: TValidator;
  /** The JSON Schema handed to the model. Defaults to `{ type: 'object' }`. */
  parameters?: Record<string, unknown>;
  /** `exclusive` makes the call run alone in its step. Defaults to `parallel`. */
  concurrency?: ToolConcurrency;
  /** Runs the call. Throwing is allowed; it becomes an error outcome (D5). */
  execute: (args: InferOutput<TValidator>, context: ToolContext) => TReturn;
}): ToolDefinition<InferOutput<TValidator>, Awaited<TReturn>> {
  return {
    name: definition.name,
    description: definition.description,
    validator: definition.validator,
    parameters: definition.parameters ?? { type: "object" },
    concurrency: definition.concurrency ?? "parallel",
    execute: definition.execute as ToolDefinition<
      InferOutput<TValidator>,
      Awaited<TReturn>
    >["execute"],
  };
}

/**
 * Middleware for one tool, typed from its definition: `args` is the validated
 * argument type and the outcome is the tool's result type (F1). Arguments that
 * fail validation skip the middleware and fall through to the handler, which
 * produces the usual error outcome.
 *
 * @example
 * ```ts
 * instance.use(
 *   toolCallAction,
 *   toolMiddleware(search, ({ input, next }) =>
 *     input.args.query === 'secret'
 *       ? { ok: false, error: 'refused' }
 *       : next({ query: input.args.query.trim() }),
 *   ),
 * )
 * ```
 */
export function toolMiddleware<TArgs, TResult>(
  tool: ToolDefinition<TArgs, TResult>,
  middleware: (context: {
    readonly input: { call: ToolCall; args: TArgs; turn: number; step: number };
    readonly next: (args: TArgs) => Promise<ToolOutcome<TResult>>;
  }) => ToolOutcome<TResult> | Promise<ToolOutcome<TResult>>,
): Middleware<ToolCallInput, ToolOutcome> {
  return async ({ input, next }) => {
    if (input.call.name !== tool.name) return next(input);
    const validated = await validateArgs(tool, input.call.args);
    if (!validated.ok) return next(input);
    return middleware({
      input: {
        call: input.call,
        args: validated.value,
        turn: input.turn,
        step: input.step,
      },
      next: (args: TArgs) =>
        next({ ...input, call: { ...input.call, args } }) as Promise<
          ToolOutcome<TResult>
        >,
    });
  };
}

const registryOptions = optionsSchema<
  { tools?: ReadonlyArray<AnyTool> } | undefined,
  { tools: Array<AnyTool> }
>((value) => ({ tools: [...(value?.tools ?? [])] }));

const toolsetOptions = optionsSchema<
  { tools: ReadonlyArray<AnyTool> },
  { tools: Array<AnyTool> }
>((value) => ({ tools: [...value.tools] }));

/** Build a registry. Registration order is the order tools are offered. */
const createRegistry = (): ToolRegistry => {
  const tools: Array<AnyTool> = [];
  return {
    register: (tool: AnyTool): Cleanup => {
      tools.push(tool);
      return () => {
        const at = tools.indexOf(tool);
        if (at !== -1) tools.splice(at, 1);
      };
    },
    list: () => [...tools],
    get: (name: string) => tools.find((tool) => tool.name === name),
  };
};

/**
 * The tool registry. Provides {@link toolsKey}; the tools it is given in its
 * options are registered for as long as the instance runs.
 */
export const toolsPlugin = createPlugin({
  name: "tools",
  provides: [toolsKey],
  validator: registryOptions,
  setup(instance, options) {
    const registry = createRegistry();
    for (const tool of options.tools) {
      instance.cleanup(registry.register(tool), `tool(${tool.name})`);
    }
    instance.provide(toolsKey, registry);
  },
});

/**
 * A set of tools contributed by its own plugin entry, so adding the entry makes
 * them callable from the next step and removing it makes them neither offered
 * nor executable (C4).
 *
 * @example
 * ```ts
 * await client.addPlugin({ id: 'search-tools', plugin: toolsetPlugin, options: { tools: [search] } })
 * ```
 */
export const toolsetPlugin = createPlugin({
  name: "toolset",
  deps: [toolsKey],
  validator: toolsetOptions,
  setup(instance, options) {
    const registry = instance.context.get(toolsKey);
    for (const tool of options.tools) {
      instance.cleanup(registry.register(tool), `tool(${tool.name})`);
    }
  },
});
