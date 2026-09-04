import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import type { UsageSqlV1 } from "./store.js";
import type { UsageEntryV1 } from "./shared.js";
import { BillingUserBackendContribution } from "./user.js";
import { customCreditCentsV1 } from "./billing.js";

function sqlV1(database: Database): UsageSqlV1 {
  return {
    exec(query, ...bindings) {
      const statement = database.query(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        return { toArray: () => statement.all(...bindings) as never[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

function usage(entryId: string, costMicros: number): UsageEntryV1 {
  return {
    schemaVersion: 1,
    entryId,
    kind: "model",
    botId: "bot-a",
    runId: `run-${entryId}`,
    turnId: `run-${entryId}:1`,
    turn: 1,
    requestId: `request-${entryId}`,
    at: "2026-09-04T12:00:00.000Z",
    provider: "flock-ai",
    model: "test-model",
    inputTokens: 100,
    outputTokens: 20,
    cachedInputTokens: 0,
    reasoningTokens: 0,
    voiceSeconds: 0,
    latencyMs: 100,
    estimated: false,
    unknownPrice: false,
    priceTableVersion: "test",
    costMicros,
  };
}

describe("billing entitlement", () => {
  test("a new User has no funded Turn entitlement", () => {
    const database = new Database(":memory:");
    const billing = new BillingUserBackendContribution({
      sql: sqlV1(database),
      now: () => Date.parse("2026-09-04T12:00:00.000Z"),
    });

    expect(billing.readBilling()).toMatchObject({
      schemaVersion: 1,
      plan: "none",
      subscriptionStatus: "none",
      allowanceMicros: 0,
      allowanceUsedMicros: 0,
      allowanceRemainingMicros: 0,
      creditBalanceMicros: 0,
      availableMicros: 0,
      canStartTurn: false,
      history: [],
    });

    database.close();
  });

  test("a paid credit Checkout funds Turns once even when its event is retried", () => {
    const database = new Database(":memory:");
    const billing = new BillingUserBackendContribution({
      sql: sqlV1(database),
      now: () => Date.parse("2026-09-04T12:00:00.000Z"),
    });
    const event = {
      id: "evt_credit_25",
      type: "checkout.session.completed",
      created: 1_788_523_200,
      data: {
        object: {
          id: "cs_test_credit_25",
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_credit_25",
          amount_total: 2_500,
          customer: "cus_alice",
          metadata: { frockbot_user_id: "alice", frockbot_kind: "credit" },
        },
      },
    } as const;

    expect(billing.applyStripeEvent(event)).toEqual({ applied: true });
    expect(billing.applyStripeEvent(event)).toEqual({ applied: false });
    expect(billing.readBilling()).toMatchObject({
      creditBalanceMicros: 25_000_000,
      availableMicros: 25_000_000,
      canStartTurn: true,
    });
    expect(billing.readBilling().history).toEqual([
      expect.objectContaining({
        eventId: "evt_credit_25",
        amountMicros: 25_000_000,
        description: "$25 credit purchase",
      }),
    ]);

    database.close();
  });

  test("Basic resets to $20 each paid period and settlement spends allowance before credits", () => {
    const database = new Database(":memory:");
    const billing = new BillingUserBackendContribution({
      sql: sqlV1(database),
      now: () => Date.parse("2026-09-04T12:00:00.000Z"),
    });
    billing.applyStripeEvent({
      id: "evt_subscription",
      type: "customer.subscription.updated",
      created: 1_788_523_100,
      data: {
        object: {
          id: "sub_basic",
          customer: "cus_alice",
          status: "active",
          current_period_start: 1_788_480_000,
          current_period_end: 1_791_158_400,
          metadata: { frockbot_user_id: "alice" },
        },
      },
    });
    expect(billing.readBilling()).toMatchObject({
      subscriptionStatus: "active",
      allowanceMicros: 0,
      canStartTurn: false,
    });
    billing.applyStripeEvent({
      id: "evt_invoice",
      type: "invoice.paid",
      created: 1_788_523_200,
      data: {
        object: {
          id: "in_basic",
          customer: "cus_alice",
          subscription: "sub_basic",
          period_start: 1_788_480_000,
          period_end: 1_791_158_400,
          metadata: { frockbot_user_id: "alice" },
        },
      },
    });

    expect(billing.recordEntries([usage("first", 19_000_000)])).toEqual({
      recorded: 1,
      quarantined: 0,
    });
    expect(billing.readBilling()).toMatchObject({
      plan: "basic",
      allowanceMicros: 20_000_000,
      allowanceUsedMicros: 19_000_000,
      allowanceRemainingMicros: 1_000_000,
      creditBalanceMicros: 0,
      availableMicros: 1_000_000,
      canStartTurn: true,
    });

    billing.recordEntries([usage("crosses-zero", 2_000_000)]);
    expect(billing.readBilling()).toMatchObject({
      allowanceUsedMicros: 20_000_000,
      allowanceRemainingMicros: 0,
      creditBalanceMicros: -1_000_000,
      availableMicros: -1_000_000,
      canStartTurn: false,
    });

    database.close();
  });

  test("a cumulative charge refund removes purchased credit once", () => {
    const database = new Database(":memory:");
    const billing = new BillingUserBackendContribution({
      sql: sqlV1(database),
    });
    billing.applyStripeEvent({
      id: "evt_checkout",
      type: "checkout.session.completed",
      created: 1_788_523_200,
      data: {
        object: {
          id: "cs_test",
          mode: "payment",
          payment_status: "paid",
          payment_intent: "pi_test",
          amount_total: 5_000,
          metadata: { frockbot_kind: "credit" },
        },
      },
    });
    const refunded = {
      id: "evt_refund",
      type: "charge.refunded",
      created: 1_788_523_300,
      data: {
        object: {
          id: "ch_test",
          payment_intent: "pi_test",
          amount_refunded: 2_000,
          metadata: { frockbot_user_id: "alice", frockbot_kind: "credit" },
        },
      },
    } as const;

    expect(billing.applyStripeEvent(refunded)).toEqual({ applied: true });
    expect(billing.applyStripeEvent(refunded)).toEqual({ applied: false });
    expect(billing.readBilling().creditBalanceMicros).toBe(30_000_000);
    expect(billing.readBilling().history[0]).toMatchObject({
      eventId: "evt_refund",
      amountMicros: -20_000_000,
      description: "$20 credit refund",
    });

    database.close();
  });

  test("a non-credit charge refund does not alter purchased credit", () => {
    const database = new Database(":memory:");
    const billing = new BillingUserBackendContribution({
      sql: sqlV1(database),
    });

    expect(
      billing.applyStripeEvent({
        id: "evt_subscription_refund",
        type: "charge.refunded",
        created: 1_788_523_300,
        data: {
          object: {
            id: "ch_subscription",
            payment_intent: "pi_subscription",
            amount_refunded: 2_000,
            metadata: {
              frockbot_user_id: "alice",
              frockbot_kind: "subscription",
            },
          },
        },
      }),
    ).toEqual({ applied: true });
    expect(billing.readBilling()).toMatchObject({
      creditBalanceMicros: 0,
      history: [
        expect.objectContaining({
          eventId: "evt_subscription_refund",
          amountMicros: 0,
          description: "Charge refunded",
        }),
      ],
    });

    database.close();
  });

  test("a deleted subscription removes the monthly entitlement", () => {
    const database = new Database(":memory:");
    const billing = new BillingUserBackendContribution({
      sql: sqlV1(database),
      now: () => Date.parse("2026-09-04T12:00:00.000Z"),
    });
    const subscription = {
      id: "sub_basic",
      customer: "cus_alice",
      status: "active",
      current_period_start: 1_788_480_000,
      current_period_end: 1_791_158_400,
      metadata: { frockbot_user_id: "alice" },
    };
    billing.applyStripeEvent({
      id: "evt_subscription",
      type: "customer.subscription.updated",
      created: 1_788_523_100,
      data: { object: subscription },
    });
    billing.applyStripeEvent({
      id: "evt_deleted",
      type: "customer.subscription.deleted",
      created: 1_788_523_200,
      data: { object: subscription },
    });

    expect(billing.readBilling()).toMatchObject({
      plan: "none",
      subscriptionStatus: "canceled",
      allowanceMicros: 0,
      canStartTurn: false,
    });
    database.close();
  });
});

describe("custom credit amount", () => {
  test("accepts cents from $5 through $1,000 and refuses values outside it", () => {
    expect(customCreditCentsV1(500)).toBe(500);
    expect(customCreditCentsV1(100_000)).toBe(100_000);
    expect(() => customCreditCentsV1(499)).toThrow("between $5 and $1,000");
    expect(() => customCreditCentsV1(100_001)).toThrow("between $5 and $1,000");
    expect(() => customCreditCentsV1(500.5)).toThrow("between $5 and $1,000");
  });
});
