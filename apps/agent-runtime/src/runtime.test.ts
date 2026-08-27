import { afterEach, describe, expect, test } from "bun:test";
import { flySpriteRuntimePackage } from "./fly-sprite-package.js";
import type { FoundationRuntime } from "./runtime.js";
import { createFoundationRuntime } from "./runtime.js";

const runtimes: FoundationRuntime[] = [];

async function createRuntime(): Promise<FoundationRuntime> {
  const runtime = await createFoundationRuntime(undefined, {
    agentPackages: [flySpriteRuntimePackage],
  });
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("foundation Cordis runtime", () => {
  test("streams a deterministic response through the custom loop", async () => {
    const runtime = await createRuntime();
    runtime.agent.agent.send("hello");
    await runtime.agent.agent.whenIdle();

    const chunks = runtime.agent.agent.session.events
      .filter((event) => event.type === "assistant/chunk")
      .map((event) => event.text)
      .join("");
    expect(chunks).toBe("Cordis runtime: hello");
    expect(runtime.agent.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("loads the echo capability as a Cordis tool plugin", async () => {
    const runtime = await createRuntime();
    runtime.agent.agent.send("/echo plugin architecture");
    await runtime.agent.agent.whenIdle();

    expect(
      runtime.agent.agent.session.events.filter(
        (event) => event.type === "tool/call",
      ),
    ).toHaveLength(1);
    expect(
      runtime.agent.agent.session.events.filter(
        (event) => event.type === "tool/result",
      ),
    ).toHaveLength(1);
    expect(runtime.agent.agent.session.deriveMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "Echo: plugin architecture",
    });
  });

  test("loads the clock package's agent contribution", async () => {
    const runtime = await createRuntime();
    runtime.agent.agent.send("/time");
    await runtime.agent.agent.whenIdle();

    expect(
      runtime.agent.agent.session.events.find(
        (event) => event.type === "tool/call",
      ),
    ).toMatchObject({ call: { name: "current_time" } });
    expect(runtime.agent.agent.session.deriveMessages().at(-1)).toMatchObject({
      role: "assistant",
    });
    const finalMessage = runtime.agent.agent.session.deriveMessages().at(-1);
    expect(
      finalMessage?.role === "assistant" ? finalMessage.content : "",
    ).toStartWith("current_time: ");
  });

  test("loads the Fly Sprite computer tools without requiring a token at startup", async () => {
    const runtime = await createRuntime();

    expect(runtime.root.tools.schemas().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["computer_exec", "computer_browser"]),
    );
  });

  test("selects the configured OpenAI-compatible provider", async () => {
    const encoder = new TextEncoder();
    const runtime = await createFoundationRuntime({
      baseUrl: "https://models.example/v1",
      model: "production-model",
      providerId: "production",
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(
                  encoder.encode(
                    'data: {"choices":[{"delta":{"content":"Production response"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
                  ),
                );
                controller.close();
              },
            }),
          ),
        ),
    });
    runtimes.push(runtime);

    runtime.agent.agent.send("hello");
    await runtime.agent.agent.whenIdle();

    expect(runtime.provider).toBe("production");
    expect(runtime.model).toBe("production-model");
    expect(runtime.agent.agent.session.deriveMessages().at(-1)).toMatchObject({
      role: "assistant",
      content: "Production response",
    });
  });
});
