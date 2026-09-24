import { describe, expect, test } from "bun:test";
import {
  LoopHookListV1,
  ModelProviderFailureError,
  type AgentRuntimeV1,
  type LlmProvider,
  type LlmStreamEvent,
  type NormalizedModelRequest,
} from "@frockbot/core/contracts";
import {
  FROCK_AI_CONNECTION_GENERATION,
  FROCK_AI_CONNECTION_ID,
  FROCK_AI_DEFAULT_MODEL,
  FROCK_AI_SUMMARY_MODEL,
} from "@frockbot/providers/frock-ai/catalog";
import {
  createFrockAiFeature,
  frockAiServedModelFromHeadersV1,
} from "@frockbot/providers/frock-ai/runtime";
import type { UsageReservation, UsageSettlement } from "./ledger";
import {
  BilledLlmRegistry,
  type AccountUsage,
  type ModelBilling,
} from "./model";
import {
  decodeHostedModelRatesV1,
  decodeSaveHostedModelRatesCommandV1,
  modelCost,
  seedHostedModelRatesV1,
  type HostedModelRatesV1,
  type ModelRate,
} from "./rates";

const rate: ModelRate = {
  inputMicrosPerToken: 3,
  cachedInputMicrosPerToken: 1,
  outputMicrosPerToken: 5,
  maximumInputTokens: 100,
  maximumOutputTokens: 20,
};

/** Auto's ceiling: `rate`'s prices, with room for the hosted calls below. */
const autoRate: ModelRate = {
  ...rate,
  maximumInputTokens: 2_000,
  maximumOutputTokens: 200,
};

const SERVED = "custom-together/deepseek-ai/DeepSeek-V4.1-Flash";

/** Version 7, so a reservation that names it names this table. */
function table(
  overrides: Partial<Pick<HostedModelRatesV1, "routes" | "served">> = {},
): HostedModelRatesV1 {
  return {
    schemaVersion: 1,
    version: 7,
    createdAt: "2026-09-24T00:00:00.000Z",
    createdBy: "owner@example.com",
    routes: { "model-a": rate, [FROCK_AI_DEFAULT_MODEL]: autoRate },
    served: {
      [SERVED]: {
        inputMicrosPerToken: 1,
        cachedInputMicrosPerToken: 0.5,
        outputMicrosPerToken: 2,
      },
    },
    ...overrides,
  };
}

function request(
  provider = "flock-ai",
  requestId = "request-1",
): NormalizedModelRequest {
  return {
    requestId,
    provider,
    model: "model-a",
    system: "",
    messages: [{ role: "user", content: "hi" }],
    tools: [],
  };
}

class UsageSpy implements AccountUsage {
  reservations: UsageReservation[] = [];
  settlements: UsageSettlement[] = [];
  created = true;
  async reserve(value: UsageReservation) {
    this.reservations.push(value);
    return { status: "reserved" as const, created: this.created };
  }
  async settle(value: UsageSettlement) {
    this.settlements.push(value);
  }
}

function billing(
  account: AccountUsage,
  overrides: Partial<ModelBilling> = {},
): ModelBilling {
  return {
    account,
    rates: async () => table(),
    botId: "bot-1",
    sessionId: "session-1",
    ...overrides,
  };
}

function registry(
  events: LlmStreamEvent[],
  account = new UsageSpy(),
  hooks = new LoopHookListV1(),
  providerId = "flock-ai",
  attribution?: string,
) {
  let calls = 0;
  const provider: LlmProvider = {
    id: providerId,
    async *stream() {
      calls += 1;
      yield* events;
    },
  };
  const llm = new BilledLlmRegistry(
    hooks,
    billing(account, attribution ? { attribution } : {}),
  );
  llm.register(provider);
  return { llm, account, calls: () => calls };
}

async function collect(llm: BilledLlmRegistry, input = request()) {
  const events: LlmStreamEvent[] = [];
  for await (const event of llm.stream(input, new AbortController().signal))
    events.push(event);
  return events;
}

const quantities = (
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
  reasoningTokens = 0,
) => ({ inputTokens, outputTokens, cachedInputTokens, reasoningTokens });

describe("model billing", () => {
  test("reserves a hosted call at its route's ceiling under the table's version", async () => {
    const hooks = new LoopHookListV1();
    const order: string[] = [];
    hooks.add({
      modelStream(_request, _signal, next) {
        order.push("hook");
        return next();
      },
    });
    const account = new UsageSpy();
    const originalReserve = account.reserve.bind(account);
    account.reserve = async (value) => {
      order.push("reserve");
      return originalReserve(value);
    };
    const { llm } = registry(
      [
        {
          type: "usage",
          usage: {
            inputTokens: 10,
            cachedInputTokens: 4,
            outputTokens: 3,
            reasoningTokens: 2,
          },
        },
        { type: "finish", reason: "completed" },
      ],
      account,
      hooks,
    );
    await collect(llm);
    expect(order).toEqual(["hook", "reserve"]);
    expect(account.reservations[0]).toEqual({
      id: "model:request-1",
      kind: "model",
      maximumMicros: 800,
      botId: "bot-1",
      sessionId: "session-1",
      description: "model-a",
      pricingVersion: "model-rates-7",
      unitRates: {
        inputMicrosPerToken: 6,
        cachedInputMicrosPerToken: 2,
        outputMicrosPerToken: 10,
      },
    });
    // No Frock AI provider said which model answered, so the ceiling is
    // charged and the settlement says the answer was not priced.
    expect(account.settlements[0]).toEqual({
      id: "model:request-1",
      costMicros: 37,
      chargeMicros: 74,
      pricing: "unpriced",
      unitRates: {
        inputMicrosPerToken: 6,
        cachedInputMicrosPerToken: 2,
        outputMicrosPerToken: 10,
      },
      quantities: quantities(10, 3, 4, 2),
    });
  });

  test("a hook-supplied answer that bypasses the provider creates no charge", async () => {
    const hooks = new LoopHookListV1();
    hooks.add({
      modelStream: async function* () {
        yield { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } };
        yield { type: "finish", reason: "completed" };
      },
    });
    const { llm, account, calls } = registry([], new UsageSpy(), hooks);
    await collect(llm);
    expect(calls()).toBe(0);
    expect(account.reservations).toEqual([]);
    expect(account.settlements).toEqual([]);
  });

  test("a hook cannot lower the provider usage captured for billing", async () => {
    const hooks = new LoopHookListV1();
    hooks.add({
      modelStream: async function* (_request, _signal, next) {
        for await (const event of next()) {
          yield event.type === "usage"
            ? { type: "usage", usage: { inputTokens: 0, outputTokens: 0 } }
            : event;
        }
      },
    });
    const { llm, account } = registry(
      [
        { type: "usage", usage: { inputTokens: 10, outputTokens: 3 } },
        { type: "finish", reason: "completed" },
      ],
      new UsageSpy(),
      hooks,
    );
    const output = await collect(llm);
    expect(output.find((event) => event.type === "usage")).toEqual({
      type: "usage",
      usage: { inputTokens: 0, outputTokens: 0 },
    });
    expect(account.settlements[0]?.chargeMicros).toBe(90);
  });

  test("a hook cannot disguise the selected hosted provider as a free connection", async () => {
    const hooks = new LoopHookListV1();
    hooks.add({
      modelStream(modelRequest, _signal, next) {
        modelRequest.provider = "own-provider";
        return next();
      },
    });
    const { llm, account } = registry(
      [
        { type: "usage", usage: { inputTokens: 2, outputTokens: 1 } },
        { type: "finish", reason: "completed" },
      ],
      new UsageSpy(),
      hooks,
    );
    await collect(llm);
    expect(account.reservations[0]).toMatchObject({
      maximumMicros: 800,
      description: "model-a",
    });
    expect(account.settlements[0]?.chargeMicros).toBe(22);
  });

  test("duplicate invocation identity is refused before provider dispatch", async () => {
    const account = new UsageSpy();
    account.created = false;
    const hooks = new LoopHookListV1();
    let hooksCalled = 0;
    hooks.add({
      modelStream(_request, _signal, next) {
        hooksCalled += 1;
        return next();
      },
    });
    const { llm, calls } = registry([], account, hooks);
    await expect(collect(llm)).rejects.toBeInstanceOf(
      ModelProviderFailureError,
    );
    expect({
      hooksCalled,
      providerCalls: calls(),
      settlements: account.settlements.length,
    }).toEqual({ hooksCalled: 1, providerCalls: 0, settlements: 0 });
  });

  // ADR 0026 step 9c: a Plugin spends the Bot's budget under the Turn's own
  // Session, and the operation the User reads has to say which Plugin did it.
  test("a Plugin's call is billed to the Turn's Session, named on the operation", async () => {
    const { llm, account } = registry(
      [
        { type: "usage", usage: { inputTokens: 10, outputTokens: 3 } },
        { type: "finish", reason: "completed" },
      ],
      new UsageSpy(),
      new LoopHookListV1(),
      "flock-ai",
      "plugin weather",
    );
    await collect(llm);
    expect(account.reservations[0]).toMatchObject({
      botId: "bot-1",
      sessionId: "session-1",
      description: "model-a · plugin weather",
    });
    expect(account.settlements[0]).toMatchObject({
      costMicros: 45,
      chargeMicros: 90,
    });
  });

  test("a Plugin on its own model account is named beside the connection", async () => {
    const { llm, account } = registry(
      [
        { type: "usage", usage: { inputTokens: 500, outputTokens: 20 } },
        { type: "finish", reason: "completed" },
      ],
      new UsageSpy(),
      new LoopHookListV1(),
      "own-provider",
      "plugin weather",
    );
    await collect(llm, request("own-provider"));
    expect(account.reservations[0]).toMatchObject({
      maximumMicros: 0,
      description: "model-a · own model account · plugin weather",
    });
  });

  test("a connected model account settles at zero without reading the rate table", async () => {
    const account = new UsageSpy();
    let reads = 0;
    const llm = new BilledLlmRegistry(
      new LoopHookListV1(),
      billing(account, {
        rates: async () => {
          reads += 1;
          return table();
        },
      }),
    );
    llm.register({
      id: "own-provider",
      async *stream() {
        yield { type: "usage", usage: { inputTokens: 500, outputTokens: 20 } };
        yield { type: "finish", reason: "completed" };
      },
    });
    await collect(llm, request("own-provider"));
    expect(reads).toBe(0);
    expect(account.reservations[0]).toMatchObject({
      maximumMicros: 0,
      description: "model-a · own model account",
    });
    expect(account.settlements[0]).toEqual({
      id: "model:request-1",
      costMicros: 0,
      chargeMicros: 0,
      quantities: quantities(500, 20),
    });
  });

  test("a completed hosted stream with no usage leaves its reservation pending", async () => {
    const { llm, account } = registry([
      { type: "finish", reason: "completed" },
    ]);
    await collect(llm);
    expect(account.settlements).toEqual([]);
  });

  test("a provider failure after partial usage leaves its reservation for reconciliation", async () => {
    const account = new UsageSpy();
    const llm = new BilledLlmRegistry(new LoopHookListV1(), billing(account));
    llm.register({
      id: "flock-ai",
      async *stream() {
        yield { type: "usage", usage: { inputTokens: 5, outputTokens: 1 } };
        throw new ModelProviderFailureError({
          classification: "transient",
          reason: "stream failed late",
        });
      },
    });
    await expect(collect(llm)).rejects.toBeInstanceOf(
      ModelProviderFailureError,
    );
    expect(account.settlements).toEqual([]);
  });

  test("a provider failure part-way through a tool call's arguments is not free", async () => {
    const account = new UsageSpy();
    const llm = new BilledLlmRegistry(new LoopHookListV1(), billing(account));
    llm.register({
      id: "flock-ai",
      async *stream() {
        yield {
          type: "tool-input-delta",
          id: "call-1",
          name: "send_to_user",
          delta: '{"payload":{"type":"text","text":"Half a rep',
        };
        throw new ModelProviderFailureError({
          classification: "transient",
          reason: "stream failed mid-call",
        });
      },
    });
    await expect(collect(llm)).rejects.toBeInstanceOf(
      ModelProviderFailureError,
    );
    // The model wrote output, so the reservation waits for reconciliation
    // rather than settling as a call that cost nothing.
    expect(account.settlements).toEqual([]);
  });

  test("a rate table that cannot be read refuses the call before anything is reserved", async () => {
    const account = new UsageSpy();
    const llm = new BilledLlmRegistry(
      new LoopHookListV1(),
      billing(account, {
        rates: () => Promise.reject(new Error("authority unreachable")),
      }),
    );
    let dispatched = false;
    llm.register({
      id: "flock-ai",
      async *stream() {
        dispatched = true;
      },
    });
    const failure = await collect(llm).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelProviderFailureError);
    expect((failure as ModelProviderFailureError).classification).toBe(
      "transient",
    );
    expect({ dispatched, reservations: account.reservations }).toEqual({
      dispatched: false,
      reservations: [],
    });
  });

  test("a model the table does not route is refused before anything is reserved", async () => {
    const account = new UsageSpy();
    const { llm } = registry([], account);
    await expect(
      collect(llm, { ...request(), model: "model-unpriced" }),
    ).rejects.toThrow("does not have a published usage rate");
    expect(account.reservations).toEqual([]);
  });

  test("a Bot bound before the rename is priced by the renamed route", async () => {
    const account = new UsageSpy();
    const { llm } = registry(
      [
        { type: "usage", usage: { inputTokens: 1, outputTokens: 1 } },
        { type: "finish", reason: "completed" },
      ],
      account,
    );
    await collect(llm, { ...request(), model: "@flock/auto" });
    expect(account.reservations[0]).toMatchObject({ maximumMicros: 14_000 });
  });

  test("counts cached input at its discounted rate and validates provider reports", () => {
    expect(
      modelCost(
        { inputTokens: 10, cachedInputTokens: 4, outputTokens: 3 },
        rate,
      ),
    ).toBe(37);
    expect(() =>
      modelCost(
        { inputTokens: 3, cachedInputTokens: 4, outputTokens: 0 },
        rate,
      ),
    ).toThrow("Invalid reported model usage");
  });
});

/**
 * The real Frock AI provider behind a Gateway stand-in: the served model comes
 * from the response headers, exactly as the Cloudflare host reads them.
 */
function hosted(
  headers: Record<string, string>,
  options: {
    rates?: HostedModelRatesV1;
    usage?: string;
    reports?: unknown[];
    settled?: UsageSettlement[];
  } = {},
) {
  const account = new UsageSpy();
  const llm = new BilledLlmRegistry(
    new LoopHookListV1(),
    billing(account, {
      rates: async () => options.rates ?? table(),
      reportUnpriced: (report) => options.reports?.push(report),
      settled: (settlement) => options.settled?.push(settlement),
    }),
  );
  const usage =
    options.usage ??
    '{"prompt_tokens":1000,"completion_tokens":100,"prompt_tokens_details":{"cached_tokens":400}}';
  createFrockAiFeature({
    connectionId: FROCK_AI_CONNECTION_ID,
    connectionGeneration: FROCK_AI_CONNECTION_GENERATION,
    autoRoute: "flock-auto",
    runChatCompletion: async (_model, _body, _signal, served) => {
      served?.(frockAiServedModelFromHeadersV1(new Headers(headers)));
      const body = new Response(
        `data: {"choices":[{"delta":{"content":"hi"},"finish_reason":"stop"}],"usage":${usage}}\n\ndata: [DONE]\n\n`,
      ).body;
      if (!body) throw new Error("test response stream is unavailable");
      return body;
    },
  })({ llm, hooks: new LoopHookListV1() } as unknown as AgentRuntimeV1);
  const auto: NormalizedModelRequest = {
    ...request(),
    model: FROCK_AI_DEFAULT_MODEL,
    modelBinding: {
      connectionId: FROCK_AI_CONNECTION_ID,
      connectionGeneration: FROCK_AI_CONNECTION_GENERATION,
    },
  };
  return { account, run: () => collect(llm, auto) };
}

const TOGETHER = {
  "cf-aig-provider": "custom-together",
  "cf-aig-model": "deepseek-ai/DeepSeek-V4.1-Flash",
  "cf-aig-cache-status": "MISS",
};

describe("hosted calls, billed by the model that answered", () => {
  test("reserve at the ceiling, settle at the served model's rate", async () => {
    const { account, run } = hosted(TOGETHER);
    await run();
    // Ceiling: 2000 × 3 + 200 × 5 = 7000 micros, charged twice.
    expect(account.reservations[0]).toMatchObject({
      maximumMicros: 14_000,
      pricingVersion: "model-rates-7",
      unitRates: {
        inputMicrosPerToken: 6,
        cachedInputMicrosPerToken: 2,
        outputMicrosPerToken: 10,
      },
    });
    // Served: 600 × 1 + 400 × 0.5 + 100 × 2 = 1000 micros.
    expect(account.settlements).toEqual([
      {
        id: "model:request-1",
        costMicros: 1000,
        chargeMicros: 2000,
        pricing: "served",
        servedModel: SERVED,
        unitRates: {
          inputMicrosPerToken: 2,
          cachedInputMicrosPerToken: 1,
          outputMicrosPerToken: 4,
        },
        quantities: quantities(1000, 100, 400),
      },
    ]);
  });

  test("a served model with no rate settles at the ceiling, flagged and reported", async () => {
    const reports: unknown[] = [];
    const { account, run } = hosted(
      { ...TOGETHER, "cf-aig-model": "deepseek-ai/DeepSeek-V5" },
      { reports },
    );
    await run();
    // Ceiling: 600 × 3 + 400 × 1 + 100 × 5 = 2700 micros.
    expect(account.settlements[0]).toMatchObject({
      costMicros: 2700,
      chargeMicros: 5400,
      pricing: "unpriced",
      servedModel: "custom-together/deepseek-ai/DeepSeek-V5",
    });
    expect(reports).toEqual([
      {
        servedModel: "custom-together/deepseek-ai/DeepSeek-V5",
        route: FROCK_AI_DEFAULT_MODEL,
        version: 7,
      },
    ]);
  });

  test("an answer that names no model settles at the ceiling and is reported unnamed", async () => {
    const reports: unknown[] = [];
    const { account, run } = hosted({}, { reports });
    await run();
    expect(account.settlements[0]).toMatchObject({
      chargeMicros: 5400,
      pricing: "unpriced",
    });
    expect(account.settlements[0]).not.toHaveProperty("servedModel");
    expect(reports).toEqual([
      { servedModel: null, route: FROCK_AI_DEFAULT_MODEL, version: 7 },
    ]);
  });

  test("a Gateway cache hit ran no provider and settles at zero", async () => {
    const reports: unknown[] = [];
    const { account, run } = hosted(
      { ...TOGETHER, "cf-aig-cache-status": "HIT" },
      { reports },
    );
    await run();
    expect(account.settlements).toEqual([
      {
        id: "model:request-1",
        costMicros: 0,
        chargeMicros: 0,
        pricing: "cached",
        servedModel: SERVED,
        quantities: quantities(1000, 100, 400),
      },
    ]);
    expect(reports).toEqual([]);
  });

  test("a served model priced above its route is charged the ceiling, never more", async () => {
    const { account, run } = hosted(TOGETHER, {
      rates: table({
        served: {
          [SERVED]: {
            inputMicrosPerToken: 10,
            cachedInputMicrosPerToken: 5,
            outputMicrosPerToken: 10,
          },
        },
      }),
    });
    await run();
    // Served: 600 × 10 + 400 × 5 + 100 × 10 = 9000; the ceiling is 2700.
    expect(account.settlements[0]).toMatchObject({
      costMicros: 9000,
      chargeMicros: 5400,
      pricing: "capped",
      servedModel: SERVED,
    });
    expect(account.settlements[0]!.chargeMicros).toBeLessThanOrEqual(
      account.reservations[0]!.maximumMicros,
    );
  });

  test("each reservation records the version it was priced from", async () => {
    const { account, run } = hosted(TOGETHER, {
      rates: { ...table(), version: 12 },
    });
    await run();
    expect(account.reservations[0]?.pricingVersion).toBe("model-rates-12");
  });

  test("whoever shows the charge is told the settlement", async () => {
    const settled: UsageSettlement[] = [];
    const { account, run } = hosted(TOGETHER, { settled });
    await run();
    expect(settled).toEqual(account.settlements);
  });
});

describe("the hosted model rate table", () => {
  test("seeds the prices production ran on, with the model Auto serves priced as served", () => {
    const seed = decodeHostedModelRatesV1(
      seedHostedModelRatesV1("2026-09-24T00:00:00.000Z"),
    );
    expect(seed.version).toBe(1);
    expect(seed.routes[FROCK_AI_DEFAULT_MODEL]).toEqual({
      inputMicrosPerToken: 0.3,
      cachedInputMicrosPerToken: 0.006,
      outputMicrosPerToken: 1.2,
      maximumInputTokens: 400_000,
      maximumOutputTokens: 16_384,
    });
    expect(Object.keys(seed.routes).toSorted()).toEqual([
      "@flock/auto",
      "@flock/deepseek-ai/deepseek-v4-flash-0731",
      "@frock/auto",
      "@frock/deepseek-ai/deepseek-v4-flash-0731",
      FROCK_AI_SUMMARY_MODEL,
    ]);
    // Summaries run on their own route for every Bot, so a billed Bot can
    // compact from the first deploy.
    expect(seed.routes[FROCK_AI_SUMMARY_MODEL]).toEqual(
      seed.routes[FROCK_AI_DEFAULT_MODEL],
    );
    expect(seed.served).toEqual({
      [SERVED]: {
        inputMicrosPerToken: 0.3,
        cachedInputMicrosPerToken: 0.006,
        outputMicrosPerToken: 1.2,
      },
    });
  });

  const command = (routes: unknown, served: unknown = {}) => ({
    schemaVersion: 1,
    type: "deployment/save-model-rates",
    baseVersion: 1,
    routes,
    served,
  });
  const auto = (overrides: Record<string, unknown> = {}) => ({
    [FROCK_AI_DEFAULT_MODEL]: { ...rate, ...overrides },
    [FROCK_AI_SUMMARY_MODEL]: rate,
  });

  test("accepts fractional micro-dollars", () => {
    expect(
      decodeSaveHostedModelRatesCommandV1(
        command(auto({ cachedInputMicrosPerToken: 0.006 }), {
          [SERVED]: {
            inputMicrosPerToken: 0.3,
            cachedInputMicrosPerToken: 0.006,
            outputMicrosPerToken: 1.2,
          },
        }),
      ).routes[FROCK_AI_DEFAULT_MODEL]?.cachedInputMicrosPerToken,
    ).toBe(0.006);
  });

  test("refuses malformed or economically unsafe tables", () => {
    for (const [routes, served, message] of [
      [auto({ cachedInputMicrosPerToken: 4 }), {}, "cached input above"],
      [
        auto({
          inputMicrosPerToken: 1_000_000,
          outputMicrosPerToken: 1_000_000,
          maximumInputTokens: 1_000_000,
          maximumOutputTokens: 1_000_000,
        }),
        {},
        "more than one dispatch may",
      ],
      [auto({ inputMicrosPerToken: -1 }), {}, "from 0 to"],
      [auto({ maximumOutputTokens: 1.5 }), {}, "whole number of tokens"],
      [auto({ inputMicrosPerTok: 1 }), {}, 'unknown field "inputMicrosPerTok"'],
      [auto(), { [SERVED]: rate }, 'unknown field "maximumInputTokens"'],
      [
        auto(),
        {
          "no-provider": {
            inputMicrosPerToken: 1,
            cachedInputMicrosPerToken: 1,
            outputMicrosPerToken: 1,
          },
        },
        '"<provider>/<model>"',
      ],
      [{ "model-a": rate }, {}, 'routes must price "@frock/auto"'],
      [
        { [FROCK_AI_DEFAULT_MODEL]: rate },
        {},
        'routes must price "@frock/structured"',
      ],
      [{}, {}, "at least one model"],
    ] as const) {
      expect(() =>
        decodeSaveHostedModelRatesCommandV1(command(routes, served)),
      ).toThrow(message);
    }
  });
});
