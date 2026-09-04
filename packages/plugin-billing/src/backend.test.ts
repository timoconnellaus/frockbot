import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createBillingBackendContribution } from "./backend.js";
import type { StripeEventV1 } from "./billing.js";
import type { UsageSqlV1 } from "./store.js";
import { BillingUserBackendContribution } from "./user.js";

const WEBHOOK_SECRET = "whsec_fixture_secret";
const NOW_SECONDS = 1_788_523_500;

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

async function signedRequest(
  event: StripeEventV1,
  secret = WEBHOOK_SECRET,
): Promise<Request> {
  const body = JSON.stringify(event);
  const message = `${NOW_SECONDS}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = Array.from(
    new Uint8Array(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)),
    ),
    (byte) => byte.toString(16).padStart(2, "0"),
  ).join("");
  return new Request("https://bot.frockbot.com/api/billing/stripe/webhook", {
    method: "POST",
    headers: { "stripe-signature": `t=${NOW_SECONDS},v1=${signature}` },
    body,
  });
}

function event(
  id: string,
  type: string,
  object: Record<string, unknown>,
): StripeEventV1 {
  return { id, type, created: NOW_SECONDS, data: { object } };
}

describe("Stripe webhook", () => {
  test("verifies the raw-body signature and rejects a mismatched secret", async () => {
    const contribution = createBillingBackendContribution({
      stripeWebhookSecret: WEBHOOK_SECRET,
      stripeSecretKey: "sk_test_fixture",
      now: () => NOW_SECONDS * 1_000,
      readUsage: () => Promise.reject(new Error("not used")),
      readBilling: () => Promise.reject(new Error("not used")),
      applyStripeEvent: () => Promise.resolve({ applied: true }),
      prepareStripeCommand: () => Promise.resolve({ status: "pending" }),
      recordStripeCustomer: () => Promise.resolve(),
      completeStripeCommand: () => Promise.resolve(),
    });
    const fixture = event("evt_bad", "checkout.session.completed", {
      metadata: { frockbot_user_id: "alice" },
    });

    const response = await contribution.publicRoute!(
      await signedRequest(fixture, "whsec_wrong"),
      new URL("https://bot.frockbot.com/api/billing/stripe/webhook"),
      {},
    );

    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "Invalid Stripe signature.",
    });
  });

  test("applies every subscribed Stripe event and deduplicates a retried event id", async () => {
    const database = new Database(":memory:");
    const billing = new BillingUserBackendContribution({
      sql: sqlV1(database),
      now: () => NOW_SECONDS * 1_000,
    });
    const appliedTypes: string[] = [];
    const contribution = createBillingBackendContribution({
      stripeWebhookSecret: WEBHOOK_SECRET,
      stripeSecretKey: "sk_test_fixture",
      now: () => NOW_SECONDS * 1_000,
      readUsage: () => Promise.reject(new Error("not used")),
      readBilling: () => Promise.resolve(billing.readBilling()),
      applyStripeEvent: (_userId, stripeEvent) => {
        appliedTypes.push(stripeEvent.type);
        return Promise.resolve(billing.applyStripeEvent(stripeEvent));
      },
      prepareStripeCommand: () => Promise.resolve({ status: "pending" }),
      recordStripeCustomer: () => Promise.resolve(),
      completeStripeCommand: () => Promise.resolve(),
    });
    const fixtures = [
      event("evt_checkout", "checkout.session.completed", {
        id: "cs_test",
        mode: "payment",
        payment_status: "paid",
        payment_intent: "pi_test",
        amount_total: 2_500,
        customer: "cus_alice",
        metadata: { frockbot_user_id: "alice", frockbot_kind: "credit" },
      }),
      event("evt_subscription", "customer.subscription.updated", {
        id: "sub_test",
        customer: "cus_alice",
        status: "active",
        current_period_start: NOW_SECONDS - 100,
        current_period_end: NOW_SECONDS + 2_000_000,
        metadata: { frockbot_user_id: "alice" },
      }),
      event("evt_invoice", "invoice.paid", {
        id: "in_test",
        customer: "cus_alice",
        period_start: NOW_SECONDS - 100,
        period_end: NOW_SECONDS + 2_000_000,
        parent: {
          subscription_details: {
            subscription: "sub_test",
            metadata: { frockbot_user_id: "alice" },
          },
        },
      }),
      event("evt_refund", "charge.refunded", {
        id: "ch_test",
        payment_intent: "pi_test",
        amount_refunded: 500,
        metadata: { frockbot_user_id: "alice", frockbot_kind: "credit" },
      }),
      event("evt_deleted", "customer.subscription.deleted", {
        id: "sub_test",
        customer: "cus_alice",
        status: "canceled",
        current_period_start: NOW_SECONDS - 100,
        current_period_end: NOW_SECONDS + 2_000_000,
        metadata: { frockbot_user_id: "alice" },
      }),
    ];

    for (const fixture of fixtures) {
      const request = await signedRequest(fixture);
      const response = await contribution.publicRoute!(
        request,
        new URL(request.url),
        {},
      );
      expect(response?.status).toBe(200);
    }
    const retried = await signedRequest(fixtures[0]!);
    const retryResponse = await contribution.publicRoute!(
      retried,
      new URL(retried.url),
      {},
    );

    expect(await retryResponse?.json()).toEqual({
      received: true,
      applied: false,
    });
    expect(appliedTypes).toEqual([
      "checkout.session.completed",
      "customer.subscription.updated",
      "invoice.paid",
      "charge.refunded",
      "customer.subscription.deleted",
      "checkout.session.completed",
    ]);
    expect(billing.readBilling().creditBalanceMicros).toBe(20_000_000);
    expect(billing.readBilling().history).toHaveLength(5);
    database.close();
  });
});

describe("Stripe Checkout and Portal", () => {
  test("creates one Customer and opens hosted Checkout for a fixed credit pack", async () => {
    const calls: Array<{ url: string; body: URLSearchParams }> = [];
    let customerId: string | undefined;
    const contribution = createBillingBackendContribution({
      stripeSecretKey: "sk_test_fixture",
      stripeWebhookSecret: WEBHOOK_SECRET,
      readUsage: () => Promise.reject(new Error("not used")),
      readBilling: () =>
        Promise.resolve({
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
        }),
      applyStripeEvent: () => Promise.resolve({ applied: true }),
      prepareStripeCommand: () =>
        Promise.resolve({ status: "pending", customerId }),
      recordStripeCustomer: (_userId, value) => {
        customerId = value;
        return Promise.resolve();
      },
      completeStripeCommand: () => Promise.resolve(),
      stripeFetch: (async (input, init) => {
        const url = String(input);
        const body = new URLSearchParams(String(init?.body ?? ""));
        calls.push({ url, body });
        if (url.endsWith("/v1/customers")) {
          return Response.json({ id: "cus_alice" });
        }
        if (url.includes("/v1/prices")) {
          return Response.json({ data: [{ id: "price_credit_25" }] });
        }
        return Response.json({
          id: "cs_test",
          url: "https://checkout.stripe.test/cs_test",
        });
      }) as typeof fetch,
    });

    const response = await contribution.route(
      new Request("https://bot.frockbot.com/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "command-credit-25",
          kind: "credit",
          amountCents: 2_500,
        }),
      }),
      new URL("https://bot.frockbot.com/api/billing/checkout"),
      { userId: "alice" },
    );

    expect(response?.status).toBe(200);
    expect(await response?.json()).toEqual({
      schemaVersion: 1,
      url: "https://checkout.stripe.test/cs_test",
    });
    expect(calls.map((call) => new URL(call.url).pathname)).toEqual([
      "/v1/customers",
      "/v1/prices",
      "/v1/checkout/sessions",
    ]);
    expect(calls[1]?.url).toContain("frockbot_credit_25");
    expect(calls[2]?.body.get("metadata[frockbot_user_id]")).toBe("alice");
    expect(calls[2]?.body.get("line_items[0][price]")).toBe("price_credit_25");
  });

  test("rejects a custom credit outside $5 to $1,000 before contacting Stripe", async () => {
    let contactedStripe = false;
    const contribution = createBillingBackendContribution({
      stripeSecretKey: "sk_test_fixture",
      stripeWebhookSecret: WEBHOOK_SECRET,
      readUsage: () => Promise.reject(new Error("not used")),
      readBilling: () => Promise.reject(new Error("not used")),
      applyStripeEvent: () => Promise.resolve({ applied: true }),
      prepareStripeCommand: () =>
        Promise.resolve({ status: "pending", customerId: "cus_alice" }),
      recordStripeCustomer: () => Promise.resolve(),
      completeStripeCommand: () => Promise.resolve(),
      stripeFetch: (async () => {
        contactedStripe = true;
        return Response.json({});
      }) as unknown as typeof fetch,
    });

    const response = await contribution.route(
      new Request("https://bot.frockbot.com/api/billing/checkout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          commandId: "command-custom",
          kind: "credit",
          amountCents: 499,
        }),
      }),
      new URL("https://bot.frockbot.com/api/billing/checkout"),
      { userId: "alice" },
    );

    expect(response?.status).toBe(400);
    expect(contactedStripe).toBe(false);
  });
});
