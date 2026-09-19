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
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "@frockbot/core/connection";
import type { UserSettingsViewV1 } from "@frockbot/core/configuration";
import {
  pluginServedProviderV1,
  PLUGIN_SERVED_PROVIDERS_V1,
} from "@frockbot/providers/catalog/definition";
import { pluginModelTransportUrlV1 } from "@frockbot/core/contracts";
import {
  createPluginModelHostV1,
  isolateModelTransport,
  PLUGIN_MODEL_MAX_OUTPUT_TOKENS_V1,
  pluginModelBodyRefusalV1,
  pluginModelOutputBoundV1,
  pluginModelStatusV1,
  priorOutcomeUnknownV1,
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

/**
 * A real keyring and a real sealed secret, so the tests that need to reach the
 * fetch pass the same credential gate the Durable Object runs.
 */
const SERIALIZED_KEYRING =
  '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}';

async function sealedLease(effectId: string) {
  const envelope = await sealCredentialV1({
    keyring: parseCredentialKeyringV1(SERIALIZED_KEYRING),
    context: {
      accountId: "user-1",
      connectionId: "connection-1",
      packageId: "provider-deepseek",
      credentialGeneration: "generation-1",
    },
    plaintext: "test-key",
  });
  return {
    schemaVersion: 1 as const,
    leaseId: "lease-1",
    effectId,
    connectionId: "connection-1",
    credentialGeneration: "generation-1",
    expiresAt: "2099-01-01T00:00:00.000Z",
    envelope,
  };
}

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
  overrides: {
    requestId?: string;
    session?: unknown;
    deadlineAt?: number;
    /** The host admits this from the log; here a suite may state it directly. */
    priorOutcomeUnknown?: boolean;
  } = {},
) {
  return registry.begin({
    requestId: overrides.requestId ?? SCOPE.requestId,
    session: (overrides.session ?? session()) as never,
    priorOutcomeUnknown: overrides.priorOutcomeUnknown === true,
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
    deadlineAt: overrides.deadlineAt ?? Date.now() + 60_000,
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
    expect(handle.sent()).toBe(false);
    const dispatch = registry.take(handle.transportId)!;
    // Spending the ticket is not sending: only the fetch says a call left.
    expect(handle.sent()).toBe(false);
    dispatch.sent = true;
    expect(handle.sent()).toBe(true);
    expect(handle.priorOutcomeUnknown()).toBe(false);
    dispatch.priorOutcomeUnknown = true;
    expect(handle.priorOutcomeUnknown()).toBe(true);
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
  /** Makes the transport's credential gate pass, so the fetch is reached. */
  credentials?: boolean;
  /** The upstream answer, or a fetcher that fails before answering. */
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
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
    outboundFetch: options.fetch,
    env: {
      ...(options.credentials === true
        ? { CREDENTIAL_KEYRING: SERIALIZED_KEYRING }
        : {}),
      USER_CONFIGURATIONS: {
        idFromName: (name: string) => name,
        get: () => ({
          readConfiguration: async () =>
            ({
              // This stands in for the UserConfiguration RPC itself, whose
              // boundary returns the complete, versioned settings view.
              schemaVersion: 1,
              revision: 1,
              profile: { name: "Test user" },
              packages: [],
              connections: [
                {
                  connectionId: "connection-1",
                  packageId: options.connectionPackageId ?? "provider-deepseek",
                  connectionTypeId: "deepseek-api-key",
                  displayName: "DeepSeek",
                  state: options.connectionState ?? "ready",
                  generation: options.connectionGeneration ?? "generation-1",
                  providerType: "deepseek",
                  safeMetadata: {},
                  settings: {},
                },
              ],
            }) satisfies UserSettingsViewV1,
          ...(options.credentials === true
            ? { leaseModelCredential: async () => sealedLease(requestId) }
            : {}),
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

function transportCall(
  transportId: string,
  body: Record<string, unknown> = {
    model: "deepseek-v4-pro",
    stream: true,
    max_tokens: 1_024,
  },
) {
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
      body: JSON.stringify(body),
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

  test("sends nothing for an effect the kernel dispatched a second time, and keeps its possible cost", async () => {
    // The conservative first-slice rule: one request id is one upstream call,
    // even when the first attempt's outcome is unknown. Unknown is the point:
    // the log carries no outcome for it, so whether the provider accepted and
    // billed the first call is exactly what is not known, and erasing it with
    // a definitive no-effect result would be the wrong way round.
    const state = botState({
      events: [modelRequest(SCOPE.requestId), modelRequest(SCOPE.requestId)],
    });
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /not sent twice/,
    );
    expect(handle.sent()).toBe(false);
    // No refusal: the adapter settles this as uncertainty and records the
    // estimate, rather than a call that never happened. The dispatch says so
    // itself, because this ticket is not the call whose cost is in question.
    expect(handle.refusal()).toBeUndefined();
    expect(handle.priorOutcomeUnknown()).toBe(true);
  });

  test("a replay of an effect the kernel retried after a refusal is a definitive refusal", async () => {
    // The kernel journals `model/retry` only after a failure it classified,
    // and a classified failure is one that did not bill. So this replay is not
    // uncertain: the effect is accounted for, and refusing to send it again is
    // a call that did not happen — no estimate belongs to it.
    const state = botState({
      events: [
        modelRequest(SCOPE.requestId),
        {
          type: "model/retry",
          turn: 1,
          step: 1,
          attempt: 2,
          classification: "transient",
          delayMs: 500,
        },
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
    expect(handle.priorOutcomeUnknown()).toBe(false);
    expect(handle.refusal()).toMatchObject({ classification: "permanent" });
  });

  test("a second dispatch of an effect the log already accounted for adds nothing", async () => {
    // The first dispatch settled and its usage is durable, so the effect is
    // paid for already: refusing to send again is a definitive result, and no
    // second estimate is recorded.
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
    expect(handle.sent()).toBe(false);
    expect(handle.refusal()).toMatchObject({ classification: "permanent" });
    // The effect is accounted for, so nothing about it is uncertain: this
    // refusal must not become a second estimate.
    expect(handle.priorOutcomeUnknown()).toBe(false);
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

/**
 * A refusal the host itself makes is a call that did not happen, and it has to
 * be recorded as one: the adapter reads the host's own answer to decide
 * whether the effect may be settled without an estimate (ADR 0032).
 */
/**
 * The one question that decides whether an attempt answers for a possible
 * cost: does the log show an earlier dispatch of this effect that nothing
 * ever accounted for? It is read from the durable journal alone, and it is
 * read when the attempt is admitted — before the Plugin is called — so a
 * failure that never reaches the transport cannot erase that cost.
 */
describe("what the log says of the effect behind an attempt", () => {
  const retried = () => ({
    type: "model/retry",
    turn: 1,
    step: 1,
    attempt: 2,
    classification: "transient",
    delayMs: 500,
  });
  const usage = () => ({
    type: "model/usage",
    requestId: SCOPE.requestId,
    estimated: true,
  });

  test("a first dispatch is not a replay of anything", () => {
    expect(
      priorOutcomeUnknownV1(
        session([modelRequest(SCOPE.requestId)]) as never,
        SCOPE.requestId,
      ),
    ).toBe(false);
  });

  test("an interrupted dispatch with nothing recorded is uncertain", () => {
    expect(
      priorOutcomeUnknownV1(
        session([
          modelRequest(SCOPE.requestId),
          modelRequest(SCOPE.requestId),
        ]) as never,
        SCOPE.requestId,
      ),
    ).toBe(true);
  });

  test("an effect whose usage is on the log is accounted for", () => {
    expect(
      priorOutcomeUnknownV1(
        session([
          modelRequest(SCOPE.requestId),
          usage(),
          modelRequest(SCOPE.requestId),
        ]) as never,
        SCOPE.requestId,
      ),
    ).toBe(false);
  });

  test("a retry the kernel planned after a classified failure is accounted for", () => {
    expect(
      priorOutcomeUnknownV1(
        session([
          modelRequest(SCOPE.requestId),
          retried(),
          modelRequest(SCOPE.requestId),
        ]) as never,
        SCOPE.requestId,
      ),
    ).toBe(false);
  });

  test("the admission reads it before the Plugin is called", () => {
    const state = botState({
      events: [modelRequest(SCOPE.requestId), modelRequest(SCOPE.requestId)],
    });
    const host = createPluginModelHostV1(
      state as never,
      { userId: "user-1", botId: SCOPE.botId },
      {
        provider: pluginServedProviderV1("deepseek")!,
        connectionId: "connection-1",
        connectionGeneration: "generation-1",
        model: "deepseek-v4-pro",
        maxOutputTokens: 8_192,
      },
    );
    const handle = host.begin({
      scope: SCOPE,
      session: state.session as never,
      deadlineAt: Date.now() + 60_000,
    });
    // Nothing has called the transport, and the ticket was never presented:
    // the flag is the log's own answer, taken at admission.
    expect(handle.priorOutcomeUnknown()).toBe(true);
    handle.finish();
  });
});

describe("a refusal the host makes before the fetch", () => {
  /** The upstream requests the host issues: a refusal here means none. */
  function upstream() {
    const made: string[] = [];
    return {
      made,
      fetch: async (url: string): Promise<Response> => {
        made.push(url);
        return new Response("not reached", { status: 200 });
      },
    };
  }

  test("a body the host will not send is recorded as a definitive refusal", async () => {
    const requests = upstream();
    const state = botState({
      events: [modelRequest(SCOPE.requestId)],
      credentials: true,
      fetch: requests.fetch,
    });
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId, {
        model: "deepseek-v4-flash",
        stream: true,
        max_tokens: 1_024,
      }),
    );
    expect(outcome).toMatchObject({ status: "refused" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /not admitted/,
    );
    expect(handle.sent()).toBe(false);
    expect(handle.refusal()).toMatchObject({
      httpStatus: 0,
      classification: "permanent",
    });
    expect(requests.made).toEqual([]);
  });

  test("a clock that ran out before the transport began is recorded too", async () => {
    const requests = upstream();
    const state = botState({
      events: [modelRequest(SCOPE.requestId)],
      credentials: true,
      fetch: requests.fetch,
    });
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
      deadlineAt: Date.now() - 1,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    expect(outcome).toMatchObject({ status: "refused" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /time ran out/,
    );
    expect(handle.sent()).toBe(false);
    expect(handle.refusal()).toMatchObject({ classification: "permanent" });
    expect(requests.made).toEqual([]);
  });

  test("a Connection that is not ready is a refusal, not an unknown outcome", async () => {
    const requests = upstream();
    const state = botState({
      events: [modelRequest(SCOPE.requestId)],
      credentials: true,
      connectionState: "revoked",
      fetch: requests.fetch,
    });
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    expect(outcome).toMatchObject({ status: "refused" });
    expect(handle.sent()).toBe(false);
    expect(handle.refusal()).toMatchObject({ classification: "permanent" });
    expect(requests.made).toEqual([]);
  });

  test("a credential the host cannot open refuses too, with nothing sent", async () => {
    const requests = upstream();
    const state = botState({
      events: [modelRequest(SCOPE.requestId)],
      fetch: requests.fetch,
    });
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /credential is unavailable/,
    );
    // No credential is not an unknown outcome: the host made the call and
    // refused it before the fetch, so the failure is definitive and costs
    // nothing — but the classification is unknown because nothing here says
    // whether a retry would find the key.
    expect(handle.sent()).toBe(false);
    expect(handle.priorOutcomeUnknown()).toBe(false);
    expect(handle.refusal()).toMatchObject({
      httpStatus: 0,
      classification: "unknown",
    });
    expect(requests.made).toEqual([]);
  });
});

/**
 * Once the fetch is issued the dispatch is a call the provider may have billed,
 * and only a status the host reads itself can say otherwise. Nothing here is
 * the Plugin's account of the call: it is what the host observed of it.
 */
describe("what the host records of a call it sent", () => {
  async function call(
    fetch: (url: string, init: RequestInit) => Promise<Response>,
  ) {
    const state = botState({
      events: [modelRequest(SCOPE.requestId)],
      credentials: true,
      fetch,
    });
    const { handle } = begin((state as never as BotStateStub).modelTransports, {
      session: state.session,
    });
    const outcome = await isolateModelTransport(
      state as never,
      transportCall(handle.transportId),
    );
    return { handle, outcome };
  }

  test("the provider's refusal keeps the ticket a call with no bill", async () => {
    const { handle, outcome } = await call(
      async () =>
        new Response("", { status: 429, headers: { "retry-after": "2" } }),
    );
    expect(outcome).toMatchObject({ status: "refused", httpStatus: 429 });
    expect(handle.sent()).toBe(true);
    expect(handle.refusal()).toEqual({
      httpStatus: 429,
      classification: "transient",
      retryAfterMs: 2_000,
    });
  });

  test("a 5xx is uncertainty: the call left, and no refusal is recorded", async () => {
    const { handle, outcome } = await call(
      async () => new Response("", { status: 500 }),
    );
    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /outcome of the model request is unknown/,
    );
    expect(handle.sent()).toBe(true);
    expect(handle.refusal()).toBeUndefined();
  });

  test("a call that never answered is uncertainty too", async () => {
    const { handle, outcome } = await call(async () => {
      throw new Error("network down");
    });
    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(String((outcome as { reason: string }).reason)).toMatch(
      /could not be reached/,
    );
    expect(handle.sent()).toBe(true);
    expect(handle.refusal()).toBeUndefined();
  });

  test("the call the host makes carries its own headers and the durable key", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const { handle, outcome } = await call(async (url, init) => {
      seen.push({ url, init });
      return new Response("data: [DONE]\n\n", { status: 200 });
    });
    expect(outcome).toMatchObject({ status: "streaming", httpStatus: 200 });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://api.deepseek.com/chat/completions");
    expect(seen[0]!.init).toMatchObject({
      method: "POST",
      redirect: "manual",
      headers: {
        authorization: "Bearer test-key",
        "idempotency-key": SCOPE.requestId,
      },
    });
    if (outcome.status !== "streaming") throw new Error("no stream");
    await outcome.body.cancel();
    handle.finish();
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
