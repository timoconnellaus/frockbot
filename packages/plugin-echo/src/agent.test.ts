import { describe, expect, test } from "bun:test";
import {
  type LlmStreamEvent,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { createAgentRuntimeHarness } from "@frockbot/plugin-testkit";
import echoFeature, { ECHO_TOOL_NAME } from "./agent.js";

function request(content: string): NormalizedModelRequest {
  return {
    requestId: "request",
    provider: "fixture",
    model: "fixture",
    system: "",
    messages: [{ role: "user", content }],
    tools: [],
  };
}

async function collect(
  source: AsyncIterable<LlmStreamEvent>,
): Promise<LlmStreamEvent[]> {
  const events: LlmStreamEvent[] = [];
  for await (const event of source) events.push(event);
  return events;
}

describe("echo feature", () => {
  test("registers its tool and handles the reference echo command", async () => {
    const runtime = createAgentRuntimeHarness();
    runtime.llm.register({
      id: "fixture",
      async *stream() {
        yield* [] as LlmStreamEvent[];
        throw new Error("echo stream hook delegated unexpectedly");
      },
    });
    await runtime.mount(echoFeature);
    const controller = new AbortController();

    const events = await collect(
      runtime.llm.stream(request("/echo hello plugins"), controller.signal),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "tool-call",
      call: {
        name: "call_dynamic_tool",
        input: {
          namespace: "frockbot",
          toolName: ECHO_TOOL_NAME,
          arguments: { text: "hello plugins" },
        },
      },
    });
    const first = events[0];
    if (first?.type !== "tool-call") throw new Error("expected a tool call");
    const preparation = await runtime.tools.prepare(first.call, {
      botId: "echo-bot",
      agentId: "echo-agent",
      compositionGenerationId: "bootstrap",
      turnType: "chat" as const,
      sessionId: "session",
      effectId: "tool:1:1:0",
      signal: controller.signal,
    });
    if (preparation.kind !== "ready") throw new Error("echo tool was denied");
    expect(
      await runtime.tools.executePrepared(preparation, {
        botId: "echo-bot",
        agentId: "echo-agent",
        compositionGenerationId: "bootstrap",
        turnType: "chat" as const,
        sessionId: "session",
        effectId: "tool:1:1:0",
        signal: controller.signal,
      }),
    ).toEqual({ content: "hello plugins", isError: false });

    await runtime.dispose();
    expect(
      runtime.tools.schemas({ turnType: "chat" }).map((tool) => tool.name),
    ).toEqual(["get_dynamic_tools", "call_dynamic_tool"]);
  });
});
