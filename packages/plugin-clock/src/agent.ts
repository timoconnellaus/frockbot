import {
  type AgentRuntimeV1,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type RuntimeFeatureV1,
  type ToolDefinition,
} from "@frockbot/kernel-contracts";

function currentTime(): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "long",
  }).format(new Date());
}

const clockTool: ToolDefinition = {
  name: "current_time",
  namespace: "frockbot",
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
    call: {
      id: crypto.randomUUID(),
      name: "call_dynamic_tool",
      input: {
        namespace: "frockbot",
        toolName: "current_time",
        arguments: {},
      },
    },
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

export const clockFeature: RuntimeFeatureV1<AgentRuntimeV1> = (runtime) => {
  const tool = runtime.tools.register(clockTool);
  const hooks = runtime.hooks.add({
    modelStream: (request, signal, next) => {
      if (!shouldRequestClock(request)) return next();
      return requestClockTool(signal);
    },
  });
  return [tool, hooks];
};

export default clockFeature;
