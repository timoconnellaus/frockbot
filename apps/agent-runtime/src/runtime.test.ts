import { afterEach, describe, expect, test } from "bun:test";
import type { SessionEvent, ToolDefinition } from "@frockbot/kernel-contracts";
import { Context, type Plugin } from "cordis";
import { desktopComputerRuntimePackages } from "../../../applications/foundation/src/desktop-runtime.js";
import {
  createMemoryRuntimePlugin,
  memoryManifest,
  MemoryStore,
  botMemoryRootV1,
  createTestMemoryFilesV1,
} from "@frockbot/plugin-memory";
import type {
  FoundationResidentProjection,
  FoundationResidentRuntime,
  FoundationRuntime,
} from "./runtime.js";
import {
  createFoundationResidentRuntime,
  createFoundationRuntime,
} from "./runtime.js";

const runtimes: FoundationRuntime[] = [];
const allowEffect = () => Promise.resolve(true);
const residentRuntimes: Array<{
  runtime: FoundationResidentRuntime;
  root: Context;
}> = [];

function openToolEvents(toolName: string): SessionEvent[] {
  const timestamp = "2026-08-30T00:00:00.000Z";
  return [
    { type: "session/created", createdAt: timestamp },
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
    {
      type: "model/request",
      turn: 1,
      step: 1,
      request: {
        requestId: "request-1",
        provider: "foundation",
        model: "foundation-model",
        system: "",
        messages: [],
        tools: [],
      },
    },
    {
      type: "assistant/message",
      turn: 1,
      step: 1,
      requestId: "request-1",
      text: "",
      toolCalls: [{ id: "provider-call", name: toolName, input: {} }],
    },
    {
      type: "tool/call",
      turn: 1,
      step: 1,
      occurrenceId: "tool:1:1:0",
      name: toolName,
      input: {},
    },
  ].map((event, seq) => ({ ...event, seq, timestamp })) as SessionEvent[];
}

function reconciliationPackage(
  tool: ToolDefinition,
  onModelRequest: () => void,
): FoundationResidentProjection["agentPackages"][number] {
  const plugin: Plugin.Function = (ctx) => {
    const unregisterTool = ctx.tools.register(tool);
    const unregisterModelObserver = ctx.on(
      "llm/stream",
      (_request, _signal, next) => {
        onModelRequest();
        return next();
      },
    );
    return () => {
      unregisterModelObserver();
      unregisterTool();
    };
  };
  plugin.inject = ["llm", "tools"];
  return {
    specifier: `fixture-${tool.name}`,
    contributionSpecifier: `fixture-${tool.name}/agent`,
    manifest: {},
    plugin,
  };
}

async function createRuntime(): Promise<FoundationRuntime> {
  const runtime = await createFoundationRuntime(undefined, {
    agentPackages: desktopComputerRuntimePackages,
    admitEffect: allowEffect,
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

  test("cancels only the exact resident session and run", async () => {
    const root = new Context();
    const runtime = await createFoundationResidentRuntime(root);
    residentRuntimes.push({ runtime, root });
    await runtime.project({ generation: 1, agentPackages: [] });
    const exact = { sessionId: "alice:primary", runId: "run-1" };
    const otherSession = { sessionId: "alice:other", runId: "run-1" };
    const otherRun = { sessionId: "alice:primary", runId: "run-2" };

    expect(runtime.cancel(exact)).toBe(false);

    const handle = await runtime.execute({
      admitEffect: allowEffect,
      botId: "primary",
      sessionId: "alice:primary",
      runId: "run-1",
      previousEvents: [],
      persistSessionEvents: () => Promise.resolve(),
      beforeStart: () => Promise.resolve(true),
      text: "hello",
    });

    // The run settled, so a late Stop can no longer reach the resident Agent.
    expect(runtime.cancel(exact)).toBe(false);
    expect(runtime.cancel(otherSession)).toBe(false);
    expect(runtime.cancel(otherRun)).toBe(false);
    expect(handle.agent.status).toBe("idle");
  });

  test("makes a run addressable before a durable activation fence", async () => {
    const root = new Context();
    const runtime = await createFoundationResidentRuntime(root);
    residentRuntimes.push({ runtime, root });
    await runtime.project({ generation: 1, agentPackages: [] });
    let addressed = false;

    await expect(
      runtime.execute({
        admitEffect: allowEffect,
        botId: "primary",
        sessionId: "alice:primary",
        runId: "run-fenced",
        previousEvents: [],
        persistSessionEvents: () => Promise.resolve(),
        beforeStart: () => {
          addressed = runtime.cancel({
            sessionId: "alice:primary",
            runId: "run-fenced",
          });
          return Promise.resolve(false);
        },
        text: "must not start",
      }),
    ).rejects.toThrow("resident Bot execution was durably fenced");

    expect(addressed).toBe(true);
    expect(
      runtime.cancel({ sessionId: "alice:primary", runId: "run-fenced" }),
    ).toBe(false);
    expect(root.agents.get("primary")?.session.events).not.toContainEqual(
      expect.objectContaining({ type: "model/request" }),
    );
  });

  test("cold recovery retries an idempotent tool with the same effect id before Stop cancellation", async () => {
    const root = new Context();
    const runtime = await createFoundationResidentRuntime(root);
    residentRuntimes.push({ runtime, root });
    const effectIds: string[] = [];
    let modelRequests = 0;
    const tool: ToolDefinition = {
      name: "recover-idempotent",
      description: "Idempotent recovery fixture.",
      inputSchema: { type: "object" },
      idempotent: true,
      execute(_input, context) {
        effectIds.push(context.effectId);
        return Promise.resolve({ content: "original effect", isError: false });
      },
    };
    await runtime.project({
      generation: 1,
      agentPackages: [
        reconciliationPackage(tool, () => {
          modelRequests += 1;
        }),
      ],
    });
    const cancellation = {
      sessionId: "alice:primary",
      runId: "run-idempotent-stop",
    };
    let durable = openToolEvents(tool.name);
    let signalled = false;

    const handle = await runtime.execute({
      admitEffect: allowEffect,
      botId: "primary",
      ...cancellation,
      previousEvents: durable,
      persistSessionEvents: async (_sessionId, events) => {
        durable = [...durable, ...structuredClone([...events])];
        if (
          !signalled &&
          events.some(
            (event) =>
              event.type === "tool/result" &&
              event.occurrenceId === "tool:1:1:0",
          )
        ) {
          signalled = true;
          expect(runtime.cancel(cancellation)).toBe(true);
        }
      },
      beforeStart: () => Promise.resolve(true),
      resume: true,
      text: "",
    });

    expect(effectIds).toEqual(["tool:1:1:0"]);
    expect(modelRequests).toBe(0);
    expect(signalled).toBe(true);
    expect(handle.agent.session.events).toContainEqual(
      expect.objectContaining({
        type: "tool/result",
        occurrenceId: "tool:1:1:0",
        status: "completed",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
    });
  });

  test("cold recovery retrieves a non-idempotent tool result before Stop cancellation", async () => {
    const root = new Context();
    const runtime = await createFoundationResidentRuntime(root);
    residentRuntimes.push({ runtime, root });
    const reconciled: string[] = [];
    let executions = 0;
    let modelRequests = 0;
    const tool: ToolDefinition = {
      name: "recover-non-idempotent",
      description: "Non-idempotent recovery fixture.",
      inputSchema: { type: "object" },
      execute() {
        executions += 1;
        return Promise.resolve({ content: "duplicate", isError: false });
      },
      reconcile(_input, context) {
        reconciled.push(context.effectId);
        return Promise.resolve({
          status: "recovered",
          result: { content: "retrieved original", isError: false },
        });
      },
    };
    await runtime.project({
      generation: 1,
      agentPackages: [
        reconciliationPackage(tool, () => {
          modelRequests += 1;
        }),
      ],
    });
    const cancellation = {
      sessionId: "alice:primary",
      runId: "run-recovered-stop",
    };
    let durable = openToolEvents(tool.name);

    const handle = await runtime.execute({
      admitEffect: allowEffect,
      botId: "primary",
      ...cancellation,
      previousEvents: durable,
      persistSessionEvents: async (_sessionId, events) => {
        durable = [...durable, ...structuredClone([...events])];
        if (
          events.some(
            (event) =>
              event.type === "tool/result" &&
              event.occurrenceId === "tool:1:1:0",
          )
        ) {
          runtime.cancel(cancellation);
        }
      },
      beforeStart: () => Promise.resolve(true),
      resume: true,
      text: "",
    });

    expect(executions).toBe(0);
    expect(reconciled).toEqual(["tool:1:1:0"]);
    expect(modelRequests).toBe(0);
    expect(durable).toContainEqual(
      expect.objectContaining({
        type: "tool/result",
        occurrenceId: "tool:1:1:0",
        content: "retrieved original",
      }),
    );
    expect(handle.agent.session.events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "cancelled",
    });
  });

  test("cold recovery keeps an unavailable non-idempotent effect resumable across eviction", async () => {
    const reconciled: string[] = [];
    let executions = 0;
    let modelRequests = 0;
    const tool: ToolDefinition = {
      name: "unavailable-non-idempotent",
      description: "Unavailable recovery fixture.",
      inputSchema: { type: "object" },
      execute() {
        executions += 1;
        return Promise.resolve({ content: "duplicate", isError: false });
      },
      reconcile(_input, context) {
        reconciled.push(context.effectId);
        return Promise.resolve({
          status: "unavailable",
          reason: "provider result is still pending",
        });
      },
    };
    const durable = openToolEvents(tool.name);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      const root = new Context();
      const runtime = await createFoundationResidentRuntime(root);
      residentRuntimes.push({ runtime, root });
      await runtime.project({
        generation: 1,
        agentPackages: [
          reconciliationPackage(tool, () => {
            modelRequests += 1;
          }),
        ],
      });
      const handle = await runtime.execute({
        admitEffect: allowEffect,
        botId: "primary",
        sessionId: "alice:primary",
        runId: "run-unavailable-stop",
        previousEvents: durable,
        persistSessionEvents: () =>
          Promise.reject(new Error("unavailable recovery must not append")),
        beforeStart: () => Promise.resolve(true),
        resume: true,
        text: "",
      });
      expect(handle.agent.session.events).toEqual(durable);
    }

    expect(executions).toBe(0);
    expect(reconciled).toEqual(["tool:1:1:0", "tool:1:1:0"]);
    expect(modelRequests).toBe(0);
    expect(
      durable.some(
        (event) => event.type === "tool/result" || event.type === "turn/end",
      ),
    ).toBe(false);
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
      admitEffect: allowEffect,
      botId: "primary",
      sessionId: "alice:primary",
      runId: "run-1",
      previousEvents: [],
      persistSessionEvents: persist,
      beforeStart: () => Promise.resolve(true),
      text: "hello",
    });
    const firstEvents = [...first.agent.session.events];
    await runtime.project({
      generation: 2,
      agentPackages: [],
      systemPromptSection: "Generation two",
    });
    const second = await runtime.execute({
      admitEffect: allowEffect,
      botId: "primary",
      sessionId: "alice:primary",
      runId: "run-2",
      previousEvents: firstEvents,
      persistSessionEvents: persist,
      beforeStart: () => Promise.resolve(true),
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
      admitEffect: allowEffect,
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

  test("keeps a manifest-bounded tool out of a chat Turn's model request", async () => {
    const runtime = await createFoundationRuntime(undefined, {
      admitEffect: allowEffect,
    });
    runtimes.push(runtime);
    // The producer is the Composition host: a Capability whose manifest admits
    // only automation turns registers its tools under that ceiling.
    runtime.root.tools.register(
      {
        name: "wake_parent",
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
    expect(offered).not.toContain("wake_parent");
    expect(
      runtime.root.tools
        .schemas({ turnType: "automation" })
        .map((tool) => tool.name),
    ).toContain("wake_parent");
  });

  test("mounts the Agent on the turn type the root was created with", async () => {
    const runtime = await createFoundationRuntime(undefined, {
      admitEffect: allowEffect,
      turnType: "automation",
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

  test("loads generic Computer tools and the Fly provider without a token at startup", async () => {
    const runtime = await createRuntime();

    expect(
      runtime.root.tools.schemas({ turnType: "chat" }).map((tool) => tool.name),
    ).toEqual(expect.arrayContaining(["computer_exec", "computer_browser"]));
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
        {
          specifier: "@frockbot/plugin-memory",
          contributionSpecifier: "@frockbot/plugin-memory/agent",
          manifest: memoryManifest,
          plugin: createMemoryRuntimePlugin({
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
