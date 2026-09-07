import { afterEach, describe, expect, test } from "bun:test";
import {
  createMemoryRuntimeFeature,
  MemoryStore,
  botMemoryRootV1,
  createTestMemoryFilesV1,
} from "@frockbot/app/memory";
import clockFeature from "@frockbot/app/clock/agent";
import echoFeature from "@frockbot/app/echo/agent";
import identityFeature from "@frockbot/app/identity/agent";
import foundationProviderFeature from "@frockbot/providers/foundation/runtime";
import type {
  FoundationAgentPackage,
  FoundationRuntime,
} from "./agent-runtime.js";
import { createFoundationRuntime } from "./agent-runtime.js";

const runtimes: FoundationRuntime[] = [];
const allowEffect = () => Promise.resolve(true);

/**
 * The Packages a host mounts on every Turn. This runtime composes no list of
 * its own, so the test names the four it asserts against.
 */
function basePackages(): FoundationAgentPackage[] {
  return [
    { id: "identity", feature: identityFeature },
    { id: "provider-foundation", feature: foundationProviderFeature },
    { id: "echo", feature: echoFeature },
    { id: "clock", feature: clockFeature },
  ];
}

async function createRuntime(): Promise<FoundationRuntime> {
  const runtime = await createFoundationRuntime(undefined, {
    admitEffect: allowEffect,
    agentPackages: basePackages(),
  });
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
});

describe("foundation runtime", () => {
  test("streams a deterministic response through the custom loop", async () => {
    const runtime = await createRuntime();
    runtime.agent.agent.send("hello");
    await runtime.agent.agent.whenIdle();

    const chunks = runtime.agent.agent.session.events
      .filter((event) => event.type === "assistant/chunk")
      .map((event) => event.text)
      .join("");
    expect(chunks).toBe("Built-in model: hello");
    expect(runtime.agent.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("includes the durable Bot description in the normalized model request", async () => {
    const runtime = await createFoundationRuntime(undefined, {
      systemPromptSection:
        "You are Housework.\n\nResearch, marketing, admin.\n\nKeep the household organized.",
      admitEffect: allowEffect,
      agentPackages: basePackages(),
    });
    runtimes.push(runtime);
    runtime.agent.agent.send("hello");
    await runtime.agent.agent.whenIdle();

    const request = runtime.agent.agent.session.events.find(
      (event) => event.type === "model/request",
    );
    expect(request).toMatchObject({
      type: "model/request",
      request: {
        system: expect.stringContaining("Keep the household organized."),
      },
    });
  });

  test("loads the echo capability as a tool feature", async () => {
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
    ).toMatchObject({
      name: "call_dynamic_tool",
      input: { namespace: "frockbot", toolName: "current_time" },
    });
    expect(runtime.agent.agent.session.deriveMessages().at(-1)).toMatchObject({
      role: "assistant",
    });
    const finalMessage = runtime.agent.agent.session.deriveMessages().at(-1);
    expect(
      finalMessage?.role === "assistant" ? finalMessage.content : "",
    ).toStartWith("current_time: ");
  });

  test("keeps a manifest-bounded tool out of a chat Turn's model request", async () => {
    const runtime = await createFoundationRuntime(undefined, {
      admitEffect: allowEffect,
      agentPackages: basePackages(),
    });
    runtimes.push(runtime);
    // The producer is the Composition host: a Capability whose manifest admits
    // only automation turns registers its tools under that ceiling. The name
    // is a probe rather than a shipped tool, so the assertion stays about the
    // ceiling and not about what any Package happens to contribute.
    runtime.services.tools.register(
      {
        name: "automation_only_probe",
        description: "Hands off to the parent conversation.",
        inputSchema: { type: "object", properties: {} },
        idempotent: false,
        execute: () =>
          Promise.resolve({ content: "handed off", isError: false }),
      },
      { admissionCeiling: ["automation"] },
    );

    runtime.agent.agent.send("hello");
    await runtime.agent.agent.whenIdle();

    const request = runtime.agent.agent.session.events.find(
      (event) => event.type === "model/request",
    );
    const offered =
      request?.type === "model/request"
        ? request.request.tools.map((tool) => tool.name)
        : [];
    expect(offered).not.toContain("automation_only_probe");
    expect(
      runtime.services.tools
        .schemas({ turnType: "automation" })
        .map((tool) => tool.name),
    ).toContain("automation_only_probe");
  });

  test("mounts the Agent on the turn type the root was created with", async () => {
    const runtime = await createFoundationRuntime(undefined, {
      admitEffect: allowEffect,
      turnType: "automation",
      agentPackages: basePackages(),
    });
    runtimes.push(runtime);

    runtime.agent.agent.send("hello");
    await runtime.agent.agent.whenIdle();

    expect(
      runtime.agent.agent.session.events.find(
        (event) => event.type === "turn/admission",
      ),
    ).toMatchObject({ turnType: "automation" });
  });

  test("injects Memory into the model request, through the Memory Package", async () => {
    const owner = { userId: "alice", botId: "primary" };
    const store = new MemoryStore({
      files: createTestMemoryFilesV1({ userId: owner.userId }),
      owner,
    });
    const runtime = await createFoundationRuntime(undefined, {
      botId: owner.botId,
      sessionId: "alice:primary",
      admitEffect: allowEffect,
      agentPackages: [
        ...basePackages(),
        {
          id: "@frockbot/app/memory",
          feature: createMemoryRuntimeFeature({
            owner,
            store,
            writer: {
              sessionId: "alice:primary",
              turnId: "turn-1",
              runId: "run-1",
            },
          }),
        },
      ],
    });
    runtimes.push(runtime);
    // The fact is recorded the way a previous Turn's `memory_write` recorded
    // it: through the Package's own writer, into this Bot's own Memory root.
    const written = await store.write({
      root: botMemoryRootV1(owner),
      tier: "profile",
      fact: "The user's dog is named Rex.",
      writer: {
        kind: "bot",
        botId: owner.botId,
        sessionId: "alice:primary",
        turnId: "turn-0",
        runId: "run-0",
      },
    });
    expect(written.status).toBe("ok");

    runtime.agent.agent.send("What is my dog's name?");
    await runtime.agent.agent.whenIdle();

    const requests = runtime.agent.agent.session.events.filter(
      (event) => event.type === "model/request",
    );
    expect(requests.at(-1)).toMatchObject({
      type: "model/request",
      request: { system: expect.stringContaining("dog is named Rex") },
    });
    expect(
      runtime.agent.agent.session.events.some(
        (event) => event.type === "memory/injected",
      ),
    ).toBe(true);
  });

  test("selects the configured OpenAI-compatible provider", async () => {
    const encoder = new TextEncoder();
    const runtime = await createFoundationRuntime(
      {
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
      },
      {
        admitEffect: allowEffect,
      },
    );
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
