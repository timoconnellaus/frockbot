import { describe, expect, test } from "bun:test";
import {
  LoopHookListV1,
  ModelProviderFailureError,
  type LlmProvider,
  type LlmStreamEvent,
  type NormalizedModelRequest,
} from "@frockbot/core/contracts";
import {
  BILLING_PLAN,
  type UsageReservation,
  type UsageSettlement,
} from "./ledger";
import {
  BilledLlmRegistry,
  decodeModelRates,
  modelCost,
  type AccountUsage,
  type ModelRate,
} from "./model";

const rate: ModelRate = {
  inputMicrosPerToken: 3,
  cachedInputMicrosPerToken: 1,
  outputMicrosPerToken: 5,
  maximumInputTokens: 100,
  maximumOutputTokens: 20,
};

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
  const llm = new BilledLlmRegistry(hooks, {
    account,
    rates: { "model-a": rate },
    botId: "bot-1",
    sessionId: "session-1",
    ...(attribution ? { attribution } : {}),
  });
  llm.register(provider);
  return { llm, account, calls: () => calls };
}

async function collect(llm: BilledLlmRegistry, input = request()) {
  const events: LlmStreamEvent[] = [];
  for await (const event of llm.stream(input, new AbortController().signal))
    events.push(event);
  return events;
}

describe("model billing", () => {
  test("charges provider usage inside hooks at twice hosted cost", async () => {
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
      pricingVersion: BILLING_PLAN.pricingVersion,
      unitRates: {
        inputMicrosPerToken: 6,
        cachedInputMicrosPerToken: 2,
        outputMicrosPerToken: 10,
      },
    });
    expect(account.settlements[0]).toEqual({
      id: "model:request-1",
      costMicros: 37,
      chargeMicros: 74,
      quantities: {
        inputTokens: 10,
        outputTokens: 3,
        cachedInputTokens: 4,
        reasoningTokens: 2,
      },
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

  test("a connected model account settles at zero even when it reports usage", async () => {
    const account = new UsageSpy();
    const { llm } = registry(
      [
        { type: "usage", usage: { inputTokens: 500, outputTokens: 20 } },
        { type: "finish", reason: "completed" },
      ],
      account,
      new LoopHookListV1(),
      "own-provider",
    );
    await collect(llm, request("own-provider"));
    expect(account.reservations[0]).toMatchObject({
      maximumMicros: 0,
      description: "model-a · own model account",
    });
    expect(account.settlements[0]).toMatchObject({
      costMicros: 0,
      chargeMicros: 0,
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
    const llm = new BilledLlmRegistry(new LoopHookListV1(), {
      account,
      rates: { "model-a": rate },
      botId: "bot-1",
      sessionId: "session-1",
    });
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

  test("refuses malformed or economically unsafe hosted rate tables", () => {
    expect(() =>
      decodeModelRates(
        '{"model-a":{"inputMicrosPerToken":1,"cachedInputMicrosPerToken":2,"outputMicrosPerToken":1,"maximumInputTokens":1,"maximumOutputTokens":1}}',
      ),
    ).toThrow("Invalid hosted model limits");
    expect(() =>
      decodeModelRates(
        '{"model-a":{"inputMicrosPerToken":1000000,"cachedInputMicrosPerToken":0,"outputMicrosPerToken":1000000,"maximumInputTokens":1000000,"maximumOutputTokens":1000000}}',
      ),
    ).toThrow();
  });
});
