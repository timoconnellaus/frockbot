import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { PaymentsPlanV1 } from "@frockbot/core/contracts";
import {
  BillingError,
  BillingLedger,
  CREDIT_EXHAUSTED_REASON_V1,
  USAGE_PRICING_VERSION_V1,
  type BillingStorage,
} from "./ledger";

/** A plan like the hosted one: a monthly subscription, top-ups tied to it. */
const PLAN: PaymentsPlanV1 = {
  subscription: { monthlyCents: 2_000, includedMicros: 15_000_000 },
  topUpCents: [1_000, 2_500, 5_000],
  purchasedCreditNeedsSubscription: true,
};

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

const NOW = Date.UTC(2026, 8, 9);

function active(ledger: BillingLedger, end = NOW + 30 * 86_400_000) {
  ledger.set("subscription", {
    customerId: "cus_test",
    subscriptionId: "sub_test",
    status: "active",
    periodStart: NOW,
    periodEnd: end,
    cancelAtPeriodEnd: false,
  });
  ledger.set("paidAccess", {
    subscriptionId: "sub_test",
    periodStart: NOW,
    periodEnd: end,
  });
}

function reservation(id: string, maximumMicros: number) {
  return {
    id,
    kind: "model" as const,
    maximumMicros,
    description: "one model response",
    pricingVersion: USAGE_PRICING_VERSION_V1,
  };
}

describe("the billing ledger", () => {
  test("prices usage under its own tariff version, whatever the plan", () => {
    expect(USAGE_PRICING_VERSION_V1).toBe("2026-09-09");
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    expect(ledger.snapshot().plan).toEqual(PLAN);
  });

  test("replays an identical grant and rejects the same payment key with different value", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.grant("invoice:one", "included", 15_000_000, NOW + 1_000);
    ledger.grant("invoice:one", "included", 15_000_000, NOW + 1_000);
    expect(ledger.snapshot().includedMicros).toBe(15_000_000);
    expect(() =>
      ledger.grant("invoice:one", "included", 14_000_000, NOW + 1_000),
    ).toThrow("Credit grant conflicts with existing payment");
  });

  test("serializes competing reservations so credit cannot be overspent", async () => {
    const shared = storage();
    const first = new BillingLedger(shared, "FrockBot", PLAN, () => NOW);
    const second = new BillingLedger(shared, "FrockBot", PLAN, () => NOW);
    active(first);
    first.grant("topup:one", "purchased", 10_000_000, null);

    const outcomes = await Promise.allSettled([
      Promise.resolve().then(() =>
        first.reserve(reservation("effect:one", 7_000_000)),
      ),
      Promise.resolve().then(() =>
        second.reserve(reservation("effect:two", 7_000_000)),
      ),
    ]);

    expect(
      outcomes.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    const rejection = outcomes.find((result) => result.status === "rejected");
    expect(rejection?.status === "rejected" && rejection.reason).toBeInstanceOf(
      BillingError,
    );
    expect(first.snapshot()).toMatchObject({
      purchasedMicros: 3_000_000,
      reservedMicros: 7_000_000,
    });
  });

  test("an expired grant cannot fund new work, including at its exact expiry", () => {
    let now = NOW;
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => now);
    active(ledger);
    ledger.grant("invoice:period", "included", 15_000_000, NOW + 100);
    now = NOW + 100;
    expect(() => ledger.reserve(reservation("effect:late", 1))).toThrow(
      "You have no usage credit left",
    );
    expect(ledger.snapshot().includedMicros).toBe(0);
  });

  test("settlement replays once and refunds unused reservation without reviving expired credit", () => {
    let now = NOW;
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => now);
    active(ledger);
    ledger.grant("invoice:period", "included", 10_000, NOW + 100);
    ledger.reserve(reservation("effect:settle", 8_000));
    now = NOW + 101;
    const settlement = {
      id: "effect:settle",
      costMicros: 2_000,
      chargeMicros: 4_000,
      quantities: { inputTokens: 12, outputTokens: 4 },
    };
    ledger.settle(settlement);
    ledger.settle(settlement);
    expect(ledger.snapshot()).toMatchObject({
      includedMicros: 0,
      reservedMicros: 0,
    });
    expect(ledger.snapshot().usage[0]).toMatchObject({
      status: "settled",
      settlement,
    });
    expect(() => ledger.settle({ ...settlement, chargeMicros: 4_001 })).toThrow(
      "Usage settlement conflicts with its receipt",
    );
  });

  test("a settlement keeps the model that answered and how it was priced", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    active(ledger);
    ledger.grant("topup:one", "purchased", 10_000, null);
    ledger.reserve({
      ...reservation("model:served", 8_000),
      pricingVersion: "model-rates-3",
    });
    const settlement = {
      id: "model:served",
      costMicros: 1_000,
      chargeMicros: 2_000,
      pricing: "unpriced" as const,
      servedModel: "custom-together/deepseek-ai/DeepSeek-V5",
      unitRates: { inputMicrosPerToken: 0.012 },
      quantities: { inputTokens: 12, outputTokens: 4 },
    };
    expect(() =>
      ledger.settle({
        ...settlement,
        pricing: "guessed" as unknown as "served",
      }),
    ).toThrow("Invalid usage pricing");
    expect(() =>
      ledger.settle({ ...settlement, unitRates: { inputMicrosPerToken: -1 } }),
    ).toThrow("Invalid usage rates");
    ledger.settle(settlement);
    expect(ledger.snapshot().usage[0]).toMatchObject({
      pricingVersion: "model-rates-3",
      settlement,
    });
  });

  test("zero-cost BYO model usage releases its hold without consuming credit", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    active(ledger);
    ledger.grant("topup:one", "purchased", 10_000, null);
    ledger.reserve(reservation("effect:byo", 5_000));
    ledger.settle({
      id: "effect:byo",
      costMicros: 0,
      chargeMicros: 0,
      quantities: { inputTokens: 99 },
    });
    expect(ledger.snapshot()).toMatchObject({
      purchasedMicros: 10_000,
      reservedMicros: 0,
    });
    expect(ledger.snapshot().usage[0]).toMatchObject({ status: "released" });
  });

  test("insufficient credit changes neither balance nor usage history", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    active(ledger);
    ledger.grant("topup:one", "purchased", 99, null);
    expect(() => ledger.reserve(reservation("effect:too-large", 100))).toThrow(
      "You have no usage credit left",
    );
    expect(ledger.snapshot()).toMatchObject({
      purchasedMicros: 99,
      reservedMicros: 0,
      usage: [],
    });
  });

  test("complimentary credit is spendable without a subscription and is idempotent by id", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    expect(() => ledger.reserve(reservation("own-model", 0))).toThrow(
      "A paid FrockBot subscription is required",
    );
    expect(ledger.balance()).toMatchObject({
      canSpend: false,
      subscribed: false,
      complimentaryMicros: 0,
    });
    const command = {
      id: "gift-1",
      micros: 5_000_000,
      grantedBy: "tim",
      reason: "Early tester",
    };
    ledger.grantComplimentary(command);
    // The same command again grants nothing more; a different amount under
    // the same id is refused rather than silently replacing it.
    ledger.grantComplimentary(command);
    expect(() => ledger.grantComplimentary({ ...command, micros: 1 })).toThrow(
      "Billing key reused with different data",
    );
    expect(ledger.balance()).toMatchObject({
      canSpend: true,
      subscribed: false,
      complimentaryMicros: 5_000_000,
    });
    expect(ledger.snapshot().payments).toMatchObject([
      { id: "complimentary:gift-1", kind: "complimentary", expires: null },
    ]);
    // A BYO model call costs nothing and is admitted; a hosted call draws on
    // the gift; more than the gift is refused as exhausted credit.
    expect(ledger.reserve(reservation("own-model", 0)).created).toBe(true);
    expect(ledger.reserve(reservation("hosted", 4_000_000)).created).toBe(true);
    expect(() => ledger.reserve(reservation("hosted-2", 2_000_000))).toThrow(
      "You have no usage credit left",
    );
    ledger.settle({
      id: "hosted",
      costMicros: 500_000,
      chargeMicros: 1_000_000,
      quantities: { outputTokens: 10 },
    });
    expect(ledger.balance().complimentaryMicros).toBe(4_000_000);
  });

  test("purchased credit stays locked without a subscription; complimentary is spent after monthly credit", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.grant("topup:one", "purchased", 3_000_000, null);
    ledger.grantComplimentary({
      id: "gift-2",
      micros: 1_000_000,
      grantedBy: "tim",
      reason: "Early tester",
    });
    expect(() => ledger.reserve(reservation("hosted", 2_000_000))).toThrow(
      "You have no usage credit left",
    );
    active(ledger);
    ledger.grant("monthly:sub_test:1", "included", 500_000, NOW + 86_400_000);
    expect(ledger.reserve(reservation("hosted", 2_000_000)).created).toBe(true);
    expect(ledger.balance()).toMatchObject({
      includedMicros: 0,
      complimentaryMicros: 0,
      purchasedMicros: 2_500_000,
      reservedMicros: 2_000_000,
      subscribed: true,
      canSpend: true,
    });
  });

  test("a suspended account cannot spend complimentary credit either", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.grantComplimentary({
      id: "gift-3",
      micros: 1_000_000,
      grantedBy: "tim",
      reason: "Early tester",
    });
    ledger.set("suspended", true);
    expect(ledger.balance().canSpend).toBe(false);
    expect(() => ledger.reserve(reservation("hosted", 1))).toThrow(
      "A paid FrockBot subscription is required",
    );
  });

  test("requires a current subscription and treats the period end as expired", () => {
    for (const state of [undefined, "past", "future"] as const) {
      const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
      if (state === "past") active(ledger, NOW);
      if (state === "future") {
        active(ledger);
        const subscription = ledger.subscription()!;
        ledger.set("subscription", { ...subscription, periodStart: NOW + 1 });
        ledger.set("paidAccess", {
          subscriptionId: "sub_test",
          periodStart: NOW + 1,
          periodEnd: subscription.periodEnd,
        });
      }
      ledger.grant(`topup:${state ?? "none"}`, "purchased", 1_000, null);
      expect(() =>
        ledger.reserve(reservation(`effect:${state ?? "none"}`, 1)),
      ).toThrow("A paid FrockBot subscription is required");
    }
  });

  test("an active or trialing subscription without a paid period grants no access", () => {
    for (const status of ["active", "trialing"]) {
      const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
      active(ledger);
      ledger.set("subscription", { ...ledger.subscription()!, status });
      if (status === "active") ledger.set("paidAccess", null);
      ledger.grant(`topup:${status}`, "purchased", 1_000, null);
      expect(() => ledger.reserve(reservation(`effect:${status}`, 1))).toThrow(
        "paid FrockBot subscription",
      );
    }
  });

  test("row cursors do not skip equal-timestamp usage and the rollup counts settlement once", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    active(ledger);
    ledger.grant("topup:pagination", "purchased", 101, null);
    for (let index = 0; index < 101; index += 1) {
      const id = `effect:page:${index}`;
      ledger.reserve({
        ...reservation(id, 1),
        botId: index % 2 ? "odd" : "even",
      });
      const settlement = {
        id,
        costMicros: 1,
        chargeMicros: 1,
        quantities: { calls: 1 },
      };
      ledger.settle(settlement);
      ledger.settle(settlement);
    }
    const first = ledger.snapshot();
    const second = ledger.snapshot(
      (first.usage.at(-1)! as unknown as { cursor: number }).cursor,
    );
    expect(first.usage).toHaveLength(100);
    expect(second.usage).toHaveLength(1);
    expect(
      new Set(
        [...first.usage, ...second.usage].map(
          (row) => (row as unknown as { id: string }).id,
        ),
      ).size,
    ).toBe(101);
    expect(first.spentLast30DaysMicros).toBe(101);
  });

  test("revoking a grant keeps later hold refunds expired and unspendable", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    active(ledger);
    ledger.grant("topup:revoked", "purchased", 100, null);
    ledger.reserve(reservation("effect:held", 80));
    ledger.reconcile({
      id: "support-revoke",
      actorId: "admin-1",
      reason: "chargeback case 123",
      revokeGrantId: "topup:revoked",
    });
    ledger.settle({
      id: "effect:held",
      costMicros: 20,
      chargeMicros: 40,
      quantities: { calls: 1 },
    });
    expect(ledger.snapshot()).toMatchObject({
      purchasedMicros: 0,
      reservedMicros: 0,
    });
    expect(() => ledger.reserve(reservation("effect:after-revoke", 1))).toThrow(
      "You have no usage credit left",
    );
  });

  test("malformed reconciliation rolls back every requested mutation", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    active(ledger);
    ledger.grant("topup:safe", "purchased", 100, null);
    expect(() =>
      ledger.reconcile({
        id: "support-invalid",
        reason: "support case invalid value",
        suspended: "yes" as unknown as boolean,
        revokeGrantId: "topup:safe",
      }),
    ).toThrow("Invalid account suspension");
    expect(ledger.snapshot()).toMatchObject({
      purchasedMicros: 100,
      suspended: false,
    });
  });
});

describe("the payments port", () => {
  const DAY = 86_400_000;
  const subscription = (id: string, start: number, status = "active") => ({
    customerId: "cus_port",
    subscriptionId: id,
    status,
    periodStart: start,
    periodEnd: start + 30 * DAY,
    cancelAtPeriodEnd: false,
  });

  test("applies a provider event once by its receipt, and refuses it changed", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    const port = ledger.paymentsPort();
    const evidence = { amount: 2_500 };
    let ran = 0;
    const credit = () =>
      port.apply("evt_1", evidence, (effects) => {
        ran += 1;
        effects.grantPurchased({ key: "pay_1", micros: 25_000_000 });
      });
    credit();
    credit();
    expect(ran).toBe(1);
    expect(port.applied("evt_1", evidence)).toBe(true);
    expect(() => port.applied("evt_1", { amount: 5_000 })).toThrow(
      "Billing key reused with different data",
    );
    expect(() =>
      port.apply("evt_1", { amount: 5_000 }, () => undefined),
    ).toThrow("Billing key reused with different data");
    expect(ledger.snapshot().payments).toMatchObject([
      { id: "topup:pay_1", kind: "purchased", creditMicros: 25_000_000 },
    ]);
  });

  test("a second event for the same payment grants nothing, and another amount rolls it back whole", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    const port = ledger.paymentsPort();
    port.apply("evt_a", { n: 1 }, (effects) =>
      effects.grantPurchased({ key: "pay_same", micros: 10_000_000 }),
    );
    // A duplicate delivery under a different event id: the payment key holds.
    port.apply("evt_b", { n: 2 }, (effects) =>
      effects.grantPurchased({ key: "pay_same", micros: 10_000_000 }),
    );
    expect(() =>
      port.apply("evt_c", { n: 3 }, (effects) => {
        effects.remember("note", "written before the conflict");
        effects.grantPurchased({ key: "pay_same", micros: 50_000_000 });
      }),
    ).toThrow("Credit grant conflicts with existing payment");
    // Nothing of the refused event stuck, its receipt included.
    expect(port.record("note")).toBeUndefined();
    expect(port.applied("evt_c", { n: 3 })).toBe(false);
    active(ledger);
    expect(ledger.balance().purchasedMicros).toBe(10_000_000);
  });

  test("a paid period grants the plan's allowance once and access never moves back", () => {
    const now = NOW + 40 * DAY;
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => now);
    const port = ledger.paymentsPort();
    const later = {
      subscriptionId: "sub_p",
      periodStart: NOW + 30 * DAY,
      periodEnd: NOW + 60 * DAY,
    };
    const earlier = {
      subscriptionId: "sub_p",
      periodStart: NOW,
      periodEnd: NOW + 30 * DAY,
    };
    port.apply("evt_later", later, (effects) => {
      effects.recordSubscription(subscription("sub_p", later.periodStart));
      effects.recordPaidPeriod(later);
    });
    // Reordered: the earlier invoice arrives after the later one.
    port.apply("evt_earlier", earlier, (effects) =>
      effects.recordPaidPeriod(earlier),
    );
    expect(port.account()).toMatchObject({
      paidPeriod: later,
      subscribed: true,
    });
    expect(
      ledger
        .snapshot()
        .payments.map((row) => row.id)
        .sort(),
    ).toEqual([
      `monthly:sub_p:${Math.floor(earlier.periodStart / 1000)}`,
      `monthly:sub_p:${Math.floor(later.periodStart / 1000)}`,
    ]);
    // The earlier period's allowance expired with it.
    expect(ledger.balance().includedMicros).toBe(15_000_000);
  });

  test("an event about an older subscription cannot replace a newer one", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    const port = ledger.paymentsPort();
    port.apply("evt_new", 1, (effects) =>
      effects.recordSubscription(subscription("sub_new", NOW)),
    );
    expect(() =>
      port.apply("evt_old", 2, (effects) =>
        effects.recordSubscription(
          subscription("sub_old", NOW - DAY, "canceled"),
        ),
      ),
    ).toThrow("Old subscription event");
    expect(port.account().subscription?.subscriptionId).toBe("sub_new");
    port.apply("evt_end", 3, (effects) =>
      effects.recordSubscription(subscription("sub_new", NOW, "canceled")),
    );
    expect(port.account().subscription?.status).toBe("canceled");
  });

  test("a suspension stops spending until an administrator lifts it", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    active(ledger);
    ledger.grant("topup:held", "purchased", 1_000, null);
    ledger
      .paymentsPort()
      .apply("evt_refund", {}, (effects) => effects.suspend());
    expect(ledger.balance()).toMatchObject({
      suspended: true,
      canSpend: false,
    });
    expect(() => ledger.reserve(reservation("after-refund", 1))).toThrow(
      "A paid FrockBot subscription is required",
    );
  });

  test("an asynchronous callback spends no receipt", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    const port = ledger.paymentsPort();
    expect(() =>
      port.apply("evt_async", {}, (async () => undefined) as () => void),
    ).toThrow("Payment effects apply synchronously");
    expect(port.applied("evt_async", {})).toBe(false);
  });

  test("keeps the ledger's own state and receipts out of a Package's reach", () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    const port = ledger.paymentsPort();
    for (const key of [
      "subscription",
      "paidAccess",
      "suspended",
      "spike:bot|b",
    ])
      expect(() => port.remember(key, true)).toThrow("Invalid payment record");
    for (const receipt of ["complimentary:gift", "reconcile:case", ""])
      expect(() => port.apply(receipt, {}, () => undefined)).toThrow(
        "Invalid payment receipt",
      );
    let kept: Parameters<Parameters<typeof port.apply>[2]>[0] | undefined;
    port.apply("evt_keep", {}, (effects) => {
      kept = effects;
    });
    expect(() =>
      kept!.grantPurchased({ key: "later", micros: 1_000_000 }),
    ).toThrow("Payment effects apply only inside apply");
    expect(() =>
      port.apply("evt_zero", {}, (effects) =>
        effects.grantPurchased({ key: "zero", micros: 0 }),
      ),
    ).toThrow("Invalid credit");
    port.remember("customer", "cus_kept");
    expect(port.record<string>("customer")).toBe("cus_kept");
    expect(ledger.balance().purchasedMicros).toBe(0);
  });

  test("a plan with no subscription spends purchased credit without one", () => {
    const plan: PaymentsPlanV1 = {
      subscription: null,
      topUpCents: [500],
      purchasedCreditNeedsSubscription: false,
    };
    const ledger = new BillingLedger(storage(), "FrockBot", plan, () => NOW);
    const port = ledger.paymentsPort();
    expect(() => ledger.reserve(reservation("nothing-yet", 1))).toThrow(
      CREDIT_EXHAUSTED_REASON_V1,
    );
    expect(() => ledger.requireSubscription()).toThrow(
      CREDIT_EXHAUSTED_REASON_V1,
    );
    port.apply("evt_buy", {}, (effects) =>
      effects.grantPurchased({ key: "buy", micros: 5_000_000 }),
    );
    expect(ledger.balance()).toMatchObject({
      subscribed: false,
      canSpend: true,
      purchasedMicros: 5_000_000,
    });
    expect(ledger.reserve(reservation("paid-by-top-up", 1_000))).toMatchObject({
      status: "reserved",
    });
    expect(() => ledger.requireSubscription()).not.toThrow();
    expect(() =>
      port.apply("evt_period", {}, (effects) =>
        effects.recordPaidPeriod({
          subscriptionId: "sub_none",
          periodStart: NOW,
          periodEnd: NOW + DAY,
        }),
      ),
    ).toThrow("This deployment sells no subscription");
  });
});
