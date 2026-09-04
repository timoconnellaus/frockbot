import { createStub } from "@frockbot/compose-core";
import { jsonSchemaValidator } from "@frockbot/compose-tools";
import { promptKey, toolsKey } from "./keys";
import { createTool } from "./tools";
import type { AnyStubGrant, StubGrant } from "@frockbot/compose-core";
import type { JsonSchema } from "@frockbot/compose-tools";
import type { ToolConcurrency } from "./types";

/**
 * What a **written plugin** passes to the `tools` **stub** to register one
 * **tool**. Plain data: `handler` names an export of the plugin's own module
 * rather than carrying a function, because a function cannot cross a host
 * boundary.
 */
export interface WrittenTool {
  /** The name the model calls. */
  name: string;
  /** What the tool does, shown to the model. */
  description: string;
  /** JSON Schema for the arguments; the model's arguments are checked against it. */
  parameters?: JsonSchema;
  /** The name of the export that runs the call. */
  handler: string;
  /** `exclusive` makes the call run alone in its step. Defaults to `parallel`. */
  concurrency?: ToolConcurrency;
}

/** What a written plugin passes to the `prompt` stub to register one section. */
export interface WrittenSection {
  /** Identifies the section; never shown to the model. */
  name: string;
  /** Lower sorts earlier. Defaults to `0`. */
  order?: number;
  /** The text this plugin contributes to the system prompt. */
  text: string;
}

/** The JSON Schema vocabulary a written plugin declares its arguments in. */
const jsonSchemaDeclaration = `
/** The subset of JSON Schema a tool declares its arguments with. */
interface JsonSchema {
  type?: JsonSchemaType | Array<JsonSchemaType>
  description?: string
  enum?: Array<unknown>
  properties?: Record<string, JsonSchema>
  required?: Array<string>
  /** \`false\` rejects any property \`properties\` does not name. */
  additionalProperties?: boolean
  items?: JsonSchema
}

type JsonSchemaType =
  | 'object'
  | 'array'
  | 'string'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'null'
`.trim();

const toolsDeclaration = `
${jsonSchemaDeclaration}

/**
 * Register a tool the model may call. \`handler\` names an export of this
 * module; the model's arguments are validated against \`parameters\` before it
 * runs, and whatever it returns is the tool's result. A tool registered here is
 * offered from the next turn.
 */
declare const tools: (tool: {
  name: string
  description: string
  parameters?: JsonSchema
  handler: string
  concurrency?: 'parallel' | 'exclusive'
}) => Promise<void>
`.trim();

const promptDeclaration = `
/**
 * Register a section of the system prompt. Sections are assembled in \`order\`
 * and a section registered here is assembled from the next turn.
 */
declare const prompt: (section: {
  name: string
  order?: number
  text: string
}) => Promise<void>
`.trim();

/** Refuse a payload that is not the shape the declarations promise. */
const expectString = (value: unknown, what: string): string => {
  if (typeof value !== "string" || value === "") {
    throw new Error(`agent example: ${what} must be a non-empty string`);
  }
  return value;
};

/**
 * The **stub** that lets a **written plugin** register a **tool**. The handler
 * runs client-side with the hosted **plugin instance**'s own handle, so the
 * registration is owned by that instance and ordinary kernel **cleanup** undoes
 * it when the entry is removed or rewritten.
 *
 * @example
 * ```ts
 * { id: 'greeter', source, stubs: [toolsStub] }
 * ```
 */
export const toolsStub: StubGrant<WrittenTool, void> = createStub<
  WrittenTool,
  void
>({
  name: "tools",
  declarations: toolsDeclaration,
  deps: [toolsKey],
  handler: ({ input, instance, call }) => {
    // The declarations promise this shape, but a client without a checker
    // starts source as written, so the payload is checked here too.
    const given = input as Partial<WrittenTool> | null | undefined;
    const name = expectString(given?.name, "a tool registration name");
    const handler = expectString(
      given?.handler,
      `the handler of tool "${name}"`,
    );
    const parameters: JsonSchema = given?.parameters ?? { type: "object" };
    const registry = instance.context.get(toolsKey);
    const tool = createTool({
      name,
      description: given?.description ?? "",
      parameters,
      validator: jsonSchemaValidator<Record<string, unknown>>(parameters),
      concurrency:
        given?.concurrency === "exclusive" ? "exclusive" : "parallel",
      execute: (args: Record<string, unknown>) => call(handler, args),
    });
    instance.cleanup(registry.register(tool), `tool(${name})`);
  },
});

/**
 * The **stub** that lets a written plugin register a **prompt section**. The
 * text is a string rather than a function, because only plain data crosses a
 * host boundary; a section that has to change re-registers.
 */
export const promptStub: StubGrant<WrittenSection, void> = createStub<
  WrittenSection,
  void
>({
  name: "prompt",
  declarations: promptDeclaration,
  deps: [promptKey],
  handler: ({ input, instance }) => {
    const given = input as Partial<WrittenSection> | null | undefined;
    const name = expectString(given?.name, "a prompt section name");
    const text = expectString(
      given?.text,
      `the text of prompt section "${name}"`,
    );
    const registry = instance.context.get(promptKey);
    instance.cleanup(
      registry.register({ name, order: given?.order ?? 0, text }),
      `section(${name})`,
    );
  },
});

/**
 * The stubs this package owns: enough for a written plugin to contribute a tool
 * and a prompt section to the agent it runs in. The operator decides which of
 * them a written entry actually receives.
 *
 * @example
 * ```ts
 * { id: 'composer', plugin: composerPlugin, options: { stubs: agentStubs } }
 * ```
 */
export const agentStubs: ReadonlyArray<AnyStubGrant> = [toolsStub, promptStub];
