import { describe, expect, test } from "bun:test";
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  decodePluginDescriptorV1,
  LoopHookListV1,
} from "@frockbot/core/contracts";
import type {
  BotCapabilitiesStub,
  IsolateHealthV1,
  IsolateHookInvocationV1,
  BotIsolateEntrypoint,
  IsolateToolInvocationV1,
  ToolDefinition,
  ToolExecutionContext,
  ToolNamespaceRegistration,
  PluginActionV1,
  PluginGrantV1,
} from "@frockbot/core/contracts";
import {
  BotIsolateContributionHost,
  botIsolateModuleSetHashV1,
  pluginHookEventsV1,
  raceDeadline,
  type BotIsolateHostOptions,
  type BotIsolateLoadedWorker,
  type BotIsolateMemberV1,
  type BotIsolateWorkerCode,
} from "./isolate-host.ts";

const CONTENT_HASH = "a".repeat(64);

function member(
  overrides: {
    actions?: PluginActionV1[];
    grants?: PluginGrantV1[];
    slots?: string[];
    tools?: { name: string; description: string; inputSchema: object }[];
  } = {},
): BotIsolateMemberV1 {
  return {
    packageId: "bot-authored",
    version: "0.0.1",
    artifact: { contentHash: CONTENT_HASH },
    descriptor: decodePluginDescriptorV1({
      id: "bot-authored",
      displayName: "Bot authored",
      version: "0.0.1",
      tools: overrides.tools ?? [
        {
          name: "reverse_text",
          description: "Reverses text",
          inputSchema: { type: "object" },
        },
      ],
      actions: overrides.actions ?? [],
      grants: overrides.grants ?? [],
      ...(overrides.slots ? { slots: overrides.slots } : {}),
      contextKeys: ["user", "bot", "session"],
    }),
  };
}

interface RecordedLoad {
  loaderId: string;
  code: BotIsolateWorkerCode;
}

function fakeIsolate(
  entrypoint: Partial<BotIsolateEntrypoint>,
  loads: RecordedLoad[],
) {
  return {
    get(
      loaderId: string,
      callback: () => Promise<BotIsolateWorkerCode>,
    ): BotIsolateLoadedWorker {
      void callback().then((code) => loads.push({ loaderId, code }));
      return {
        getEntrypoint: () =>
          ({
            health: () => Promise.reject(new Error("health was not stubbed")),
            execute: () => Promise.reject(new Error("execute was not stubbed")),
            hook: () => Promise.reject(new Error("hook was not stubbed")),
            ...entrypoint,
          }) as BotIsolateEntrypoint,
      };
    },
  };
}

type HealthTool = IsolateHealthV1["tools"][number];

function healthy(
  tools: HealthTool[] = [
    {
      name: "reverse_text",
      description: "Reverses text",
      inputSchema: { type: "object" },
      idempotent: true,
    },
  ],
) {
  return {
    schemaVersion: 1 as const,
    ok: true,
    packageId: "bot-authored",
    contractVersion: 1 as const,
    tools,
  };
}

const BINDING_DIGEST = "c".repeat(64);

function host(
  overrides: Partial<BotIsolateHostOptions> & {
    entrypoint?: Partial<BotIsolateEntrypoint>;
  } = {},
) {
  const loads: RecordedLoad[] = [];
  const registered: ToolDefinition[] = [];
  const namespaces: ToolNamespaceRegistration[] = [];
  const { entrypoint, ...rest } = overrides;
  const options: BotIsolateHostOptions = {
    loader: fakeIsolate(
      entrypoint ?? { health: () => Promise.resolve(healthy()) },
      loads,
    ),
    artifacts: {
      loadPackageArtifact: () => Promise.resolve("export const tools = [];"),
    },
    tools: {
      registerNamespace: (namespace) => {
        namespaces.push(namespace);
        return () => {
          const index = namespaces.indexOf(namespace);
          if (index >= 0) namespaces.splice(index, 1);
        };
      },
      register: (definition) => {
        registered.push(definition);
        return () => {
          const index = registered.indexOf(definition);
          if (index >= 0) registered.splice(index, 1);
        };
      },
    },
    hooks: new LoopHookListV1(),
    userId: "user-1",
    botId: "bot-1",
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generationId: "gen-1",
    turnType: "chat",
    recordHookFailure: () => Promise.resolve(),
    capabilities: {} as BotCapabilitiesStub,
    bindingDigest: BINDING_DIGEST,
    compatibilityDate: "2026-08-27",
    ...rest,
  };
  return {
    host: new BotIsolateContributionHost(options),
    loads,
    registered,
    namespaces,
  };
}

function executionContext(): ToolExecutionContext {
  return {
    botId: "bot-1",
    agentId: "bot-1",
    sessionId: "session-1",
    compositionGenerationId: "gen-1",
    turnType: "chat" as const,
    effectId: "tool:1:1:0",
    signal: new AbortController().signal,
  };
}

describe("Bot isolate contribution host", () => {
  test("refuses a descriptor that is not this member's", async () => {
    const { host: subject } = host();
    const mismatched = member();
    await expect(
      subject.prepare({ ...mismatched, packageId: "someone-else" }),
    ).rejects.toThrow(/descriptor does not match its Composition member/);
  });

  test("loads with egress disabled and exactly two modules", async () => {
    const { host: subject, loads } = host();
    await subject.prepare(member());
    expect(loads).toHaveLength(1);
    const code = loads[0]!.code;
    expect(code.globalOutbound).toBeNull();
    expect(Object.keys(code.modules).sort()).toEqual([
      "index.js",
      "package.js",
    ]);
    expect(Object.keys(code.env).sort()).toEqual(["CAPABILITIES", "IDENTITY"]);
    expect(code.mainModule).toBe("index.js");
    expect(code.limits).toEqual({ cpuMs: 5_000, subRequests: 5 });
  });

  test("bakes the User and the declared grants into IDENTITY", async () => {
    const { host: subject, loads } = host();
    await subject.prepare(member({ grants: ["ai", "workspace"] }));
    expect(loads[0]!.code.env.IDENTITY).toEqual({
      userId: "user-1",
      botId: "bot-1",
      generationId: "gen-1",
      packageId: "bot-authored",
      grants: ["ai", "workspace"],
    });
  });

  test("a caller that omits the binding digest does not compile", () => {
    // @ts-expect-error the binding digest is required: an isolate loaded with
    // no digest of its granted bindings would share a loader id across
    // Connection authority and generations.
    void botIsolateModuleSetHashV1(CONTENT_HASH);
    expect(true).toBe(true);
  });

  test("a different binding digest is a different loader id", async () => {
    const { host: subject, loads } = host();
    await subject.prepare(member());
    const other = host({ bindingDigest: "d".repeat(64) });
    await other.host.prepare(member());
    expect(loads[0]!.loaderId).not.toBe(other.loads[0]!.loaderId);
  });

  test("a different grant set is a different loader id", async () => {
    // `env` is baked into a cached loader id, so a member whose grants changed
    // must not be served the isolate built for the grants it used to hold.
    const { host: subject, loads } = host();
    await subject.prepare(member({ grants: ["ai"] }));
    const other = host();
    await other.host.prepare(member({ grants: ["ai", "workspace"] }));
    expect(loads[0]!.loaderId).not.toBe(other.loads[0]!.loaderId);
  });

  test("keys the loader id on the User and identity-bound module set", async () => {
    const { host: subject, loads } = host();
    await subject.prepare(member({ grants: ["ai"] }));
    const expected = await botIsolateModuleSetHashV1(
      CONTENT_HASH,
      BINDING_DIGEST,
      ["ai"],
    );
    expect(loads[0]!.loaderId).toBe(`bot-package:user-1:${expected}`);
  });

  test("health failure is a prepare failure with a diagnostic", async () => {
    const { host: subject } = host({
      entrypoint: {
        health: () =>
          Promise.reject(
            new Error(
              "Failed to start Worker:\nUncaught SyntaxError: Unexpected end of input\n  at package.js:4",
            ),
          ),
      },
    });
    await expect(subject.prepare(member())).rejects.toThrow(
      /failed to mount in its isolate.*package\.js:4/s,
    );
  });

  test("rejects an isolate claiming another package's identity", async () => {
    const { host: subject } = host({
      entrypoint: {
        health: () => Promise.resolve({ ...healthy(), packageId: "other" }),
      },
    });
    await expect(subject.prepare(member())).rejects.toThrow(
      /different package id/,
    );
  });

  test("rejects an isolate that declares no tools", async () => {
    const { host: subject } = host({
      entrypoint: { health: () => Promise.resolve(healthy([])) },
    });
    await expect(subject.prepare(member())).rejects.toThrow(/unhealthy/);
  });

  test("rejects isolate tool names that differ from the descriptor", async () => {
    const { host: subject } = host({
      entrypoint: {
        health: () =>
          Promise.resolve(
            healthy([
              {
                name: "undeclared_tool",
                description: "Not in the descriptor",
                inputSchema: { type: "object" },
                idempotent: false,
              },
            ]),
          ),
      },
    });
    await expect(subject.prepare(member())).rejects.toThrow(
      /tools do not match its descriptor/,
    );
  });

  test("rejects isolate hooks that differ from the declared actions", async () => {
    const { host: subject } = host({
      entrypoint: {
        health: () =>
          Promise.resolve({
            ...healthy(),
            contractVersion: 3 as const,
            hooks: ["tools/post-execute" as const],
          }),
      },
    });
    await expect(
      subject.prepare(member({ actions: ["tools.expose"] })),
    ).rejects.toThrow(/hooks do not match its declared actions/);
  });

  test("runs a declared action after first-party policy with a snapshot", async () => {
    const hooks = new LoopHookListV1();
    const order: string[] = [];
    let seen: IsolateHookInvocationV1 | undefined;
    hooks.add({
      toolExposure: async (_agent, tools, _turn, _step, _signal, next) => {
        order.push(`first-party:${tools[0]?.name}`);
        return next();
      },
    });
    const { host: subject } = host({
      hooks,
      entrypoint: {
        health: () =>
          Promise.resolve({
            ...healthy(),
            contractVersion: 3 as const,
            hooks: ["agent/tool-exposure" as const],
          }),
        hook: (invocation) => {
          seen = invocation;
          order.push(`hook:${invocation.event}`);
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "replaced" as const,
            replacement: [
              {
                name: "hook_visible",
                description: "Visible only for this step.",
                inputSchema: { type: "object" },
              },
            ],
          });
        },
      },
    });
    const prepared = await subject.prepare(
      member({ actions: ["tools.expose"] }),
    );
    const active = await prepared.commit();
    const original = [
      {
        name: "reverse_text",
        description: "Reverses text",
        inputSchema: { type: "object" },
      },
    ];
    const agent = {
      id: "bot-1",
      botId: "bot-1",
      status: "running" as const,
      session: { id: "session-1" },
    } as never;
    const result = await hooks.toolExposure(
      agent,
      original,
      1,
      2,
      new AbortController().signal,
      () => Promise.resolve(original),
    );
    const otherBotResult = await hooks.toolExposure(
      {
        id: "bot-2",
        botId: "bot-2",
        status: "running" as const,
        session: { id: "session-2" },
      } as never,
      original,
      1,
      2,
      new AbortController().signal,
      () => Promise.resolve(original),
    );

    expect(order).toEqual([
      "first-party:reverse_text",
      "hook:agent/tool-exposure",
      "first-party:reverse_text",
    ]);
    expect(result.map((tool) => tool.name)).toEqual(["hook_visible"]);
    expect(otherBotResult).toEqual(original);
    expect(seen?.payload).toMatchObject({
      step: {
        botId: "bot-1",
        sessionId: "session-1",
        compositionGenerationId: "gen-1",
        turn: 1,
        step: 2,
      },
      tools: original,
    });
    expect(seen?.payload).not.toHaveProperty("agent");
    expect(seen?.payload).not.toHaveProperty("signal");

    await active.dispose();
  });

  test("bridges every action in the vocabulary", async () => {
    const hooks = new LoopHookListV1();
    const seen: string[] = [];
    const replacement: Record<string, unknown> = {
      "system-prompt/assemble": {
        text: "hook prompt",
        sections: [{ id: "hook", text: "hook prompt" }],
      },
      "agent/tool-exposure": [],
      "tools/pre-execute": {
        kind: "denied",
        call: { id: "call-1", name: "reverse_text", input: {} },
        result: { content: "hook denied", isError: true },
      },
      "tools/post-execute": { content: "hook result", isError: false },
    };
    const actions: PluginActionV1[] = [
      "context.assemble",
      "tools.expose",
      "tool.call",
      "turn.terminate",
    ];
    const { host: subject } = host({
      hooks,
      entrypoint: {
        health: () =>
          Promise.resolve({
            ...healthy(),
            contractVersion: 3 as const,
            hooks: [...BOT_ISOLATE_HOOK_EVENTS_V1],
          }),
        hook: (invocation) => {
          seen.push(invocation.event);
          return Promise.resolve({
            schemaVersion: 1,
            status: "replaced",
            replacement: replacement[invocation.event],
          });
        },
      },
    });
    const prepared = await subject.prepare(member({ actions }));
    const active = await prepared.commit();
    const agent = {
      id: "bot-1",
      botId: "bot-1",
      status: "running" as const,
      session: { id: "session-1" },
    } as never;
    const signal = new AbortController().signal;
    const call = { id: "call-1", name: "reverse_text", input: {} };
    const toolContext = executionContext();

    expect(
      await hooks.assemblePrompt(
        {
          sessionId: "session-1",
          provider: "scripted",
          model: "scripted-v1",
          turnType: "chat",
        },
        () => Promise.resolve({ text: "core", sections: [] }),
      ),
    ).toMatchObject({ text: "hook prompt" });
    expect(
      await hooks.toolExposure(agent, [], 1, 1, signal, () =>
        Promise.resolve([]),
      ),
    ).toEqual([]);
    expect(
      await hooks.prepareTool(call, toolContext, () =>
        Promise.resolve({ kind: "ready", call, idempotent: true }),
      ),
    ).toMatchObject({ kind: "denied" });
    expect(
      await hooks.toolResult(
        call,
        { content: "core", isError: false },
        toolContext,
        () => Promise.resolve({ content: "core", isError: false }),
      ),
    ).toMatchObject({ content: "hook result" });
    await hooks.turnStopping(agent, 1);

    // The four actions cover all five loop seams: `tool.call` is both halves.
    expect(seen.toSorted()).toEqual([...BOT_ISOLATE_HOOK_EVENTS_V1].toSorted());
    expect(pluginHookEventsV1(actions).toSorted()).toEqual(
      [...BOT_ISOLATE_HOOK_EVENTS_V1].toSorted(),
    );

    await active.dispose();
  });

  test("a throwing or timed-out hook passes through and records failure", async () => {
    for (const hook of [
      () => Promise.reject(new Error("hook exploded")),
      () => new Promise<never>(() => {}),
    ]) {
      const failures: string[] = [];
      const hooks = new LoopHookListV1();
      const { host: subject } = host({
        hooks,
        deadlineMs: 5,
        recordHookFailure: (failure) => {
          failures.push(failure.message);
          return Promise.resolve();
        },
        entrypoint: {
          health: () =>
            Promise.resolve({
              ...healthy(),
              contractVersion: 3 as const,
              hooks: ["agent/tool-exposure" as const],
            }),
          hook,
        },
      });
      const prepared = await subject.prepare(
        member({ actions: ["tools.expose"] }),
      );
      await prepared.commit();
      const original = [
        {
          name: "reverse_text",
          description: "Reverses text",
          inputSchema: { type: "object" },
        },
      ];
      const result = await hooks.toolExposure(
        {
          id: "bot-1",
          botId: "bot-1",
          status: "running",
          session: { id: "session-1" },
        } as never,
        original,
        1,
        1,
        new AbortController().signal,
        () => Promise.resolve(original),
      );
      expect(result).toEqual(original);
      expect(failures).toHaveLength(1);
    }
  });

  test("registers one tool per health entry and executes it over RPC", async () => {
    let seen: IsolateToolInvocationV1 | undefined;
    const {
      host: subject,
      registered,
      namespaces,
    } = host({
      entrypoint: {
        health: () => Promise.resolve(healthy()),
        execute: (invocation) => {
          seen = invocation;
          return Promise.resolve({
            schemaVersion: 1 as const,
            content: "ba",
            isError: false,
          });
        },
      },
    });
    const prepared = await subject.prepare(member());
    const active = await prepared.commit();
    expect(registered).toHaveLength(1);
    expect(registered[0]!.name).toBe("reverse_text");
    expect(registered[0]!.namespace).toBe("bot-authored");
    expect(registered[0]!.idempotent).toBe(true);
    // Not external: this is the deployment's own reviewed code reached over no
    // network, and the dispatch guard refuses an external call that carries no
    // `mcpDetails.description` — a field nothing ever told the model to send
    // for an isolate-hosted Package.
    expect(namespaces).toEqual([
      {
        name: "bot-authored",
        external: false,
        status: "ready",
      },
    ]);

    const result = await registered[0]!.execute(
      { text: "ab" },
      executionContext(),
    );
    expect(result).toEqual({ content: "ba", isError: false });
    expect(seen?.deadlineMs).toBe(15_000);
    expect(seen?.generationId).toBe("gen-1");

    await active.dispose();
    expect(registered).toHaveLength(0);
    expect(namespaces).toHaveLength(0);
  });

  test("carries a tool's own turn admission from the health report", async () => {
    const { host: subject, registered } = host({
      entrypoint: {
        health: () =>
          Promise.resolve({
            ...healthy([
              {
                name: "reverse_text",
                description: "Reverses text",
                inputSchema: { type: "object" },
                idempotent: true,
                admission: { turnTypes: ["automation"] },
              },
            ]),
            contractVersion: 2 as const,
          }),
      },
    });
    const prepared = await subject.prepare(member());
    await prepared.commit();
    expect(registered[0]!.admission).toEqual({ turnTypes: ["automation"] });
  });

  test("an undecodable isolate result is a tool error, not a throw", async () => {
    const { host: subject, registered } = host({
      entrypoint: {
        health: () => Promise.resolve(healthy()),
        execute: () => Promise.resolve({ content: "ba" } as never),
      },
    });
    const prepared = await subject.prepare(member());
    await prepared.commit();
    expect(await registered[0]!.execute({}, executionContext())).toMatchObject({
      isError: true,
    });
  });

  test("an unavailable artifact names the package and the hash", async () => {
    const { host: subject } = host({
      artifacts: {
        loadPackageArtifact: () => Promise.reject(new Error("not found")),
      },
    });
    await expect(subject.prepare(member())).rejects.toThrow(
      new RegExp(`"bot-authored" artifact "${CONTENT_HASH}" is unavailable`),
    );
  });
});

describe("the extension points this deployment has not opened", () => {
  test("refuses a grant with no host behind it", async () => {
    const { host: subject } = host();
    await expect(
      subject.prepare(member({ grants: ["storage", "ai"] })),
    ).rejects.toThrow(/has not opened: storage/);
  });

  test("refuses the Memory actions until Memory is an app module", async () => {
    const { host: subject } = host();
    await expect(
      subject.prepare(member({ actions: ["memory.read", "memory.write"] })),
    ).rejects.toThrow(/no loop seam yet: memory\.read, memory\.write/);
  });

  test("refuses slots until the renderer lands", async () => {
    const { host: subject } = host();
    await expect(
      subject.prepare(member({ slots: ["composer.toolbar"] })),
    ).rejects.toThrow(/declares slots/);
  });
});

describe("the Durable Object side of the deadline", () => {
  test("resolves work inside the deadline", async () => {
    await expect(raceDeadline(() => Promise.resolve(1), 1_000)).resolves.toBe(
      1,
    );
  });

  test("rejects work that outlives the deadline", async () => {
    await expect(raceDeadline(() => new Promise(() => {}), 10)).rejects.toThrow(
      /exceeded its deadline of 10ms/,
    );
  });

  test("rejects immediately when the Turn is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      raceDeadline(() => new Promise(() => {}), 10_000, controller.signal),
    ).rejects.toThrow(/was cancelled/);
  });

  test("rejects when the Turn is cancelled mid-flight", async () => {
    const controller = new AbortController();
    const pending = raceDeadline(
      () => new Promise(() => {}),
      10_000,
      controller.signal,
    );
    controller.abort();
    await expect(pending).rejects.toThrow(/was cancelled/);
  });

  test("refuses a deadline outside the contract bound", async () => {
    await expect(raceDeadline(() => Promise.resolve(1), 0)).rejects.toThrow(
      /out of range/,
    );
  });
});
