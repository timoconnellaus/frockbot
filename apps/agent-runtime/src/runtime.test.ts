import { afterEach, describe, expect, test } from "bun:test";
import { Context, type Plugin } from "cordis";
import { desktopComputerRuntimePackages } from "../../../applications/foundation/src/desktop-runtime.js";
import type {
  MemoryBucketObject,
  MemoryPluginConfig,
  MemoryVector,
} from "@frockbot/plugin-memory";
import type {
  FoundationResidentRuntime,
  FoundationRuntime,
} from "./runtime.js";
import {
  createFoundationResidentRuntime,
  createFoundationRuntime,
} from "./runtime.js";

const runtimes: FoundationRuntime[] = [];
const residentRuntimes: Array<{
  runtime: FoundationResidentRuntime;
  root: Context;
}> = [];

async function createRuntime(): Promise<FoundationRuntime> {
  const runtime = await createFoundationRuntime(undefined, {
    agentPackages: desktopComputerRuntimePackages,
  });
  runtimes.push(runtime);
  return runtime;
}

afterEach(async () => {
  await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()));
  await Promise.all(
    residentRuntimes.splice(0).map(async ({ runtime, root }) => {
      await runtime.dispose();
      await root.fiber.dispose();
    }),
  );
});

describe("resident foundation Bot runtime", () => {
  test("serializes duplicate projections and mounts one owned registration", async () => {
    const root = new Context();
    const runtime = await createFoundationResidentRuntime(root);
    residentRuntimes.push({ runtime, root });
    let releaseSetup: (() => void) | undefined;
    let reportStarted: (() => void) | undefined;
    const setupStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const setupRelease = new Promise<void>((resolve) => {
      releaseSetup = resolve;
    });
    let mounts = 0;
    let disposals = 0;
    const owned: Plugin.Function = async () => {
      mounts += 1;
      reportStarted?.();
      await setupRelease;
      return () => {
        disposals += 1;
      };
    };
    const projection = {
      generation: 4,
      agentPackages: [
        {
          specifier: "fixture-owned",
          contributionSpecifier: "fixture-owned/agent",
          manifest: {},
          plugin: owned,
        },
      ],
    };

    const first = runtime.project(projection);
    await setupStarted;
    const duplicate = runtime.project(projection);
    releaseSetup?.();
    await Promise.all([first, duplicate]);

    expect(runtime.generation).toBe(4);
    expect(mounts).toBe(1);
    expect(disposals).toBe(0);
    await runtime.dispose();
    expect(disposals).toBe(1);
  });

  test("orders different projection generations and disposes each registration once", async () => {
    const root = new Context();
    const runtime = await createFoundationResidentRuntime(root);
    residentRuntimes.push({ runtime, root });
    let releaseFirst: (() => void) | undefined;
    let reportFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => {
      reportFirstStarted = resolve;
    });
    const firstRelease = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const lifecycle: string[] = [];
    const firstPlugin: Plugin.Function = async () => {
      lifecycle.push("mount-1");
      reportFirstStarted?.();
      await firstRelease;
      return () => lifecycle.push("dispose-1");
    };
    const secondPlugin: Plugin.Function = () => {
      lifecycle.push("mount-2");
      return () => lifecycle.push("dispose-2");
    };

    const first = runtime.project({
      generation: 1,
      agentPackages: [
        {
          specifier: "fixture-first",
          contributionSpecifier: "fixture-first/agent",
          manifest: {},
          plugin: firstPlugin,
        },
      ],
    });
    await firstStarted;
    const second = runtime.project({
      generation: 2,
      agentPackages: [
        {
          specifier: "fixture-second",
          contributionSpecifier: "fixture-second/agent",
          manifest: {},
          plugin: secondPlugin,
        },
      ],
    });
    await Bun.sleep(1);
    const beforeRelease = [...lifecycle];
    releaseFirst?.();
    await Promise.all([first, second]);
    expect(beforeRelease).toEqual(["mount-1"]);
    expect(runtime.generation).toBe(2);
    expect(lifecycle).toEqual(["mount-1", "dispose-1", "mount-2"]);
    await runtime.dispose();
    expect(lifecycle).toEqual(["mount-1", "dispose-1", "mount-2", "dispose-2"]);
  });

  test("remounts runtime generations inside one Cordis root and keeps durable history", async () => {
    const root = new Context();
    const runtime = await createFoundationResidentRuntime(root);
    residentRuntimes.push({ runtime, root });
    await runtime.project({
      generation: 1,
      agentPackages: [],
      systemPromptSection: "Generation one",
    });
    const durableEvents: Parameters<
      NonNullable<Parameters<typeof runtime.execute>[0]["persistSessionEvents"]>
    >[1][] = [];
    const persist = (
      _sessionId: string,
      events: (typeof durableEvents)[number],
    ) => {
      durableEvents.push(events);
      return Promise.resolve();
    };

    const first = await runtime.execute({
      botId: "primary",
      sessionId: "alice:primary",
      previousEvents: [],
      persistSessionEvents: persist,
      text: "hello",
    });
    const firstEvents = [...first.agent.session.events];
    await runtime.project({
      generation: 2,
      agentPackages: [],
      systemPromptSection: "Generation two",
    });
    const second = await runtime.execute({
      botId: "primary",
      sessionId: "alice:primary",
      previousEvents: firstEvents,
      persistSessionEvents: persist,
      text: "again",
    });

    expect(runtime.root).toBe(root);
    expect(runtime.generation).toBe(2);
    expect(second).toBe(first);
    const requests = second.agent.session.events.filter(
      (event) => event.type === "model/request",
    );
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      request: { system: expect.stringContaining("Generation one") },
    });
    expect(requests[1]).toMatchObject({
      request: { system: expect.stringContaining("Generation two") },
    });
    expect(durableEvents.flat()).toEqual([...second.agent.session.events]);
  });

  test("rolls back a partial projection and permits exact retry", async () => {
    const root = new Context();
    const runtime = await createFoundationResidentRuntime(root);
    residentRuntimes.push({ runtime, root });
    let active = 0;
    const owned: Plugin.Function = () => {
      active += 1;
      return () => {
        active -= 1;
      };
    };
    const failing: Plugin.Function = () => {
      throw new Error("projection failed");
    };

    await expect(
      runtime.project({
        generation: 3,
        agentPackages: [
          {
            specifier: "fixture-owned",
            contributionSpecifier: "fixture-owned/agent",
            manifest: {},
            plugin: owned,
          },
          {
            specifier: "fixture-failing",
            contributionSpecifier: "fixture-failing/agent",
            manifest: {},
            plugin: failing,
          },
        ],
      }),
    ).rejects.toThrow("projection failed");
    expect(active).toBe(0);
    expect(runtime.generation).toBeUndefined();

    await runtime.project({
      generation: 3,
      agentPackages: [
        {
          specifier: "fixture-owned",
          contributionSpecifier: "fixture-owned/agent",
          manifest: {},
          plugin: owned,
        },
      ],
    });
    expect(runtime.generation).toBe(3);
    expect(active).toBe(1);
  });
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
    ).toMatchObject({ name: "current_time" });
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
