import type {
  LlmStreamEvent,
  NormalizedModelRequest,
  ToolDefinition,
} from "@frockbot/agent-core";
import type { Plugin } from "cordis";

function currentTime(): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date());
}

const clockTool: ToolDefinition = {
  name: "current_time",
  description: "Return the current local date and time.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  idempotent: true,
  validate: (input: unknown) => typeof input === "object" && input !== null,
  execute: async () => ({ content: currentTime(), isError: false }),
};

async function* requestClockTool(
  signal: AbortSignal,
): AsyncIterable<LlmStreamEvent> {
  signal.throwIfAborted();
  yield {
    // pi-lens-ignore: ts:2322
    type: "tool-call",
    call: { id: crypto.randomUUID(), name: "current_time", input: {} },
  };
  yield {
    type: "finish",
    // pi-lens-ignore: ts:2322
    reason: "tool-calls",
  };
}

function shouldRequestClock(request: NormalizedModelRequest): boolean {
  if (request.messages.at(-1)?.role === "tool") return false;
  const user = request.messages.findLast((message) => message.role === "user");
  return user?.role === "user" && user.content.trim() === "/time";
}

export const clockAgentPlugin: Plugin.Function = (ctx) => {
  const tool = ctx.tools.register(clockTool);
  const llm = ctx.on("llm/stream", (request, signal, next) => {
    if (!shouldRequestClock(request)) return next();
    return requestClockTool(signal);
  });
  return [tool, llm];
};
clockAgentPlugin.inject = ["tools", "llm"];

export default clockAgentPlugin;
