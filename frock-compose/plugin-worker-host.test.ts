import { describe, expect, test } from "bun:test";
import { TURN_READ_CONCURRENCY_V1 } from "@frockbot/core/concurrency";
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  decodePluginDescriptorV1,
  ISOLATE_CONTRACT_VERSION,
  LoopHookListV1,
  MAX_TRIGGER_BODY_BYTES_V1,
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
  PluginWorkerTriggerInvocationV1,
  PluginWorkerTriggerResultV1,
  PluginWorkerViewInvocationV1,
  ToolDefinition,
  ToolExecutionContext,
  ToolRegistration,
} from "@frockbot/core/contracts";
import {
  PluginFatalFailureError,
  PluginWorkerHost,
  pluginMountOrderV1,
  raceDeadline,
  type BotIsolateLoadedWorker,
  type BotIsolateMemberV1,
  type BotIsolateWorkerCode,
  type IsolateHookFailureV1,
  type PluginCardFailureV1,
  type PluginWorkerHostOptions,
} from "./plugin-worker-host.ts";
import {
  BOT_ISOLATE_DEADLINE_SOURCE,
  BOT_ISOLATE_ERROR_TEXT_SOURCE,
  BOT_ISOLATE_HOOK_CHAIN_SOURCE,
  BOT_ISOLATE_HOOK_VALUE_KEYS_V1,
  PLUGIN_WORKER_MAIN_MODULE,
} from "./plugin-worker-wrapper.ts";

// The generated chain, compiled from the source the worker embeds, so this
// runs the real chain behind the Durable Object's race.
const runHookChain = new Function(
  [
    `const HOOK_VALUE_KEYS = ${JSON.stringify(BOT_ISOLATE_HOOK_VALUE_KEYS_V1)};`,
    BOT_ISOLATE_DEADLINE_SOURCE,
    BOT_ISOLATE_ERROR_TEXT_SOURCE,
    BOT_ISOLATE_HOOK_CHAIN_SOURCE,
    "return runHookChain;",
  ].join("\n"),
)() as (
  plugins: unknown[],
  invocation: PluginWorkerHookInvocationV1,
  contextFor: () => unknown,
) => Promise<{
  status: string;
  failures: { pluginId: string; reason: string }[];
}>;

const HASH = "a".repeat(64);

function member(
  id: string,
  overrides: {
    hooks?: BotIsolateHookEventNameV1[];
    grants?: PluginGrantV1[];
    slots?: string[];
    views?: {
      slot: string;
      surfaceId: string;
      label?: string;
      opens?: string;
    }[];
    cards?: { id: string; actions: string[] }[];
    tools?: string[];
    provides?: { name: string; version: number }[];
    consumes?: { name: string; version: number }[];
    modelProviders?: { id: string; protocolVersion: number }[];
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
      ...(overrides.modelProviders
        ? { modelProviders: overrides.modelProviders }
        : {}),
      ...(overrides.provides ? { provides: overrides.provides } : {}),
      ...(overrides.consumes ? { consumes: overrides.consumes } : {}),
      ...(overrides.views ? { views: overrides.views } : {}),
      ...(overrides.cards
        ? {
            cards: overrides.cards.map((card) => ({
              id: card.id,
              displayName: card.id,
              description: `The ${card.id} card.`,
              dataSchema: {
                type: "object",
                properties: { subject: { type: "string" } },
                required: ["subject"],
                additionalProperties: false,
              },
              actions: card.actions.map((name) => ({
                name,
                description: name,
              })),
            })),
          }
        : {}),
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
    modelProviders: [],
    views: [],
    cards: [],
    ...overrides,
  };
}

interface RecordedLoad {
  loaderId: string;
  code: BotIsolateWorkerCode;
}

interface Harness {
  host: PluginWorkerHost;
  healthCalls(): number;
  cardFailures: PluginCardFailureV1[];
  loads: RecordedLoad[];
  definitions: ToolDefinition[];
  namespaces: string[];
  hooks: LoopHookListV1;
  hookFailures: IsolateHookFailureV1[];
  hookInvocations: PluginWorkerHookInvocationV1[];
  toolInvocations: PluginWorkerToolInvocationV1[];
  triggerInvocations: PluginWorkerTriggerInvocationV1[];
}

function harness(
  input: {
    health?: (plugins: string[]) => PluginWorkerHealthV1;
    hook?: PluginWorkerEntrypoint["hook"];
    streamModel?: PluginWorkerEntrypoint["streamModel"];
    openModelProviders?: PluginWorkerHostOptions["openModelProviders"];
    selectedModelProvider?: PluginWorkerHostOptions["selectedModelProvider"];
    receiveTrigger?: PluginWorkerEntrypoint["receiveTrigger"];
    view?: PluginWorkerEntrypoint["view"];
    cardAction?: PluginWorkerEntrypoint["cardAction"];
    reviseCard?: PluginWorkerEntrypoint["reviseCard"];
    renderCard?: PluginWorkerEntrypoint["renderCard"];
    sendCard?: PluginWorkerHostOptions["sendCard"];
    healthThrows?: string;
    deadlineMs?: number;
    artifacts?: Record<string, string>;
    loadArtifact?: (contentHash: string) => Promise<string>;
    recordHookFailure?: (failure: IsolateHookFailureV1) => Promise<void>;
  } = {},
): Harness {
  const loads: RecordedLoad[] = [];
  const definitions: ToolDefinition[] = [];
  const namespaces: string[] = [];
  const hooks = new LoopHookListV1();
  const hookFailures: IsolateHookFailureV1[] = [];
  const cardFailures: PluginCardFailureV1[] = [];
  const hookInvocations: PluginWorkerHookInvocationV1[] = [];
  const toolInvocations: PluginWorkerToolInvocationV1[] = [];
  const triggerInvocations: PluginWorkerTriggerInvocationV1[] = [];
  let healthCalls = 0;
  const entrypoint: PluginWorkerEntrypoint = {
    health: () => {
      healthCalls += 1;
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
    streamModel: (invocation) =>
      input.streamModel?.(invocation) ??
      Promise.resolve({
        schemaVersion: 1 as const,
        status: "refused" as const,
        reason: "this fake serves no model provider",
      }),
    view: (invocation) =>
      input.view?.(invocation) ??
      Promise.resolve({
        schemaVersion: 1 as const,
        status: "drop" as const,
        reason: "this fake renders nothing",
      }),
    cardAction: (invocation) =>
      input.cardAction?.(invocation) ??
      Promise.resolve({
        schemaVersion: 1 as const,
        status: "drop" as const,
        reason: "this fake runs no card handlers",
      }),
    reviseCard: (invocation) =>
      input.reviseCard?.(invocation) ??
      Promise.resolve({
        schemaVersion: 1 as const,
        status: "drop" as const,
        reason: "this fake revises no cards",
      }),
    renderCard: (invocation) =>
      input.renderCard?.(invocation) ??
      Promise.resolve({
        schemaVersion: 1 as const,
        status: "drop" as const,
        reason: "this fake draws no cards",
      }),
    receiveTrigger: (invocation) => {
      triggerInvocations.push(invocation);
      if (input.receiveTrigger) return input.receiveTrigger(invocation);
      return Promise.resolve({
        schemaVersion: 1,
        status: "fire" as const,
        text: `${invocation.pluginId}:${invocation.trigger}`,
      });
    },
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
        if (input.loadArtifact) return input.loadArtifact(contentHash);
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
    ...(input.sendCard === undefined ? {} : { sendCard: input.sendCard }),
    recordHookFailure: (failure) => {
      hookFailures.push(failure);
      return input.recordHookFailure?.(failure) ?? Promise.resolve();
    },
    recordCardFailure: (failure) => {
      cardFailures.push(failure);
      return Promise.resolve();
    },
    capabilities: {} as BotCapabilitiesStub,
    compatibilityDate: "2026-01-01",
    bindingDigest: "b".repeat(64),
    ...(input.deadlineMs === undefined ? {} : { deadlineMs: input.deadlineMs }),
    ...(input.openModelProviders === undefined
      ? {}
      : { openModelProviders: input.openModelProviders }),
    ...(input.selectedModelProvider === undefined
      ? {}
      : { selectedModelProvider: input.selectedModelProvider }),
  };
  return {
    host: new PluginWorkerHost(options),
    healthCalls: () => healthCalls,
    loads,
    definitions,
    namespaces,
    hooks,
    hookFailures,
    cardFailures,
    hookInvocations,
    toolInvocations,
    triggerInvocations,
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

  test("reuses immutable worker health by loader generation", async () => {
    const subject = harness();
    await subject.host.mount([member("weather")]);
    await subject.host.mount([member("weather")]);
    expect(subject.healthCalls()).toBe(1);

    await subject.host.mount([
      member("weather", { contentHash: "c".repeat(64) }),
    ]);
    expect(subject.healthCalls()).toBe(2);
  });

  test("does not cache a failed worker health check", async () => {
    const subject = harness({ healthThrows: "temporarily unavailable" });
    await expect(subject.host.mount([member("weather")])).rejects.toThrow(
      /temporarily unavailable/,
    );
    await expect(subject.host.mount([member("weather")])).rejects.toThrow(
      /temporarily unavailable/,
    );
    expect(subject.healthCalls()).toBe(2);
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
      'plugin "provider" declares slots this deployment has not opened: composer.toolbar',
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

  test("a plugin whose reported entry cannot be decoded fails alone", async () => {
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          pluginId === "greeter"
            ? healthy(pluginId, {
                tools: [
                  {
                    name: "reverse_text",
                    description: "x".repeat(3_000),
                    inputSchema: { type: "object" },
                    idempotent: true,
                  },
                ],
              })
            : healthy(pluginId),
        ),
      }),
    });
    const prepared = await subject.host.mount([
      member("weather"),
      member("greeter", { contentHash: "c".repeat(64) }),
    ]);
    expect(prepared.mounted).toEqual(["weather"]);
    expect(
      prepared.failures.map((failure) => [failure.pluginId, failure.phase]),
    ).toEqual([["greeter", "health"]]);
    await (await prepared.commit()).dispose();
    expect(subject.namespaces).toEqual(["weather"]);
  });

  test("a trigger naming a plugin excluded at health is dropped without reaching the worker", async () => {
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          pluginId === "greeter"
            ? healthy(pluginId, {
                ok: false,
                reason: 'plugin "greeter" must export an "execute" function',
                tools: [],
              })
            : healthy(pluginId),
        ),
      }),
    });
    const prepared = await subject.host.mount([
      member("weather"),
      member("greeter", { contentHash: "c".repeat(64) }),
    ]);
    expect(prepared.mounted).toEqual(["weather"]);
    const active = await prepared.commit();

    const invocation = (pluginId: string): PluginWorkerTriggerInvocationV1 => ({
      schemaVersion: 1,
      pluginId,
      trigger: "inbound",
      headers: {},
      body: "{}",
      botId: "bot-1",
      routineId: "routine-1",
      deadlineMs: 1_000,
    });
    expect(await active.deliverTrigger(invocation("greeter"))).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: 'plugin "greeter" did not mount in this generation',
    });
    expect(subject.triggerInvocations).toEqual([]);

    expect(await active.deliverTrigger(invocation("weather"))).toEqual({
      schemaVersion: 1,
      status: "fire",
      text: "weather:inbound",
    });
    expect(subject.triggerInvocations.map((entry) => entry.pluginId)).toEqual([
      "weather",
    ]);

    await active.dispose();
    expect(await active.deliverTrigger(invocation("weather"))).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "the plugin worker for this generation is no longer mounted",
    });
    expect(subject.triggerInvocations.map((entry) => entry.pluginId)).toEqual([
      "weather",
    ]);
  });

  test("a trigger answer the kernel cannot decode is dropped, not passed on", async () => {
    const subject = harness({
      receiveTrigger: () =>
        Promise.resolve({
          schemaVersion: 1,
          status: "fire",
          text: "",
        } as unknown as PluginWorkerTriggerResultV1),
    });
    const prepared = await subject.host.mount([member("weather")]);
    const active = await prepared.commit();
    const result = await active.deliverTrigger({
      schemaVersion: 1,
      pluginId: "weather",
      trigger: "inbound",
      headers: {},
      body: "{}",
      botId: "bot-1",
      routineId: "routine-1",
      deadlineMs: 1_000,
    });
    expect(result.status).toBe("drop");
    expect(result.status === "drop" ? result.reason : "").toMatch(
      /plugin "weather" trigger result\.text/,
    );
    await active.dispose();
  });

  test("a fired trigger body over the contract's limit is dropped, not truncated", async () => {
    const subject = harness({
      receiveTrigger: () =>
        Promise.resolve({
          schemaVersion: 1,
          status: "fire",
          text: "a".repeat(MAX_TRIGGER_BODY_BYTES_V1 + 1),
        } as PluginWorkerTriggerResultV1),
    });
    const prepared = await subject.host.mount([member("weather")]);
    const active = await prepared.commit();
    const result = await active.deliverTrigger({
      schemaVersion: 1,
      pluginId: "weather",
      trigger: "inbound",
      headers: {},
      body: "{}",
      botId: "bot-1",
      routineId: "routine-1",
      deadlineMs: 1_000,
    });
    expect(result).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: `plugin "weather" fired a trigger body over the ${MAX_TRIGGER_BODY_BYTES_V1} byte limit`,
    });
    await active.dispose();
  });

  test("a trigger answered inside the host's margin still fires", async () => {
    const subject = harness({
      receiveTrigger: (invocation: PluginWorkerTriggerInvocationV1) =>
        new Promise<PluginWorkerTriggerResultV1>((resolve) =>
          setTimeout(
            () =>
              resolve({
                schemaVersion: 1,
                status: "fire",
                text: `answered after ${invocation.deadlineMs}ms`,
              }),
            120,
          ),
        ),
    });
    const prepared = await subject.host.mount([member("weather")]);
    const active = await prepared.commit();
    const result = await active.deliverTrigger({
      schemaVersion: 1,
      pluginId: "weather",
      trigger: "inbound",
      headers: {},
      body: "{}",
      botId: "bot-1",
      routineId: "routine-1",
      deadlineMs: 100,
    });
    expect(result).toEqual({
      schemaVersion: 1,
      status: "fire",
      text: "answered after 100ms",
    });
    await active.dispose();
  });

  test("a trigger the worker never answers is dropped at the deadline", async () => {
    const subject = harness({
      receiveTrigger: () => new Promise<PluginWorkerTriggerResultV1>(() => {}),
    });
    const prepared = await subject.host.mount([member("weather")]);
    const active = await prepared.commit();
    const result = await active.deliverTrigger({
      schemaVersion: 1,
      pluginId: "weather",
      trigger: "inbound",
      headers: {},
      body: "{}",
      botId: "bot-1",
      routineId: "routine-1",
      deadlineMs: 25,
    });
    expect(result.status).toBe("drop");
    expect(result.status === "drop" ? result.reason : "").toMatch(/deadline/);
    await active.dispose();
  });

  test("a view renders on a mounted plugin, is dropped for one that did not mount, and refused after dispose", async () => {
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          healthy(pluginId, { views: ["weather.settings"] }),
        ),
      }),
      view: (invocation) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "rendered" as const,
          document: { root: { type: "text", text: invocation.surfaceId } },
        }),
    });
    const prepared = await subject.host.mount([
      member("weather", {
        views: [{ slot: "settings.sections", surfaceId: "weather.settings" }],
      }),
    ]);
    const active = await prepared.commit();
    const invocation = (pluginId: string): PluginWorkerViewInvocationV1 => ({
      schemaVersion: 1,
      pluginId,
      surfaceId: "weather.settings",
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      runId: "view:1",
      turnId: "view:1",
      generationId: "gen-1",
      deadlineMs: 1_000,
    });
    expect(await active.renderView(invocation("weather"))).toEqual({
      schemaVersion: 1,
      status: "rendered",
      document: { root: { type: "text", text: "weather.settings" } },
    });
    expect(await active.renderView(invocation("absent"))).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: 'plugin "absent" did not mount in this generation',
    });
    await active.dispose();
    expect(await active.renderView(invocation("weather"))).toEqual({
      schemaVersion: 1,
      status: "drop",
      reason: "the plugin worker for this generation is no longer mounted",
    });
  });

  test("a tool runs outside a Turn only when the plugin mounted and reported it", async () => {
    const subject = harness();
    const prepared = await subject.host.mount([member("weather")]);
    const active = await prepared.commit();
    const invocation = (
      pluginId: string,
      tool: string,
    ): PluginWorkerToolInvocationV1 => ({
      schemaVersion: 1,
      pluginId,
      tool,
      input: { text: "abc" },
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      runId: "action:1",
      turnId: "action:1",
      generationId: "gen-1",
      deadlineMs: 1_000,
    });
    expect(
      await active.executeTool(invocation("weather", "reverse_text")),
    ).toEqual({
      schemaVersion: 1,
      content: "weather:reverse_text",
      isError: false,
    });
    expect(await active.executeTool(invocation("weather", "other"))).toEqual({
      schemaVersion: 1,
      content: 'plugin "weather" declares no tool "other"',
      isError: true,
    });
    expect(
      await active.executeTool(invocation("absent", "reverse_text")),
    ).toEqual({
      schemaVersion: 1,
      content: 'plugin "absent" did not mount in this generation',
      isError: true,
    });
    expect(subject.toolInvocations.map((entry) => entry.tool)).toEqual([
      "reverse_text",
    ]);
    await active.dispose();
    expect(
      (await active.executeTool(invocation("weather", "reverse_text"))).isError,
    ).toBe(true);
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
      ["greeter", "health"],
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

  test("artifact reads stay under the shared bound without losing any", async () => {
    const members = [...Array(TURN_READ_CONCURRENCY_V1 * 3).keys()].map((n) =>
      member(`plugin-${n}`, { contentHash: `${n}`.padStart(64, "0") }),
    );
    let running = 0;
    let peak = 0;
    const subject = harness({
      loadArtifact: async (contentHash) => {
        running += 1;
        peak = Math.max(peak, running);
        await new Promise((resolve) => setTimeout(resolve, 0));
        running -= 1;
        return `export const tools = []; // ${contentHash}`;
      },
    });
    const prepared = await subject.host.mount(members);

    expect(peak).toBe(TURN_READ_CONCURRENCY_V1);
    expect(prepared.failures).toEqual([]);
    expect(prepared.mounted).toEqual(members.map((one) => one.packageId));
  });
});

describe("what a descriptor may declare", () => {
  test("a grant this deployment has not opened is refused at resolve", async () => {
    const subject = harness();
    const prepared = await subject.host.mount([
      member("weather", { grants: ["files", "ai"] }),
    ]);
    expect(prepared.failures[0]).toMatchObject({
      pluginId: "weather",
      phase: "resolve",
      message: expect.stringMatching(/has not opened: files/),
    });
    expect(subject.loads).toHaveLength(0);
  });

  test("closed slots are refused by name; conversation.panel and bot.nav are open", async () => {
    const subject = harness();
    const prepared = await subject.host.mount([
      member("weather", { slots: ["composer.toolbar"] }),
      member("panel", {
        contentHash: "c".repeat(64),
        views: [{ slot: "bot.profile", surfaceId: "panel.profile" }],
      }),
    ]);
    expect(prepared.failures.map((failure) => failure.message)).toEqual([
      'plugin "weather" declares slots this deployment has not opened: composer.toolbar',
      'plugin "panel" declares slots this deployment has not opened: bot.profile',
    ]);
    expect(subject.loads).toHaveLength(0);
  });

  test("conversation.panel and bot.nav views mount when the worker reports them", async () => {
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          healthy(pluginId, {
            views: ["weather.board", "weather.door"],
          }),
        ),
      }),
    });
    const prepared = await subject.host.mount([
      member("weather", {
        views: [
          { slot: "conversation.panel", surfaceId: "weather.board" },
          {
            slot: "bot.nav",
            surfaceId: "weather.door",
            opens: "weather.board",
          },
        ],
      }),
    ]);
    expect(prepared.mounted).toEqual(["weather"]);
    expect(prepared.failures).toEqual([]);
  });

  test("a settings section view mounts when the worker reports it, and is a health failure when it does not", async () => {
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          pluginId === "weather"
            ? healthy(pluginId, { views: ["weather.settings"] })
            : healthy(pluginId),
        ),
      }),
    });
    const prepared = await subject.host.mount([
      member("weather", {
        views: [{ slot: "settings.sections", surfaceId: "weather.settings" }],
      }),
      member("panel", {
        contentHash: "c".repeat(64),
        views: [{ slot: "settings.sections", surfaceId: "panel.settings" }],
      }),
    ]);
    expect(prepared.mounted).toEqual(["weather"]);
    expect(prepared.failures.map((failure) => failure.message)).toEqual([
      'plugin "panel" views do not match its declared views (declared:panel.settings reported:)',
    ]);
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
      "theme/assemble": {
        schemaVersion: 1,
        look: "ink",
        tokens: {
          surfaces: {
            window: "#1f1e24",
            surface: "#1a191e",
            raised: "#2c2a33",
            text: "#f6f2ee",
            muted: "#a8a3a6",
            line: "#3a3742",
            accent: "#d03f64",
            onAccent: "#ffffff",
          },
          type: "manrope",
          bubbles: { bot: "raised", me: "accent" },
        },
      },
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
    const assembled = await active.assembleTheme(
      {
        document: replacement["theme/assemble"] as never,
        look: "inherit",
        now: "2026-09-18T12:00:00.000Z",
        timezone: "UTC",
      },
      replacement["theme/assemble"] as never,
    );
    expect(assembled.tokens.bubbles.me).toBe("accent");

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

  test("assembleTheme keeps the original document when a plugin throws", async () => {
    const original = {
      schemaVersion: 1 as const,
      look: "ink" as const,
      tokens: {
        surfaces: {
          window: "#1f1e24",
          surface: "#1a191e",
          raised: "#2c2a33",
          text: "#f6f2ee",
          muted: "#a8a3a6",
          line: "#3a3742",
          accent: "#db4b6d",
          onAccent: "#ffffff",
        },
        type: "manrope" as const,
        bubbles: { bot: "raised" as const, me: "tint" as const },
      },
    };
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          healthy(pluginId, { hooks: ["theme/assemble"] }),
        ),
      }),
      hook: () => Promise.reject(new Error("theme hook exploded")),
    });
    const prepared = await subject.host.mount([
      member("weather", { hooks: ["theme/assemble"] }),
    ]);
    const active = await prepared.commit();
    const assembled = await active.assembleTheme(
      {
        document: original,
        look: "inherit",
        now: "2026-09-18T12:00:00.000Z",
        timezone: "UTC",
      },
      original,
    );
    expect(assembled).toEqual(original);
    await active.dispose();
  });

  test("assembleTheme records a refused document against the plugin that returned it", async () => {
    const original = {
      schemaVersion: 1 as const,
      look: "ink" as const,
      tokens: {
        surfaces: {
          window: "#1f1e24",
          surface: "#1a191e",
          raised: "#2c2a33",
          text: "#f6f2ee",
          muted: "#a8a3a6",
          line: "#3a3742",
          accent: "#db4b6d",
          onAccent: "#ffffff",
        },
        type: "manrope" as const,
        bubbles: { bot: "raised" as const, me: "tint" as const },
      },
    };
    // Grey text on a grey window: well under the 4.5:1 floor.
    const unreadable = {
      ...original,
      tokens: {
        ...original.tokens,
        surfaces: { ...original.tokens.surfaces, text: "#2a2930" },
      },
    };
    const subject = harness({
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          healthy(pluginId, { hooks: ["theme/assemble"] }),
        ),
      }),
      hook: () =>
        Promise.resolve({
          schemaVersion: 1,
          status: "replaced",
          replacement: unreadable,
          failures: [],
        }),
    });
    const prepared = await subject.host.mount([
      member("weather", { hooks: ["theme/assemble"] }),
    ]);
    const active = await prepared.commit();
    const assembled = await active.assembleTheme(
      {
        document: original,
        look: "inherit",
        now: "2026-09-18T12:00:00.000Z",
        timezone: "UTC",
      },
      original,
    );
    expect(assembled).toEqual(original);
    expect(subject.hookFailures).toEqual([
      expect.objectContaining({
        packageId: "weather",
        event: "theme/assemble",
        message: expect.stringMatching(/contrast/),
      }),
    ]);
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

  test("a failure the Bot answers as fatal fails the hook instead of being swallowed", async () => {
    for (const hook of [
      // The worker named the Plugin it skipped...
      () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "unchanged" as const,
          failures: [{ pluginId: "weather", reason: "hook exploded" }],
        }),
      // ...and the worker as a whole never answered.
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
        recordHookFailure: () =>
          Promise.reject(
            new PluginFatalFailureError('plugin "weather" is always on'),
          ),
      });
      const prepared = await subject.host.mount([
        member("weather", { hooks: ["agent/tool-exposure"] }),
      ]);
      const active = await prepared.commit();
      const original = [
        { name: "first_party", description: "", inputSchema: {} },
      ];
      await expect(
        subject.hooks.toolExposure(
          agent(),
          original,
          1,
          1,
          new AbortController().signal,
          () => Promise.resolve(original),
        ),
      ).rejects.toThrow(/is always on/);
      await active.dispose();
    }
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

  test("lets a chain that spends its whole deadline still name who it skipped", async () => {
    const subject = harness({
      deadlineMs: 150,
      health: (plugins) => ({
        schemaVersion: 1,
        contractVersion: ISOLATE_CONTRACT_VERSION,
        plugins: plugins.map((pluginId) =>
          healthy(pluginId, { hooks: ["agent/tool-exposure"] }),
        ),
      }),
      hook: (invocation) =>
        runHookChain(
          [
            {
              pluginId: "slow",
              ok: true,
              hooks: ["agent/tool-exposure"],
              module: {
                hooks: {
                  "agent/tool-exposure": () => new Promise(() => {}),
                },
              },
            },
            {
              pluginId: "starved",
              ok: true,
              hooks: ["agent/tool-exposure"],
              module: {
                hooks: { "agent/tool-exposure": () => undefined },
              },
            },
          ],
          invocation,
          () => ({}),
        ) as ReturnType<PluginWorkerEntrypoint["hook"]>,
    });
    const prepared = await subject.host.mount([
      member("slow", { hooks: ["agent/tool-exposure"] }),
      member("starved", {
        hooks: ["agent/tool-exposure"],
        contentHash: "c".repeat(64),
      }),
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
    expect(subject.hookFailures.map((failure) => failure.packageId)).toEqual([
      "slow",
      "starved",
    ]);
    expect(subject.hookFailures[1]!.message).toBe(
      "the hook chain exhausted its deadline of 150ms before this plugin ran",
    );
    await active.dispose();
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

describe("a Plugin's cards", () => {
  const messages = [
    {
      version: "v1.0",
      createSurface: { surfaceId: "mail_draft.1", components: [] },
    },
  ];

  function cardHarness(
    input: {
      renderCard?: PluginWorkerEntrypoint["renderCard"];
      sendCard?: PluginWorkerHostOptions["sendCard"];
      deadlineMs?: number;
    } = {},
  ) {
    const sends: unknown[] = [];
    const subject = harness({
      ...(input.deadlineMs === undefined
        ? {}
        : { deadlineMs: input.deadlineMs }),
      health: (plugins) =>
        ({
          schemaVersion: 1,
          contractVersion: ISOLATE_CONTRACT_VERSION,
          plugins: plugins.map((pluginId) =>
            healthy(pluginId, {
              cards: [{ id: "draft", actions: ["details"] }],
            }),
          ),
        }) as never,
      ...(input.renderCard ? { renderCard: input.renderCard } : {}),
      sendCard:
        input.sendCard ??
        ((send) => {
          sends.push(send);
          return Promise.resolve({ status: "sent" as const, approvals: 0 });
        }),
    });
    return { ...subject, sends };
  }

  const cardMember = () =>
    member("mail", { cards: [{ id: "draft", actions: ["details"] }] });

  test("one tool per card, in the Plugin's own namespace", async () => {
    const subject = cardHarness();
    await (await subject.host.mount([cardMember()])).commit();
    const tool = subject.definitions.find(
      (definition) => definition.name === "mail_draft",
    );
    expect(tool?.namespace).toBe("mail");
    expect(
      (tool?.inputSchema as { required?: string[] } | undefined)?.required,
    ).toEqual(["data"]);
  });

  test("the values are validated against the card's schema before the Plugin sees them", async () => {
    const rendered: unknown[] = [];
    const subject = cardHarness({
      renderCard: (invocation) => {
        rendered.push(invocation);
        return Promise.resolve({
          schemaVersion: 1 as const,
          status: "rendered" as const,
          messages,
        });
      },
    });
    await (await subject.host.mount([cardMember()])).commit();
    const tool = subject.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!;
    const refused = await tool.execute!(
      { data: { subject: 7 } },
      executionContext(),
    );
    expect(refused.isError).toBe(true);
    expect(refused.content).toMatch(/must be a string/);
    expect(rendered).toHaveLength(0);
    expect(subject.sends).toHaveLength(0);
  });

  test("the kernel mints the surface, and the Bot may name one it already drew", async () => {
    const subject = cardHarness({
      renderCard: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "rendered" as const,
          messages,
        }),
    });
    await (await subject.host.mount([cardMember()])).commit();
    const tool = subject.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!;
    const drawn = await tool.execute!(
      { data: { subject: "Hello" } },
      executionContext(),
    );
    expect(drawn.isError).toBe(false);
    const send = subject.sends[0] as { surfaceId: string; cardId: string };
    expect(send.cardId).toBe("draft");
    // The Plugin and the card it drew are readable in the id, and the rest is
    // minted from the Session and the effect.
    expect(send.surfaceId.startsWith("mail_draft.")).toBe(true);
    expect(drawn.content).toContain(send.surfaceId);

    // A replay of the same call in the same Session redraws that surface,
    // while another Session of this Bot at the same turn and step draws its
    // own: card records are Bot-wide and an effect id is not.
    await tool.execute!({ data: { subject: "Hello" } }, executionContext());
    expect((subject.sends[1] as { surfaceId: string }).surfaceId).toBe(
      send.surfaceId,
    );
    await tool.execute!(
      { data: { subject: "Hello" } },
      executionContext({ sessionId: "routine:r-1" }),
    );
    expect((subject.sends[2] as { surfaceId: string }).surfaceId).not.toBe(
      send.surfaceId,
    );

    await tool.execute!(
      { data: { subject: "Hello" }, surfaceId: send.surfaceId },
      executionContext(),
    );
    expect((subject.sends[3] as { surfaceId: string }).surfaceId).toBe(
      send.surfaceId,
    );
    const refused = await tool.execute!(
      { data: { subject: "Hello" }, surfaceId: "not a surface" },
      executionContext(),
    );
    expect(refused.isError).toBe(true);
    // A surface another Plugin's card minted is not this card's to draw on.
    const stolen = await tool.execute!(
      { data: { subject: "Hello" }, surfaceId: "post_draft.0123456789abcdef" },
      executionContext(),
    );
    expect(stolen.isError).toBe(true);
    expect(stolen.content).toMatch(/not a surface this card drew/);
    expect(subject.sends).toHaveLength(4);

    // An effect id too long for the surface id the Card seam bounds falls
    // back to a random half rather than drawing nothing.
    await tool.execute!(
      { data: { subject: "Hello" } },
      executionContext({ effectId: "e".repeat(200) }),
    );
    expect((subject.sends[2] as { surfaceId: string }).surfaceId).toMatch(
      /^mail_draft\.[0-9a-f]{24}$/,
    );
  });

  test("a card the Plugin refused, and a send the app refused, are the Bot's answer", async () => {
    const refusing = cardHarness({
      renderCard: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "drop" as const,
          reason: "no draft to draw",
        }),
    });
    await (await refusing.host.mount([cardMember()])).commit();
    const drop = await refusing.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!.execute!({ data: { subject: "Hello" } }, executionContext());
    expect(drop).toMatchObject({ isError: true });
    expect(drop.content).toMatch(/no draft to draw/);

    const unrecorded = cardHarness({
      renderCard: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "rendered" as const,
          messages,
        }),
      sendCard: () =>
        Promise.resolve({
          status: "refused" as const,
          reason: "the session is unavailable",
        }),
    });
    await (await unrecorded.host.mount([cardMember()])).commit();
    const refused = await unrecorded.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!.execute!({ data: { subject: "Hello" } }, executionContext());
    expect(refused).toMatchObject({ isError: true });
    expect(refused.content).toMatch(/session is unavailable/);
  });

  // A Card that asks the person to decide is a question, so it ends the Turn
  // the way an approval send does.
  test("a card that asked for a decision ends the Turn", async () => {
    const subject = cardHarness({
      renderCard: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "rendered" as const,
          messages,
        }),
      sendCard: () =>
        Promise.resolve({ status: "sent" as const, approvals: 1 }),
    });
    await (await subject.host.mount([cardMember()])).commit();
    const drawn = await subject.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!.execute!({ data: { subject: "Hello" } }, executionContext());
    expect(drawn.endsTurn).toBe(true);
  });

  // A draw that broke is charged to the Plugin the way a press that broke is,
  // and a draw that refused in as many words is not.
  test("a draw that failed counts toward the Plugin's health; one that refused does not", async () => {
    const broken = cardHarness({
      renderCard: () => Promise.reject(new Error("the worker is unreachable")),
    });
    await (await broken.host.mount([cardMember()])).commit();
    const failed = await broken.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!.execute!({ data: { subject: "Hello" } }, executionContext());
    // The model still reads the failure; the charge is beside it.
    expect(failed).toMatchObject({ isError: true });
    expect(failed.content).toMatch(/unreachable/);
    expect(broken.cardFailures).toEqual([
      {
        pluginId: "mail",
        cardId: "draft",
        message: "the worker is unreachable",
      },
    ]);

    const refusing = cardHarness({
      renderCard: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "drop" as const,
          deliberate: true as const,
          reason: "there is no draft to draw",
        }),
    });
    await (await refusing.host.mount([cardMember()])).commit();
    const dropped = await refusing.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!.execute!({ data: { subject: "Hello" } }, executionContext());
    expect(dropped).toMatchObject({ isError: true });
    expect(refusing.cardFailures).toEqual([]);

    // A drop that says nothing about being deliberate is a failure.
    const silent = cardHarness({
      renderCard: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          status: "drop" as const,
          reason: "the card handler drew nothing",
        }),
    });
    await (await silent.host.mount([cardMember()])).commit();
    await silent.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!.execute!({ data: { subject: "Hello" } }, executionContext());
    expect(silent.cardFailures).toHaveLength(1);
  });

  // The Plugin's own deadline is the Plugin failing; the Turn's signal is the
  // person pressing stop or the Turn running out of time, which is not.
  test("a draw the Turn cancelled is not charged, while one that overran its deadline is", async () => {
    const cancelled = cardHarness({
      renderCard: () => new Promise(() => {}),
    });
    await (await cancelled.host.mount([cardMember()])).commit();
    const controller = new AbortController();
    const running = cancelled.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!.execute!(
      { data: { subject: "Hello" } },
      executionContext({ signal: controller.signal }),
    );
    controller.abort(new Error("agent cancelled by user"));
    const stopped = await running;
    expect(stopped).toMatchObject({ isError: true });
    expect(stopped.content).toMatch(/agent cancelled by user/);
    expect(cancelled.cardFailures).toEqual([]);

    const overran = cardHarness({
      deadlineMs: 5,
      renderCard: () => new Promise(() => {}),
    });
    await (await overran.host.mount([cardMember()])).commit();
    const late = await overran.definitions.find(
      (definition) => definition.name === "mail_draft",
    )!.execute!({ data: { subject: "Hello" } }, executionContext());
    expect(late).toMatchObject({ isError: true });
    expect(overran.cardFailures).toEqual([
      {
        pluginId: "mail",
        cardId: "draft",
        message: "isolate invocation exceeded its deadline of 5ms",
      },
    ]);
  });

  // A press names no card, so the card a module says owns an action is what
  // routes it. A module owning `details` on a card the descriptor does not
  // put it on must fail health rather than answer presses from there.
  test("a report whose card actions differ from the descriptor fails that Plugin alone", async () => {
    const subject = harness({
      health: (plugins) =>
        ({
          schemaVersion: 1,
          contractVersion: ISOLATE_CONTRACT_VERSION,
          plugins: plugins.map((pluginId) =>
            healthy(pluginId, {
              cards: [{ id: "draft", actions: ["escalate"] }],
            }),
          ),
        }) as never,
      sendCard: () =>
        Promise.resolve({ status: "sent" as const, approvals: 0 }),
    });
    const prepared = await subject.host.mount([cardMember()]);
    expect(prepared.mounted).toEqual([]);
    expect(prepared.failures[0]?.message).toMatch(/cards do not match/);
  });

  test("a report whose cards differ from the descriptor fails that Plugin alone", async () => {
    const subject = harness({
      health: (plugins) =>
        ({
          schemaVersion: 1,
          contractVersion: ISOLATE_CONTRACT_VERSION,
          plugins: plugins.map((pluginId) => healthy(pluginId)),
        }) as never,
      sendCard: () =>
        Promise.resolve({ status: "sent" as const, approvals: 0 }),
    });
    const prepared = await subject.host.mount([cardMember()]);
    expect(prepared.mounted).toEqual([]);
    expect(prepared.failures[0]?.message).toMatch(/cards do not match/);
  });

  test("a host with no way to record a send registers no card tools", async () => {
    const subject = harness({
      health: (plugins) =>
        ({
          schemaVersion: 1,
          contractVersion: ISOLATE_CONTRACT_VERSION,
          plugins: plugins.map((pluginId) =>
            healthy(pluginId, {
              cards: [{ id: "draft", actions: ["details"] }],
            }),
          ),
        }) as never,
    });
    await (await subject.host.mount([cardMember()])).commit();
    expect(
      subject.definitions.map((definition) => definition.name),
    ).not.toContain("mail_draft");
  });
});

describe("the model provider one deployment serves", () => {
  const ARTIFACT = "d".repeat(64);
  /** The deployment's own claim: which Plugin, at which bytes, serves it. */
  const OPEN = [
    { provider: "deepseek", pluginId: "deepseek", contentHash: ARTIFACT },
  ];
  /** The claims, plus a Bot whose model selection names that provider. */
  const SELECTED = {
    openModelProviders: OPEN,
    selectedModelProvider: "deepseek",
  };
  const declaringDeepseek = (plugins: string[]) =>
    ({
      schemaVersion: 1,
      contractVersion: ISOLATE_CONTRACT_VERSION,
      plugins: plugins.map((pluginId) =>
        healthy(pluginId, { modelProviders: ["deepseek"] }),
      ),
    }) as never;

  test("a Bot's claimant is refused alone, and the deployment's Plugin still serves", async () => {
    const invocations: string[] = [];
    const subject = harness({
      ...SELECTED,
      health: declaringDeepseek,
      streamModel: (invocation) => {
        invocations.push(invocation.pluginId);
        return Promise.resolve({
          schemaVersion: 1 as const,
          status: "streaming" as const,
          events: new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
        });
      },
    });
    const prepared = await subject.host.mount([
      member("aaa-shadow", {
        contentHash: "e".repeat(64),
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
      }),
      member("deepseek", {
        contentHash: ARTIFACT,
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
      }),
    ]);
    expect(prepared.mounted).toContain("deepseek");
    expect(prepared.mounted).not.toContain("aaa-shadow");
    expect(prepared.failures).toEqual([
      {
        pluginId: "aaa-shadow",
        phase: "resolve",
        message: expect.stringMatching(
          /serves only through the Plugin "deepseek"/,
        ),
      },
    ]);
    const active = await prepared.commit();
    expect(active.modelProviders).toEqual([
      { pluginId: "deepseek", providerId: "deepseek", protocolVersion: 1 },
    ]);
    // The shadow claimant's provider never reaches the worker — and neither
    // does its code, which is what a credentialed call would need.
    const shadow = await active.streamModel({
      schemaVersion: 1,
      pluginId: "aaa-shadow",
      provider: "deepseek",
      protocolVersion: 1,
      request: {} as never,
      transportId: "transport-1",
      deadlineMs: 1_000,
      firstEventDeadlineMs: 1_000,
    } as never);
    expect(shadow).toMatchObject({ status: "refused" });
    expect(invocations).toEqual([]);
    await active.streamModel({
      schemaVersion: 1,
      pluginId: "deepseek",
      provider: "deepseek",
      protocolVersion: 1,
      request: {} as never,
      transportId: "transport-1",
      deadlineMs: 1_000,
      firstEventDeadlineMs: 1_000,
    } as never);
    expect(invocations).toEqual(["deepseek"]);
  });

  test("the only claimant is refused when it is not the deployment's artifact", async () => {
    const subject = harness({ ...SELECTED, health: declaringDeepseek });
    const prepared = await subject.host.mount([
      member("aaa-shadow", {
        contentHash: "e".repeat(64),
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
      }),
    ]);
    expect(prepared.mounted).toEqual([]);
    expect(prepared.failures[0]?.message).toMatch(/serves only through/);
    const active = await prepared.commit();
    expect(active.modelProviders).toEqual([]);
  });

  test("a second claimant that is not the deployment's Plugin serves nothing either", async () => {
    const subject = harness({ ...SELECTED, health: declaringDeepseek });
    const prepared = await subject.host.mount([
      member("deepseek", {
        contentHash: ARTIFACT,
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
      }),
      member("zzz-copy", {
        contentHash: "f".repeat(64),
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
      }),
    ]);
    expect(prepared.mounted).toEqual(["deepseek"]);
    expect(prepared.failures.map((failure) => failure.pluginId)).toEqual([
      "zzz-copy",
    ]);
    const active = await prepared.commit();
    expect(active.modelProviders.map((entry) => entry.pluginId)).toEqual([
      "deepseek",
    ]);
  });

  test("with no provider selected, the deployment's Plugin still mounts and serves nothing", async () => {
    // An account installs the provider's Package before any Bot chooses the
    // model (ADR 0032), and a Bot whose model is something else keeps the
    // member mounted: its tools and hooks follow the Bot's own switch, and
    // only the selection runs the contribution. Refusing it here would report
    // a correctly installed Plugin as a failed one on every Turn.
    const subject = harness({
      openModelProviders: OPEN,
      health: declaringDeepseek,
    });
    const prepared = await subject.host.mount([
      member("deepseek", {
        contentHash: ARTIFACT,
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
      }),
    ]);
    expect(prepared.failures).toEqual([]);
    expect(prepared.mounted).toEqual(["deepseek"]);
    const active = await prepared.commit();
    expect(active.modelProviders).toEqual([]);
    // Its tools are registered under its own namespace, as any other member's
    // are: a provider Plugin is a Plugin first.
    expect(subject.namespaces).toContain("deepseek");
    expect(subject.definitions.map((definition) => definition.name)).toContain(
      "reverse_text",
    );
  });

  test("with no provider selected, a foreign claimant is refused and the deployment's Plugin still mounts", async () => {
    // The claim is judged by bytes at every mount, never by which member the
    // generation lists first: a Bot-written claimant sorting ahead of the
    // deployment's Plugin must not take the provider from it.
    const subject = harness({
      openModelProviders: OPEN,
      health: declaringDeepseek,
    });
    const prepared = await subject.host.mount([
      member("aaa-shadow", {
        contentHash: "e".repeat(64),
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
      }),
      member("deepseek", {
        contentHash: ARTIFACT,
        modelProviders: [{ id: "deepseek", protocolVersion: 1 }],
      }),
    ]);
    expect(prepared.mounted).toEqual(["deepseek"]);
    expect(prepared.failures.map((failure) => failure.pluginId)).toEqual([
      "aaa-shadow",
    ]);
    const active = await prepared.commit();
    expect(active.modelProviders).toEqual([]);
  });

  test("with no provider selected, a provider the deployment does not open is still refused", async () => {
    const subject = harness({ openModelProviders: OPEN });
    const prepared = await subject.host.mount([
      member("asker", {
        contentHash: "a".repeat(64),
        modelProviders: [{ id: "openai", protocolVersion: 1 }],
      }),
    ]);
    expect(prepared.mounted).toEqual([]);
    expect(prepared.failures[0]?.message).toMatch(
      /does not open to plugins: openai/,
    );
  });
});
