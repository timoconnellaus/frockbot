import { describe, expect, test } from "bun:test";
import { BOT_ISOLATE_CONTEXT_KEYS_V1 } from "@frockbot/core/contracts";
import {
  BOT_ISOLATE_DEADLINE_SOURCE,
  BOT_ISOLATE_INVOCATION_SOURCE,
  BOT_ISOLATE_NARROW_CONTEXT_KEYS_V1,
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
    const index = modules[PLUGIN_WORKER_MAIN_MODULE]!.js;
    expect(index).toBe(pluginWorkerIndexSourceV1(["weather", "greeter"]));
    expect(index.indexOf('"./plugins/weather.js"')).toBeLessThan(
      index.indexOf('"./plugins/greeter.js"'),
    );
  });

  test("exposes only the wrapper entrypoint to the loader", () => {
    const index = pluginWorkerIndexSourceV1(["weather"]);
    expect(index).toContain(
      'import { WorkerEntrypoint } from "cloudflare:workers";',
    );
    for (const method of [
      "async health()",
      "async execute(rawInvocation)",
      "async hook(rawInvocation)",
      "async receiveTrigger(rawInvocation)",
    ]) {
      expect(index).toContain(method);
    }
    expect(index).toContain("return capabilities.schedule(request);");
    expect(index).not.toContain("globalThis");
  });
});
