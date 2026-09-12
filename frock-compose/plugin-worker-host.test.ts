import { describe, expect, test } from "bun:test";
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  decodePluginDescriptorV1,
  ISOLATE_CONTRACT_VERSION,
  LoopHookListV1,
} from "@frockbot/core/contracts";
import type {
  BotCapabilitiesStub,
  BotIsolateHookEventNameV1,
  PluginGrantV1,
  PluginWorkerEntrypoint,
  PluginWorkerHealthV1,
  PluginWorkerHookInvocationV1,
  PluginWorkerPluginHealthV1,
  PluginWorkerToolInvocationV1,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistration,
} from "@frockbot/core/contracts";
import {
  PluginWorkerHost,
  pluginMountOrderV1,
  raceDeadline,
  type BotIsolateLoadedWorker,
  type BotIsolateMemberV1,
  type BotIsolateWorkerCode,
  type IsolateHookFailureV1,
  type PluginWorkerHostOptions,
} from "./plugin-worker-host.ts";
import { PLUGIN_WORKER_MAIN_MODULE } from "./plugin-worker-wrapper.ts";

const HASH = "a".repeat(64);

function member(
  id: string,
  overrides: {
    hooks?: BotIsolateHookEventNameV1[];
    grants?: PluginGrantV1[];
    slots?: string[];
    tools?: string[];
    provides?: { name: string; version: number }[];
    consumes?: { name: string; version: number }[];
    contractVersion?: number;
    contentHash?: string;
  } = {},
): BotIsolateMemberV1 {
  return {
    packageId: id,
    version: "0.0.1",
    artifact: { contentHash: overrides.contentHash ?? HASH },
    descriptor: decodePluginDescriptorV1({
      id,
      displayName: id,
      version: "0.0.1",
      contractVersion: overrides.contractVersion ?? ISOLATE_CONTRACT_VERSION,
      tools: (overrides.tools ?? ["reverse_text"]).map((name) => ({
        name,
        description: name,
        inputSchema: { type: "object" },
      })),
      hooks: overrides.hooks ?? [],
      grants: overrides.grants ?? [],
      ...(overrides.provides ? { provides: overrides.provides } : {}),
      ...(overrides.consumes ? { consumes: overrides.consumes } : {}),
      ...(overrides.slots ? { slots: overrides.slots } : {}),
      contextKeys: ["user", "bot", "session"],
    }),
  };
}

function healthy(
  pluginId: string,
  overrides: Partial<PluginWorkerPluginHealthV1> = {},
): PluginWorkerPluginHealthV1 {
  return {
    pluginId,
    ok: true,
    tools: [
      {
        name: "reverse_text",
        description: "Reverses text",
        inputSchema: { type: "object" },
        idempotent: true,
      },
    ],
    hooks: [],
    provides: [],
    consumes: [],
    triggers: [],
    ...overrides,
  };
}

interface RecordedLoad {
  loaderId: string;
  code: BotIsolateWorkerCode;
}

interface Harness {
  host: PluginWorkerHost;
  loads: RecordedLoad[];
  definitions: ToolDefinition[];
  namespaces: string[];
  hooks: LoopHookListV1;
  hookFailures: IsolateHookFailureV1[];
  hookInvocations: PluginWorkerHookInvocationV1[];
  toolInvocations: PluginWorkerToolInvocationV1[];
}

function harness(
  input: {
    health?: (plugins: string[]) => PluginWorkerHealthV1;
    hook?: PluginWorkerEntrypoint["hook"];
    healthThrows?: string;
    deadlineMs?: number;
    artifacts?: Record<string, string>;
  } = {},
): Harness {
  const loads: RecordedLoad[] = [];
  const definitions: ToolDefinition[] = [];
  const namespaces: string[] = [];
  const hooks = new LoopHookListV1();
  const hookFailures: IsolateHookFailureV1[] = [];
  const hookInvocations: PluginWorkerHookInvocationV1[] = [];
  const toolInvocations: PluginWorkerToolInvocationV1[] = [];
  const entrypoint: PluginWorkerEntrypoint = {
    health: () => {
      if (input.healthThrows) throw new Error(input.healthThrows);
      const last = loads.at(-1)!;
      const plugins = last.code.env.IDENTITY.plugins.map(
        (plugin) => plugin.pluginId,
      );
      return Promise.resolve(
        input.health?.(plugins) ?? {
          schemaVersion: 1,
          contractVersion: ISOLATE_CONTRACT_VERSION,
          plugins: plugins.map((pluginId) => healthy(pluginId)),
        },
      );
    },
    hook: (invocation) => {
      hookInvocations.push(invocation);
      return (
        input.hook?.(invocation) ??
        Promise.resolve({ schemaVersion: 1, status: "unchanged", failures: [] })
      );
    },
    execute: (invocation) => {
      toolInvocations.push(invocation);
      return Promise.resolve({
        schemaVersion: 1,
        content: `${invocation.pluginId}:${invocation.tool}`,
        isError: false,
      });
    },
    receiveTrigger: () =>
      Promise.resolve({ schemaVersion: 1, status: "drop" as const }),
  };
  const worker: BotIsolateLoadedWorker = { getEntrypoint: () => entrypoint };
  const options: PluginWorkerHostOptions = {
    loader: {
      get(id, callback) {
        void callback().then((code) => loads.push({ loaderId: id, code }));
        return worker;
      },
    },
    artifacts: {
      loadPackageArtifact: (contentHash) => {
        const source = input.artifacts?.[contentHash];
        if (input.artifacts && source === undefined) {
          return Promise.reject(new Error("missing artifact"));
        }
        return Promise.resolve(source ?? "export const tools = [];");
      },
    },
    tools: {
      registerNamespace: (registration: { name: string }) => {
        namespaces.push(registration.name);
        return () => {};
      },
      register: (definition: ToolDefinition) => {
        definitions.push(definition);
        return () => {};
      },
    } as unknown as ToolRegistration,
    hooks,
    userId: "user-1",
    botId: "bot-1",
    sessionId: "session-1",
    runId: "run-1",
    turnId: "turn-1",
    generationId: "gen-1",
    turnType: "chat",
    recordHookFailure: (failure) => {
      hookFailures.push(failure);
      return Promise.resolve();
    },
    capabilities: {} as BotCapabilitiesStub,
    compatibilityDate: "2026-01-01",
    bindingDigest: "b".repeat(64),
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
  };
  return {
    host: new PluginWorkerHost(options),
    loads,
    definitions,
    namespaces,
    hooks,
    hookFailures,
    hookInvocations,
    toolInvocations,
  };
}

function agent(botId = "bot-1") {
  return {
    id: botId,
    botId,
    status: "running" as const,
    session: { id: "session-1" },
  } as never;
}

function executionContext(
  overrides: Partial<ToolExecutionContext> = {},
): ToolExecutionContext {
  return {
    botId: "bot-1",
    agentId: "bot-1",
    sessionId: "session-1",
    compositionGenerationId: "gen-1",
    turnType: "chat",
    effectId: "tool:1:1:0",
    signal: new AbortController().signal,
    ...overrides,
  } as ToolExecutionContext;
}

describe("one worker per User", () => {
  test("mounts every plugin as one loaded worker and registers each one's tools", async () => {
    const subject = harness();
    const prepared = await subject.host.mount([
      member("weather"),
      member("greeter", { contentHash: "c".repeat(64) }),
    ]);
    expect(prepared.failures).toEqual([]);
    expect(prepared.mounted).toEqual(["weather", "greeter"]);
    expect(subject.loads).toHaveLength(1);
    const load = subject.loads[0]!;
    expect(load.loaderId).toMatch(/^plugin-worker:user-1:[0-9a-f]{64}$/);
    expect(Object.keys(load.code.modules).sort()).toEqual([
      PLUGIN_WORKER_MAIN_MODULE,
      "plugins/greeter.js",
      "plugins/weather.js",
    ]);
    expect(load.code.globalOutbound).toBeNull();
    expect(load.code.env.IDENTITY).toEqual({
      userId: "user-1",
      botId: "bot-1",
      generationId: "gen-1",
      plugins: [
        { pluginId: "weather", grants: [], consumes: [] },
        { pluginId: "greeter", grants: [], consumes: [] },
      ],
    });

    const active = await prepared.commit();
    expect(subject.namespaces).toEqual(["weather", "greeter"]);
    expect(subject.definitions.map((tool) => tool.namespace)).toEqual([
      "weather",
      "greeter",
    ]);
    const result = await subject.definitions[1]!.execute(
      { text: "x" },
      executionContext(),
    );
    expect(result).toEqual({ content: "greeter:reverse_text", isError: false });
    expect(subject.toolInvocations[0]).toMatchObject({
      pluginId: "greeter",
      tool: "reverse_text",
      botId: "bot-1",
    });
    await active.dispose();
  });

  test("the loader id follows the artifacts, the bindings and the mount order", async () => {
    const first = harness();
    await first.host.mount([
      member("weather"),
      member("greeter", { contentHash: "c".repeat(64) }),
    ]);
    const second = harness();
    await second.host.mount([
      member("greeter", { contentHash: "c".repeat(64) }),
      member("weather"),
    ]);
    const third = harness();
    await third.host.mount([
      member("weather"),
      member("greeter", { contentHash: "d".repeat(64) }),
    ]);
    // The same Plugins in a different mount order are a different load: the
    // index, `IDENTITY.plugins` and the hook chain all follow that order.
    expect(first.loads[0]!.loaderId).not.toBe(second.loads[0]!.loaderId);
    expect(first.loads[0]!.loaderId).not.toBe(third.loads[0]!.loaderId);
    expect(first.loads[0]!.code.env.IDENTITY).not.toEqual(
      second.loads[0]!.code.env.IDENTITY,
    );
  });

  test("no plugins means no loader call and nothing registered", async () => {
    const subject = harness();
    const prepared = await subject.host.mount([]);
    expect(prepared.mounted).toEqual([]);
    expect(subject.loads).toHaveLength(0);
    await (await prepared.commit()).dispose();
    expect(subject.definitions).toEqual([]);
  });
});

describe("mount order from provides and consumes", () => {
  test("a provider mounts before its consumer whatever the listed order", () => {
    const weather = member("weather", {
      provides: [{ name: "weather-data", version: 1 }],
    });
    const greeter = member("greeter", {
      consumes: [{ name: "weather-data", version: 1 }],
    });
    const plain = member("plain");
    const ordered = pluginMountOrderV1([greeter, plain, weather]);
    expect(ordered.failures).toEqual([]);
    expect(ordered.order.map((entry) => entry.packageId)).toEqual([
      "plain",
      "weather",
      "greeter",
    ]);
  });

  test("an unmet, mismatched, duplicated or cyclic need excludes only the plugins it touches", () => {
    const orphan = member("orphan", {
      consumes: [{ name: "nothing", version: 1 }],
    });
    const weather = member("weather", {
      provides: [{ name: "weather-data", version: 2 }],
    });
    const stale = member("stale", {
      consumes: [{ name: "weather-data", version: 1 }],
    });
    const downstream = member("downstream", {
      consumes: [{ name: "stale-data", version: 1 }],
    });
    const staleProvider = member("stale-provider", {
      consumes: [{ name: "nothing", version: 1 }],
      provides: [{ name: "stale-data", version: 1 }],
    });
    const twin = member("twin", {
      provides: [{ name: "weather-data", version: 2 }],
    });
    const ordered = pluginMountOrderV1([
      orphan,
      weather,
      stale,
      downstream,
      staleProvider,
      twin,
      member("plain"),
    ]);
    expect(ordered.order.map((entry) => entry.packageId)).toEqual([
      "weather",
      "plain",
    ]);
    expect(
      ordered.failures.map((failure) => [failure.pluginId, failure.phase]),
    ).toEqual([
      ["twin", "resolve"],
      ["orphan", "resolve"],
      ["stale", "resolve"],
      ["stale-provider", "resolve"],
      ["downstream", "resolve"],
    ]);
    expect(ordered.failures[2]!.message).toMatch(
      /version 1.*provides version 2/,
    );

    const a = member("a", {
      provides: [{ name: "a-data", version: 1 }],
      consumes: [{ name: "b-data", version: 1 }],
    });
    const b = member("b", {
      provides: [{ name: "b-data", version: 1 }],
      consumes: [{ name: "a-data", version: 1 }],
    });
    const cyclic = pluginMountOrderV1([a, b]);
    expect(cyclic.order).toEqual([]);
    expect(cyclic.failures.map((failure) => failure.message)).toEqual([
      'plugin "a" consumes a service in a cycle',
      'plugin "b" consumes a service in a cycle',
    ]);
  });

  test("a consumer of a duplicate provider is named for the plugin that did not mount", () => {
    const a = member("a", { provides: [{ name: "x", version: 1 }] });
    const b = member("b", {
      provides: [
        { name: "x", version: 1 },
        { name: "y", version: 1 },
      ],
    });
    const c = member("c", { consumes: [{ name: "y", version: 1 }] });
    const ordered = pluginMountOrderV1([a, b, c]);
    expect(ordered.order.map((entry) => entry.packageId)).toEqual(["a"]);
    expect(ordered.failures.map((failure) => failure.message)).toEqual([
      'plugin "b" provides "x", which "a" already provides',
      'plugin "c" consumes a service from a plugin that did not mount',
    ]);
  });

  test("a consumer of a refused provider is named for the plugin that did not mount", async () => {
    const subject = harness();
    const provider = member("provider", {
      slots: ["composer.toolbar"],
      provides: [{ name: "greeting", version: 1 }],
    });
    const consumer = member("consumer", {
      consumes: [{ name: "greeting", version: 1 }],
    });
    const prepared = await subject.host.mount([provider, consumer]);
    expect(prepared.mounted).toEqual([]);
    expect(subject.loads).toHaveLength(0);
    expect(prepared.failures.map((failure) => failure.message)).toEqual([
      'plugin "provider" declares slots, which open when the settings section lands',
      'plugin "consumer" consumes a service from a plugin that did not mount',
    ]);
  });

  test("a plugin downstream of a cycle is named for the cycle it is not in", () => {
    const a = member("a", {
      provides: [{ name: "a-data", version: 1 }],
      consumes: [{ name: "b-data", version: 1 }],
    });
    const b = member("b", {
      provides: [{ name: "b-data", version: 1 }],
      consumes: [{ name: "a-data", version: 1 }],
    });
    const c = member("c", { consumes: [{ name: "a-data", version: 1 }] });
    const ordered = pluginMountOrderV1([a, b, c]);
    expect(ordered.order).toEqual([]);
    expect(ordered.failures.map((failure) => failure.message)).toEqual([
      'plugin "a" consumes a service in a cycle',
      'plugin "b" consumes a service in a cycle',
      'plugin "c" consumes a service from a plugin that did not mount',
    ]);
  });

  test("the identity tells the index what each plugin consumes", async () => {
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          healthy(pluginId, {
            provides:
              pluginId === "weather"
                ? [{ name: "weather-data", version: 1 }]
                : [],
            consumes:
              pluginId === "greeter"
                ? [{ name: "weather-data", version: 1 }]
                : [],
          }),
        ),
      }),
    });
    const prepared = await subject.host.mount([
      member("greeter", {
        consumes: [{ name: "weather-data", version: 1 }],
        contentHash: "c".repeat(64),
      }),
      member("weather", { provides: [{ name: "weather-data", version: 1 }] }),
    ]);
    expect(prepared.failures).toEqual([]);
    expect(prepared.mounted).toEqual(["weather", "greeter"]);
    expect(subject.loads[0]!.code.env.IDENTITY.plugins).toEqual([
      { pluginId: "weather", grants: [], consumes: [] },
      { pluginId: "greeter", grants: [], consumes: ["weather-data"] },
    ]);
  });
});

describe("what the worker reports at mount", () => {
  test("a plugin whose report differs from its descriptor is a health failure, and the rest mount", async () => {
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          pluginId === "greeter"
            ? healthy(pluginId, {
                tools: [
                  {
                    name: "other_tool",
                    description: "",
                    inputSchema: {},
                    idempotent: false,
                  },
                ],
              })
            : pluginId === "broken"
              ? healthy(pluginId, {
                  ok: false,
                  reason: 'plugin "broken" must export an "execute" function',
                  tools: [],
                })
              : healthy(pluginId),
        ),
      }),
    });
    const prepared = await subject.host.mount([
      member("weather"),
      member("greeter", { contentHash: "c".repeat(64) }),
      member("broken", { contentHash: "d".repeat(64) }),
      member("absent", { contentHash: "e".repeat(64) }),
    ]);
    expect(prepared.mounted).toEqual(["weather", "absent"]);
    expect(
      prepared.failures.map((failure) => [failure.pluginId, failure.phase]),
    ).toEqual([
      ["greeter", "health"],
      ["broken", "health"],
    ]);
    expect(prepared.failures[0]!.message).toMatch(/tools do not match/);
    expect(prepared.failures[1]!.message).toMatch(/must export an "execute"/);
    await (await prepared.commit()).dispose();
    expect(subject.namespaces).toEqual(["weather", "absent"]);
  });

  test("a consumer is excluded when its provider fails health", async () => {
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          pluginId === "weather"
            ? healthy(pluginId, {
                ok: false,
                reason: 'plugin "weather" must export an "execute" function',
                tools: [],
              })
            : healthy(pluginId, {
                consumes:
                  pluginId === "greeter"
                    ? [{ name: "weather-data", version: 1 }]
                    : [],
              }),
        ),
      }),
    });
    const prepared = await subject.host.mount([
      member("weather", { provides: [{ name: "weather-data", version: 1 }] }),
      member("greeter", {
        consumes: [{ name: "weather-data", version: 1 }],
        contentHash: "c".repeat(64),
      }),
      member("unrelated", { contentHash: "d".repeat(64) }),
    ]);
    expect(prepared.mounted).toEqual(["unrelated"]);
    expect(
      prepared.failures.map((failure) => [failure.pluginId, failure.phase]),
    ).toEqual([
      ["weather", "health"],
      ["greeter", "resolve"],
    ]);
    expect(prepared.failures[1]!.message).toMatch(
      /consumes "weather-data", which "weather" did not mount/,
    );
    await (await prepared.commit()).dispose();
    expect(subject.namespaces).toEqual(["unrelated"]);
  });

  test("a report missing a plugin, or speaking another contract, is refused", async () => {
    const missing = harness({
      health: () => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: [],
      }),
    });
    const prepared = await missing.host.mount([member("weather")]);
    expect(prepared.mounted).toEqual([]);
    expect(prepared.failures[0]!.message).toMatch(/missing from the worker/);

    const stale = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: (ISOLATE_CONTRACT_VERSION - 1) as 3,
        plugins: plugins.map((pluginId) => healthy(pluginId)),
      }),
    });
    await expect(stale.host.mount([member("weather")])).rejects.toThrow(
      /speaks contract/,
    );
  });

  test("a worker that cannot answer health fails the mount naming every plugin", async () => {
    const subject = harness({ healthThrows: "SyntaxError: Unexpected token" });
    const failure = await subject.host
      .mount([
        member("weather"),
        member("greeter", { contentHash: "c".repeat(64) }),
      ])
      .then(
        () => undefined,
        (error: unknown) =>
          error as { phase: string; message: string; diagnostics?: string[] },
      );
    expect(failure?.phase).toBe("mount");
    expect(failure?.message).toMatch(
      /plugin worker failed to mount \(plugins: weather, greeter\)/,
    );
    expect(failure?.diagnostics).toEqual(["plugin:weather", "plugin:greeter"]);
  });

  test("an artifact that cannot be read excludes its plugin at resolve", async () => {
    const subject = harness({
      artifacts: { [HASH]: "export const tools = [];" },
    });
    const prepared = await subject.host.mount([
      member("weather"),
      member("gone", { contentHash: "f".repeat(64) }),
    ]);
    expect(prepared.mounted).toEqual(["weather"]);
    expect(prepared.failures).toEqual([
      {
        pluginId: "gone",
        phase: "resolve",
        message: expect.stringMatching(/artifact .* is unavailable/),
      },
    ]);
  });
});

describe("what a descriptor may declare", () => {
  test("a grant this deployment has not opened is refused at resolve", async () => {
    const subject = harness();
    const prepared = await subject.host.mount([
      member("weather", { grants: ["storage", "ai"] }),
    ]);
    expect(prepared.failures[0]).toMatchObject({
      pluginId: "weather",
      phase: "resolve",
      message: expect.stringMatching(/has not opened: storage/),
    });
    expect(subject.loads).toHaveLength(0);
  });

  test("slots are refused until the settings section lands", async () => {
    const subject = harness();
    const prepared = await subject.host.mount([
      member("weather", { slots: ["composer.toolbar"] }),
    ]);
    expect(prepared.failures[0]!.message).toMatch(/declares slots/);
  });

  test("a retired contract is refused with the reason; the previous one is served", async () => {
    const subject = harness();
    const prepared = await subject.host.mount([
      member("old", { contractVersion: ISOLATE_CONTRACT_VERSION - 2 }),
      member("previous", {
        contractVersion: ISOLATE_CONTRACT_VERSION - 1,
        contentHash: "c".repeat(64),
      }),
    ]);
    expect(prepared.mounted).toEqual(["previous"]);
    expect(prepared.failures[0]!.message).toMatch(/no longer serves/);
  });
});

describe("hooks", () => {
  test("every open hook reaches the worker once with the mounted plugins enabled", async () => {
    const seen: string[] = [];
    const replacement: Record<string, unknown> = {
      "system-prompt/assemble": {
        text: "hook prompt",
        sections: [{ id: "hook", text: "hook prompt" }],
      },
      "agent/tool-exposure": [],
      "agent/request": {
        requestId: "request-1",
        provider: "scripted",
        model: "scripted-v1",
        system: "hook system",
        messages: [],
        tools: [],
      },
      "tools/pre-execute": {
        kind: "denied",
        call: { id: "call-1", name: "reverse_text", input: {} },
        result: { content: "hook denied", isError: true },
      },
      "tools/post-execute": { content: "hook result", isError: false },
    };
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          healthy(pluginId, {
            hooks:
              pluginId === "weather" ? [...BOT_ISOLATE_HOOK_EVENTS_V1] : [],
          }),
        ),
      }),
      hook: (invocation) => {
        seen.push(invocation.event);
        return Promise.resolve(
          invocation.event === "agent/turn-stopping"
            ? { schemaVersion: 1, status: "unchanged", failures: [] }
            : {
                schemaVersion: 1,
                status: "replaced",
                replacement: replacement[invocation.event],
                failures: [],
              },
        );
      },
    });
    const prepared = await subject.host.mount([
      member("weather", { hooks: [...BOT_ISOLATE_HOOK_EVENTS_V1] }),
      member("greeter", { contentHash: "c".repeat(64) }),
    ]);
    expect(prepared.failures).toEqual([]);
    const active = await prepared.commit();
    const hooks = subject.hooks;
    const signal = new AbortController().signal;
    const call = { id: "call-1", name: "reverse_text", input: {} };

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
      await hooks.toolExposure(agent(), [], 1, 1, signal, () =>
        Promise.resolve([]),
      ),
    ).toEqual([]);
    const proposed = {
      requestId: "request-1",
      provider: "scripted",
      model: "scripted-v1",
      system: "core",
      messages: [],
      tools: [],
    };
    expect(
      await hooks.request(agent(), proposed, 1, 1, signal, () =>
        Promise.resolve(proposed),
      ),
    ).toMatchObject({ system: "hook system" });
    expect(
      await hooks.prepareTool(call, executionContext({ toolCall: call }), () =>
        Promise.resolve({ kind: "ready", call, idempotent: true }),
      ),
    ).toMatchObject({ kind: "denied" });
    expect(
      await hooks.toolResult(
        call,
        { content: "core", isError: false },
        executionContext({ toolCall: call }),
        () => Promise.resolve({ content: "core", isError: false }),
      ),
    ).toMatchObject({ content: "hook result" });
    await hooks.turnStopping(agent(), 1);

    expect(seen.toSorted()).toEqual([...BOT_ISOLATE_HOOK_EVENTS_V1].toSorted());
    expect(subject.hookInvocations[0]!.enabled).toEqual(["weather", "greeter"]);
    expect(subject.hookInvocations[0]!.payload).not.toHaveProperty("signal");
    expect(subject.hookFailures).toEqual([]);

    // Another Bot's Turn in the same runtime is left alone.
    const original = [
      { name: "first_party", description: "", inputSchema: {} },
    ];
    expect(
      await hooks.toolExposure(agent("bot-2"), original, 1, 1, signal, () =>
        Promise.resolve(original),
      ),
    ).toEqual(original);
    await active.dispose();
  });

  test("a plugin the worker skipped is recorded by name; the chain's value is kept", async () => {
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          healthy(pluginId, { hooks: ["agent/tool-exposure"] }),
        ),
      }),
      hook: () =>
        Promise.resolve({
          schemaVersion: 1,
          status: "replaced",
          replacement: [
            { name: "hook_visible", description: "", inputSchema: {} },
          ],
          failures: [{ pluginId: "greeter", reason: "hook exploded" }],
        }),
    });
    const prepared = await subject.host.mount([
      member("weather", { hooks: ["agent/tool-exposure"] }),
      member("greeter", {
        hooks: ["agent/tool-exposure"],
        contentHash: "c".repeat(64),
      }),
    ]);
    const active = await prepared.commit();
    const result = await subject.hooks.toolExposure(
      agent(),
      [],
      1,
      1,
      new AbortController().signal,
      () => Promise.resolve([]),
    );
    expect(result.map((tool) => tool.name)).toEqual(["hook_visible"]);
    expect(subject.hookFailures).toEqual([
      {
        packageId: "greeter",
        event: "agent/tool-exposure",
        generationId: "gen-1",
        message: "hook exploded",
      },
    ]);
    await active.dispose();
  });

  test("an undecodable or late answer passes the original through and is recorded", async () => {
    for (const hook of [
      () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "replaced" as const,
          replacement: [
            { name: "x", description: "", inputSchema: {}, execute: 1 },
          ],
          failures: [],
        }),
      () => new Promise<never>(() => {}),
    ]) {
      const subject = harness({
        deadlineMs: 5,
        health: (plugins) => ({
          schemaVersion: 1,
          contractVersion: ISOLATE_CONTRACT_VERSION,
          plugins: plugins.map((pluginId) =>
            healthy(pluginId, { hooks: ["agent/tool-exposure"] }),
          ),
        }),
        hook,
      });
      const prepared = await subject.host.mount([
        member("weather", { hooks: ["agent/tool-exposure"] }),
      ]);
      const active = await prepared.commit();
      const original = [
        { name: "first_party", description: "", inputSchema: {} },
      ];
      expect(
        await subject.hooks.toolExposure(
          agent(),
          original,
          1,
          1,
          new AbortController().signal,
          () => Promise.resolve(original),
        ),
      ).toEqual(original);
      expect(subject.hookFailures).toHaveLength(1);
      expect(subject.hookFailures[0]!.packageId).toBe("weather");
      await active.dispose();
    }
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

  test("rejects on abort and refuses an out-of-range deadline", async () => {
    const controller = new AbortController();
    const racing = raceDeadline(
      () => new Promise(() => {}),
      1_000,
      controller.signal,
    );
    controller.abort(new Error("stopped"));
    await expect(racing).rejects.toThrow("stopped");
    await expect(
      raceDeadline(() => Promise.resolve(1), 60_001),
    ).rejects.toThrow(/out of range/);
  });
});
