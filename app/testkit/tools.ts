import type {
  ToolCall,
  ToolExecutionContext,
  ToolSchema,
  TurnTypeV1,
} from "@frockbot/core/contracts";
import type { AgentRuntimeHarness } from "./harness.js";

export function frockbotToolCall(
  name: string,
  input: unknown,
  id = "test-call",
): ToolCall {
  return {
    id,
    name: "call_dynamic_tool",
    input: { namespace: "frockbot", toolName: name, arguments: input },
  };
}

/** Exercise the same on-demand schema path the model uses. */
export async function discoverFrockbotTools(
  tools: AgentRuntimeHarness["tools"],
  admission: { turnType: TurnTypeV1; subagentRole?: string },
): Promise<ToolSchema[]> {
  const context: ToolExecutionContext = {
    ...admission,
    botId: "test",
    agentId: "test",
    sessionId: "test",
    effectId: "discovery",
    compositionGenerationId: "test",
    signal: new AbortController().signal,
  };
  const preparation = await tools.prepare(
    {
      id: "discovery",
      name: "get_dynamic_tools",
      input: { namespace: "frockbot" },
    },
    context,
  );
  const result =
    preparation.kind === "denied"
      ? preparation.result
      : await tools.executePrepared(preparation, context);
  if (result.isError && result.content === "Namespace not found")
    return tools.schemas(admission);
  if (result.isError) throw new Error(result.content);
  return [
    ...JSON.parse(result.content).tools.map(
      (tool: {
        tool: string;
        description: string;
        inputSchema: Record<string, unknown>;
      }) => ({
        name: tool.tool,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }),
    ),
    ...tools.schemas(admission),
  ];
}
