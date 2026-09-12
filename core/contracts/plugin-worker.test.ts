import { describe, expect, test } from "bun:test";
import {
  decodePluginWorkerHealthV1,
  decodePluginWorkerHookInvocationV1,
  decodePluginWorkerHookResultV1,
  decodePluginWorkerToolInvocationV1,
  decodePluginWorkerTriggerInvocationV1,
  decodePluginWorkerTriggerResultV1,
  pluginWorkerLoaderIdV1,
  pluginWorkerModuleSetHashV1,
} from "./plugin-worker.js";

const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);
const DIGEST = "c".repeat(64);

describe("the plugin worker's identity", () => {
  test("hashes the same module set differently when the mount order differs", async () => {
    const forward = await pluginWorkerModuleSetHashV1({
      contractVersion: 3,
      indexVersion: "index-v1",
      members: [
        { pluginId: "weather", contentHash: HASH_A },
        { pluginId: "greeter", contentHash: HASH_B },
      ],
      bindingDigest: DIGEST,
    });
    const reversed = await pluginWorkerModuleSetHashV1({
      contractVersion: 3,
      indexVersion: "index-v1",
      members: [
        { pluginId: "greeter", contentHash: HASH_B },
        { pluginId: "weather", contentHash: HASH_A },
      ],
      bindingDigest: DIGEST,
    });
    expect(forward).not.toBe(reversed);
    expect(forward).toMatch(/^[0-9a-f]{64}$/);
    expect(reversed).toMatch(/^[0-9a-f]{64}$/);
  });

  test("changes with the contract, the index, an artifact or the bindings", async () => {
    const base = {
      contractVersion: 3 as const,
      indexVersion: "index-v1",
      members: [{ pluginId: "weather", contentHash: HASH_A }],
      bindingDigest: DIGEST,
    };
    const reference = await pluginWorkerModuleSetHashV1(base);
    for (const variant of [
      { ...base, contractVersion: 2 as const },
      { ...base, indexVersion: "index-v2" },
      { ...base, members: [{ pluginId: "weather", contentHash: HASH_B }] },
      { ...base, bindingDigest: "d".repeat(64) },
      { ...base, members: [] },
    ]) {
      expect(await pluginWorkerModuleSetHashV1(variant)).not.toBe(reference);
    }
  });

  test("refuses duplicate members and non-hex hashes", async () => {
    await expect(
      pluginWorkerModuleSetHashV1({
        contractVersion: 3,
        indexVersion: "index-v1",
        members: [
          { pluginId: "weather", contentHash: HASH_A },
          { pluginId: "weather", contentHash: HASH_B },
        ],
        bindingDigest: DIGEST,
      }),
    ).rejects.toThrow(/duplicate/);
    await expect(
      pluginWorkerModuleSetHashV1({
        contractVersion: 3,
        indexVersion: "index-v1",
        members: [{ pluginId: "weather", contentHash: "not hex" }],
        bindingDigest: DIGEST,
      }),
    ).rejects.toThrow(/hex/);
  });

  test("names the User and the module set, and nothing that could collide", () => {
    expect(
      pluginWorkerLoaderIdV1({ userId: "user-1", moduleSetHash: HASH_A }),
    ).toBe(`plugin-worker:user-1:${HASH_A}`);
    expect(() =>
      pluginWorkerLoaderIdV1({ userId: "user:1", moduleSetHash: HASH_A }),
    ).toThrow();
    expect(() =>
      pluginWorkerLoaderIdV1({ userId: "user-1", moduleSetHash: "zz" }),
    ).toThrow();
  });
});

const healthyPlugin = {
  pluginId: "weather",
  ok: true,
  tools: [
    {
      name: "forecast",
      description: "Forecasts",
      inputSchema: { type: "object" },
      idempotent: true,
    },
  ],
  hooks: ["agent/request", "tools/post-execute"],
  provides: [{ name: "weather-data", version: 1 }],
  consumes: [],
  triggers: ["forecast_ready"],
};

describe("plugin worker health", () => {
  test("decodes every plugin the index mounted", () => {
    const health = decodePluginWorkerHealthV1({
      schemaVersion: 1,
      contractVersion: 3,
      plugins: [
        healthyPlugin,
        {
          pluginId: "greeter",
          ok: false,
          reason: "package.js must export tools",
          tools: [],
          hooks: [],
          provides: [],
          consumes: [{ name: "weather-data", version: 1 }],
          triggers: [],
        },
      ],
    });
    expect(health.contractVersion).toBe(3);
    expect(health.plugins.map((plugin) => plugin.pluginId)).toEqual([
      "weather",
      "greeter",
    ]);
    expect(health.plugins[0]!.hooks).toEqual([
      "agent/request",
      "tools/post-execute",
    ]);
    expect(health.plugins[1]!.reason).toBe("package.js must export tools");
  });

  test("an empty worker still names its contract", () => {
    expect(
      decodePluginWorkerHealthV1({
        schemaVersion: 1,
        contractVersion: 3,
        plugins: [],
      }),
    ).toEqual({ schemaVersion: 1, contractVersion: 3, plugins: [] });
    expect(() =>
      decodePluginWorkerHealthV1({
        schemaVersion: 1,
        contractVersion: 99,
        plugins: [],
      }),
    ).toThrow(/contractVersion/);
  });

  test("a worker on the previous contract reports health without hooks", () => {
    const { hooks: _hooks, ...hooklessPlugin } = healthyPlugin;
    const health = decodePluginWorkerHealthV1({
      schemaVersion: 1,
      contractVersion: 2,
      plugins: [hooklessPlugin],
    });
    expect(health.contractVersion).toBe(2);
    expect(health.plugins[0]!.hooks).toEqual([]);
    expect(() =>
      decodePluginWorkerHealthV1({
        schemaVersion: 1,
        contractVersion: 2,
        plugins: [healthyPlugin],
      }),
    ).toThrow(/invalid fields/);
  });

  test("a reason is present exactly when a plugin is not ok, and ids are unique", () => {
    expect(() =>
      decodePluginWorkerHealthV1({
        schemaVersion: 1,
        contractVersion: 3,
        plugins: [{ ...healthyPlugin, reason: "fine" }],
      }),
    ).toThrow(/reason/);
    expect(() =>
      decodePluginWorkerHealthV1({
        schemaVersion: 1,
        contractVersion: 3,
        plugins: [{ ...healthyPlugin, ok: false }],
      }),
    ).toThrow(/reason/);
    expect(() =>
      decodePluginWorkerHealthV1({
        schemaVersion: 1,
        contractVersion: 3,
        plugins: [healthyPlugin, healthyPlugin],
      }),
    ).toThrow(/duplicate/);
  });

  test("refuses an undeclared hook, a bad trigger name and extra fields", () => {
    expect(() =>
      decodePluginWorkerHealthV1({
        schemaVersion: 1,
        contractVersion: 3,
        plugins: [{ ...healthyPlugin, hooks: ["agent/request-error"] }],
      }),
    ).toThrow(/hooks/);
    expect(() =>
      decodePluginWorkerHealthV1({
        schemaVersion: 1,
        contractVersion: 3,
        plugins: [{ ...healthyPlugin, triggers: ["Forecast Ready"] }],
      }),
    ).toThrow(/triggers/);
    expect(() =>
      decodePluginWorkerHealthV1({
        schemaVersion: 1,
        contractVersion: 3,
        plugins: [{ ...healthyPlugin, extra: true }],
      }),
    ).toThrow(/invalid fields/);
  });
});

const hookInvocation = {
  schemaVersion: 1,
  event: "agent/turn-stopping",
  payload: { agent: { botId: "bot-1" }, turn: 1 },
  botId: "bot-1",
  sessionId: "session-1",
  runId: "run-1",
  turnId: "turn-1",
  generationId: "gen-1",
  deadlineMs: 1_000,
  enabled: ["weather", "greeter"],
};

describe("plugin worker hook invocations and results", () => {
  test("carry the Bot's enabled list beside the isolate invocation", () => {
    expect(decodePluginWorkerHookInvocationV1(hookInvocation).enabled).toEqual([
      "weather",
      "greeter",
    ]);
    const { enabled: _enabled, ...withoutEnabled } = hookInvocation;
    expect(() => decodePluginWorkerHookInvocationV1(withoutEnabled)).toThrow(
      /invalid fields/,
    );
    expect(() =>
      decodePluginWorkerHookInvocationV1({
        ...hookInvocation,
        enabled: ["weather", "weather"],
      }),
    ).toThrow(/duplicates/);
    expect(() =>
      decodePluginWorkerHookInvocationV1({
        ...hookInvocation,
        enabled: ["Weather"],
      }),
    ).toThrow(/enabled\[0\]/);
  });

  test("name every plugin the index skipped", () => {
    expect(
      decodePluginWorkerHookResultV1({
        schemaVersion: 1,
        status: "replaced",
        replacement: { text: "x", sections: [] },
        failures: [{ pluginId: "greeter", reason: "hook exploded" }],
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "replaced",
      replacement: { text: "x", sections: [] },
      failures: [{ pluginId: "greeter", reason: "hook exploded" }],
    });
    expect(
      decodePluginWorkerHookResultV1({
        schemaVersion: 1,
        status: "unchanged",
        failures: [],
      }),
    ).toEqual({ schemaVersion: 1, status: "unchanged", failures: [] });
    expect(() =>
      decodePluginWorkerHookResultV1({ schemaVersion: 1, status: "unchanged" }),
    ).toThrow(/invalid fields/);
    expect(() =>
      decodePluginWorkerHookResultV1({
        schemaVersion: 1,
        status: "unchanged",
        failures: [{ pluginId: "greeter" }],
      }),
    ).toThrow(/invalid fields/);
  });

  test("a tool invocation names the plugin that owns the tool", () => {
    const invocation = decodePluginWorkerToolInvocationV1({
      schemaVersion: 1,
      pluginId: "weather",
      tool: "forecast",
      input: { city: "Wollongong" },
      botId: "bot-1",
      sessionId: "session-1",
      runId: "run-1",
      turnId: "turn-1",
      generationId: "gen-1",
      deadlineMs: 1_000,
    });
    expect(invocation.pluginId).toBe("weather");
    expect(invocation.tool).toBe("forecast");
    expect(() =>
      decodePluginWorkerToolInvocationV1({
        schemaVersion: 1,
        tool: "forecast",
        input: {},
        botId: "bot-1",
        sessionId: "session-1",
        runId: "run-1",
        turnId: "turn-1",
        generationId: "gen-1",
        deadlineMs: 1_000,
      }),
    ).toThrow(/invalid fields/);
  });
});

describe("plugin worker triggers", () => {
  const invocation = {
    schemaVersion: 1,
    pluginId: "weather",
    trigger: "forecast_ready",
    headers: { "X-Signature": "abc", "Content-Type": "application/json" },
    body: '{"city":"Wollongong"}',
    botId: "bot-1",
    routineId: "routine-1",
    deadlineMs: 5_000,
  };

  test("lowercase the header names and keep the body as text", () => {
    const decoded = decodePluginWorkerTriggerInvocationV1(invocation);
    expect(decoded.headers).toEqual({
      "x-signature": "abc",
      "content-type": "application/json",
    });
    expect(decoded.body).toBe('{"city":"Wollongong"}');
    expect(
      decodePluginWorkerTriggerInvocationV1({ ...invocation, body: "" }).body,
    ).toBe("");
  });

  test("refuse two header names that collide once lowercased", () => {
    expect(() =>
      decodePluginWorkerTriggerInvocationV1({
        ...invocation,
        headers: { "X-Signature": "good", "x-signature": "bad" },
      }),
    ).toThrow(/duplicate/);
  });

  test("refuse a bad trigger name, too many headers and an out-of-range deadline", () => {
    expect(() =>
      decodePluginWorkerTriggerInvocationV1({
        ...invocation,
        trigger: "Forecast Ready",
      }),
    ).toThrow(/trigger/);
    expect(() =>
      decodePluginWorkerTriggerInvocationV1({
        ...invocation,
        headers: Object.fromEntries(
          Array.from({ length: 65 }, (_, index) => [`h-${index}`, "v"]),
        ),
      }),
    ).toThrow(/headers/);
    expect(() =>
      decodePluginWorkerTriggerInvocationV1({
        ...invocation,
        deadlineMs: 60_001,
      }),
    ).toThrow(/deadlineMs/);
  });

  test("a result either fires with text or drops with an optional reason", () => {
    expect(
      decodePluginWorkerTriggerResultV1({
        schemaVersion: 1,
        status: "fire",
        text: "A forecast arrived for Wollongong.",
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "fire",
      text: "A forecast arrived for Wollongong.",
    });
    expect(
      decodePluginWorkerTriggerResultV1({
        schemaVersion: 1,
        status: "drop",
        reason: "signature mismatch",
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "signature mismatch",
    });
    expect(
      decodePluginWorkerTriggerResultV1({ schemaVersion: 1, status: "drop" }),
    ).toEqual({ schemaVersion: 1, status: "drop" });
    expect(() =>
      decodePluginWorkerTriggerResultV1({
        schemaVersion: 1,
        status: "fire",
        text: "",
      }),
    ).toThrow(/text/);
    expect(() =>
      decodePluginWorkerTriggerResultV1({
        schemaVersion: 1,
        status: "fire",
        text: "x",
        reason: "y",
      }),
    ).toThrow(/invalid fields/);
  });
});
