import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { PaymentsPlanV1 } from "@frockbot/core/contracts";
import { createPlatformJevFetchV1, jevChargeMicrosV1 } from "../billing/jev.js";
import {
  BillingLedger,
  JEV_FAIR_USE_EXHAUSTED_REASON_V1,
  type BillingStorage,
} from "../billing/ledger.js";
import type { AccountUsage } from "../billing/model.js";
import { runFailureCopyV1 } from "../shell/run-failure-copy.js";
import { createJevClientV1 } from "./jev.js";
import { RESPONSE_REVIEW_MODEL_V1 } from "./response-review.js";

// Turn supervision's Jev, through the real client, against a ledger: metered
// on a plan with Jev fair use, covered on any other.

function storage(database = new Database(":memory:")): BillingStorage {
  return {
    sql: {
      exec<T extends Record<string, unknown>>(
        query: string,
        ...bindings: (string | number | null)[]
      ) {
        const rows = database.query(query).all(...bindings) as T[];
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return database.transaction(callback)();
    },
  };
}

const NOW = Date.UTC(2026, 8, 30);
const DAY = 86_400_000;
const PLAN: PaymentsPlanV1 = {
  subscriptions: [
    {
      id: "byo",
      name: "BYO",
      monthlyCents: 500,
      includedMicros: 0,
      trial: false,
      jevFairUseMicros: 2_000_000,
    },
    {
      id: "standard",
      name: "Standard",
      monthlyCents: 2_000,
      includedMicros: 20_000_000,
    },
  ],
  trial: null,
  topUpCents: [1_000],
  purchasedCreditNeedsSubscription: true,
};

function account(planId: string) {
  const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
  const period = {
    subscriptionId: "sub_1",
    planId,
    periodStart: NOW,
    periodEnd: NOW + 30 * DAY,
  };
  ledger.paymentsPort().apply("evt_paid", period, (effects) => {
    effects.recordSubscription({
      customerId: "cus_1",
      subscriptionId: "sub_1",
      planId,
      status: "active",
      periodStart: NOW,
      periodEnd: NOW + 30 * DAY,
      trialEnd: null,
      cancelAtPeriodEnd: false,
    });
    effects.recordPaidPeriod(period);
  });
  const usage: AccountUsage = {
    reserve: (reservation) => Promise.resolve(ledger.reserve(reservation)),
    settle: (settlement) => Promise.resolve(ledger.settle(settlement)),
  };
  return { ledger, usage };
}

/** A stand-in for Jev that answers, refuses or drops, and counts its calls. */
function jev(answer: (calls: number) => Response | Promise<Response>) {
  let calls = 0;
  return {
    calls: () => calls,
    fetch: async (_input: string, _init?: RequestInit) => {
      calls += 1;
      return answer(calls);
    },
  };
}

const ANSWERED = () =>
  Response.json({
    model: RESPONSE_REVIEW_MODEL_V1,
    answers: { pick: { type: "choice", choice: "a" } },
    usage: { input_tokens: 100, output_tokens: 0 },
  });

async function ask(fetch: ReturnType<typeof createPlatformJevFetchV1>) {
  return await createJevClientV1({
    apiKey: "jev-test",
    baseURL: "https://jev.test",
    fetch,
  }).systemOne(
    {
      state: { said: "hello" },
      questions: {
        pick: {
          type: "choice",
          instructions: "Which?",
          criteria: { a: null, b: null },
        },
      },
    } as never,
    { retry: { maxRetries: 0 } },
  );
}

function metered(usage: AccountUsage, upstream: ReturnType<typeof jev>) {
  let n = 0;
  return createPlatformJevFetchV1({
    account: usage,
    botId: "bot-1",
    sessionId: "session-1",
    fetch: upstream.fetch,
    requestId: () => `r${(n += 1)}`,
  });
}

describe("Turn supervision's Jev", () => {
  test("on BYO, is held before Jev is asked and charged to the fair use", async () => {
    const { ledger, usage } = account("byo");
    const upstream = jev(ANSWERED);
    await ask(metered(usage, upstream));
    expect(upstream.calls()).toBe(1);
    expect(ledger.snapshot().usage).toMatchObject([
      {
        id: "jev:turn:r1",
        kind: "jev",
        status: "settled",
        botId: "bot-1",
        settlement: { chargeMicros: jevChargeMicrosV1(100) },
      },
    ]);
    expect(ledger.jevFairUse()?.remainingMicros).toBe(
      2_000_000 - jevChargeMicrosV1(100),
    );
  });

  test("on a plan that covers Jev, is sent without a charge or a record", async () => {
    const { ledger, usage } = account("standard");
    const upstream = jev(ANSWERED);
    await ask(metered(usage, upstream));
    expect(upstream.calls()).toBe(1);
    expect(ledger.snapshot().usage).toEqual([]);
  });

  test("a request Jev refused releases its hold", async () => {
    const { ledger, usage } = account("byo");
    const upstream = jev(() =>
      Response.json({ message: "bad request" }, { status: 400 }),
    );
    await expect(ask(metered(usage, upstream))).rejects.toThrow();
    expect(ledger.snapshot().usage[0]).toMatchObject({ status: "released" });
    expect(ledger.jevFairUse()?.remainingMicros).toBe(2_000_000);
  });

  test("an answer that never arrived stays held for reconciliation", async () => {
    const { ledger, usage } = account("byo");
    const upstream = jev(() => {
      throw new TypeError("connection reset");
    });
    await expect(ask(metered(usage, upstream))).rejects.toThrow();
    expect(ledger.snapshot().usage[0]).toMatchObject({ status: "reserved" });
  });

  test("past the fair use with no credit, Jev is never asked and the Turn says why", async () => {
    const { ledger, usage } = account("byo");
    ledger.reserve({
      id: "jev:turn:spent",
      kind: "jev",
      platform: true,
      maximumMicros: 2_000_000,
      description: "Jev decisions",
      pricingVersion: "jev-test",
    });
    const upstream = jev(ANSWERED);
    const failure = await ask(metered(usage, upstream)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(upstream.calls()).toBe(0);
    expect(failure).toBeInstanceOf(Error);
    // The supervisor wraps the client's error, and the Turn's failure wraps
    // that: the sentence survives both, and is what the person reads.
    expect(
      runFailureCopyV1({
        failure: `Bot turn ended with outcome model-error: ${(failure as Error).message}`,
      }),
    ).toBe(JEV_FAIR_USE_EXHAUSTED_REASON_V1);
  });
});
