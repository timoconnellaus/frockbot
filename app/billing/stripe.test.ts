import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { BillingLedger, type BillingStorage } from "./ledger";
import { AccountPayments, StripeClient, verifyStripeEvent } from "./stripe";

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
    transactionSync<T>(callback: () => T) {
      return database.transaction(callback)();
    },
  };
}

const NOW = Date.UTC(2026, 8, 9);
const config = {
  secretKey: "sk_test",
  webhookSecret: "whsec_test",
  monthlyPriceId: "price_monthly",
  origin: "https://app.frockbot.com",
};
function fakeFetch(
  fn: (
    url: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ) => Promise<Response>,
): typeof fetch {
  return fn as typeof fetch;
}

function active(ledger: BillingLedger) {
  ledger.set("subscription", {
    customerId: "cus_owner",
    subscriptionId: "sub_owner",
    status: "active",
    periodStart: NOW - 1,
    periodEnd: NOW + 1_000_000,
    cancelAtPeriodEnd: false,
  });
  ledger.set("paidAccess", {
    subscriptionId: "sub_owner",
    periodStart: NOW - 1,
    periodEnd: NOW + 1_000_000,
  });
}

describe("Stripe payment boundaries", () => {
  test("accepts a current HMAC and rejects a valid signature outside the replay window", async () => {
    const raw = JSON.stringify({
      id: "evt_one",
      type: "invoice.paid",
      created: Math.floor(NOW / 1000),
      data: { object: { id: "in_one" } },
    });
    const timestamp = String(Math.floor(NOW / 1000));
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(config.webhookSecret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const bytes = new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(`${timestamp}.${raw}`),
      ),
    );
    const digest = [...bytes]
      .map((value) => value.toString(16).padStart(2, "0"))
      .join("");
    expect(
      await verifyStripeEvent(
        raw,
        `t=${timestamp},v1=${digest}`,
        config.webhookSecret,
        NOW,
      ),
    ).toMatchObject({ id: "evt_one" });
    await expect(
      verifyStripeEvent(
        raw,
        `t=${timestamp},v1=${digest}`,
        config.webhookSecret,
        NOW + 301_000,
      ),
    ).rejects.toThrow("Expired payment signature");
  });

  test("top-up checkout requires membership and sends only an allowed exact amount", async () => {
    const ledger = new BillingLedger(storage(), () => NOW);
    const calls: {
      path: string;
      fields?: Record<string, string>;
      key?: string;
    }[] = [];
    const stripe = new StripeClient(
      config,
      fakeFetch(async (_url, init) => {
        const url = String(_url);
        const path = url.split("/v1/")[1]!;
        const fields = init?.body
          ? Object.fromEntries(new URLSearchParams(String(init.body)))
          : undefined;
        calls.push({
          path,
          fields,
          key: new Headers(init?.headers).get("Idempotency-Key") ?? undefined,
        });
        const response =
          path === "customers"
            ? { id: "cus_owner" }
            : path === "billing_portal/sessions"
              ? { id: "bps_owner", url: "https://billing.stripe.com/p/pay" }
              : { id: "cs_topup", url: "https://checkout.stripe.com/c/pay" };
        return Response.json(response);
      }),
    );
    const payments = new AccountPayments(ledger, stripe, "user_one", () => NOW);
    await expect(
      payments.checkout({
        id: "0123456789abcdef",
        kind: "topup",
        cents: 1_000,
      }),
    ).rejects.toThrow("paid FrockBot subscription");
    active(ledger);
    await expect(
      payments.checkout({
        id: "0123456789abcdeg",
        kind: "topup",
        cents: 1_001,
      }),
    ).rejects.toThrow("Choose a $10, $25 or $50 top-up");
    const first = await payments.checkout({
      id: "0123456789abcdef",
      kind: "topup",
      cents: 1_000,
    });
    const callCount = calls.length;
    expect(
      await payments.checkout({
        id: "0123456789abcdef",
        kind: "topup",
        cents: 1_000,
      }),
    ).toEqual(first);
    expect(calls).toHaveLength(callCount);
    expect(calls.at(-1)).toMatchObject({
      path: "checkout/sessions",
      key: "frockbot:checkout:user_one:0123456789abcdef",
      fields: {
        mode: "payment",
        "line_items[0][price_data][unit_amount]": "1000",
        expires_at: String(NOW / 1000 + 3600),
      },
    });
    await expect(
      payments.checkout({
        id: "native_checkout_123456",
        kind: "topup",
        cents: 2_500,
      }),
    ).resolves.toMatchObject({
      url: expect.stringContaining("checkout.stripe.com"),
    });
    await expect(
      payments.portal("native_portal_123456"),
    ).resolves.toMatchObject({
      url: expect.stringContaining("billing.stripe.com"),
    });
  });

  test("uses a stable one-hour Stripe expiry and refuses an intent too old to submit safely", async () => {
    let now = NOW;
    const ledger = new BillingLedger(storage(), () => now);
    active(ledger);
    let calls = 0;
    const stripe = new StripeClient(
      config,
      fakeFetch(async (url) => {
        calls += 1;
        return Response.json(
          String(url).endsWith("/customers")
            ? { id: "cus_owner" }
            : { id: "cs_expiry", url: "https://checkout.stripe.com/c/pay" },
        );
      }),
    );
    const payments = new AccountPayments(ledger, stripe, "user_one", () => now);
    await payments.checkout({
      id: "expiry-check-1234",
      kind: "topup",
      cents: 1_000,
    });
    const checkoutCall = calls;
    ledger.set("checkout:stale-check-1234", {
      id: "stale-check-1234",
      kind: "topup",
      cents: 1000,
      created: NOW,
    });
    now += 25 * 60_000 + 1;
    await expect(
      payments.checkout({
        id: "stale-check-1234",
        kind: "topup",
        cents: 1_000,
      }),
    ).rejects.toThrow("Checkout needs reconciliation");
    expect(calls).toBe(checkoutCall);
  });

  test("paid top-up webhook grants exactly the recorded purchase and replays once", async () => {
    const ledger = new BillingLedger(storage(), () => NOW);
    active(ledger);
    ledger.set("customer", "cus_owner");
    ledger.set("checkout:0123456789abcdef", {
      id: "0123456789abcdef",
      kind: "topup",
      cents: 2500,
      created: NOW,
      sessionId: "cs_topup",
    });
    const stripe = new StripeClient(
      config,
      fakeFetch(async () =>
        Response.json({
          id: "cs_topup",
          customer: "cus_owner",
          client_reference_id: "user_one",
          metadata: { frockbot_checkout_id: "0123456789abcdef" },
          payment_status: "paid",
          mode: "payment",
          currency: "usd",
          amount_total: 2500,
        }),
      ),
    );
    const payments = new AccountPayments(ledger, stripe, "user_one", () => NOW);
    const event = {
      id: "evt_topup",
      type: "checkout.session.completed",
      created: NOW / 1000,
      data: { object: { id: "cs_topup", customer: "cus_owner" } },
    };
    await payments.webhook(event);
    await payments.webhook(event);
    expect(ledger.snapshot().purchasedMicros).toBe(25_000_000);
  });

  test("rejects a webhook for another customer before it can change credit", async () => {
    const ledger = new BillingLedger(storage(), () => NOW);
    ledger.set("customer", "cus_owner");
    const payments = new AccountPayments(
      ledger,
      new StripeClient(
        config,
        fakeFetch(async () => {
          throw new Error("must not call Stripe");
        }),
      ),
      "user_one",
      () => NOW,
    );
    await expect(
      payments.webhook({
        id: "evt_other",
        type: "charge.refunded",
        created: NOW / 1000,
        data: { object: { id: "ch_other", customer: "cus_other" } },
      }),
    ).rejects.toThrow("Payment customer does not match account");
    expect(ledger.snapshot()).toMatchObject({
      purchasedMicros: 0,
      includedMicros: 0,
      suspended: false,
    });
  });

  test("a paid monthly invoice grants one allowance for its canonical invoice period", async () => {
    const ledger = new BillingLedger(storage(), () => NOW);
    ledger.set("customer", "cus_owner");
    const periodStart = Math.floor((NOW - 1_000) / 1000);
    const periodEnd = Math.floor((NOW + 30 * 86_400_000) / 1000);
    const stripe = new StripeClient(
      config,
      fakeFetch(async (url) => {
        const path = String(url).split("/v1/")[1];
        if (path === "invoices/in_monthly")
          return Response.json({
            id: "in_monthly",
            customer: "cus_owner",
            subscription: "sub_owner",
            status: "paid",
            currency: "usd",
            billing_reason: "subscription_cycle",
            lines: {
              has_more: false,
              data: [
                {
                  type: "subscription",
                  proration: false,
                  quantity: 1,
                  price: { id: "price_monthly" },
                  period: { start: periodStart, end: periodEnd },
                },
              ],
            },
          });
        return Response.json({
          id: "sub_owner",
          customer: "cus_owner",
          status: "active",
          current_period_start: periodStart,
          current_period_end: periodEnd,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                quantity: 1,
                price: {
                  id: "price_monthly",
                  currency: "usd",
                  unit_amount: 2900,
                  recurring: { interval: "month" },
                },
              },
            ],
          },
        });
      }),
    );
    const payments = new AccountPayments(ledger, stripe, "user_one", () => NOW);
    const event = {
      id: "evt_invoice",
      type: "invoice.paid",
      created: NOW / 1000,
      data: { object: { id: "in_monthly", customer: "cus_owner" } },
    };
    await payments.webhook(event);
    await payments.webhook(event);
    expect(ledger.snapshot()).toMatchObject({
      includedMicros: 15_000_000,
      subscription: {
        subscriptionId: "sub_owner",
        periodEnd: periodEnd * 1000,
      },
    });
  });

  test("a delayed old invoice cannot grant access to the canonical newer unpaid period", async () => {
    const ledger = new BillingLedger(storage(), () => NOW);
    ledger.set("customer", "cus_owner");
    const oldStart = Math.floor((NOW - 60 * 86_400_000) / 1000);
    const oldEnd = Math.floor((NOW - 30 * 86_400_000) / 1000);
    const currentStart = Math.floor((NOW - 1_000) / 1000);
    const currentEnd = Math.floor((NOW + 30 * 86_400_000) / 1000);
    const stripe = new StripeClient(
      config,
      fakeFetch(async (url) => {
        const path = String(url).split("/v1/")[1];
        if (path === "invoices/in_old")
          return Response.json({
            id: "in_old",
            customer: "cus_owner",
            subscription: "sub_owner",
            status: "paid",
            currency: "usd",
            billing_reason: "subscription_cycle",
            lines: {
              has_more: false,
              data: [
                {
                  type: "subscription",
                  proration: false,
                  quantity: 1,
                  price: { id: "price_monthly" },
                  period: { start: oldStart, end: oldEnd },
                },
              ],
            },
          });
        return Response.json({
          id: "sub_owner",
          customer: "cus_owner",
          status: "active",
          current_period_start: currentStart,
          current_period_end: currentEnd,
          cancel_at_period_end: false,
          items: {
            data: [
              {
                quantity: 1,
                price: {
                  id: "price_monthly",
                  currency: "usd",
                  unit_amount: 2900,
                  recurring: { interval: "month" },
                },
              },
            ],
          },
        });
      }),
    );
    const payments = new AccountPayments(ledger, stripe, "user_one", () => NOW);
    await payments.webhook({
      id: "evt_old",
      type: "invoice.paid",
      created: oldStart,
      data: { object: { id: "in_old", customer: "cus_owner" } },
    });
    expect(
      ledger.get<{
        subscriptionId: string;
        periodStart: number;
        periodEnd: number;
      }>("paidAccess"),
    ).toEqual({
      subscriptionId: "sub_owner",
      periodStart: oldStart * 1000,
      periodEnd: oldEnd * 1000,
    });
    expect(() => ledger.requireSubscription()).toThrow(
      "paid FrockBot subscription",
    );
  });

  test("concurrent subscription starts claim one checkout slot before calling Stripe", async () => {
    const ledger = new BillingLedger(storage(), () => NOW);
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    const stripe = new StripeClient(
      config,
      fakeFetch(async (url) => {
        calls += 1;
        if (String(url).endsWith("/customers")) await held;
        return Response.json(
          String(url).endsWith("/customers")
            ? { id: "cus_owner" }
            : {
                id: "cs_subscription",
                url: "https://checkout.stripe.com/c/sub",
              },
        );
      }),
    );
    const payments = new AccountPayments(ledger, stripe, "user_one", () => NOW);
    const first = payments.checkout({
      id: "subscription-first",
      kind: "subscription",
    });
    await Promise.resolve();
    await expect(
      payments.checkout({ id: "subscription-second", kind: "subscription" }),
    ).rejects.toThrow("previous checkout is still being confirmed");
    expect(calls).toBe(1);
    release();
    await expect(first).resolves.toEqual({
      url: "https://checkout.stripe.com/c/sub",
    });
  });

  test("a confirmed subscription checkout clears only its matching pending slot", async () => {
    const ledger = new BillingLedger(storage(), () => NOW);
    ledger.set("customer", "cus_owner");
    const intent = {
      id: "subscription-done",
      kind: "subscription",
      cents: 2900,
      created: NOW,
      sessionId: "cs_subscription",
    };
    ledger.set("checkout:subscription-done", intent);
    ledger.set("pendingSubscription", intent);
    const start = Math.floor(NOW / 1000);
    const end = start + 30 * 86_400;
    const stripe = new StripeClient(
      config,
      fakeFetch(async (url) =>
        Response.json(
          String(url).includes("checkout/sessions")
            ? {
                id: "cs_subscription",
                customer: "cus_owner",
                client_reference_id: "user_one",
                metadata: { frockbot_checkout_id: "subscription-done" },
                payment_status: "paid",
                mode: "subscription",
                subscription: "sub_owner",
              }
            : {
                id: "sub_owner",
                customer: "cus_owner",
                status: "active",
                current_period_start: start,
                current_period_end: end,
                cancel_at_period_end: false,
                items: {
                  data: [
                    {
                      quantity: 1,
                      price: {
                        id: "price_monthly",
                        currency: "usd",
                        unit_amount: 2900,
                        recurring: { interval: "month" },
                      },
                    },
                  ],
                },
              },
        ),
      ),
    );
    const payments = new AccountPayments(ledger, stripe, "user_one", () => NOW);
    await payments.webhook({
      id: "evt_subscription_done",
      type: "checkout.session.completed",
      created: start,
      data: { object: { id: "cs_subscription", customer: "cus_owner" } },
    });
    expect(ledger.get("pendingSubscription")).toBeNull();
  });

  test("a refund suspends usage once and cannot be replayed with changed event data", async () => {
    const ledger = new BillingLedger(storage(), () => NOW);
    ledger.set("customer", "cus_owner");
    const payments = new AccountPayments(
      ledger,
      new StripeClient(
        config,
        fakeFetch(async () => {
          throw new Error("must not call Stripe");
        }),
      ),
      "user_one",
      () => NOW,
    );
    const event = {
      id: "evt_refund",
      type: "charge.refunded",
      created: NOW / 1000,
      data: { object: { id: "ch_refund", customer: "cus_owner" } },
    };
    await payments.webhook(event);
    await payments.webhook(event);
    expect(ledger.snapshot().suspended).toBe(true);
    await expect(
      payments.webhook({ ...event, created: NOW / 1000 + 1 }),
    ).rejects.toThrow("Billing key reused with different data");
  });
});
