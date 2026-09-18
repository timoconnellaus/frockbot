import { describe, expect, test } from "bun:test";
import {
  BOT_ISOLATE_CONTEXT_KEYS_V1,
  decodePluginWorkerHookResultV1,
} from "@frockbot/core/contracts";
import {
  BOT_ISOLATE_DEADLINE_SOURCE,
  BOT_ISOLATE_ERROR_TEXT_SOURCE,
  BOT_ISOLATE_HOOK_CHAIN_SOURCE,
  BOT_ISOLATE_HOOK_VALUE_KEYS_V1,
  BOT_ISOLATE_CARD_SOURCE,
  BOT_ISOLATE_DECLARATION_SOURCE,
  BOT_ISOLATE_INVOCATION_SOURCE,
  BOT_ISOLATE_MODEL_PROVIDER_SOURCE,
  BOT_ISOLATE_MODEL_SOURCE,
  BOT_ISOLATE_NARROW_CONTEXT_KEYS_V1,
  BOT_ISOLATE_NARROW_CONTEXT_SOURCE_V1,
  BOT_ISOLATE_TRIGGER_SOURCE,
  BOT_ISOLATE_VIEW_SOURCE,
  PLUGIN_WORKER_MAIN_MODULE,
  pluginWorkerIndexSourceV1,
  pluginWorkerModuleMap,
  pluginWorkerModulePathV1,
} from "./plugin-worker-wrapper.ts";

type Deadline = (work: () => unknown, deadlineMs: number) => Promise<unknown>;

// The wrapper ships as generated text, so the tested function is compiled from
// exactly the source the wrapper embeds rather than from a TypeScript twin.
const withIsolateDeadline = new Function(
  `${BOT_ISOLATE_DEADLINE_SOURCE}\nreturn withIsolateDeadline;`,
)() as Deadline;

type Decode = (value: unknown) => unknown;

const decodeInvocation = new Function(
  `${BOT_ISOLATE_INVOCATION_SOURCE}\nreturn decodeInvocation;`,
)() as Decode;
const decodeHookInvocation = new Function(
  `${BOT_ISOLATE_INVOCATION_SOURCE}\nreturn decodeHookInvocation;`,
)() as Decode;
const decodeTriggerInvocation = new Function(
  `${BOT_ISOLATE_INVOCATION_SOURCE}\nreturn decodeTriggerInvocation;`,
)() as Decode;
const decodeCardActionInvocation = new Function(
  `${BOT_ISOLATE_INVOCATION_SOURCE}\nreturn decodeCardActionInvocation;`,
)() as Decode;
const decodeRenderCardInvocation = new Function(
  `${BOT_ISOLATE_INVOCATION_SOURCE}\nreturn decodeRenderCardInvocation;`,
)() as Decode;

type NarrowContext = (
  env: Record<string, unknown>,
  invocation: Record<string, unknown>,
  plugin: Record<string, unknown>,
  deadlineMs: number,
  transportId?: string,
) => Record<string, unknown>;

const narrowContext = new Function(
  `${BOT_ISOLATE_MODEL_SOURCE}\n${BOT_ISOLATE_NARROW_CONTEXT_SOURCE_V1}\nreturn narrowContext;`,
)() as NarrowContext;

const declarations = new Function(
  `${BOT_ISOLATE_INVOCATION_SOURCE}\n${BOT_ISOLATE_DECLARATION_SOURCE}\nreturn { declaredTools, declaredHooks, declaredServices, declaredTriggers, declaredViews, declaredCards, declaredModelProviders };`,
)() as {
  declaredTools: (module: unknown, pluginId: string) => unknown[];
  declaredHooks: (module: unknown, pluginId: string) => string[];
  declaredServices: (module: unknown, pluginId: string) => unknown;
  declaredTriggers: (module: unknown, pluginId: string) => string[];
  declaredViews: (module: unknown, pluginId: string) => string[];
  declaredCards: (
    module: unknown,
    pluginId: string,
  ) => { id: string; actions: string[] }[];
  declaredModelProviders: (module: unknown, pluginId: string) => string[];
};

function invocation(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    pluginId: "weather",
    tool: "reverse_text",
    input: { text: "a" },
    botId: "bot-1",
    sessionId: "user-1:bot-1",
    runId: "run-1",
    turnId: "turn-1",
    generationId: "gen-1",
    deadlineMs: 1_000,
    ...overrides,
  };
}

function never(): Promise<never> {
  return new Promise(() => {});
}

describe("the generated wrapper's deadline", () => {
  test("resolves work that finishes inside the deadline", async () => {
    await expect(withIsolateDeadline(() => "done", 1_000)).resolves.toBe(
      "done",
    );
  });

  test("rejects work that outlives the deadline", async () => {
    await expect(withIsolateDeadline(never, 10)).rejects.toThrow(
      "isolate invocation exceeded its deadline of 10ms",
    );
  });

  test("turns a synchronous throw into a rejection", async () => {
    await expect(
      withIsolateDeadline(() => {
        throw new Error("boom");
      }, 1_000),
    ).rejects.toThrow("boom");
  });

  test("refuses a deadline outside the contract bound", async () => {
    for (const deadline of [0, -1, 60_001, 1.5, Number.NaN]) {
      await expect(withIsolateDeadline(() => "done", deadline)).rejects.toThrow(
        "isolate invocation deadline is out of range",
      );
    }
  });

  test("does not hold the isolate open after the work settles", async () => {
    const started = Date.now();
    await withIsolateDeadline(() => "done", 50_000);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

type HookPlugin = {
  pluginId: string;
  ok: boolean;
  hooks: string[];
  module: { hooks: Record<string, (payload: unknown) => unknown> };
};

type RunHookChain = (
  plugins: HookPlugin[],
  invocation: Record<string, unknown>,
  contextFor: (plugin: HookPlugin, deadlineMs: number) => unknown,
) => Promise<{
  status: string;
  replacement?: unknown;
  failures: { pluginId: string; reason: string }[];
}>;

const runHookChain = new Function(
  [
    `const HOOK_VALUE_KEYS = ${JSON.stringify(BOT_ISOLATE_HOOK_VALUE_KEYS_V1)};`,
    BOT_ISOLATE_DEADLINE_SOURCE,
    BOT_ISOLATE_ERROR_TEXT_SOURCE,
    BOT_ISOLATE_HOOK_CHAIN_SOURCE,
    "return runHookChain;",
  ].join("\n"),
)() as RunHookChain;

function hookPlugin(
  pluginId: string,
  hook: (payload: unknown) => unknown,
): HookPlugin {
  return {
    pluginId,
    ok: true,
    hooks: ["agent/tool-exposure"],
    module: { hooks: { "agent/tool-exposure": hook } },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("the generated wrapper's hook chain", () => {
  function hookInvocation(deadlineMs: number, enabled: string[]) {
    return {
      event: "agent/tool-exposure",
      payload: { tools: ["base"] },
      enabled,
      deadlineMs,
    };
  }

  test("hands each plugin the value the one before it left", async () => {
    const seen: unknown[] = [];
    const result = await runHookChain(
      [
        hookPlugin("first", (payload) => {
          seen.push((payload as { tools: string[] }).tools);
          return ["first"];
        }),
        hookPlugin("second", (payload) => {
          seen.push((payload as { tools: string[] }).tools);
          return ["first", "second"];
        }),
      ],
      hookInvocation(5_000, ["first", "second"]),
      () => ({}),
    );
    expect(seen).toEqual([["base"], ["first"]]);
    expect(result).toMatchObject({
      status: "replaced",
      replacement: ["first", "second"],
      failures: [],
    });
  });

  test("spends one deadline across the chain, naming a plugin left no time", async () => {
    const ran: string[] = [];
    const started = Date.now();
    const result = await runHookChain(
      [
        hookPlugin("slow", async () => {
          ran.push("slow");
          await sleep(400);
          return ["slow"];
        }),
        hookPlugin("starved", () => {
          ran.push("starved");
          return ["starved"];
        }),
      ],
      hookInvocation(150, ["slow", "starved"]),
      () => ({}),
    );
    expect(Date.now() - started).toBeLessThan(400);
    expect(ran).toEqual(["slow"]);
    expect(result.status).toBe("unchanged");
    expect(result.failures.map((failure) => failure.pluginId)).toEqual([
      "slow",
      "starved",
    ]);
    expect(result.failures[1]!.reason).toBe(
      "the hook chain exhausted its deadline of 150ms before this plugin ran",
    );
  });

  test("bounds a plugin's failure reason to what the kernel will decode", async () => {
    const result = await runHookChain(
      [
        hookPlugin("provider", () => ["provider"]),
        hookPlugin("consumer", () => {
          throw new Error("x".repeat(4_000));
        }),
      ],
      hookInvocation(1_000, ["provider", "consumer"]),
      () => ({}),
    );
    const decoded = decodePluginWorkerHookResultV1(result);
    expect(decoded.status).toBe("replaced");
    expect(decoded.failures.map((failure) => failure.pluginId)).toEqual([
      "consumer",
    ]);
  });

  test("names a plugin that threw a value with no message", async () => {
    const result = await runHookChain(
      [
        hookPlugin("provider", () => ["provider"]),
        hookPlugin("consumer", () => {
          throw "";
        }),
      ],
      hookInvocation(1_000, ["provider", "consumer"]),
      () => ({}),
    );
    expect(decodePluginWorkerHookResultV1(result)).toEqual({
      schemaVersion: 1,
      status: "replaced",
      replacement: ["provider"],
      failures: [{ pluginId: "consumer", reason: "unknown error" }],
    });
  });

  test("hands each plugin the deadline it actually has, not the chain's", async () => {
    const slices: number[] = [];
    await runHookChain(
      [
        hookPlugin("first", async () => {
          await sleep(120);
        }),
        hookPlugin("second", () => undefined),
      ],
      hookInvocation(1_000, ["first", "second"]),
      (_plugin, deadlineMs) => {
        slices.push(deadlineMs);
        return {};
      },
    );
    expect(slices).toHaveLength(2);
    expect(slices[0]).toBeLessThanOrEqual(1_000);
    expect(slices[1]).toBeLessThan(slices[0]! - 100);
  });
});

describe("the generated wrapper's invocation decoders", () => {
  test("accept exactly the declared tool invocation, naming its plugin", () => {
    expect(decodeInvocation(invocation())).toMatchObject({
      pluginId: "weather",
      tool: "reverse_text",
    });
    expect(() => decodeInvocation(invocation({ pluginId: "Weather" }))).toThrow(
      /pluginId is invalid/,
    );
    expect(() =>
      decodeInvocation(invocation({ capabilities: ["models:invoke"] })),
    ).toThrow("plugin worker tool invocation has invalid fields");
    const { turnId: _turnId, ...missing } = invocation();
    expect(() => decodeInvocation(missing)).toThrow(
      "plugin worker tool invocation has invalid fields",
    );
  });

  test("accept only a public hook invocation carrying the enabled list", () => {
    const hook = {
      ...invocation(),
      event: "agent/tool-exposure",
      payload: { tools: [] },
      enabled: ["weather"],
    } as Record<string, unknown>;
    delete hook.tool;
    delete hook.input;
    delete hook.pluginId;
    expect(decodeHookInvocation(hook)).toMatchObject({
      event: "agent/tool-exposure",
      enabled: ["weather"],
    });
    expect(() =>
      decodeHookInvocation({ ...hook, event: "agent/request-error" }),
    ).toThrow(/unsupported/);
    expect(() =>
      decodeHookInvocation({ ...hook, signal: "live AbortSignal" }),
    ).toThrow(/invalid fields/);
    expect(() =>
      decodeHookInvocation({ ...hook, enabled: ["Weather"] }),
    ).toThrow(/enabled is invalid/);
  });

  test("accept a trigger invocation and refuse a bad trigger name", () => {
    const trigger = {
      schemaVersion: 1,
      pluginId: "weather",
      trigger: "forecast_ready",
      headers: { "x-signature": "abc" },
      body: "{}",
      botId: "bot-1",
      routineId: "routine-1",
      deadlineMs: 1_000,
    };
    expect(decodeTriggerInvocation(trigger)).toMatchObject({
      trigger: "forecast_ready",
    });
    expect(() =>
      decodeTriggerInvocation({ ...trigger, trigger: "Forecast" }),
    ).toThrow(/trigger is invalid/);
    expect(() => decodeTriggerInvocation({ ...trigger, body: 42 })).toThrow(
      /event is invalid/,
    );
  });

  test("accept a card action invocation, its context and model optional", () => {
    const action = {
      schemaVersion: 1,
      pluginId: "email",
      cardId: "draft",
      surfaceId: "draft-email",
      action: "send",
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      runId: "run-1",
      turnId: "run-1",
      generationId: "gen-1",
      deadlineMs: 1_000,
    };
    expect(decodeCardActionInvocation(action)).toMatchObject({
      cardId: "draft",
      surfaceId: "draft-email",
      action: "send",
    });
    expect(
      decodeCardActionInvocation({
        ...action,
        context: { choice: "tuesday" },
        dataModel: { sent: false },
        record: { sent: false },
      }),
    ).toMatchObject({
      context: { choice: "tuesday" },
      record: { sent: false },
    });
    expect(() =>
      decodeCardActionInvocation({ ...action, surfaceId: "../run:foo" }),
    ).toThrow(/surfaceId is invalid/);
    expect(() =>
      decodeCardActionInvocation({ ...action, cardId: "Draft" }),
    ).toThrow(/cardId is invalid/);
    expect(() => decodeCardActionInvocation({ ...action, record: [] })).toThrow(
      /record is invalid/,
    );
    const { cardId: _cardId, ...cardless } = action;
    expect(() => decodeCardActionInvocation(cardless)).toThrow(
      /invalid fields/,
    );
    expect(() =>
      decodeCardActionInvocation({ ...action, action: "send/now" }),
    ).toThrow(/action is invalid/);
    expect(() =>
      decodeCardActionInvocation({ ...action, context: [] }),
    ).toThrow(/context is invalid/);
    expect(() =>
      decodeCardActionInvocation({ ...action, capabilities: [] }),
    ).toThrow(/invalid fields/);
    const { turnId: _turnId, ...missing } = action;
    expect(() => decodeCardActionInvocation(missing)).toThrow(/invalid fields/);
  });
});

describe("the generated index module map", () => {
  test("the wrapper context keys equal the generated contract catalog", () => {
    // The catalog is sorted by the field names in `isolate.ts`; the wrapper's
    // list is grouped by where each member comes from, so the two are compared
    // as sets.
    expect([...BOT_ISOLATE_NARROW_CONTEXT_KEYS_V1].toSorted()).toEqual(
      [...BOT_ISOLATE_CONTEXT_KEYS_V1].toSorted(),
    );
  });

  test("is the index plus one module per plugin, imported in mount order", () => {
    const modules = pluginWorkerModuleMap([
      { pluginId: "weather", source: "export const tools = [];" },
      { pluginId: "greeter", source: "export const tools = [1];" },
    ]);
    expect(Object.keys(modules).sort()).toEqual([
      PLUGIN_WORKER_MAIN_MODULE,
      pluginWorkerModulePathV1("greeter"),
      pluginWorkerModulePathV1("weather"),
    ]);
    expect(modules[pluginWorkerModulePathV1("weather")]?.js).toBe(
      "export const tools = [];",
    );
    expect(modules[PLUGIN_WORKER_MAIN_MODULE]!.js).toBe(
      pluginWorkerIndexSourceV1(["weather", "greeter"]),
    );
    // The order the index actually runs is proven in a real isolate by the
    // two-Plugin workerd probe, which mounts a provider and its consumer.
    expect(pluginWorkerIndexSourceV1(["weather", "greeter"])).not.toBe(
      pluginWorkerIndexSourceV1(["greeter", "weather"]),
    );
  });
});

describe("the generated wrapper's narrowed context", () => {
  const env = () => {
    const calls: { method: string; argument: unknown }[] = [];
    return {
      calls,
      env: {
        IDENTITY: { userId: "user-1" },
        CAPABILITIES: {
          // Every loopback call carries its scope first; the fakes record it
          // so the tests can hold the wrapper to naming the Plugin.
          list: (scope: unknown) => {
            calls.push({ method: "list", argument: scope });
            return Promise.resolve({ status: "available" });
          },
          schedule: (scope: unknown, request: unknown) => {
            calls.push({ method: "schedule", argument: { scope, request } });
            return Promise.resolve({ status: "scheduled" });
          },
        },
      } as unknown as Record<string, unknown>,
    };
  };

  const invocation = {
    tool: "reverse_text",
    event: undefined,
    botId: "bot-1",
    sessionId: "user-1:bot-1",
    runId: "run-1",
    turnId: "turn-1",
    generationId: "gen-1",
  };
  const scope = {
    botId: "bot-1",
    sessionId: "user-1:bot-1",
    runId: "run-1",
    turnId: "turn-1",
    generationId: "gen-1",
    pluginId: "weather",
  };

  test("builds no grant member for a plugin that declared no grants", () => {
    const subject = env();
    const context = narrowContext(
      subject.env,
      invocation,
      { pluginId: "weather", grants: [], services: {} },
      1_000,
    );
    for (const key of [
      "model",
      "memory",
      "workspace",
      "connection",
      "schedule",
    ]) {
      expect(context[key]).toBeUndefined();
    }
    expect(context.packageId).toBe("weather");
    expect(context.deadlineMs).toBe(1_000);
    expect(context.session).toEqual({
      sessionId: "user-1:bot-1",
      runId: "run-1",
      turnId: "turn-1",
      generationId: "gen-1",
    });
  });

  test("builds exactly the declared grant's member, wired to the stub", async () => {
    const subject = env();
    const context = narrowContext(
      subject.env,
      invocation,
      {
        pluginId: "weather",
        grants: ["schedule"],
        services: { forecast: { at: () => "noon" } },
      },
      1_000,
    );
    expect(typeof context.schedule).toBe("function");
    expect(context.memory).toBeUndefined();
    await expect(
      (context.schedule as (request: unknown) => Promise<unknown>)({
        in: 60,
      }),
    ).resolves.toEqual({ status: "scheduled" });
    await (context.capabilities as { list: () => Promise<unknown> }).list();
    expect(subject.calls).toEqual([
      { method: "schedule", argument: { scope, request: { in: 60 } } },
      { method: "list", argument: scope },
    ]);
    expect(
      (context.services as { forecast: { at: () => string } }).forecast.at(),
    ).toBe("noon");
  });

  test("holds every catalogued key when every grant is declared", () => {
    const subject = env();
    const context = narrowContext(
      subject.env,
      invocation,
      {
        pluginId: "weather",
        grants: ["ai", "memory", "workspace", "http", "schedule", "storage"],
        services: {},
      },
      1_000,
      // The credentialed transport is present while a model call is being
      // served, which is the one invocation that carries a ticket.
      "ticket-1",
    );
    expect(Object.keys(context).toSorted()).toEqual(
      [...BOT_ISOLATE_NARROW_CONTEXT_KEYS_V1].toSorted(),
    );
  });
});

describe("the generated wrapper's declaration checks", () => {
  test("accepts a well-formed module and normalizes its tools", () => {
    expect(
      declarations.declaredTools(
        {
          tools: [{ name: "reverse_text" }],
          execute: () => undefined,
        },
        "weather",
      ),
    ).toEqual([
      {
        name: "reverse_text",
        description: "",
        inputSchema: {},
        idempotent: false,
      },
    ]);
    expect(
      declarations.declaredHooks(
        { hooks: { "agent/request": () => undefined } },
        "weather",
      ),
    ).toEqual(["agent/request"]);
    expect(
      declarations.declaredTriggers(
        { triggers: { forecast_ready: () => undefined } },
        "weather",
      ),
    ).toEqual(["forecast_ready"]);
    expect(declarations.declaredServices({}, "weather")).toEqual({});
    expect(
      declarations.declaredViews(
        { views: { "weather.settings": () => undefined } },
        "weather",
      ),
    ).toEqual(["weather.settings"]);
    expect(declarations.declaredViews({}, "weather")).toEqual([]);
  });

  test("refuses a module that does not declare itself", () => {
    expect(() => declarations.declaredTools({}, "weather")).toThrow(
      /a "tools" array/,
    );
    // A hooks-only Plugin declares no tools, and the build admits one.
    expect(
      declarations.declaredTools(
        { tools: [], execute: () => undefined },
        "weather",
      ),
    ).toEqual([]);
    expect(() =>
      declarations.declaredTools({ tools: [{ name: "ok" }] }, "weather"),
    ).toThrow(/"execute" function/);
    expect(() =>
      declarations.declaredTools(
        { tools: [{ name: "Bad Name" }], execute: () => undefined },
        "weather",
      ),
    ).toThrow(/invalid name/);
    expect(() =>
      declarations.declaredHooks(
        { hooks: { "agent/nope": () => 1 } },
        "weather",
      ),
    ).toThrow(/unsupported hook/);
    expect(() =>
      declarations.declaredTriggers({ triggers: { Bad: () => 1 } }, "weather"),
    ).toThrow(/invalid name/);
    expect(() =>
      declarations.declaredServices({ services: 1 }, "weather"),
    ).toThrow(/"services" must be an object/);
    expect(() =>
      declarations.declaredViews(
        { views: { "bad surface": () => 1 } },
        "weather",
      ),
    ).toThrow(/invalid surface id/);
    expect(() =>
      declarations.declaredViews({ views: { ok: 1 } }, "weather"),
    ).toThrow(/must be a function/);
  });
});

type TriggerResult = {
  schemaVersion: number;
  status: string;
  text?: string;
  reason?: string;
};

const runTrigger = new Function(
  [
    BOT_ISOLATE_DEADLINE_SOURCE,
    BOT_ISOLATE_ERROR_TEXT_SOURCE,
    BOT_ISOLATE_TRIGGER_SOURCE,
    "return runTrigger;",
  ].join("\n"),
)() as (
  invocation: Record<string, unknown>,
  resolve: (pluginId: string) => unknown,
  contextFor: (
    identity: Record<string, string>,
    plugin: unknown,
    deadlineMs: number,
  ) => unknown,
) => Promise<TriggerResult>;

describe("the generated wrapper's trigger delivery", () => {
  function triggerInvocation(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      pluginId: "weather",
      trigger: "inbound",
      headers: { "x-source": "hook" },
      body: '{"city":"Wollongong"}',
      botId: "bot-1",
      routineId: "routine-1",
      deadlineMs: 1_000,
      ...overrides,
    };
  }

  function triggerPlugin(
    handler: (
      event: { headers: unknown; body: string },
      ctx: unknown,
    ) => unknown,
    triggers: string[] = ["inbound"],
  ) {
    return {
      pluginId: "weather",
      triggers,
      module: { triggers: { inbound: handler } },
    };
  }

  const identities: Record<string, string>[] = [];
  function contextFor(
    identity: Record<string, string>,
    _plugin: unknown,
    deadlineMs: number,
  ) {
    identities.push(identity);
    return { deadlineMs };
  }

  test("a returned string fires whole, with the event and a routine identity", async () => {
    identities.length = 0;
    const seen: { event: unknown; ctx: unknown }[] = [];
    const result = await runTrigger(
      triggerInvocation(),
      () =>
        triggerPlugin((event, ctx) => {
          seen.push({ event, ctx });
          return "a".repeat(2_000_000);
        }),
      contextFor,
    );
    expect(result).toEqual({
      schemaVersion: 1,
      status: "fire",
      text: "a".repeat(2_000_000),
    });
    expect(seen).toEqual([
      {
        event: {
          headers: { "x-source": "hook" },
          body: '{"city":"Wollongong"}',
        },
        ctx: { deadlineMs: 1_000 },
      },
    ]);
    expect(identities).toEqual([
      {
        botId: "bot-1",
        sessionId: "trigger:routine-1",
        runId: "trigger:routine-1",
        turnId: "trigger:routine-1",
        generationId: "trigger",
      },
    ]);
  });

  test("an explicit drop keeps its reason and an implicit one names the silence", async () => {
    expect(
      await runTrigger(
        triggerInvocation(),
        () => triggerPlugin(() => ({ drop: true, reason: "not for this bot" })),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "not for this bot",
    });
    expect(
      await runTrigger(
        triggerInvocation(),
        () => triggerPlugin(() => ({ drop: true })),
        contextFor,
      ),
    ).toEqual({ schemaVersion: 1, status: "drop" });
    expect(
      await runTrigger(
        triggerInvocation(),
        () => triggerPlugin(() => undefined),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "the trigger returned no text",
    });
    expect(
      await runTrigger(
        triggerInvocation(),
        () => triggerPlugin(() => ""),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "the trigger returned no text",
    });
  });

  test("an undeclared trigger, an unmounted plugin and a throw all drop with a reason", async () => {
    expect(
      await runTrigger(
        triggerInvocation(),
        () => triggerPlugin(() => "fired", ["other"]),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: 'plugin "weather" did not declare trigger "inbound"',
    });
    expect(
      await runTrigger(
        triggerInvocation(),
        () => {
          throw new Error('plugin "weather" is not mounted');
        },
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: 'plugin "weather" is not mounted',
    });
    expect(
      await runTrigger(
        triggerInvocation(),
        () =>
          triggerPlugin(() => {
            throw new Error("the routine exploded");
          }),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "the routine exploded",
    });
  });

  test("a trigger that overruns its deadline is dropped, never left running", async () => {
    const result = await runTrigger(
      triggerInvocation({ deadlineMs: 25 }),
      () => triggerPlugin(() => never()),
      contextFor,
    );
    expect(result.status).toBe("drop");
    expect(result.reason).toMatch(/exceeded its deadline of 25ms/);
  });
});

type ViewResult = {
  schemaVersion: number;
  status: string;
  document?: unknown;
  reason?: string;
};

const runView = new Function(
  [
    BOT_ISOLATE_DEADLINE_SOURCE,
    BOT_ISOLATE_ERROR_TEXT_SOURCE,
    BOT_ISOLATE_VIEW_SOURCE,
    "return runView;",
  ].join("\n"),
)() as (
  invocation: Record<string, unknown>,
  resolve: (pluginId: string) => unknown,
  contextFor: (
    identity: Record<string, unknown>,
    plugin: unknown,
    deadlineMs: number,
  ) => unknown,
) => Promise<ViewResult>;

describe("the generated wrapper's view rendering", () => {
  function viewInvocation(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      pluginId: "weather",
      surfaceId: "weather.settings",
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      runId: "view:weather.settings",
      turnId: "view:weather.settings",
      generationId: "gen-1",
      deadlineMs: 1_000,
      ...overrides,
    };
  }

  function viewPlugin(
    render: (ctx: unknown) => unknown,
    views: string[] = ["weather.settings"],
  ) {
    return {
      pluginId: "weather",
      views,
      module: { views: { "weather.settings": render } },
    };
  }

  const contexts: unknown[] = [];
  function contextFor(
    identity: Record<string, unknown>,
    _plugin: unknown,
    deadlineMs: number,
  ) {
    contexts.push({ runId: identity.runId, deadlineMs });
    return { deadlineMs };
  }

  test("a returned object is the rendered document, with the invocation as the context's identity", async () => {
    contexts.length = 0;
    const result = await runView(
      viewInvocation(),
      () => viewPlugin(() => ({ root: { type: "text", text: "Sunny" } })),
      contextFor,
    );
    expect(result).toEqual({
      schemaVersion: 1,
      status: "rendered",
      document: { root: { type: "text", text: "Sunny" } },
    });
    expect(contexts).toEqual([
      { runId: "view:weather.settings", deadlineMs: 1_000 },
    ]);
  });

  test("nothing, an undeclared surface, a throw and an overrun all drop with a reason", async () => {
    expect(
      await runView(
        viewInvocation(),
        () => viewPlugin(() => undefined),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "the view returned no document",
    });
    expect(
      await runView(
        viewInvocation(),
        () => viewPlugin(() => ({ root: {} }), ["other"]),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: 'plugin "weather" did not declare view "weather.settings"',
    });
    expect(
      await runView(
        viewInvocation(),
        () =>
          viewPlugin(() => {
            throw new Error("no forecast today");
          }),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "no forecast today",
    });
    const late = await runView(
      viewInvocation({ deadlineMs: 25 }),
      () => viewPlugin(() => never()),
      contextFor,
    );
    expect(late.status).toBe("drop");
    expect(late.reason).toMatch(/exceeded its deadline of 25ms/);
  });
});

type CardRun = (
  invocation: Record<string, unknown>,
  resolve: (pluginId: string) => unknown,
  contextFor: (
    identity: Record<string, unknown>,
    plugin: unknown,
    deadlineMs: number,
  ) => unknown,
) => Promise<{
  schemaVersion: number;
  status: string;
  reason?: string;
  deliberate?: true;
  messages?: unknown[];
  input?: string;
  covers?: Record<string, unknown>;
}>;

const { runRenderCard, runCardAction } = new Function(
  `${BOT_ISOLATE_DEADLINE_SOURCE}\n${BOT_ISOLATE_INVOCATION_SOURCE}\n${BOT_ISOLATE_ERROR_TEXT_SOURCE}\n${BOT_ISOLATE_CARD_SOURCE}\nreturn { runRenderCard, runCardAction };`,
)() as { runRenderCard: CardRun; runCardAction: CardRun };

describe("the generated wrapper's card handlers", () => {
  const messages = [{ version: "v1.0", createSurface: { surfaceId: "s-1" } }];

  /**
   * One mounted Plugin holding one card, declared the way the mount declares
   * it: the press path resolves against what `declaredCards` returned, so the
   * test hands it exactly that rather than a list of its own.
   */
  function cardPlugin(
    card: Record<string, unknown>,
    cards?: { id: string; actions: string[] }[],
  ) {
    const module = { cards: { draft: card } };
    return {
      pluginId: "mail",
      cards: cards ?? declarations.declaredCards(module, "mail"),
      module,
    };
  }

  function renderInvocation(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      pluginId: "mail",
      cardId: "draft",
      surfaceId: "mail-draft-1",
      data: { subject: "Hello" },
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      runId: "run-1",
      turnId: "run-1",
      generationId: "gen-1",
      deadlineMs: 1_000,
      ...overrides,
    };
  }

  function pressInvocation(overrides: Record<string, unknown> = {}) {
    return {
      schemaVersion: 1,
      pluginId: "mail",
      cardId: "draft",
      surfaceId: "mail-draft-1",
      action: "details",
      context: { expanded: true },
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      runId: "card-action:mail-draft-1:1",
      turnId: "card-action:mail-draft-1:1",
      generationId: "gen-1",
      deadlineMs: 1_000,
      ...overrides,
    };
  }

  const contextFor = (
    _identity: Record<string, unknown>,
    _plugin: unknown,
    deadlineMs: number,
  ) => ({ deadlineMs });

  test("a render is handed the kernel's surface and the Bot's values", async () => {
    const seen: unknown[] = [];
    expect(
      await runRenderCard(
        renderInvocation(),
        () =>
          cardPlugin({
            render: (payload: unknown) => {
              seen.push(payload);
              return messages;
            },
          }),
        contextFor,
      ),
    ).toEqual({ schemaVersion: 1, status: "rendered", messages });
    expect(seen).toEqual([
      { surfaceId: "mail-draft-1", data: { subject: "Hello" } },
    ]);
  });

  test("a render never carries the line a press may leave for the Bot", async () => {
    expect(
      await runRenderCard(
        renderInvocation(),
        () => cardPlugin({ render: () => ({ messages, input: "read me" }) }),
        contextFor,
      ),
    ).toEqual({ schemaVersion: 1, status: "rendered", messages });
  });

  test("a render carries the values it says its decision covers", async () => {
    expect(
      await runRenderCard(
        renderInvocation(),
        () =>
          cardPlugin({
            // What the Plugin drew, not what the Bot sent: the kernel binds
            // the Approval to this.
            render: () => ({ messages, covers: { subject: "Held" } }),
          }),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "rendered",
      messages,
      covers: { subject: "Held" },
    });
    // A bare array of messages declares nothing, and the seam refuses such a
    // draw if it asked for a decision.
    expect(
      await runRenderCard(
        renderInvocation(),
        () => cardPlugin({ render: () => messages }),
        contextFor,
      ),
    ).toEqual({ schemaVersion: 1, status: "rendered", messages });
  });

  test("an undeclared card, nothing, a throw and an overrun all drop", async () => {
    expect(
      await runRenderCard(
        renderInvocation(),
        () =>
          cardPlugin({ render: () => messages }, [
            { id: "other", actions: [] },
          ]),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: 'plugin "mail" did not declare card "draft"',
    });
    expect(
      await runRenderCard(
        renderInvocation(),
        () => cardPlugin({ render: () => undefined }),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "the card handler drew nothing",
    });
    expect(
      await runRenderCard(
        renderInvocation(),
        () =>
          cardPlugin({
            render: () => {
              throw new Error("no draft today");
            },
          }),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "no draft today",
    });
    const late = await runRenderCard(
      renderInvocation({ deadlineMs: 25 }),
      () => cardPlugin({ render: () => never() }),
      contextFor,
    );
    expect(late.status).toBe("drop");
    expect(late.reason).toMatch(/exceeded its deadline of 25ms/);
  });

  test("a press finds its handler by name, and may leave one line for the Bot", async () => {
    const presses: unknown[] = [];
    expect(
      await runCardAction(
        pressInvocation(),
        () =>
          cardPlugin({
            render: () => messages,
            actions: {
              details: (press: unknown) => {
                presses.push(press);
                return { messages, input: "they opened it" };
              },
            },
          }),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "rendered",
      messages,
      input: "they opened it",
    });
    expect(presses).toEqual([
      {
        cardId: "draft",
        surfaceId: "mail-draft-1",
        action: "details",
        context: { expanded: true },
        dataModel: undefined,
        record: undefined,
      },
    ]);
  });

  test("a press hands its handler the card it is on and the Card's record", async () => {
    const presses: unknown[] = [];
    await runCardAction(
      pressInvocation({ record: { sent: false, subject: "Hello" } }),
      () =>
        cardPlugin({
          render: () => messages,
          actions: {
            details: (press: unknown) => {
              presses.push(press);
              return messages;
            },
          },
        }),
      contextFor,
    );
    expect(presses).toEqual([
      {
        cardId: "draft",
        surfaceId: "mail-draft-1",
        action: "details",
        context: { expanded: true },
        dataModel: undefined,
        record: { sent: false, subject: "Hello" },
      },
    ]);
  });

  // One Plugin, two cards: the press names the action, and the surface names
  // the card. A press that pairs one card's action with another card's
  // surface is a drop, never an answer folded onto the wrong surface.
  test("a press whose surface names another of the Plugin's cards is a drop", async () => {
    const pressed: unknown[] = [];
    expect(
      await runCardAction(
        pressInvocation({ cardId: "receipt" }),
        () =>
          cardPlugin(
            {
              render: () => messages,
              actions: {
                details: (press: unknown) => {
                  pressed.push(press);
                  return messages;
                },
              },
            },
            [
              { id: "draft", actions: ["details"] },
              { id: "receipt", actions: ["archive"] },
            ],
          ),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: 'plugin "mail" card "receipt" does not declare action "details"',
    });
    expect(pressed).toEqual([]);
  });

  test("a press at a name no card declares is a drop, and the Card is left alone", async () => {
    expect(
      await runCardAction(
        pressInvocation({ action: "send" }),
        () =>
          cardPlugin({
            render: () => messages,
            actions: { details: () => messages },
          }),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: 'plugin "mail" declares no card action "send"',
    });
  });

  // The kernel charges a Plugin's health for a press that broke, and only for
  // one. A well-formed refusal is marked so the two are telling apart on the
  // wire rather than by guessing from the reason.
  test("a handler's own refusal is marked deliberate; a failure never is", async () => {
    expect(
      await runCardAction(
        pressInvocation(),
        () =>
          cardPlugin({
            render: () => messages,
            actions: {
              details: () => ({ drop: true, reason: "already settled" }),
            },
          }),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      deliberate: true,
      reason: "already settled",
    });
    for (const actions of [
      {
        details: () => {
          throw new Error("no draft today");
        },
      },
      { details: () => undefined },
    ]) {
      const answer = await runCardAction(
        pressInvocation(),
        () => cardPlugin({ render: () => messages, actions }),
        contextFor,
      );
      expect(answer.status).toBe("drop");
      expect(answer.deliberate).toBeUndefined();
    }
    const late = await runCardAction(
      pressInvocation({ deadlineMs: 25 }),
      () => cardPlugin({ render: () => messages, actions: { details: never } }),
      contextFor,
    );
    expect(late.status).toBe("drop");
    expect(late.deliberate).toBeUndefined();
  });

  // A draw is charged to the Plugin's health exactly as a press is, so it
  // carries the same marker: a render that refused in as many words costs it
  // nothing, and everything else counts.
  test("a render's own refusal is marked deliberate; a failure never is", async () => {
    expect(
      await runRenderCard(
        renderInvocation(),
        () => cardPlugin({ render: () => ({ drop: true, reason: "no data" }) }),
        contextFor,
      ),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      deliberate: true,
      reason: "no data",
    });
    const broke = await runRenderCard(
      renderInvocation(),
      () =>
        cardPlugin({
          render: () => {
            throw new Error("no draft today");
          },
        }),
      contextFor,
    );
    expect(broke.status).toBe("drop");
    expect(broke.deliberate).toBeUndefined();
  });

  test("a press resolves to the card that declared it, not to key order", async () => {
    // Two cards, each holding a handler called `details`. Nothing may resolve
    // this by scan order, so the mount refuses the module outright.
    const twoOwners = {
      cards: {
        draft: { render: () => messages, actions: { details: () => messages } },
        reply: { render: () => messages, actions: { details: () => messages } },
      },
    };
    expect(() => declarations.declaredCards(twoOwners, "mail")).toThrow(
      /declares card action "details" on both "draft" and "reply"/,
    );

    // And when they are spelled apart, the press reaches the card that owns
    // the name even though another card is scanned first: the surface names
    // that card, and the declaration is what picks the handler.
    const drew: string[] = [];
    const module = {
      cards: {
        draft: {
          render: () => messages,
          actions: {
            open: () => {
              drew.push("draft");
              return messages;
            },
          },
        },
        reply: {
          render: () => messages,
          actions: {
            details: () => {
              drew.push("reply");
              return messages;
            },
          },
        },
      },
    };
    const answer = await runCardAction(
      pressInvocation({ cardId: "reply" }),
      () => ({
        pluginId: "mail",
        cards: declarations.declaredCards(module, "mail"),
        module,
      }),
      contextFor,
    );
    expect(answer.status).toBe("rendered");
    expect(drew).toEqual(["reply"]);
  });

  test("a card must export a render function, and its id must be one", () => {
    expect(
      declarations.declaredCards(
        { cards: { draft: { render: () => undefined } } },
        "mail",
      ),
    ).toEqual([{ id: "draft", actions: [] }]);
    expect(declarations.declaredCards({}, "mail")).toEqual([]);
    expect(() =>
      declarations.declaredCards({ cards: { draft: {} } }, "mail"),
    ).toThrow(/must export a render function/);
    expect(() =>
      declarations.declaredCards(
        { cards: { Draft: { render: () => undefined } } },
        "mail",
      ),
    ).toThrow(/invalid id/);
    expect(() =>
      declarations.declaredCards(
        { cards: { draft: { render: () => undefined, actions: { go: 1 } } } },
        "mail",
      ),
    ).toThrow(/must be a function/);
  });

  test("a render invocation is decoded on the way in", () => {
    expect(decodeRenderCardInvocation(renderInvocation())).toMatchObject({
      cardId: "draft",
    });
    expect(() =>
      decodeRenderCardInvocation(renderInvocation({ cardId: "Draft" })),
    ).toThrow(/cardId is invalid/);
    expect(() =>
      decodeRenderCardInvocation(renderInvocation({ data: "values" })),
    ).toThrow(/data is invalid/);
    expect(() =>
      decodeRenderCardInvocation(renderInvocation({ extra: 1 })),
    ).toThrow(/invalid fields/);
  });
});

/**
 * The model provider half of the wrapper (ADR 0032): what a Plugin's answer
 * becomes on the wire, and what happens to a provider that stops producing
 * one.
 */
type ModelStream = {
  runModelStream: (
    invocation: Record<string, unknown>,
    resolve: (pluginId: string) => unknown,
    contextFor: (
      invocation: Record<string, unknown>,
      plugin: unknown,
      deadlineMs: number,
      transportId: string,
    ) => unknown,
  ) => Promise<{
    status: string;
    events?: ReadableStream<Uint8Array>;
    reason?: string;
  }>;
};

const modelProvider = new Function(
  `${BOT_ISOLATE_ERROR_TEXT_SOURCE}\n${BOT_ISOLATE_MODEL_SOURCE}\n${BOT_ISOLATE_MODEL_PROVIDER_SOURCE}\nreturn { runModelStream };`,
)() as ModelStream;

const modelInvocation = {
  schemaVersion: 1,
  pluginId: "deepseek",
  provider: "deepseek",
  protocolVersion: 1,
  request: { provider: "deepseek" },
  transportId: "ticket-1",
  botId: "bot-1",
  sessionId: "session-1",
  runId: "run-1",
  turnId: "run-1",
  generationId: "gen-1",
  deadlineMs: 30,
  firstEventDeadlineMs: 30,
};

function modelPlugin(stream: () => AsyncIterable<unknown>) {
  return () => ({
    modelProviders: ["deepseek"],
    module: { modelProviders: { deepseek: { stream } } },
  });
}

async function readStream(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) return text;
    text += decoder.decode(chunk.value);
  }
}

describe("the wrapper's model provider stream", () => {
  test("declares the providers a module serves", () => {
    expect(
      declarations.declaredModelProviders(
        { modelProviders: { deepseek: { stream: () => [] } } },
        "deepseek",
      ),
    ).toEqual(["deepseek"]);
    expect(() =>
      declarations.declaredModelProviders(
        { modelProviders: { deepseek: {} } },
        "deepseek",
      ),
    ).toThrow(/stream function/);
  });

  test("encodes each event as one NDJSON line", async () => {
    const result = await modelProvider.runModelStream(
      modelInvocation,
      modelPlugin(async function* () {
        yield { type: "text-delta", text: "hi" };
        yield { type: "finish", reason: "completed" };
      }),
      () => ({}),
    );
    expect(result.status).toBe("streaming");
    expect(await readStream(result.events!)).toBe(
      '{"type":"text-delta","text":"hi"}\n{"type":"finish","reason":"completed"}\n',
    );
  });

  test("refuses a provider that says nothing at all", async () => {
    const result = await modelProvider.runModelStream(
      modelInvocation,
      modelPlugin(async function* () {
        await new Promise(() => {});
        yield { type: "finish", reason: "completed" };
      }),
      () => ({}),
    );
    expect(result.status).toBe("streaming");
    await expect(readStream(result.events!)).rejects.toThrow(
      "the model provider produced no event for 30ms",
    );
  });

  test("returns the generator when the stream is cancelled", async () => {
    let returned = false;
    const result = await modelProvider.runModelStream(
      modelInvocation,
      modelPlugin(async function* () {
        try {
          for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 1));
            yield { type: "text-delta", text: "tick" };
          }
        } finally {
          returned = true;
        }
      }),
      () => ({}),
    );
    const reader = result.events!.getReader();
    await reader.read();
    await reader.cancel();
    expect(returned).toBe(true);
  });

  test("refuses a Plugin that does not serve the provider", async () => {
    const result = await modelProvider.runModelStream(
      modelInvocation,
      () => ({
        modelProviders: ["openai"],
        module: {
          modelProviders: { openai: { stream: async function* () {} } },
        },
      }),
      () => ({}),
    );
    expect(result).toMatchObject({
      status: "refused",
      reason: 'plugin "deepseek" does not serve provider "deepseek"',
    });
  });
});
