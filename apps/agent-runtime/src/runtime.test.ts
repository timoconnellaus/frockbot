import { afterEach, describe, expect, test } from "bun:test";
import { desktopComputerRuntimePackages } from "../../../applications/foundation/src/desktop-runtime.js";
import type {
  MemoryBucketObject,
  MemoryPluginConfig,
  MemoryVector,
} from "@frockbot/plugin-memory";
import type { FoundationRuntime } from "./runtime.js";
import { createFoundationRuntime } from "./runtime.js";

const runtimes: FoundationRuntime[] = [];

async function createRuntime(): Promise<FoundationRuntime> {
  const runtime = await createFoundationRuntime(undefined, {
    agentPackages: desktopComputerRuntimePackages,
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

  test("includes the durable Bot description in the normalized model request", async () => {
    const runtime = await createFoundationRuntime(undefined, {
      systemPromptSection:
        "You are Housework.\n\nResearch, marketing, admin.\n\nKeep the household organized.",
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

  test("loads generic Computer tools and the Fly provider without a token at startup", async () => {
    const runtime = await createRuntime();

    expect(runtime.root.tools.schemas().map((tool) => tool.name)).toEqual(
      expect.arrayContaining(["computer_exec", "computer_browser"]),
    );
  });

  test("journals automatically recalled tiered memory in the model request", async () => {
    const objects = new Map<string, string>();
    const vectors = new Map<string, MemoryVector>();
    const memory: MemoryPluginConfig = {
      ownerId: "alice",
      botId: "primary",
      bucket: {
        get: (key) => {
          const body = objects.get(key);
          return Promise.resolve<MemoryBucketObject | null>(
            body === undefined
              ? null
              : {
                  text: () => Promise.resolve(body),
                  json: <T>() => Promise.resolve(JSON.parse(body) as T),
                },
          );
        },
        put: (key, body) => {
          objects.set(key, body);
          return Promise.resolve();
        },
        delete: (key) => {
          objects.delete(key);
          return Promise.resolve();
        },
        list: ({ prefix }) =>
          Promise.resolve({
            objects: [...objects.keys()]
              .filter((key) => key.startsWith(prefix))
              .map((key) => ({ key })),
            truncated: false,
          }),
      },
      vectorize: {
        upsert: (entries) => {
          for (const entry of entries) vectors.set(entry.id, entry);
          return Promise.resolve();
        },
        query: (_query, options) =>
          Promise.resolve({
            matches: [...vectors.values()]
              .filter((vector) => vector.namespace === options.namespace)
              .map((vector) => ({
                id: vector.id,
                score: 1,
                metadata: vector.metadata,
              })),
          }),
        deleteByIds: (ids) => {
          for (const id of ids) vectors.delete(id);
          return Promise.resolve();
        },
      },
      embed: (texts) => Promise.resolve(texts.map(() => [1, 0])),
    };
    const runtime = await createFoundationRuntime(undefined, {
      sessionId: "alice:primary",
      memory,
    });
    runtimes.push(runtime);
    const call = {
      id: "remember",
      name: "memory_write",
      input: {
        path: "pets.md",
        content: "The user's dog is named Rex.",
      },
    };
    const context = {
      botId: "primary",
      agentId: "primary",
      sessionId: "alice:primary",
      signal: new AbortController().signal,
    };
    const preparation = await runtime.root.tools.prepare(call, context);
    if (preparation.kind !== "ready") throw new Error("memory tool was denied");
    await runtime.root.tools.executePrepared(preparation, context);

    runtime.agent.agent.send("What is my dog's name?");
    await runtime.agent.agent.whenIdle();

    const request = runtime.agent.agent.session.events.find(
      (event) => event.type === "model/request",
    );
    expect(request).toMatchObject({
      type: "model/request",
      request: { system: expect.stringContaining("dog is named Rex") },
    });
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
