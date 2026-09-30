import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { PaymentsPlanV1 } from "@frockbot/core/contracts";
import {
  BillingLedger,
  CREDIT_EXHAUSTED_REASON_V1,
  JEV_FAIR_USE_EXHAUSTED_REASON_V1,
  connectedAppsPlanRequiredReasonV1,
  type BillingStorage,
  type UsageReservation,
} from "./ledger";

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

/** BYO beside Standard, as the hosted Package sells them. */
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
  trial: { days: 7, creditMicros: 3_000_000 },
  topUpCents: [1_000, 2_500, 5_000],
  purchasedCreditNeedsSubscription: true,
};

function subscription(planId: string, start: number, status = "active") {
  return {
    customerId: "cus_byo",
    subscriptionId: "sub_byo",
    planId,
    status,
    periodStart: start,
    periodEnd: start + 30 * DAY,
    trialEnd: status === "trialing" ? start + 7 * DAY : null,
    cancelAtPeriodEnd: false,
  };
}

function paidMonth(ledger: BillingLedger, planId: string, start: number) {
  const period = {
    subscriptionId: "sub_byo",
    planId,
    periodStart: start,
    periodEnd: start + 30 * DAY,
  };
  ledger.paymentsPort().apply(`evt_${planId}_${start}`, period, (effects) => {
    effects.recordSubscription(subscription(planId, start));
    effects.recordPaidPeriod(period);
  });
}

function onPlan(planId = "byo", now: () => number = () => NOW) {
  const ledger = new BillingLedger(storage(), "FrockBot", PLAN, now);
  paidMonth(ledger, planId, NOW);
  return ledger;
}

/** Jev a Turn's supervision asks for. */
const jev = (id: string, maximumMicros: number): UsageReservation => ({
  id,
  kind: "jev",
  platform: true,
  maximumMicros,
  description: "Jev decisions",
  pricingVersion: "jev-test",
});

function spend(ledger: BillingLedger, id: string, micros: number) {
  ledger.reserve(jev(id, micros));
  ledger.settle({
    id,
    costMicros: micros / 2,
    chargeMicros: micros,
    quantities: { inputTokens: 1 },
  });
}

describe("the BYO plan", () => {
  test("a paid month grants Jev fair use and no usage credit", () => {
    const ledger = onPlan();
    expect(ledger.balance()).toMatchObject({
      includedMicros: 0,
      subscribed: true,
      canSpend: true,
    });
    expect(ledger.snapshot()).toMatchObject({
      includedGrantedMicros: 0,
      jevFairUse: { remainingMicros: 2_000_000, grantedMicros: 2_000_000 },
    });
    expect(ledger.snapshot().payments.map((row) => row.id)).toEqual([
      `jev:sub_byo:${Math.floor(NOW / 1000)}`,
    ]);
  });

  test("Jev draws on the fair use first, then on credit, and says why when both are spent", () => {
    const ledger = onPlan();
    spend(ledger, "jev:turn:a", 1_500_000);
    expect(ledger.jevFairUse()).toEqual({
      remainingMicros: 500_000,
      grantedMicros: 2_000_000,
    });
    // Past the fair use with no credit: refused, in the words that say why.
    expect(() => ledger.reserve(jev("jev:turn:b", 600_000))).toThrow(
      JEV_FAIR_USE_EXHAUSTED_REASON_V1,
    );
    // A top-up makes up the difference, after the fair use is gone.
    ledger.grant("topup:pi_1", "purchased", 1_000_000, null);
    expect(ledger.reserve(jev("jev:turn:b", 600_000)).status).toBe("reserved");
    expect(ledger.jevFairUse()?.remainingMicros).toBe(0);
    expect(ledger.balance().purchasedMicros).toBe(900_000);
  });

  test("the fair use pays for nothing but Jev", () => {
    const ledger = onPlan();
    expect(() =>
      ledger.reserve({
        id: "search:a",
        kind: "search",
        maximumMicros: 10_000,
        description: "Web search",
        pricingVersion: "search-test",
      }),
    ).toThrow(CREDIT_EXHAUSTED_REASON_V1);
    expect(ledger.jevFairUse()?.remainingMicros).toBe(2_000_000);
  });

  test("the fair use resets with each paid month", () => {
    let now = NOW;
    const ledger = onPlan("byo", () => now);
    spend(ledger, "jev:turn:a", 2_000_000);
    expect(ledger.jevFairUse()?.remainingMicros).toBe(0);
    now = NOW + 30 * DAY;
    paidMonth(ledger, "byo", now);
    expect(ledger.jevFairUse()).toEqual({
      remainingMicros: 2_000_000,
      grantedMicros: 2_000_000,
    });
  });

  test("a plan without fair use covers platform Jev and records nothing", () => {
    const ledger = onPlan("standard");
    expect(ledger.reserve(jev("jev:turn:a", 1_000_000))).toEqual({
      status: "covered",
      created: false,
    });
    expect(ledger.snapshot().usage).toEqual([]);
    expect(ledger.snapshot().jevFairUse).toBeNull();
    // Jev the Computer asked for is still the account's.
    const { platform: _, ...asked } = jev("jev:exec:a", 1_000);
    expect(ledger.reserve(asked).status).toBe("reserved");
  });

  test("only Jev can be marked the platform's", () => {
    expect(() =>
      onPlan().reserve({ ...jev("model:a", 1_000), kind: "model" }),
    ).toThrow("Invalid usage reservation");
  });

  test("BYO never grants a trial", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    expect(() =>
      ledger.paymentsPort().apply("evt_trial", 1, (effects) => {
        effects.recordSubscription(subscription("byo", NOW, "trialing"));
        effects.grantTrial({
          subscriptionId: "sub_byo",
          expires: NOW + 7 * DAY,
        });
      }),
    ).toThrow("This plan has no trial");
    expect(ledger.paymentsPort().account().trialUsed).toBe(false);
  });

  test("connected apps need a plan: BYO is one, and so is a trial", () => {
    const refusal = connectedAppsPlanRequiredReasonV1("FrockBot");
    const none = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    expect(() => none.requirePlan()).toThrow(refusal);
    // Complimentary credit is not a plan.
    none.grantComplimentary({
      id: "gift",
      micros: 1_000_000,
      grantedBy: "admin",
      reason: "thanks",
    });
    expect(() => none.requirePlan()).toThrow(refusal);
    expect(() => onPlan().requirePlan()).not.toThrow();

    const trialling = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    trialling.paymentsPort().apply("evt_trial", 1, (effects) => {
      effects.recordSubscription(subscription("standard", NOW, "trialing"));
      effects.grantTrial({ subscriptionId: "sub_byo", expires: NOW + 7 * DAY });
    });
    expect(() => trialling.requirePlan()).not.toThrow();

    // A deployment that sells no subscription asks for none.
    const unsold = new BillingLedger(storage(), "FrockBot", {
      ...PLAN,
      subscriptions: [],
      trial: null,
    });
    expect(() => unsold.requirePlan()).not.toThrow();
  });
});
