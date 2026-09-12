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
  BOT_ISOLATE_DECLARATION_SOURCE,
  BOT_ISOLATE_INVOCATION_SOURCE,
  BOT_ISOLATE_MODEL_SOURCE,
  BOT_ISOLATE_NARROW_CONTEXT_KEYS_V1,
  BOT_ISOLATE_NARROW_CONTEXT_SOURCE_V1,
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

type NarrowContext = (
  env: Record<string, unknown>,
  invocation: Record<string, unknown>,
  plugin: Record<string, unknown>,
  deadlineMs: number,
) => Record<string, unknown>;

const narrowContext = new Function(
  `${BOT_ISOLATE_MODEL_SOURCE}\n${BOT_ISOLATE_NARROW_CONTEXT_SOURCE_V1}\nreturn narrowContext;`,
)() as NarrowContext;

const declarations = new Function(
  `${BOT_ISOLATE_INVOCATION_SOURCE}\n${BOT_ISOLATE_DECLARATION_SOURCE}\nreturn { declaredTools, declaredHooks, declaredServices, declaredTriggers };`,
)() as {
  declaredTools: (module: unknown, pluginId: string) => unknown[];
  declaredHooks: (module: unknown, pluginId: string) => string[];
  declaredServices: (module: unknown, pluginId: string) => unknown;
  declaredTriggers: (module: unknown, pluginId: string) => string[];
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
});

describe("the generated index module map", () => {
  test("the wrapper context keys equal the generated contract catalog", () => {
    expect(BOT_ISOLATE_NARROW_CONTEXT_KEYS_V1).toEqual([
      ...BOT_ISOLATE_CONTEXT_KEYS_V1,
    ]);
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
          list: () => {
            calls.push({ method: "list", argument: undefined });
            return Promise.resolve({ status: "available" });
          },
          schedule: (request: unknown) => {
            calls.push({ method: "schedule", argument: request });
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
      { method: "schedule", argument: { in: 60 } },
      { method: "list", argument: undefined },
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
        grants: ["ai", "memory", "workspace", "http", "schedule"],
        services: {},
      },
      1_000,
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
  });

  test("refuses a module that does not declare itself", () => {
    expect(() => declarations.declaredTools({ tools: [] }, "weather")).toThrow(
      /non-empty "tools" array/,
    );
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
  });
});
