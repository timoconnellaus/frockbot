import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import {
  BillingLedger,
  type BillingStorage,
} from "@frockbot/app/billing/ledger";
import {
  AccountPayments,
  STRIPE_PLAN_V1 as PLAN,
  StripeClient,
  deleteAccountCustomersV1,
  verifyStripeEvent,
} from "./stripe";

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
  productName: "FrockBot",
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
    planId: "standard",
    status: "active",
    periodStart: NOW - 1,
    periodEnd: NOW + 1_000_000,
    trialEnd: null,
    cancelAtPeriodEnd: false,
  });
  ledger.set("paidAccess", {
    subscriptionId: "sub_owner",
    planId: "standard",
    periodStart: NOW - 1,
    periodEnd: NOW + 1_000_000,
  });
}

describe("Stripe payment boundaries", () => {
  test("the default request calls the global fetch without rebinding it", async () => {
    // workerd throws "Illegal invocation" when fetch is called as a method
    // of anything but the global scope.
    const original = globalThis.fetch;
    const methods: string[] = [];
    globalThis.fetch = function (this: unknown, _url, init) {
      if (this !== undefined && this !== globalThis)
        throw new TypeError("Illegal invocation");
      methods.push(init?.method ?? "GET");
      return Promise.resolve(Response.json({ id: "cus_one", deleted: true }));
    } as typeof fetch;
    try {
      const stripe = new StripeClient(config);
      expect(await stripe.call("customers/cus_one")).toMatchObject({
        id: "cus_one",
      });
      expect(await stripe.remove("customers/cus_one")).toBe("deleted");
      expect(methods).toEqual(["GET", "DELETE"]);
    } finally {
      globalThis.fetch = original;
    }
  });

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
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
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
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      stripe,
      "user_one",
      () => NOW,
    );
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
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => now);
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
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      stripe,
      "user_one",
      () => now,
    );
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
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
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
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      stripe,
      "user_one",
      () => NOW,
    );
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
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    const payments = new AccountPayments(
      ledger.paymentsPort(),
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
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
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
                  amount: 2000,
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
                id: "si_owner",
                quantity: 1,
                price: {
                  id: "price_monthly",
                  currency: "usd",
                  unit_amount: 2000,
                  recurring: { interval: "month" },
                },
              },
            ],
          },
        });
      }),
    );
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      stripe,
      "user_one",
      () => NOW,
    );
    const event = {
      id: "evt_invoice",
      type: "invoice.paid",
      created: NOW / 1000,
      data: { object: { id: "in_monthly", customer: "cus_owner" } },
    };
    await payments.webhook(event);
    await payments.webhook(event);
    expect(ledger.snapshot()).toMatchObject({
      includedMicros: 20_000_000,
      subscription: {
        subscriptionId: "sub_owner",
        periodEnd: periodEnd * 1000,
      },
    });
  });

  test("a delayed old invoice cannot grant access to the canonical newer unpaid period", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
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
                  amount: 2000,
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
                id: "si_owner",
                quantity: 1,
                price: {
                  id: "price_monthly",
                  currency: "usd",
                  unit_amount: 2000,
                  recurring: { interval: "month" },
                },
              },
            ],
          },
        });
      }),
    );
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      stripe,
      "user_one",
      () => NOW,
    );
    await payments.webhook({
      id: "evt_old",
      type: "invoice.paid",
      created: oldStart,
      data: { object: { id: "in_old", customer: "cus_owner" } },
    });
    expect(
      ledger.get<{
        subscriptionId: string;
        planId: string;
        periodStart: number;
        periodEnd: number;
      }>("paidAccess"),
    ).toEqual({
      subscriptionId: "sub_owner",
      planId: "standard",
      periodStart: oldStart * 1000,
      periodEnd: oldEnd * 1000,
    });
    expect(() => ledger.requireSubscription()).toThrow(
      "paid FrockBot subscription",
    );
  });

  test("concurrent subscription starts claim one checkout slot before calling Stripe", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
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
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      stripe,
      "user_one",
      () => NOW,
    );
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
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    const intent = {
      id: "subscription-done",
      kind: "subscription",
      cents: 2000,
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
                      id: "si_owner",
                      quantity: 1,
                      price: {
                        id: "price_monthly",
                        currency: "usd",
                        unit_amount: 2000,
                        recurring: { interval: "month" },
                      },
                    },
                  ],
                },
              },
        ),
      ),
    );
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      stripe,
      "user_one",
      () => NOW,
    );
    await payments.webhook({
      id: "evt_subscription_done",
      type: "checkout.session.completed",
      created: start,
      data: { object: { id: "cs_subscription", customer: "cus_owner" } },
    });
    expect(ledger.get("pendingSubscription")).toBeNull();
  });

  test("a refund suspends usage once and cannot be replayed with changed event data", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    const payments = new AccountPayments(
      ledger.paymentsPort(),
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

describe("deleting an account's customers", () => {
  test("deletes the recorded customer and any the search finds, once each", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const stripe = new StripeClient(
      config,
      fakeFetch(async (url, init) => {
        const method = init?.method ?? "GET";
        calls.push({ method, url: String(url) });
        if (method === "GET")
          return Response.json({
            data: [{ id: "cus_recorded" }, { id: "cus_orphan" }],
          });
        return String(url).endsWith("cus_orphan")
          ? new Response("{}", { status: 404 })
          : Response.json({ id: "cus_recorded", deleted: true });
      }),
    );
    expect(
      await deleteAccountCustomersV1(stripe, "user-1", "cus_recorded"),
    ).toEqual({ deleted: 1 });
    expect(calls[0]?.url).toContain("customers/search?query=");
    expect(decodeURIComponent(calls[0]!.url)).toContain(
      "metadata['frockbot_user_id']:'user-1'",
    );
    expect(calls.slice(1)).toEqual([
      {
        method: "DELETE",
        url: "https://api.stripe.com/v1/customers/cus_recorded",
      },
      {
        method: "DELETE",
        url: "https://api.stripe.com/v1/customers/cus_orphan",
      },
    ]);
  });

  test("a refused delete is a failure the caller retries, not a deletion", async () => {
    const stripe = new StripeClient(
      config,
      fakeFetch(async (_url, init) =>
        (init?.method ?? "GET") === "GET"
          ? Response.json({ data: [] })
          : new Response("{}", { status: 500 }),
      ),
    );
    await expect(
      deleteAccountCustomersV1(stripe, "user-1", "cus_recorded"),
    ).rejects.toThrow();
  });

  test("never interpolates an id Stripe's query language would have to escape", async () => {
    const urls: string[] = [];
    const stripe = new StripeClient(
      config,
      fakeFetch(async (url) => {
        urls.push(String(url));
        return Response.json({ id: "cus_recorded", deleted: true });
      }),
    );
    await deleteAccountCustomersV1(stripe, "a' OR 'b", "cus_recorded");
    expect(urls).toEqual(["https://api.stripe.com/v1/customers/cus_recorded"]);
  });
});

describe("plans and the trial", () => {
  const plusConfig = {
    ...config,
    plusPriceId: "price_plus",
    byoPriceId: "price_byo",
  };
  type Price = "price_monthly" | "price_plus" | "price_byo";
  const cents = { price_monthly: 2000, price_plus: 5000, price_byo: 500 };
  const DAY = 86_400;
  const unix = Math.floor(NOW / 1000);

  function subscriptionObject(options: {
    price: Price;
    status: string;
    start: number;
    end: number;
    trialEnd?: number;
  }) {
    return {
      id: "sub_owner",
      customer: "cus_owner",
      status: options.status,
      current_period_start: options.start,
      current_period_end: options.end,
      trial_end: options.trialEnd ?? null,
      cancel_at_period_end: false,
      items: {
        data: [
          {
            id: "si_owner",
            quantity: 1,
            price: {
              id: options.price,
              currency: "usd",
              unit_amount: cents[options.price],
              recurring: { interval: "month" },
            },
          },
        ],
      },
    };
  }
  function invoiceObject(options: {
    reason: string;
    price: Price;
    amount: number;
    start: number;
    end: number;
  }) {
    return {
      id: "in_one",
      customer: "cus_owner",
      subscription: "sub_owner",
      status: "paid",
      currency: "usd",
      billing_reason: options.reason,
      lines: {
        has_more: false,
        data: [
          {
            type: "subscription",
            proration: false,
            quantity: 1,
            amount: options.amount,
            price: { id: options.price },
            period: { start: options.start, end: options.end },
          },
        ],
      },
    };
  }
  function paymentsWith(
    ledger: BillingLedger,
    answer: (path: string, body?: URLSearchParams) => unknown,
    seen: { path: string; body?: URLSearchParams; key?: string }[] = [],
  ) {
    const stripe = new StripeClient(
      plusConfig,
      fakeFetch(async (url, init) => {
        const path = String(url).split("/v1/")[1]!;
        const body = init?.body as URLSearchParams | undefined;
        const key = (init?.headers as Record<string, string>)[
          "Idempotency-Key"
        ];
        seen.push({ path, body, ...(key ? { key } : {}) });
        return Response.json(answer(path, body));
      }),
    );
    return new AccountPayments(
      ledger.paymentsPort(),
      stripe,
      "user_one",
      () => NOW,
    );
  }
  const invoicePaid = (id: string) => ({
    id,
    type: "invoice.paid",
    created: unix,
    data: { object: { id: "in_one", customer: "cus_owner" } },
  });

  test("a first subscription starts with a seven-day trial, a later one does not", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    const seen: { path: string; body?: URLSearchParams }[] = [];
    const payments = paymentsWith(
      ledger,
      () => ({ id: "cs_one", url: "https://checkout.stripe.com/c/one" }),
      seen,
    );
    await payments.checkout({
      id: "subscription-trial-one",
      kind: "subscription",
      plan: "plus",
    });
    const first = seen.at(-1)!.body!;
    expect(first.get("line_items[0][price]")).toBe("price_plus");
    expect(first.get("subscription_data[trial_period_days]")).toBe("7");

    ledger.set("pendingSubscription", null);
    ledger.set("trialUsed", true);
    await payments.checkout({
      id: "subscription-trial-two",
      kind: "subscription",
    });
    const second = seen.at(-1)!.body!;
    expect(second.get("line_items[0][price]")).toBe("price_monthly");
    expect(second.has("subscription_data[trial_period_days]")).toBe(false);
  });

  test("BYO starts paying at once: never a trial, even as a first subscription", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    const seen: { path: string; body?: URLSearchParams }[] = [];
    const payments = paymentsWith(
      ledger,
      () => ({ id: "cs_byo", url: "https://checkout.stripe.com/c/byo" }),
      seen,
    );
    await payments.checkout({
      id: "subscription-byo-one",
      kind: "subscription",
      plan: "byo",
    });
    const body = seen.at(-1)!.body!;
    expect(body.get("line_items[0][price]")).toBe("price_byo");
    expect(body.has("subscription_data[trial_period_days]")).toBe(false);
    // Nor does it spend the account's one trial.
    expect(ledger.paymentsPort().account().trialUsed).toBe(false);
  });

  test("a paid BYO month grants Jev fair use and no usage credit", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    const start = unix - 60;
    const end = unix + 30 * DAY;
    const payments = paymentsWith(ledger, (path) =>
      path.startsWith("invoices/")
        ? invoiceObject({
            reason: "subscription_create",
            price: "price_byo",
            amount: 500,
            start,
            end,
          })
        : subscriptionObject({
            price: "price_byo",
            status: "active",
            start,
            end,
          }),
    );
    await payments.webhook(invoicePaid("evt_byo"));
    expect(ledger.snapshot()).toMatchObject({
      includedMicros: 0,
      subscribed: true,
      subscription: { planId: "byo" },
      jevFairUse: { remainingMicros: 2_000_000, grantedMicros: 2_000_000 },
      trial: null,
    });
  });

  test("BYO is refused where its price is not configured", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      new StripeClient(
        config,
        fakeFetch(async () => Response.json({})),
      ),
      "user_one",
      () => NOW,
    );
    await expect(
      payments.checkout({
        id: "subscription-byo-off",
        kind: "subscription",
        plan: "byo",
      }),
    ).rejects.toThrow("That plan is not available yet");
  });

  test("Plus is refused where its price is not configured", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      new StripeClient(
        config,
        fakeFetch(async () => Response.json({})),
      ),
      "user_one",
      () => NOW,
    );
    await expect(
      payments.checkout({
        id: "subscription-plus-off",
        kind: "subscription",
        plan: "plus",
      }),
    ).rejects.toThrow("That plan is not available yet");
  });

  test("a subscription checkout recorded before plans existed is answered its saved URL as Standard", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("checkout:legacy-subscription", {
      id: "legacy-subscription",
      kind: "subscription",
      cents: 2000,
      created: NOW,
      sessionId: "cs_legacy",
      url: "https://checkout.stripe.com/c/legacy",
    });
    let calls = 0;
    const payments = new AccountPayments(
      ledger.paymentsPort(),
      new StripeClient(
        config,
        fakeFetch(async () => {
          calls += 1;
          return Response.json({});
        }),
      ),
      "user_one",
      () => NOW,
    );
    expect(
      await payments.checkout({
        id: "legacy-subscription",
        kind: "subscription",
      }),
    ).toEqual({ url: "https://checkout.stripe.com/c/legacy" });
    expect(calls).toBe(0);
  });

  test("the trial's free invoice grants trial credit, never the allowance or a paid period", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    const trialEnd = unix + 7 * DAY;
    const payments = paymentsWith(ledger, (path) =>
      path.startsWith("invoices/")
        ? invoiceObject({
            reason: "subscription_create",
            price: "price_monthly",
            amount: 0,
            start: unix,
            end: trialEnd,
          })
        : subscriptionObject({
            price: "price_monthly",
            status: "trialing",
            start: unix,
            end: trialEnd,
            trialEnd,
          }),
    );
    await payments.webhook(invoicePaid("evt_trial"));
    const snapshot = ledger.snapshot();
    expect(snapshot).toMatchObject({
      includedMicros: 0,
      complimentaryMicros: 3_000_000,
      subscribed: false,
      canSpend: true,
      paidAccess: null,
      trial: { endsAt: trialEnd * 1000, creditMicros: 3_000_000 },
      subscription: { planId: "standard", trialEnd: trialEnd * 1000 },
    });
    expect(ledger.get<boolean>("trialUsed")).toBe(true);
    // The trial credit ends with the trial.
    const later = new BillingLedger(
      storage(),
      "FrockBot",
      PLAN,
      () => trialEnd * 1000 + 1,
    );
    later.grant("trial:sub_owner", "complimentary", 3_000_000, trialEnd * 1000);
    expect(later.balance().complimentaryMicros).toBe(0);
  });

  test("a paid month grants its own plan's allowance, and a mismatched amount is refused", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    const start = unix - 60;
    const end = unix + 30 * DAY;
    let amount = 5000;
    const payments = paymentsWith(ledger, (path) =>
      path.startsWith("invoices/")
        ? invoiceObject({
            reason: "subscription_cycle",
            price: "price_plus",
            amount,
            start,
            end,
          })
        : subscriptionObject({
            price: "price_plus",
            status: "active",
            start,
            end,
          }),
    );
    await payments.webhook(invoicePaid("evt_plus"));
    expect(ledger.snapshot()).toMatchObject({
      includedMicros: 60_000_000,
      subscribed: true,
      subscription: { planId: "plus" },
      trial: null,
    });
    amount = 2000;
    await expect(payments.webhook(invoicePaid("evt_short"))).rejects.toThrow(
      "Invoice amount does not match the plan",
    );
  });

  test("an upgrade charges now and restarts the month; a downgrade waits for renewal", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    active(ledger);
    const seen: { path: string; body?: URLSearchParams; key?: string }[] = [];
    let current: "price_monthly" | "price_plus" = "price_monthly";
    const payments = paymentsWith(
      ledger,
      (_path, body) =>
        body
          ? { id: "sub_owner" }
          : subscriptionObject({
              price: current,
              status: "active",
              start: unix - 60,
              end: unix + 30 * DAY,
            }),
      seen,
    );
    await expect(
      payments.changePlan({ id: "plan-change-upgrade", plan: "plus" }),
    ).resolves.toEqual({ plan: "plus" });
    const upgrade = seen.at(-1)!;
    expect(upgrade.path).toBe("subscriptions/sub_owner");
    expect(upgrade.key).toBe("frockbot:plan:user_one:plan-change-upgrade");
    expect(Object.fromEntries(upgrade.body!)).toEqual({
      "items[0][id]": "si_owner",
      "items[0][price]": "price_plus",
      proration_behavior: "none",
      billing_cycle_anchor: "now",
      payment_behavior: "error_if_incomplete",
    });
    // The same command again replays the same Stripe request.
    await payments.changePlan({ id: "plan-change-upgrade", plan: "plus" });
    expect(seen.at(-1)!.key).toBe(upgrade.key);
    await expect(
      payments.changePlan({ id: "plan-change-upgrade", plan: "standard" }),
    ).rejects.toThrow("Plan change key was reused");

    ledger.set("subscription", {
      ...ledger.subscription()!,
      planId: "plus",
    });
    current = "price_plus";
    await payments.changePlan({
      id: "plan-change-downgrade",
      plan: "standard",
    });
    expect(Object.fromEntries(seen.at(-1)!.body!)).toEqual({
      "items[0][id]": "si_owner",
      "items[0][price]": "price_monthly",
      proration_behavior: "none",
    });
  });

  test("the upgrade's invoice grants the new allowance for the restarted month", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    const end = unix + 30 * DAY;
    const payments = paymentsWith(ledger, (path) =>
      path.startsWith("invoices/")
        ? invoiceObject({
            reason: "subscription_update",
            price: "price_plus",
            amount: 5000,
            start: unix,
            end,
          })
        : subscriptionObject({
            price: "price_plus",
            status: "active",
            start: unix,
            end,
          }),
    );
    await payments.webhook(invoicePaid("evt_upgrade"));
    expect(ledger.snapshot()).toMatchObject({
      includedMicros: 60_000_000,
      paidAccess: { periodStart: NOW, periodEnd: end * 1000 },
    });
  });

  test("during a trial, choosing a plan ends the trial and charges its first month now", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    ledger.set("customer", "cus_owner");
    ledger.set("subscription", {
      customerId: "cus_owner",
      subscriptionId: "sub_owner",
      planId: "standard",
      status: "trialing",
      periodStart: NOW,
      periodEnd: NOW + 7 * DAY * 1000,
      trialEnd: NOW + 7 * DAY * 1000,
      cancelAtPeriodEnd: false,
    });
    const seen: { path: string; body?: URLSearchParams; key?: string }[] = [];
    const payments = paymentsWith(
      ledger,
      (_path, body) =>
        body
          ? { id: "sub_owner" }
          : subscriptionObject({
              price: "price_monthly",
              status: "trialing",
              start: unix,
              end: unix + 7 * DAY,
              trialEnd: unix + 7 * DAY,
            }),
      seen,
    );
    await expect(
      payments.changePlan({ id: "plan-change-in-trial", plan: "standard" }),
    ).resolves.toEqual({ plan: "standard" });
    expect(Object.fromEntries(seen.at(-1)!.body!)).toEqual({
      "items[0][id]": "si_owner",
      "items[0][price]": "price_monthly",
      proration_behavior: "none",
      trial_end: "now",
      payment_behavior: "error_if_incomplete",
    });
  });

  test("an account without a subscription cannot change plan", async () => {
    const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
    const payments = paymentsWith(ledger, () => ({}));
    await expect(
      payments.changePlan({ id: "plan-change-nobody", plan: "plus" }),
    ).rejects.toThrow("Subscribe before changing plan");
  });
});

describe("the marketing page's prices", () => {
  const homepage = readFileSync(
    new URL("../../../apps/marketing/public/index.html", import.meta.url),
    "utf8",
  );
  const start = homepage.indexOf('class="section pricing"');
  const section = homepage
    .slice(start, homepage.indexOf("</section>", start))
    .replace(/\s+/g, " ");
  const usd = (cents: number) => `US$${cents / 100}`;

  test("names each plan with its price and included credit", () => {
    for (const plan of PLAN.subscriptions) {
      expect(section).toContain(`id="plan-${plan.id}">${plan.name}</p>`);
      expect(section).toContain(
        `${usd(plan.monthlyCents)}<span> / month</span>`,
      );
      expect(section).toContain(
        plan.includedMicros > 0
          ? `Includes ${usd(plan.includedMicros / 10_000)} of usage credit every month.`
          : "No usage credit included.",
      );
      if ("jevFairUseMicros" in plan)
        expect(section).toContain(
          `Every reply checked before it's sent, up to ${usd(plan.jevFairUseMicros / 10_000)} a month`,
        );
    }
    // The hero's "From" sits beside the trial, so it is the cheapest plan
    // with one; the plan without a trial is named where hosting is offered.
    const page = homepage.replace(/\s+/g, " ");
    const withTrial = PLAN.subscriptions.filter(
      (plan) => !("trial" in plan && plan.trial === false),
    );
    expect(page).toContain(
      `${PLAN.trial.days}-day trial · From ${usd(Math.min(...withTrial.map((plan) => plan.monthlyCents)))} a month`,
    );
    for (const plan of PLAN.subscriptions)
      if (!withTrial.includes(plan))
        expect(page).toContain(`or ${usd(plan.monthlyCents)} with your own AI`);
  });

  test("the setup chooser suggests plans at these prices", async () => {
    const { PLANS } = await import(
      new URL("../../../apps/marketing/public/setup/result.js", import.meta.url)
        .href
    );
    for (const plan of PLAN.subscriptions) {
      if (plan.id in PLANS)
        expect(PLANS[plan.id].price).toBe(`${usd(plan.monthlyCents)} a month`);
    }
  });

  test("states the trial, who has none, and the top-ups", () => {
    expect(section).toContain(
      `${PLAN.trial.days}-day trial that includes ${usd(PLAN.trial.creditMicros / 10_000)} of credit`,
    );
    for (const plan of PLAN.subscriptions)
      if ("trial" in plan && plan.trial === false)
        expect(section).toContain(`${plan.name} has no trial`);
    const topUps = PLAN.topUpCents.map(usd);
    expect(section).toContain(
      `Add ${topUps.slice(0, -1).join(", ")}, or ${topUps.at(-1)} of prepaid credit`,
    );
  });
});
