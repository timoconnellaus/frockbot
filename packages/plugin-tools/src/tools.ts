import { type Context, Service } from "cordis";
import {
  admittedSubagentRolesV1,
  admittedTurnTypesV1,
  isSubagentRoleAdmittedV1,
  type ToolCall,
  type ToolDefinition,
  type ToolEffectReconciliation,
  type ToolExecution,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type ToolGuard,
  type ToolNamespaceRegistration,
  type ToolPreparation,
  type ToolRegistrationOptions,
  type ToolSchema,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";

export const GET_DYNAMIC_TOOLS_NAME = "get_dynamic_tools";
export const CALL_DYNAMIC_TOOL_NAME = "call_dynamic_tool";
export const FROCKBOT_TOOL_NAMESPACE = "frockbot";

const CATALOG_DESCRIPTION_MAX_CHARS = 200;
const TRUNCATION_SUFFIX = "... [truncated]";

export const FROCKBOT_NAMESPACE_USE_INSTRUCTIONS =
  "Native FrockBot tools for this session. You MUST read the tool schemas before calling them.";

const GET_DYNAMIC_TOOLS_DESCRIPTION = [
  "Discover schemas for dynamic tools.",
  "Call forms: get_dynamic_tools() returns the namespace catalog; get_dynamic_tools({ pattern }) searches namespace and tool names; get_dynamic_tools({ namespace }) returns every complete tool schema in one namespace; get_dynamic_tools({ namespace, pattern }) searches within one namespace; get_dynamic_tools({ namespace, toolName }) returns one complete tool schema.",
  "Catalog and pattern results omit input schemas and truncate descriptions to 200 characters ending in ... [truncated]. Namespace and single-tool lookups return complete descriptions and input schemas.",
  `IMPORTANT: Always call ${GET_DYNAMIC_TOOLS_NAME} for this namespace/tool before calling to ensure correct parameters.`,
  "Namespaces whose status is not ready are unusable until fixed.",
].join(" ");

const CALL_DYNAMIC_TOOL_DESCRIPTION = [
  "Invoke a dynamic tool using a descriptor returned by get_dynamic_tools.",
  "Discovery call forms: get_dynamic_tools() returns the namespace catalog; get_dynamic_tools({ pattern }) searches namespace and tool names; get_dynamic_tools({ namespace }) returns every complete tool schema in one namespace; get_dynamic_tools({ namespace, pattern }) searches within one namespace; get_dynamic_tools({ namespace, toolName }) returns one complete tool schema.",
  "Catalog and pattern results omit input schemas and truncate descriptions to 200 characters ending in ... [truncated]. Namespace and single-tool lookups return complete descriptions and input schemas.",
  `IMPORTANT: Always call ${GET_DYNAMIC_TOOLS_NAME} for this namespace/tool before calling to ensure correct parameters.`,
  "Pass the descriptor's namespace and tool name, put its input in arguments, and include mcpDetails.description for an external namespace.",
  "Namespaces whose status is not ready are unusable until fixed.",
].join(" ");

const GET_DYNAMIC_TOOLS_SCHEMA: ToolSchema = {
  name: GET_DYNAMIC_TOOLS_NAME,
  description: GET_DYNAMIC_TOOLS_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      namespace: {
        description: "Dynamic namespace to inspect, e.g. an MCP server.",
        type: "string",
      },
      pattern: {
        description:
          "RE2 regex pattern to search namespace and tool names (max 256 chars).",
        type: "string",
      },
      toolName: {
        description:
          "Tool name within the namespace. Requires namespace to be set.",
        type: "string",
      },
    },
  },
};

const CALL_DYNAMIC_TOOL_SCHEMA: ToolSchema = {
  name: CALL_DYNAMIC_TOOL_NAME,
  description: CALL_DYNAMIC_TOOL_DESCRIPTION,
  inputSchema: {
    type: "object",
    properties: {
      arguments: {
        description:
          "Arguments to pass to the tool, as described by the tool descriptor.",
        type: "object",
      },
      mcpDetails: {
        description:
          "MCP-specific call metadata. Set only for external MCP namespaces; omit for frockbot.",
        type: "object",
        properties: {
          description: { type: "string" },
          requestSmartModeApproval: { type: "boolean" },
          smartModeBlockReason: { type: "string" },
        },
        required: ["description"],
      },
      namespace: { type: "string" },
      toolName: { type: "string" },
    },
    required: ["namespace", "toolName"],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function optionalString(record: Record<string, unknown>, key: string): boolean {
  return record[key] === undefined || typeof record[key] === "string";
}

function validGetDynamicToolsInput(input: unknown): boolean {
  return (
    input === undefined ||
    (isRecord(input) &&
      optionalString(input, "namespace") &&
      optionalString(input, "pattern") &&
      optionalString(input, "toolName"))
  );
}

function validMcpDetailsShape(input: unknown): boolean {
  if (!isRecord(input)) return false;
  return (
    (input.description === undefined ||
      typeof input.description === "string") &&
    (input.requestSmartModeApproval === undefined ||
      typeof input.requestSmartModeApproval === "boolean") &&
    (input.smartModeBlockReason === undefined ||
      typeof input.smartModeBlockReason === "string")
  );
}

function validMcpDetails(input: unknown): boolean {
  return (
    isRecord(input) &&
    validMcpDetailsShape(input) &&
    typeof input.description === "string"
  );
}

/** The envelope every dynamic call must be wrapped in, as a worked example. */
const CALL_DYNAMIC_TOOL_ENVELOPE =
  '{"namespace":"<namespace>","toolName":"<tool>","arguments":{ … the tool\'s own input … }}';

/**
 * The names a model reaches for instead of the real ones. Naming the field it
 * *did* send is what turns a refusal into a one-step recovery: a Bot that sent
 * `{"args":"…","name":"echo"}` re-read the schema twice and still never
 * recovered, because the refusal was the single string "Invalid input for
 * tool: call_dynamic_tool" (finding F3).
 */
const CALL_DYNAMIC_TOOL_ALIASES: Readonly<Record<string, string>> = {
  name: "toolName",
  tool: "toolName",
  tool_name: "toolName",
  toolname: "toolName",
  function: "toolName",
  args: "arguments",
  arguments_: "arguments",
  input: "arguments",
  parameters: "arguments",
  params: "arguments",
  packageId: "namespace",
  package: "namespace",
  package_id: "namespace",
  ns: "namespace",
};

function jsonTypeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  const type = typeof value;
  if (type === "string") return "a string";
  if (type === "number") return "a number";
  if (type === "boolean") return "a boolean";
  if (type === "object") return "an object";
  return type;
}

/** The key the caller sent that it probably meant as `field`. */
function aliasFor(
  input: Record<string, unknown>,
  field: string,
): string | undefined {
  return Object.keys(input).find(
    (key) => CALL_DYNAMIC_TOOL_ALIASES[key] === field && key !== field,
  );
}

/**
 * Why this `call_dynamic_tool` input cannot be used, naming the offending
 * field and the shape it should have — or `undefined` when it is valid.
 */
function explainCallDynamicToolInput(input: unknown): string | undefined {
  const preamble = `${CALL_DYNAMIC_TOOL_NAME} input is invalid`;
  const expected = `Expected ${CALL_DYNAMIC_TOOL_ENVELOPE}`;
  if (!isRecord(input)) {
    return `${preamble}: it must be an object, not ${jsonTypeOf(input)}. ${expected}`;
  }
  const problems: string[] = [];
  for (const field of ["namespace", "toolName"] as const) {
    const value = input[field];
    if (typeof value === "string" && value.length > 0) continue;
    const alias = aliasFor(input, field);
    if (value === undefined) {
      problems.push(
        alias === undefined
          ? `"${field}" is missing; it must be a non-empty string`
          : `"${field}" is missing — you sent "${alias}"; the field is "${field}"`,
      );
    } else {
      problems.push(
        `"${field}" must be a non-empty string, not ${jsonTypeOf(value)}`,
      );
    }
  }
  if (input.arguments === undefined) {
    const alias = aliasFor(input, "arguments");
    if (alias !== undefined) {
      problems.push(
        `the tool's own input goes in "arguments" as an object, not in "${alias}"`,
      );
    }
  } else if (!isRecord(input.arguments)) {
    problems.push(
      typeof input.arguments === "string"
        ? `"arguments" must be a JSON object, not a string — send the object itself, not JSON text`
        : `"arguments" must be a JSON object, not ${jsonTypeOf(input.arguments)}`,
    );
  }
  if (
    input.mcpDetails !== undefined &&
    !validMcpDetailsShape(input.mcpDetails)
  ) {
    problems.push(
      `"mcpDetails" must be an object with an optional string "description", boolean "requestSmartModeApproval" and string "smartModeBlockReason"`,
    );
  }
  if (problems.length === 0) return undefined;
  return `${preamble}: ${problems.join("; ")}. ${expected}`;
}

function validCallDynamicToolInput(input: unknown): boolean {
  return explainCallDynamicToolInput(input) === undefined;
}

/** A bounded, sorted name list for a refusal that has to stay readable. */
function listOrNone(names: readonly string[]): string {
  if (names.length === 0) return "none";
  const sorted = [...names].sort();
  const shown = sorted.slice(0, 40);
  return (
    shown.join(", ") +
    (sorted.length > shown.length ? `, … (${sorted.length} in total)` : "")
  );
}

function truncateCatalogText(value: string): string {
  const characters = [...value];
  if (characters.length <= CATALOG_DESCRIPTION_MAX_CHARS) return value;
  return `${characters
    .slice(0, CATALOG_DESCRIPTION_MAX_CHARS - TRUNCATION_SUFFIX.length)
    .join("")}${TRUNCATION_SUFFIX}`;
}

function unsafeRegexPattern(pattern: string): boolean {
  // JS RegExp is intentionally used here. Reject the common catastrophic
  // forms before compiling so model-supplied searches cannot monopolise the
  // isolate: a quantified group containing another quantifier, backreferences,
  // and repeated match-any quantifiers.
  return (
    /(^|[^\\])\((?:\\.|[^()])*?(?:[+*]|\{\d+(?:,\d*)?\})(?:\\.|[^()])*\)(?:[+*]|\{\d+(?:,\d*)?\})/.test(
      pattern,
    ) ||
    /(^|[^\\])\\[1-9]/.test(pattern) ||
    /\.\*(?:[^|)]*\.\*)/.test(pattern)
  );
}

function compilePattern(
  pattern: string,
): { regex: RegExp } | { error: string } {
  if ([...pattern].length > 256) {
    return { error: "Pattern exceeds the 256 character limit" };
  }
  if (unsafeRegexPattern(pattern)) {
    return { error: "Pattern is unsafe" };
  }
  try {
    return { regex: new RegExp(pattern) };
  } catch {
    return { error: "Pattern is invalid" };
  }
}

function xmlAttribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\t", "&#9;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;");
}

function sameToolCall(left: ToolCall, right: ToolCall): boolean {
  return (
    left.id === right.id &&
    left.name === right.name &&
    JSON.stringify(left.input) === JSON.stringify(right.input)
  );
}

/** One registration: the tool, and the turn types it may ever be offered on. */
interface RegisteredTool {
  definition: ToolDefinition;
  /**
   * The tool's own declaration intersected with its Capability's durable
   * manifest ceiling, resolved once at registration so admission cannot drift
   * between the catalog the model saw and the call the loop admits.
   */
  admitted: readonly TurnTypeV1[];
  /**
   * The second ceiling dimension, resolved the same way and at the same
   * moment: the subagent roles this tool may be offered to. `undefined` is
   * every role — a tool that declares nothing is narrowed by nothing.
   */
  admittedRoles: readonly string[] | undefined;
}

interface AvailableNamespace {
  name: string;
  metadata?: ToolNamespaceRegistration;
  tools: RegisteredTool[];
}

interface ResolvedDynamicCall {
  call: ToolCall;
  registered: RegisteredTool;
}

export class ToolRegistry extends Service implements ToolExecution {
  private nativeDefinitions = new Map<string, RegisteredTool>();
  private dynamicDefinitions = new Map<string, Map<string, RegisteredTool>>();
  private namespaces = new Map<string, ToolNamespaceRegistration>();
  private guards: ToolGuard[] = [];
  private preparedDefinitions = new WeakMap<object, RegisteredTool>();

  constructor(ctx: Context) {
    super(ctx, "tools");
    this.namespaces.set(FROCKBOT_TOOL_NAMESPACE, {
      name: FROCKBOT_TOOL_NAMESPACE,
      external: false,
      useInstructions: FROCKBOT_NAMESPACE_USE_INSTRUCTIONS,
    });
    this.installMetaTool({
      ...GET_DYNAMIC_TOOLS_SCHEMA,
      validate: validGetDynamicToolsInput,
      idempotent: true,
      execute: (input, context) => this.discover(input, context),
    });
    // Successful calls are rewritten to the inner definition during prepare;
    // this body exists only to keep the registered definition total.
    this.installMetaTool({
      ...CALL_DYNAMIC_TOOL_SCHEMA,
      validate: validCallDynamicToolInput,
      execute: () =>
        Promise.resolve({
          content: "Dynamic tool call was not prepared",
          isError: true,
        }),
    });
    // A ToolRegistry is useful in narrow test/runtime roots without prompt
    // assembly. When the prompt Package is present, this lifecycle-owned child
    // registration activates and disappears with the registry.
    void ctx.inject(["systemPrompt"], (promptCtx) =>
      promptCtx.systemPrompt.register({
        id: "dynamic-tool-catalog",
        order: 70,
        render: (context) => this.renderDynamicToolCatalog(context.turnType),
      }),
    );
  }

  private installMetaTool(definition: ToolDefinition): void {
    this.nativeDefinitions.set(definition.name, this.registered(definition));
  }

  private registered(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions,
  ): RegisteredTool {
    return {
      definition,
      admitted: admittedTurnTypesV1(
        definition.admission?.turnTypes,
        options?.admissionCeiling,
      ),
      admittedRoles: admittedSubagentRolesV1(
        definition.admission?.subagentRoles,
        options?.subagentRoleCeiling,
      ),
    };
  }

  registerNamespace(namespace: ToolNamespaceRegistration): () => void {
    if (!namespace.name.trim()) {
      throw new Error("tool namespace name must be non-empty");
    }
    if (this.namespaces.has(namespace.name)) {
      throw new Error(
        `tool namespace "${namespace.name}" is already registered`,
      );
    }
    const registered = { ...namespace };
    this.namespaces.set(namespace.name, registered);
    return () => {
      if (this.namespaces.get(namespace.name) === registered) {
        this.namespaces.delete(namespace.name);
      }
    };
  }

  register(
    definition: ToolDefinition,
    options?: ToolRegistrationOptions,
  ): () => void {
    const namespace = definition.namespace;
    if (namespace !== undefined && !namespace.trim()) {
      throw new Error("tool namespace must be non-empty");
    }
    const definitions =
      namespace === undefined
        ? this.nativeDefinitions
        : (this.dynamicDefinitions.get(namespace) ?? new Map());
    if (definitions.has(definition.name)) {
      const identity =
        namespace === undefined
          ? definition.name
          : `${namespace}/${definition.name}`;
      throw new Error(`tool "${identity}" is already registered`);
    }
    if (namespace !== undefined && !this.dynamicDefinitions.has(namespace)) {
      this.dynamicDefinitions.set(namespace, definitions);
    }
    const registered = this.registered(definition, options);
    definitions.set(definition.name, registered);
    return () => {
      if (definitions.get(definition.name) === registered) {
        definitions.delete(definition.name);
        if (namespace !== undefined && definitions.size === 0) {
          this.dynamicDefinitions.delete(namespace);
        }
      }
    };
  }

  registeredNames(): string[] {
    return [
      ...this.nativeDefinitions.keys(),
      ...[...this.dynamicDefinitions].flatMap(([namespace, definitions]) =>
        [...definitions.keys()].map((name) => `${namespace}/${name}`),
      ),
    ].toSorted();
  }

  guard(guard: ToolGuard): () => void {
    this.guards.push(guard);
    return () => {
      const index = this.guards.indexOf(guard);
      if (index >= 0) this.guards.splice(index, 1);
    };
  }

  schemas(admission: {
    turnType: TurnTypeV1;
    subagentRole?: string;
  }): ToolSchema[] {
    const exposed = [...this.nativeDefinitions.values()]
      .filter(
        (registered) =>
          registered.definition.name !== GET_DYNAMIC_TOOLS_NAME &&
          registered.definition.name !== CALL_DYNAMIC_TOOL_NAME &&
          registered.admitted.includes(admission.turnType) &&
          isSubagentRoleAdmittedV1(
            registered.admittedRoles,
            admission.subagentRole,
          ),
      )
      .map(({ definition: { name, description, inputSchema } }) => ({
        name,
        description,
        inputSchema,
      }));
    return [
      exposed,
      [GET_DYNAMIC_TOOLS_SCHEMA, CALL_DYNAMIC_TOOL_SCHEMA],
    ].flat();
  }

  async prepare(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolPreparation> {
    if (call.name === CALL_DYNAMIC_TOOL_NAME) {
      const resolved = this.resolveDynamicCall(call);
      if ("error" in resolved) return this.denied(call, resolved.error);
      const metadata = this.namespaces.get(
        resolved.registered.definition.namespace!,
      );
      if (metadata?.status && metadata.status !== "ready") {
        return this.denied(
          call,
          `Namespace is not ready: ${metadata.name} (${metadata.status})`,
        );
      }
      const input = call.input as Record<string, unknown>;
      if (
        metadata?.external === true &&
        (!isRecord(input.mcpDetails) ||
          typeof input.mcpDetails.description !== "string" ||
          !input.mcpDetails.description.trim())
      ) {
        return this.denied(
          call,
          `External namespace "${metadata.name}" requires mcpDetails.description`,
        );
      }
      if (
        input.mcpDetails !== undefined &&
        !validMcpDetails(input.mcpDetails)
      ) {
        return this.denied(
          call,
          explainCallDynamicToolInput(call.input) ??
            `${CALL_DYNAMIC_TOOL_NAME} input is invalid: "mcpDetails.description" must be a non-empty string. Expected ${CALL_DYNAMIC_TOOL_ENVELOPE}`,
        );
      }
      return this.prepareRegistered(
        resolved.call,
        resolved.registered,
        context,
      );
    }
    return this.prepareRegistered(
      call,
      this.nativeDefinitions.get(call.name),
      context,
    );
  }

  private denied(call: ToolCall, content: string): ToolPreparation {
    return { kind: "denied", call, result: { content, isError: true } };
  }

  /**
   * Why a name is not callable — and, when it *is* callable through the
   * envelope, how.
   *
   * A dynamic tool is listed to the model by bare name in
   * `<dynamic_tool_namespaces>`, so the model reaches for it by that name and
   * used to get `Unknown tool: applet_list` and nothing else: a dead end for a
   * tool that was right there, costing a step every time. The refusal now
   * hands back the exact envelope for the namespace the name is actually in.
   */
  private unknownToolRefusal(name: string): string {
    const namespaces = [...this.dynamicDefinitions]
      .filter(([, definitions]) => definitions.has(name))
      .map(([namespace]) => namespace)
      .sort();
    const first = namespaces[0];
    if (first === undefined) return `Unknown tool: ${name}`;
    const where =
      namespaces.length === 1
        ? `namespace "${first}"`
        : `namespaces ${listOrNone(namespaces)} — pick one`;
    return `Unknown tool: ${name}. It is a dynamic tool in ${where}; call it through ${CALL_DYNAMIC_TOOL_NAME} as {"namespace":"${first}","toolName":"${name}","arguments":{ … the tool's own input … }}. Call ${GET_DYNAMIC_TOOLS_NAME}({"namespace":"${first}","toolName":"${name}"}) first if you do not have its schema.`;
  }

  private async prepareRegistered(
    call: ToolCall,
    registered: RegisteredTool | undefined,
    context: ToolExecutionContext,
  ): Promise<ToolPreparation> {
    const prepared = await this.ctx.waterfall(
      "tools/pre-execute",
      call,
      context,
      async () => {
        if (!registered) {
          return {
            kind: "denied",
            call,
            result: {
              content: this.unknownToolRefusal(call.name),
              isError: true,
            },
          };
        }
        // Defence in depth: the catalog was already trimmed, so a call that
        // arrives here names a tool the model was never offered.
        if (!registered.admitted.includes(context.turnType)) {
          return {
            kind: "denied",
            call,
            result: {
              content: `Tool is not available on a ${context.turnType} turn: ${call.name}`,
              isError: true,
            },
          };
        }
        // The same defence on the second dimension. A `browserUse` subagent that
        // names `computer_exec` was never offered it, and the ceiling says so
        // here as well as in the catalog.
        if (
          !isSubagentRoleAdmittedV1(
            registered.admittedRoles,
            context.subagentRole,
          )
        ) {
          return {
            kind: "denied",
            call,
            result: {
              content: `Tool is not available to a ${context.subagentRole} subagent: ${call.name}`,
              isError: true,
            },
          };
        }
        const definition = registered.definition;
        if (definition.validate && !definition.validate(call.input)) {
          return {
            kind: "denied",
            call,
            result: {
              content: `Invalid input for tool: ${call.name}`,
              isError: true,
            },
          };
        }
        return {
          kind: "ready",
          call,
          idempotent: definition.idempotent ?? false,
        };
      },
    );
    // A pre-execute listener can add a denial. Once denied, neither a guard
    // nor anything registered later can turn the call back into executable
    // work. Guards themselves return only a reason, so they have no vocabulary
    // with which to lift another guard's denial.
    if (prepared.kind === "denied") return prepared;
    for (const guard of this.guards) {
      const denial = await guard(prepared.call, context);
      if (!denial) continue;
      return {
        kind: "denied",
        call: prepared.call,
        result: { content: denial.reason, isError: true },
      };
    }
    this.preparedDefinitions.set(prepared, registered!);
    return prepared;
  }

  async executePrepared(
    preparation: Extract<ToolPreparation, { kind: "ready" }>,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const registered =
      this.preparedDefinitions.get(preparation) ??
      this.nativeDefinitions.get(preparation.call.name);
    const definition = this.isRegistered(registered)
      ? registered.definition
      : undefined;
    const initial = await this.ctx.waterfall(
      "tools/execute",
      preparation.call,
      context,
      () => {
        if (!definition) {
          return Promise.resolve({
            content: `Tool became unavailable: ${preparation.call.name}`,
            isError: true,
          });
        }
        return definition.execute(preparation.call.input, context);
      },
    );
    const result = await this.ctx.waterfall(
      "tools/post-execute",
      preparation.call,
      initial,
      context,
      () => Promise.resolve(initial),
    );
    this.ctx.emit("tools/result", preparation.call, result);
    return result;
  }

  /**
   * Settles one durably open effect without exposing provider selection to the
   * Agent loop. Idempotent definitions retry execution with the same effectId;
   * other definitions must retrieve their original result.
   */
  async reconcilePrepared(
    preparation: Extract<ToolPreparation, { kind: "ready" }>,
    context: ToolExecutionContext,
  ): Promise<ToolEffectReconciliation> {
    const expectedCall = context.toolCall;
    if (!expectedCall) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(
          `Tool ${preparation.call.name} has no durable call identity for effect reconciliation`,
          preparation.call.name,
        ),
      };
    }
    const expected =
      expectedCall.name === CALL_DYNAMIC_TOOL_NAME
        ? this.resolveDynamicCall(expectedCall)
        : {
            call: expectedCall,
            registered: this.nativeDefinitions.get(expectedCall.name),
          };
    if ("error" in expected || !expected.registered) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(
          "error" in expected
            ? expected.error
            : `Tool ${expectedCall.name} is unavailable for effect reconciliation`,
          expectedCall.name,
        ),
      };
    }
    const preparedDefinition =
      this.preparedDefinitions.get(preparation) ??
      this.nativeDefinitions.get(preparation.call.name);
    if (
      preparedDefinition !== expected.registered ||
      !sameToolCall(preparation.call, expected.call)
    ) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(
          `Prepared tool ${preparation.call.name} does not match durable effect ${expected.call.name}`,
          expectedCall.name,
        ),
      };
    }
    const definition = this.isRegistered(expected.registered)
      ? expected.registered.definition
      : undefined;
    if (!definition) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(
          `Tool ${expectedCall.name} is unavailable for effect reconciliation`,
          expectedCall.name,
        ),
      };
    }
    // Preparation is middleware-visible and therefore cannot be the authority
    // for retry safety. Only the registered definition may declare an effect
    // idempotent.
    if (definition.idempotent === true) {
      try {
        return {
          status: "recovered",
          result: await this.executePrepared(preparation, context),
        };
      } catch (error) {
        return {
          status: "unavailable",
          reason: boundedReconciliationReason(error, expectedCall.name),
        };
      }
    }
    if (!definition.reconcile) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(
          `Tool ${expectedCall.name} does not support effect reconciliation`,
          expectedCall.name,
        ),
      };
    }
    try {
      const outcome = normalizedReconciliation(
        await definition.reconcile(expected.call.input, context),
        expected.call.name,
      );
      if (outcome.status === "recovered") {
        this.ctx.emit("tools/result", expected.call, outcome.result);
      }
      return outcome;
    } catch (error) {
      return {
        status: "unavailable",
        reason: boundedReconciliationReason(error, expectedCall.name),
      };
    }
  }

  private resolveDynamicCall(
    outer: ToolCall,
  ): ResolvedDynamicCall | { error: string } {
    const invalid = explainCallDynamicToolInput(outer.input);
    if (invalid !== undefined) return { error: invalid };
    const input = outer.input as Record<string, unknown>;
    const namespace = input.namespace as string;
    const definitions = this.dynamicDefinitions.get(namespace);
    // "Namespace not found" and "Tool not found" alone leave the model
    // guessing at spelling; the names it may use are cheap to say and are
    // what let it correct itself in one step.
    if (!definitions) {
      return {
        error: `Namespace not found: "${namespace}". Available namespaces: ${listOrNone(
          [...this.dynamicDefinitions.keys()],
        )}`,
      };
    }
    const toolName = input.toolName as string;
    const registered = definitions.get(toolName);
    if (!registered) {
      return {
        error: `Tool not found: "${toolName}" in namespace "${namespace}". Tools in this namespace: ${listOrNone(
          [...definitions.keys()],
        )}`,
      };
    }
    return {
      registered,
      // One durable effect, one call id. Hooks see the inner name and input;
      // the outer call remains the exact durable intent in context.toolCall.
      call: {
        id: outer.id,
        name: toolName,
        input: input.arguments ?? {},
      },
    };
  }

  private isRegistered(
    registered: RegisteredTool | undefined,
  ): registered is RegisteredTool {
    if (!registered) return false;
    const namespace = registered.definition.namespace;
    return namespace === undefined
      ? this.nativeDefinitions.get(registered.definition.name) === registered
      : this.dynamicDefinitions
          .get(namespace)
          ?.get(registered.definition.name) === registered;
  }

  private admitted(
    registered: RegisteredTool,
    admission: { turnType: TurnTypeV1; subagentRole?: string },
  ): boolean {
    return (
      registered.admitted.includes(admission.turnType) &&
      isSubagentRoleAdmittedV1(registered.admittedRoles, admission.subagentRole)
    );
  }

  private availableNamespaces(admission: {
    turnType: TurnTypeV1;
    subagentRole?: string;
  }): AvailableNamespace[] {
    return [...this.dynamicDefinitions]
      .map(([name, definitions]) => ({
        name,
        metadata: this.namespaces.get(name),
        tools: [...definitions.values()]
          .filter((registered) => this.admitted(registered, admission))
          .toSorted((left, right) =>
            left.definition.name.localeCompare(right.definition.name),
          ),
      }))
      .filter(({ tools }) => tools.length > 0)
      .toSorted((left, right) => left.name.localeCompare(right.name));
  }

  private catalogNamespace(
    namespace: AvailableNamespace,
    tools: readonly RegisteredTool[] = namespace.tools,
  ): Record<string, unknown> {
    return {
      namespace: namespace.name,
      ...(namespace.metadata?.description
        ? {
            namespaceDescription: truncateCatalogText(
              namespace.metadata.description,
            ),
          }
        : {}),
      ...(namespace.metadata?.status
        ? { namespaceStatus: namespace.metadata.status }
        : {}),
      tools: tools.map(({ definition }) => ({
        tool: definition.name,
        description: truncateCatalogText(definition.description),
      })),
    };
  }

  private fullNamespace(
    namespace: AvailableNamespace,
  ): Record<string, unknown> {
    return {
      namespace: namespace.name,
      ...(namespace.metadata?.description
        ? { namespaceDescription: namespace.metadata.description }
        : {}),
      ...(namespace.metadata?.status
        ? { namespaceStatus: namespace.metadata.status }
        : {}),
      tools: namespace.tools.map(({ definition }) => ({
        tool: definition.name,
        description: definition.description,
        inputSchema: definition.inputSchema,
      })),
    };
  }

  private async discover(
    rawInput: unknown,
    context: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    if (!validGetDynamicToolsInput(rawInput)) {
      return {
        content: `Invalid input for tool: ${GET_DYNAMIC_TOOLS_NAME}`,
        isError: true,
      };
    }
    const input = isRecord(rawInput) ? rawInput : {};
    const namespaceName = input.namespace as string | undefined;
    const toolName = input.toolName as string | undefined;
    const pattern = input.pattern as string | undefined;
    if (toolName !== undefined && namespaceName === undefined) {
      return {
        content: "toolName requires namespace",
        isError: true,
      };
    }
    if (toolName !== undefined && pattern !== undefined) {
      return {
        content: "toolName and pattern cannot be combined",
        isError: true,
      };
    }
    const namespaces = this.availableNamespaces({
      turnType: context.turnType,
      ...(context.subagentRole === undefined
        ? {}
        : { subagentRole: context.subagentRole }),
    });
    const selected = namespaceName
      ? namespaces.filter(({ name }) => name === namespaceName)
      : namespaces;
    if (namespaceName && selected.length === 0) {
      return { content: "Namespace not found", isError: true };
    }
    if (toolName !== undefined) {
      const registered = selected[0]!.tools.find(
        ({ definition }) => definition.name === toolName,
      );
      if (!registered) {
        return {
          content: `Tool not found: "${toolName}" in namespace "${namespaceName}". Tools in this namespace: ${listOrNone(
            selected[0]!.tools.map(({ definition }) => definition.name),
          )}`,
          isError: true,
        };
      }
      // The `inputSchema` alone describes the *inner* input, and a model that
      // reads it here goes on to send it as the whole `call_dynamic_tool`
      // input. Echoing the envelope the schema has to be wrapped in is what
      // closes that gap (finding F3).
      return {
        content: JSON.stringify({
          tool: registered.definition.name,
          namespace: namespaceName,
          description: registered.definition.description,
          inputSchema: registered.definition.inputSchema,
          callWith: {
            tool: CALL_DYNAMIC_TOOL_NAME,
            input: {
              namespace: namespaceName,
              toolName: registered.definition.name,
              arguments: "<an object matching inputSchema>",
            },
          },
        }),
        isError: false,
      };
    }
    if (pattern === undefined && namespaceName !== undefined) {
      return {
        content: JSON.stringify(this.fullNamespace(selected[0]!)),
        isError: false,
      };
    }
    let regex: RegExp | undefined;
    if (pattern !== undefined) {
      const compiled = compilePattern(pattern);
      if ("error" in compiled) {
        return { content: compiled.error, isError: true };
      }
      regex = compiled.regex;
    }
    const catalog = selected.flatMap((namespace) => {
      if (!regex) return [this.catalogNamespace(namespace)];
      const tools = regex.test(namespace.name)
        ? namespace.tools
        : namespace.tools.filter(({ definition }) =>
            regex!.test(definition.name),
          );
      return tools.length > 0 ? [this.catalogNamespace(namespace, tools)] : [];
    });
    return {
      content: JSON.stringify({ mode: "catalog", namespaces: catalog }),
      isError: false,
    };
  }

  private renderDynamicToolCatalog(turnType: TurnTypeV1): string {
    const namespaces = this.availableNamespaces({ turnType });
    if (namespaces.length === 0) return "";
    const entries = namespaces.map((namespace) => {
      const attributes = [
        `name="${xmlAttribute(namespace.name)}"`,
        `tools="${xmlAttribute(
          namespace.tools.map(({ definition }) => definition.name).join(", "),
        )}"`,
        ...(namespace.metadata?.useInstructions
          ? [
              `namespaceUseInstructions="${xmlAttribute(
                namespace.metadata.useInstructions,
              )}"`,
            ]
          : []),
        ...(namespace.metadata?.status
          ? [`namespaceStatus="${xmlAttribute(namespace.metadata.status)}"`]
          : []),
      ];
      return `<namespace ${attributes.join(" ")} />`;
    });
    return [
      "<dynamic_tool_catalog>",
      `These dynamic tool namespaces were available when this conversation started. Availability may have changed, so use ${GET_DYNAMIC_TOOLS_NAME} to check current state before calling ${CALL_DYNAMIC_TOOL_NAME}.`,
      "",
      "<dynamic_tool_namespaces>",
      ...entries,
      "</dynamic_tool_namespaces>",
      "</dynamic_tool_catalog>",
    ].join("\n");
  }
}

const TOOL_RECONCILIATION_REASON_MAX_BYTES = 512;
const RECONCILIATION_REASON_ENCODER = new TextEncoder();

function ownStringKeys(
  value: Record<PropertyKey, unknown>,
): string[] | undefined {
  const keys = Reflect.ownKeys(value);
  return keys.every((key): key is string => typeof key === "string")
    ? keys.sort()
    : undefined;
}

function hasExactKeys(
  value: Record<PropertyKey, unknown>,
  expected: readonly string[],
): boolean {
  const keys = ownStringKeys(value);
  const sortedExpected = [...expected].sort();
  return (
    keys !== undefined &&
    keys.length === sortedExpected.length &&
    keys.every((key, index) => key === sortedExpected[index])
  );
}

function normalizedReconciliation(
  input: unknown,
  toolName: string,
): ToolEffectReconciliation {
  if (typeof input !== "object" || input === null) {
    return invalidReconciliation(toolName);
  }
  const record = input as Record<PropertyKey, unknown>;
  if (
    hasExactKeys(record, ["result", "status"]) &&
    record.status === "recovered"
  ) {
    const result = record.result;
    if (
      typeof result === "object" &&
      result !== null &&
      (hasExactKeys(result as Record<PropertyKey, unknown>, [
        "content",
        "isError",
      ]) ||
        hasExactKeys(result as Record<PropertyKey, unknown>, [
          "content",
          "isError",
          "endsTurn",
        ]))
    ) {
      const resultRecord = result as Record<PropertyKey, unknown>;
      if (
        typeof resultRecord.content === "string" &&
        typeof resultRecord.isError === "boolean" &&
        (resultRecord.endsTurn === undefined ||
          typeof resultRecord.endsTurn === "boolean")
      ) {
        return {
          status: "recovered",
          result: {
            content: resultRecord.content,
            isError: resultRecord.isError,
            // A recovered hand-off still ends the Turn it was recorded on.
            ...(resultRecord.endsTurn === undefined
              ? {}
              : { endsTurn: resultRecord.endsTurn }),
          },
        };
      }
    }
  }
  if (
    hasExactKeys(record, ["reason", "status"]) &&
    record.status === "unavailable" &&
    typeof record.reason === "string"
  ) {
    return {
      status: "unavailable",
      reason: boundedReconciliationReason(record.reason, toolName),
    };
  }
  return invalidReconciliation(toolName);
}

function invalidReconciliation(toolName: string): ToolEffectReconciliation {
  return {
    status: "unavailable",
    reason: boundedReconciliationReason(
      `Tool ${toolName} returned an invalid reconciliation outcome`,
      toolName,
    ),
  };
}

function boundedReconciliationReason(error: unknown, toolName: string): string {
  const reason =
    typeof error === "string"
      ? error
      : error instanceof Error
        ? error.message
        : "Tool effect is not currently retrievable";
  const normalized = reason.trim() || `Tool ${toolName} effect is unavailable`;
  let bounded = "";
  let bytes = 0;
  for (const character of normalized) {
    const characterBytes =
      RECONCILIATION_REASON_ENCODER.encode(character).byteLength;
    if (bytes + characterBytes > TOOL_RECONCILIATION_REASON_MAX_BYTES) break;
    bounded += character;
    bytes += characterBytes;
  }
  return bounded || `Tool ${toolName} effect is unavailable`;
}
