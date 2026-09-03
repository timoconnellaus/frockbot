import {
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type ToolDefinition,
} from "@frockbot/kernel-contracts";
import type { Plugin } from "cordis";

export const ECHO_TOOL_NAME = "echo";

interface EchoInput {
  text: string;
}

function decodeEchoInput(input: unknown): EchoInput | undefined {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }
  const text = (input as Record<string, unknown>).text;
  if (typeof text !== "string" || !text.trim()) return undefined;
  return { text: text.trim() };
}

export const echoTool: ToolDefinition = {
  name: ECHO_TOOL_NAME,
  namespace: "frockbot",
  description: "Return text to the conversation unchanged.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false,
  },
  idempotent: true,
  validate: (input: unknown) => decodeEchoInput(input) !== undefined,
  execute: async (input: unknown) => {
    const decoded = decodeEchoInput(input);
    if (!decoded) return { content: "Echo text is required", isError: true };
    return { content: decoded.text, isError: false };
  },
};

function requestedEchoText(
  request: NormalizedModelRequest,
): string | undefined {
  if (request.messages.at(-1)?.role === "tool") return undefined;
  const user = request.messages.findLast((message) => message.role === "user");
  if (user?.role !== "user") return undefined;
  const match = /^\/echo(?:\s+([\s\S]+))?$/.exec(user.content.trim());
  return match?.[1]?.trim() || undefined;
}

async function* requestEchoTool(
  text: string,
  signal: AbortSignal,
): AsyncIterable<LlmStreamEvent> {
  signal.throwIfAborted();
  yield {
    // pi-lens-ignore: ts:2322
    type: "tool-call",
    call: {
      id: crypto.randomUUID(),
      name: "call_dynamic_tool",
      input: {
        namespace: "frockbot",
        toolName: ECHO_TOOL_NAME,
        arguments: { text },
      },
    },
  };
  yield {
    type: "finish",
    // pi-lens-ignore: ts:2322
    reason: "tool-calls",
  };
}

export const echoAgentPlugin: Plugin.Function = (ctx) => {
  const unregisterTool = ctx.tools.register(echoTool);
  const unregisterMiddleware = ctx.on("llm/stream", (request, signal, next) => {
    const text = requestedEchoText(request);
    return text ? requestEchoTool(text, signal) : next();
  });
  return [unregisterTool, unregisterMiddleware];
};
echoAgentPlugin.inject = ["tools", "llm"];

export default echoAgentPlugin;
