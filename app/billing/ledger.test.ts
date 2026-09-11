import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  BILLING_PLAN,
  BillingError,
  BillingLedger,
  type BillingStorage,
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
    pricingVersion: BILLING_PLAN.pricingVersion,
  };
}

describe("the billing ledger", () => {
  test("declares the paid plan, included credit, and exact top-up menu", () => {
    expect(BILLING_PLAN).toEqual({
      currency: "usd",
      monthlyCents: 2_900,
      includedMicros: 15_000_000,
      topUpCents: [1_000, 2_500, 5_000],
      pricingVersion: "2026-09-09",
    });
  });

  test("replays an identical grant and rejects the same payment key with different value", () => {
    const ledger = new BillingLedger(storage(), () => NOW);
    ledger.grant("invoice:one", "included", 15_000_000, NOW + 1_000);
    ledger.grant("invoice:one", "included", 15_000_000, NOW + 1_000);
    expect(ledger.snapshot().includedMicros).toBe(15_000_000);
    expect(() =>
      ledger.grant("invoice:one", "included", 14_000_000, NOW + 1_000),
    ).toThrow("Credit grant conflicts with existing payment");
  });

  test("serializes competing reservations so credit cannot be overspent", async () => {
    const shared = storage();
    const first = new BillingLedger(shared, () => NOW);
    const second = new BillingLedger(shared, () => NOW);
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
    const ledger = new BillingLedger(storage(), () => now);
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
    const ledger = new BillingLedger(storage(), () => now);
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

  test("zero-cost BYO model usage releases its hold without consuming credit", () => {
    const ledger = new BillingLedger(storage(), () => NOW);
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
    const ledger = new BillingLedger(storage(), () => NOW);
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
    const ledger = new BillingLedger(storage(), () => NOW);
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
    const ledger = new BillingLedger(storage(), () => NOW);
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
    const ledger = new BillingLedger(storage(), () => NOW);
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
      const ledger = new BillingLedger(storage(), () => NOW);
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

  test("an active or trialing Stripe status without a paid invoice grants no access", () => {
    for (const status of ["active", "trialing"]) {
      const ledger = new BillingLedger(storage(), () => NOW);
      active(ledger);
      ledger.set("subscription", { ...ledger.subscription()!, status });
      if (status === "active") ledger.set("paidAccess", null);
      ledger.grant(`topup:${status}`, "purchased", 1_000, null);
      expect(() => ledger.reserve(reservation(`effect:${status}`, 1))).toThrow(
        "paid FrockBot subscription",
      );
    }
  });

  test("row cursors do not skip equal-timestamp usage and summaries count settlement once", () => {
    const ledger = new BillingLedger(storage(), () => NOW);
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
    expect(
      first.summaries.reduce((sum, row) => sum + Number(row.chargeMicros), 0),
    ).toBe(101);
    expect(
      first.summaries.reduce((sum, row) => sum + Number(row.operations), 0),
    ).toBe(101);
  });

  test("revoking a grant keeps later hold refunds expired and unspendable", () => {
    const ledger = new BillingLedger(storage(), () => NOW);
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
    const ledger = new BillingLedger(storage(), () => NOW);
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
