import { describe, expect, test } from "bun:test";
import {
  LlmRegistry,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  ToolRegistry,
} from "@frockbot/agent-core";
import {
  createPluginHarness,
  verifyPluginPackage,
} from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import packageJson from "../package.json" with { type: "json" };
import echoAgentPlugin, { ECHO_TOOL_NAME } from "./agent.js";

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

describe("echo plugin", () => {
  test("registers its tool and handles the reference echo command", async () => {
    const harness = await createPluginHarness([LlmRegistry, ToolRegistry]);
    harness.root.llm.register({
      id: "fixture",
      async *stream() {
        throw new Error("echo middleware delegated unexpectedly");
      },
    });
    const fiber = await harness.mount(echoAgentPlugin);
    const controller = new AbortController();

    const events = await collect(
      harness.root.llm.stream(
        request("/echo hello plugins"),
        controller.signal,
      ),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: "tool-call",
      call: { name: ECHO_TOOL_NAME, input: { text: "hello plugins" } },
    });
    const first = events[0];
    if (first?.type !== "tool-call") throw new Error("expected a tool call");
    const preparation = await harness.root.tools.prepare(first.call, {
      sessionId: "session",
      signal: controller.signal,
    });
    if (preparation.kind !== "ready") throw new Error("echo tool was denied");
    expect(
      await harness.root.tools.executePrepared(preparation, {
        sessionId: "session",
        signal: controller.signal,
      }),
    ).toEqual({ content: "hello plugins", isError: false });

    await fiber.dispose();
    expect(harness.root.tools.schemas()).toEqual([]);
    await harness.dispose();
  });

  test("satisfies plugin package conventions", () => {
    expect(verifyPluginPackage({ packageJson, manifest })).toMatchObject({
      name: "@frockbot/plugin-echo",
      contributionKinds: ["runtime"],
    });
  });
});
