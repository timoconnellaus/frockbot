/**
 * The host's dispatch registry and body admission (ADR 0032).
 *
 * The whole credentialed call is exercised against the real Durable Object in
 * `apps/cloudflare/test/provider-plugin.workerd.ts`; this file is the two
 * pieces that are pure enough to drive directly — the ticket that makes one
 * attempt worth exactly one upstream call, and the checks that keep a Plugin's
 * body inside what the host admitted.
 */
import { describe, expect, test } from "bun:test";
import {
  pluginServedProviderV1,
  PLUGIN_SERVED_PROVIDERS_V1,
} from "@frockbot/providers/catalog/definition";
import { pluginModelTransportUrlV1 } from "@frockbot/core/contracts";
import {
  isolateModelTransport,
  PLUGIN_MODEL_MAX_OUTPUT_TOKENS_V1,
  pluginModelBodyRefusalV1,
  pluginModelOutputBoundV1,
  pluginModelStatusV1,
} from "./model-transport.ts";
import { PluginModelDispatchRegistryV1 } from "./model-dispatch.ts";
import { compactionWorkV1 } from "../shell/compaction-scheduler.js";

const SCOPE = {
  botId: "bot-1",
  runId: "run-1",
  sessionId: "session-1",
  turnId: "run-1",
  generationId: "generation-1",
  requestId: "request-1",
};

/** What the stand-in Bot object offers the handler. */
interface BotStateStub {
  modelTransports: PluginModelDispatchRegistryV1;
  /** The host's own session reference, as the mount captured it. */
  session: { id: string; events: Array<Record<string, unknown>> };
}

/** A stand-in session: what the transport reads of the host's own reference. */
function session(
  events: Array<Record<string, unknown>> = [],
  id = SCOPE.sessionId,
) {
  return { id, events };
}

function begin(
  registry: PluginModelDispatchRegistryV1,
  overrides: { requestId?: string; session?: unknown } = {},
) {
  return registry.begin({
    requestId: overrides.requestId ?? SCOPE.requestId,
    session: (overrides.session ?? session()) as never,
    pluginId: "deepseek",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    connectionId: "connection-1",
    connectionGeneration: "generation-1",
    packageId: "provider-deepseek",
    endpoint: "https://api.deepseek.com",
    route: "/chat/completions",
    maxOutputTokens: 8_192,
    scope: SCOPE,
    deadlineAt: Date.now() + 60_000,
  });
}

describe("the dispatch registry", () => {
  test("spends a ticket exactly once", () => {
    const registry = new PluginModelDispatchRegistryV1();
    const { handle } = begin(registry);
    expect(registry.take(handle.transportId)?.model).toBe("deepseek-v4-pro");
    expect(registry.take(handle.transportId)).toBeUndefined();
    handle.finish();
  });

  test("carries what the host admitted, and what it later saw", () => {
    const registry = new PluginModelDispatchRegistryV1();
    const { handle } = begin(registry);
    expect(handle.spent()).toBe(false);
    const dispatch = registry.take(handle.transportId)!;
    expect(handle.spent()).toBe(true);
    expect(handle.refusal()).toBeUndefined();
    dispatch.refusal = { httpStatus: 429, classification: "transient" };
    expect(handle.refusal()).toEqual({
      httpStatus: 429,
      classification: "transient",
    });
    handle.finish();
    expect(registry.size).toBe(0);
  });

  test("ending an attempt aborts the call the ticket started", () => {
    const registry = new PluginModelDispatchRegistryV1();
    const { handle } = begin(registry);
    const dispatch = registry.take(handle.transportId)!;
    expect(dispatch.abort.signal.aborted).toBe(false);
    handle.finish();
    expect(dispatch.abort.signal.aborted).toBe(true);
  });

  test("a ticket nobody presented is retired without aborting anything twice", () => {
    const registry = new PluginModelDispatchRegistryV1();
    const { handle } = begin(registry);
    handle.finish();
    expect(registry.size).toBe(0);
    expect(() => handle.finish()).not.toThrow();
  });
});

describe("the body a Plugin asks the host to send", () => {
  const admitted = { model: "deepseek-v4-pro", maxOutputTokens: 8_192 };
  const body = (extra: Record<string, unknown>): string =>
    JSON.stringify({
      model: "deepseek-v4-pro",
      messages: [],
      stream: true,
      max_tokens: 4_096,
      ...extra,
    });

  test("accepts the approved streaming call inside the deployment's bound", () => {
    expect(pluginModelBodyRefusalV1(body({}), admitted)).toBeUndefined();
  });

  test("refuses a body naming another model", () => {
    expect(
      pluginModelBodyRefusalV1(body({ model: "deepseek-v4-flash" }), admitted),
    ).toMatch(/not admitted/);
  });

  test("refuses the non-streaming operation", () => {
    expect(pluginModelBodyRefusalV1(body({ stream: false }), admitted)).toMatch(
      /not the streaming inference call/,
    );
    expect(
      pluginModelBodyRefusalV1(body({ stream: undefined }), admitted),
    ).toMatch(/not the streaming inference call/);
  });

  test("refuses a body that names no output bound, or one beyond the deployment's", () => {
    for (const ask of [
      undefined,
      8_193,
      0,
      -1,
      1.5,
      "many",
      Number.MAX_SAFE_INTEGER,
    ]) {
      expect(
        pluginModelBodyRefusalV1(body({ max_tokens: ask }), admitted),
      ).toMatch(/output bound/);
    }
  });

  test("refuses another dialect's output field rather than guessing", () => {
    for (const alias of ["max_completion_tokens", "max_output_tokens"]) {
      expect(
        pluginModelBodyRefusalV1(body({ [alias]: 1_024 }), admitted),
      ).toMatch(/output field this provider does not use/);
    }
  });

  test("falls back to the deployment default when the entry names no bound", () => {
    expect(
      pluginModelBodyRefusalV1(body({ max_tokens: 1_024 }), {
        model: "deepseek-v4-pro",
      }),
    ).toBeUndefined();
    expect(
      pluginModelBodyRefusalV1(
        body({ max_tokens: PLUGIN_MODEL_MAX_OUTPUT_TOKENS_V1 + 1 }),
        { model: "deepseek-v4-pro" },
      ),
    ).toMatch(/output bound/);
  });

  test("refuses a body that is not an object", () => {
    expect(pluginModelBodyRefusalV1("not json", admitted)).toMatch(/not JSON/);
    expect(pluginModelBodyRefusalV1("[1,2,3]", admitted)).toMatch(
      /not an object/,
    );
  });

  test("the bound is the smaller of the deployment's and the model's own", () => {
    expect(pluginModelOutputBoundV1(8_192, 4_096)).toBe(4_096);
    expect(pluginModelOutputBoundV1(8_192, 65_536)).toBe(8_192);
    expect(pluginModelOutputBoundV1(8_192, undefined)).toBe(8_192);
    expect(pluginModelOutputBoundV1(8_192, 0)).toBe(8_192);
    expect(pluginModelOutputBoundV1(8_192, 1.5)).toBe(8_192);
    // The bound is never zero: it is what a body has to stay inside.
    expect(pluginModelOutputBoundV1(1, 1)).toBe(1);
  });

  test("a call admitted at the model's own ceiling refuses more", () => {
    const admittedAtModelCeiling = {
      model: "deepseek-v4-pro",
      maxOutputTokens: pluginModelOutputBoundV1(8_192, 4_096),
    };
    expect(
      pluginModelBodyRefusalV1(
        body({ max_tokens: 4_096 }),
        admittedAtModelCeiling,
      ),
    ).toBeUndefined();
    expect(
      pluginModelBodyRefusalV1(
        body({ max_tokens: 4_097 }),
        admittedAtModelCeiling,
      ),
    ).toMatch(/output bound/);
  });
});

/**
 * The handler itself, against a stand-in Bot object.
 *
 * Everything it checks before the credential is reached is exercised here —
 * the ticket, the durable journal, the binding, the Connection — with the
 * same code the Durable Object runs. What happens after a real fetch is
 * covered by `provider-plugin.workerd.ts`, which needs a workerd runtime.
 */
function botState(options: {
  events: Array<Record<string, unknown>>;
  requestId?: string;
  connectionState?: "ready" | "revoked";
  connectionGeneration?: string;
  connectionPackageId?: string;
}) {
  const requestId = options.requestId ?? SCOPE.requestId;
  const session = { id: SCOPE.sessionId, events: options.events };
  return {
    session,
    modelTransports: new PluginModelDispatchRegistryV1(),
    turn: {
      current: {
        runId: SCOPE.runId,
        sessionId: SCOPE.sessionId,
        turnId: SCOPE.turnId,
        generationId: SCOPE.generationId,
        mounted: {
          generation: {
            members: [
              {
                packageId: "deepseek",
                artifact: { contentHash: "a".repeat(64) },
              },
            ],
          },
          runtime: { services: { sessions: { get: () => session } } },
        },
      },
    },
    env: {
      USER_CONFIGURATIONS: {
        idFromName: (name: string) => name,
        get: () => ({
          readConfiguration: async () => ({
            connections: [
              {
                connectionId: "connection-1",
                packageId: options.connectionPackageId ?? "provider-deepseek",
                state: options.connectionState ?? "ready",
                generation: options.connectionGeneration ?? "generation-1",
                settings: {},
              },
            ],
          }),
        }),
      },
    },
  };
}

const modelRequest = (requestId: string) => ({
  type: "model/request",
  turn: 1,
  step: 1,
  request: {
    requestId,
    provider: "deepseek",
    model: "deepseek-v4-pro",
    system: "",
    messages: [],
    tools: [],
    modelBinding: {
      connectionId: "connection-1",
      connectionGeneration: "generation-1",
    },
  },
});

function transportCall(transportId: string) {
  return {
    userId: "user-1",
    botId: SCOPE.botId,
    runId: SCOPE.runId,
    sessionId: SCOPE.sessionId,
    turnId: SCOPE.turnId,
    packageId: "deepseek",
    generationId: SCOPE.generationId,
    request: {
      schemaVersion: 1,
      transportId,
      body: JSON.stringify({
        model: "deepseek-v4-pro",
        stream: true,
        max_tokens: 1_024,
      }),
    },
  };
}

describe("what the host makes of the provider's own status", () => {
  test("an answer is an answer", () => {
    expect(pluginModelStatusV1(200)).toEqual({ outcome: "streaming" });
    expect(pluginModelStatusV1(204)).toEqual({ outcome: "streaming" });
  });

  test("a request the provider will not take is a refusal, and the only kind that bills nothing", () => {
    expect(pluginModelStatusV1(401)).toMatchObject({
      outcome: "refusal",
      classification: "permanent",
    });
    expect(pluginModelStatusV1(404)).toMatchObject({
      outcome: "refusal",
      classification: "permanent",
    });
    expect(pluginModelStatusV1(429, 1_500)).toMatchObject({
      outcome: "refusal",
      classification: "transient",
      retryAfterMs: 1_500,
    });
    expect(pluginModelStatusV1(302)).toMatchObject({
      outcome: "refusal",
      classification: "permanent",
    });
  });

  test("a failure after the request arrived is uncertainty, never a refusal", () => {
    for (const status of [500, 502, 503, 529]) {
      const decision = pluginModelStatusV1(status);
      expect(decision).toMatchObject({ outcome: "uncertain" });
      expect(decision.outcome === "uncertain" ? decision.reason : "").toMatch(
        /outcome of the model request is unknown/,
      );
      // A retry hint is the provider's business only when it refused the
      // call outright: after a 5xx nothing may be planned for this effect.
      expect(pluginModelStatusV1(status, 5_000)).toMatchObject({
        outcome: "uncertain",
      });
    }
  });
});

describe("the transport handler, before anything is sent", () => {
  test("sends nothing without a durable dispatch in the Turn's log", async () => {
    const state = botState({ events: [] });
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    expect(outcome).toMatchObject({ status: "refused" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /durable dispatch/,
    );
  });

  test("sends nothing when the durable dispatch names another binding", async () => {
    const state = botState({ events: [modelRequest(SCOPE.requestId)] });
    const { handle, dispatch } = begin(
      (state as never as BotStateStub).modelTransports,
      { session: state.session },
    );
    dispatch.requestId = SCOPE.requestId;
    dispatch.connectionGeneration = "generation-2";
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    expect(outcome).toMatchObject({ status: "refused" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /does not match the durable effect/,
    );
  });

  test("sends nothing for an effect the kernel dispatched a second time", async () => {
    // The conservative first-slice rule: one request id is one upstream call,
    // even when the first attempt's outcome is unknown.
    const state = botState({
      events: [
        modelRequest(SCOPE.requestId),
        { type: "model/usage", requestId: SCOPE.requestId },
        modelRequest(SCOPE.requestId),
      ],
    });
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    expect(outcome).toMatchObject({ status: "refused" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /not sent twice/,
    );
  });

  test("sends nothing when the Connection was revoked or replaced", async () => {
    for (const options of [
      { connectionState: "revoked" as const },
      { connectionGeneration: "generation-9" },
      { connectionPackageId: "provider-openai" },
    ]) {
      const state = botState({
        events: [modelRequest(SCOPE.requestId)],
        ...options,
      });
      const { handle } = begin(
        (state as never as BotStateStub).modelTransports,
        {
          session: state.session,
        },
      );
      const outcome = await isolateModelTransport(
        state as never,
        transportCall(handle.transportId),
      );
      expect(outcome).toMatchObject({ status: "refused" });
      expect(String((outcome as { reason: string }).reason)).toMatch(
        /Connection/,
      );
    }
  });

  test("a ticket is spent once, whatever a Plugin does with it", async () => {
    const state = botState({ events: [modelRequest(SCOPE.requestId)] });
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
    });
    const first = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    // The first call got as far as the (stand-in) Connection read; the second
    // never gets that far.
    expect(first).toMatchObject({ status: "unavailable" });
    expect(
      await isolateModelTransport(
        state as never,
        transportCall(handle.transportId),
      ),
    ).toMatchObject({ status: "refused" });
  });
});

describe("a summariser's call, which outlives its Turn", () => {
  const EFFECT = "compaction-effect-1";

  /** The log a compaction writes before it calls, and the binding it ran on. */
  function compactionEvents(
    overrides: {
      effectId?: string;
      provider?: string;
      model?: string;
      connectionId?: string;
    } = {},
  ) {
    return [
      modelRequest("request-1"),
      {
        type: "conversation/compaction-intent",
        effectId: overrides.effectId ?? EFFECT,
        throughTurn: 6,
        provider: overrides.provider ?? "deepseek",
        model: overrides.model ?? "deepseek-v4-pro",
      },
    ];
  }

  /** Keeps the scheduler's in-flight flag true for the duration of a test. */
  function inFlight(sessionId: string): () => void {
    const settle = Promise.withResolvers<void>();
    compactionWorkV1(sessionId).start(() => settle.promise);
    return () => settle.resolve();
  }

  test("is admitted while it runs, with no Turn in the active slot", async () => {
    const state = botState({ events: compactionEvents() });
    const release = inFlight(SCOPE.sessionId);
    try {
      // The Turn that asked for it is over: nothing is in the slot.
      (state as { turn: { current: unknown } }).turn.current = undefined;
      const { handle } = begin(
        (state as never as BotStateStub).modelTransports,
        { requestId: EFFECT, session: state.session },
      );
      const outcome = await isolateModelTransport(
        state as never,
        transportCall(handle.transportId),
      );
      // Past every durable gate: the call gets as far as the stand-in
      // Connection, which is where this stub always stops.
      expect(outcome).toMatchObject({ status: "unavailable" });
      expect(String((outcome as { reason: string }).reason)).toMatch(
        /credential/,
      );
    } finally {
      release();
    }
  });

  test("is refused once its outcome is on the log", async () => {
    const state = botState({
      events: [
        ...compactionEvents(),
        {
          type: "conversation/compacted",
          effectId: EFFECT,
          fromTurn: 1,
          throughTurn: 6,
          summary: "## Summary\nx",
          identifiers: [],
          provider: "deepseek",
          model: "deepseek-v4-pro",
        },
      ],
    });
    const release = inFlight(SCOPE.sessionId);
    try {
      const { handle } = begin(
        (state as never as BotStateStub).modelTransports,
        { requestId: EFFECT, session: state.session },
      );
      const outcome = await isolateModelTransport(
        state as never,
        transportCall(handle.transportId),
      );
      expect(outcome).toMatchObject({ status: "refused" });
      expect(String((outcome as { reason: string }).reason)).toMatch(
        /already has an outcome/,
      );
    } finally {
      release();
    }
  });

  test("is refused when no summariser is running for it", async () => {
    const state = botState({ events: compactionEvents() });
    (state as { turn: { current: unknown } }).turn.current = undefined;
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      requestId: EFFECT,
      session: state.session,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    expect(outcome).toMatchObject({ status: "refused" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /summariser that asked for this call is not running/,
    );
  });

  test("is refused when the binding it names is not the one the Conversation runs on", async () => {
    const state = botState({ events: compactionEvents() });
    const release = inFlight(SCOPE.sessionId);
    try {
      const { handle, dispatch } = begin(
        (state as never as BotStateStub).modelTransports,
        { requestId: EFFECT, session: state.session },
      );
      dispatch.connectionGeneration = "generation-9";
      const outcome = await isolateModelTransport(
        state as never,
        transportCall(handle.transportId),
      );
      expect(outcome).toMatchObject({ status: "refused" });
      expect(String((outcome as { reason: string }).reason)).toMatch(
        /does not match the durable intent/,
      );
    } finally {
      release();
    }
  });

  test("an ordinary model call is still refused without its Turn", async () => {
    const state = botState({ events: [modelRequest(SCOPE.requestId)] });
    (state as { turn: { current: unknown } }).turn.current = undefined;
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    expect(outcome).toMatchObject({ status: "refused" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /not running in this Bot's active Composition/,
    );
  });
});

describe("the provider catalog the host trusts", () => {
  test("names one Plugin, one Package, one route and one endpoint", () => {
    const served = pluginServedProviderV1("deepseek")!;
    expect(served).toMatchObject({
      provider: "deepseek",
      pluginId: "deepseek",
      packageId: "provider-deepseek",
      route: "/chat/completions",
      endpoint: "https://api.deepseek.com",
      maxOutputTokens: 8_192,
      auth: { scheme: "bearer" },
    });
  });

  test("every entry's endpoint and route make the one URL a call may use", () => {
    for (const served of PLUGIN_SERVED_PROVIDERS_V1) {
      const destination = pluginModelTransportUrlV1(
        served.endpoint,
        served.route,
      );
      expect(destination).toMatchObject({ status: "ok" });
      expect("url" in destination && destination.url).toBe(
        `${served.endpoint}${served.route}`,
      );
    }
  });

  test("a provider the deployment does not serve through a Plugin has no entry", () => {
    expect(pluginServedProviderV1("openai")).toBeUndefined();
  });
});
