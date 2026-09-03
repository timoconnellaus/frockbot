// Addressing a progressively disclosed tool, the way a model has to (ADR 0023).
//
// After ADR 0023 the only tools a model is handed by name are the native set
// plus the two meta-tools. Everything else — `frockbot`'s own tools, a Bot
// isolate's, a connected account's — is reachable only through
// `call_dynamic_tool`, and an external namespace additionally requires
// `mcpDetails.description`. These probes drive fake models, and a fake model
// that could still call `package_author` by bare name would be testing a
// surface no real model is offered.
//
// So the helpers here are deliberately the *whole* envelope rather than a
// convenience wrapper that hides it: a test reads the namespace and the
// external-ness at its call site, which is exactly the part ADR 0023 made
// load-bearing.
import type {
  LlmMessage,
  ToolCall,
  ToolSchema,
} from "@frockbot/kernel-contracts";

/** The meta-tools `@frockbot/plugin-tools` contributes to every registry. */
export const META_TOOL_NAMES_V1 = [
  "get_dynamic_tools",
  "call_dynamic_tool",
] as const;

/** The names a root with no native tools of its own still offers. */
export function metaOnlyToolNamesV1(): readonly string[] {
  return [...META_TOOL_NAMES_V1];
}

export interface DynamicCallV1 {
  namespace: string;
  toolName: string;
  input?: unknown;
  /**
   * Why the model is making this call. Required by the registry for an
   * external namespace — a Bot isolate's Package id, an MCP server — and
   * refused for `frockbot`'s own tools only in the sense that it is not needed.
   */
  description?: string;
}

/** The `call_dynamic_tool` input a model sends to invoke one disclosed tool. */
export function dynamicToolInputV1(
  call: DynamicCallV1,
): Record<string, unknown> {
  return {
    namespace: call.namespace,
    toolName: call.toolName,
    arguments: call.input ?? {},
    ...(call.description
      ? { mcpDetails: { description: call.description } }
      : {}),
  };
}

/** One whole `call_dynamic_tool` tool call, id included. */
export function dynamicToolCallV1(id: string, call: DynamicCallV1): ToolCall {
  return {
    id,
    name: "call_dynamic_tool",
    input: dynamicToolInputV1(call),
  };
}

/** One `get_dynamic_tools` discovery call. */
export function discoveryCallV1(
  id: string,
  input: { namespace?: string; toolName?: string; pattern?: string } = {},
): ToolCall {
  return { id, name: "get_dynamic_tools", input };
}

/** One tool as a namespace lookup reports it: full description and schema. */
export interface DiscoveredToolV1 {
  tool: string;
  description: string;
  inputSchema?: unknown;
}

/** A `get_dynamic_tools({ namespace })` result, decoded. */
export interface DiscoveredNamespaceV1 {
  namespace: string;
  namespaceStatus?: string;
  namespaceDescription?: string;
  tools: DiscoveredToolV1[];
}

/** A `get_dynamic_tools()` or `{ pattern }` catalog result, decoded. */
export interface DiscoveredCatalogV1 {
  mode: "catalog";
  namespaces: DiscoveredNamespaceV1[];
}

export function decodeDiscoveredCatalogV1(
  content: string,
): DiscoveredCatalogV1 {
  return JSON.parse(content) as DiscoveredCatalogV1;
}

/**
 * The namespace one tool name lives in, read out of a catalog result. This is
 * the lookup a real model performs before it can call anything, so a probe
 * that wants the full two-tier round-trip uses it rather than hard-coding a
 * namespace the registry chose.
 */
export function namespaceOfToolV1(
  catalog: DiscoveredCatalogV1,
  toolName: string,
): string | undefined {
  return catalog.namespaces.find((namespace) =>
    namespace.tools.some((tool) => tool.tool === toolName),
  )?.namespace;
}

/** What a scripted model does next, given the transcript so far. */
export type TwoTierStepV1 =
  | { kind: "discover"; call: ToolCall }
  | { kind: "invoke"; call: ToolCall }
  | { kind: "answer"; content: string; isError: boolean };

export interface TwoTierScriptV1 {
  /** The tool the scripted model intends to reach, by its bare name. */
  toolName: string;
  /** The arguments it passes, once discovery has told it where the tool lives. */
  input?: unknown;
  /**
   * The call metadata the registry demands for an external namespace. Sent
   * always: a catalog result does not say whether a namespace is external, so
   * a real model that cannot tell includes it, and the registry accepts it for
   * `frockbot` too.
   */
  description?: string;
}

/**
 * The next step of a model that must find a tool before it can call it.
 *
 * This is the whole of ADR 0023 from the model's side: one `get_dynamic_tools`
 * round-trip to learn which namespace owns the name, then one
 * `call_dynamic_tool` carrying that namespace. It is derived from the
 * transcript rather than from probe-side state, so an evicted-and-resumed Turn
 * replays it identically.
 */
export function twoTierStepV1(
  request: { messages: readonly LlmMessage[]; tools: readonly ToolSchema[] },
  script: TwoTierScriptV1,
): TwoTierStepV1 {
  const { messages } = request;
  // A native tool is offered by name in the request, so it is called by name.
  // Only what the request does *not* name has to be discovered — which is the
  // whole distinction ADR 0023 draws, and the one a real model acts on.
  const native = request.tools.some((tool) => tool.name === script.toolName);
  // Only this Turn's exchange counts. A Session runs several Turns, and the
  // discovery the *previous* Turn did is history, not an answer to this one.
  const spoke = messages.findLastIndex((message) => message.role === "user");
  const current = messages.slice(spoke + 1);
  const asked = current.findLast(
    (message) => message.role === "assistant" && message.toolCalls.length > 0,
  );
  if (asked?.role !== "assistant") {
    return native
      ? {
          kind: "invoke",
          call: {
            id: "call-1",
            name: script.toolName,
            input: script.input ?? {},
          },
        }
      : {
          kind: "discover",
          call: discoveryCallV1("call-discover", {
            pattern: `^${script.toolName}$`,
          }),
        };
  }
  const latest = current.at(-1);
  if (latest?.role !== "tool") {
    return { kind: "answer", content: "no tool result", isError: true };
  }
  if (asked.toolCalls[0]?.name !== "get_dynamic_tools") {
    // Either the dynamic invocation or a native call has come back; either way
    // the model now has its answer.
    return { kind: "answer", content: latest.content, isError: latest.isError };
  }
  if (latest.isError) {
    return { kind: "answer", content: latest.content, isError: true };
  }
  const namespace = namespaceOfToolV1(
    decodeDiscoveredCatalogV1(latest.content),
    script.toolName,
  );
  if (!namespace) {
    return {
      kind: "answer",
      content: `Unknown tool: ${script.toolName}`,
      isError: true,
    };
  }
  return {
    kind: "invoke",
    call: dynamicToolCallV1("call-1", {
      namespace,
      toolName: script.toolName,
      input: script.input,
      description:
        script.description ?? `The scripted model called ${script.toolName}.`,
    }),
  };
}
