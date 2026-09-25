import { describe, expect, test } from "bun:test";
import { BILLING_PLAN } from "@frockbot/app/billing/ledger";
import {
  billingRoutes,
  type BillingAccountRpc,
  type BillingEnv,
} from "./billing";
import { billingPage, billingScript } from "@frockbot/app/billing/page";
import { seedHostedModelRatesV1 } from "@frockbot/app/billing/rates";

const rates = async () => seedHostedModelRatesV1("2026-09-24T00:00:00.000Z");

const env: BillingEnv = {
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_MONTHLY_PRICE_ID: "price_monthly",
  BETTER_AUTH_URL: "https://app.frockbot.com",
};

function account(
  overrides: Partial<BillingAccountRpc> = {},
): BillingAccountRpc {
  return {
    async readBilling() {
      return {
        plan: BILLING_PLAN,
        subscription: null,
        paidAccess: null,
        canSpend: false,
        subscribed: false,
        suspended: false,
        includedMicros: 0,
        purchasedMicros: 0,
        complimentaryMicros: 0,
        reservedMicros: 0,
        spentLast30DaysMicros: 0,
        payments: [],
        usage: [],
      };
    },
    async billingCheckout() {
      return { url: "https://checkout.stripe.com/c/test" };
    },
    async billingPortal() {
      return { url: "https://billing.stripe.com/p/test" };
    },
    async billingWebhook() {},
    async reconcileBilling() {},
    async reserveUsage() {
      return { status: "reserved", created: true };
    },
    async settleUsage() {},
    async requirePaidAccount() {},
    async readSpending(input) {
      return {
        since: 0,
        until: 1,
        timezone: "UTC",
        groupBy: input.groupBy,
        filters: [],
        totalMicros: 0,
        operations: 0,
        days: [],
        groups: [],
        topTurns: null,
      };
    },
    ...overrides,
  };
}

const signedIn = {
  userId: "user-one",
  client: "browser" as const,
  isAdmin: false,
};

describe("billing HTTP routes", () => {
  test("ships executable account-page JavaScript and the complete billing surface", () => {
    expect(() => new Function(billingScript)).not.toThrow();
    for (const text of [
      "US$20",
      "US$15",
      "US$10",
      "US$25",
      "US$50",
      "Hosted model rates",
      "Spent in the last 30 days",
      "Credit history",
      "Recent usage",
    ])
      expect(billingPage).toContain(text);
  });
  test("requires authentication for both the billing page and account API", async () => {
    const routes = billingRoutes(env, () => account(), rates);
    for (const path of ["/billing", "/api/billing"]) {
      const request = new Request(`https://app.frockbot.com${path}`);
      expect(
        (
          await routes.route(request, new URL(request.url), {
            client: "browser",
            isAdmin: false,
          })
        )?.status,
      ).toBe(401);
    }
  });

  test("projects only the authenticated account and never caches its balance", async () => {
    const seen: string[] = [];
    const routes = billingRoutes(
      env,
      (userId) => {
        seen.push(userId);
        return account();
      },
      rates,
    );
    const request = new Request("https://app.frockbot.com/api/billing");
    const response = await routes.route(
      request,
      new URL(request.url),
      signedIn,
    );
    expect(seen).toEqual(["user-one"]);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toMatchObject({
      plan: { monthlyCents: 2000 },
      computerRate: {
        activeUsdPerHour: 2.75,
        storageIncludedGb: 100,
        viewerOpenSeconds: 30,
        viewerRenewSeconds: 30,
      },
      paymentsAvailable: true,
      launchBlockers: [],
    });
  });

  test("reads one Spending view for the signed-in account, and refuses one it cannot name", async () => {
    const asked: unknown[] = [];
    const routes = billingRoutes(
      env,
      () =>
        account({
          async readSpending(input) {
            asked.push(input);
            return {
              since: 0,
              until: 1,
              timezone: "UTC",
              groupBy: input.groupBy,
              filters: [],
              totalMicros: 0,
              operations: 0,
              days: [],
              groups: [],
              topTurns: null,
            };
          },
        }),
      rates,
    );
    const view = async (query: string) => {
      const request = new Request(
        `https://app.frockbot.com/api/billing/spending${query}`,
      );
      return routes.route(request, new URL(request.url), signedIn);
    };
    const ok = await view("?period=7d&groupBy=cause&bot=bot-1&model=x");
    expect(ok?.status).toBe(200);
    expect(ok?.headers.get("cache-control")).toBe("no-store");
    expect(asked).toEqual([
      {
        userId: "user-one",
        period: "7d",
        groupBy: "cause",
        filters: { bot: "bot-1", model: "x" },
      },
    ]);
    expect((await view(""))?.status).toBe(200);
    expect(asked[1]).toMatchObject({ period: "30d", groupBy: "bot" });
    expect((await view("?period=forever"))?.status).toBe(400);
    expect((await view("?groupBy=colour"))?.status).toBe(400);
  });

  test("lists each billable model's customer rate once, from the rate table", async () => {
    const read = async (tableRead: typeof rates) => {
      const routes = billingRoutes(env, () => account(), tableRead);
      const request = new Request("https://app.frockbot.com/api/billing");
      const response = await routes.route(
        request,
        new URL(request.url),
        signedIn,
      );
      return ((await response?.json()) as { modelRates: unknown }).modelRates;
    };
    // Twice the deployment's cost; a pre-rename `@flock/` id is not repeated.
    expect(await read(rates)).toEqual({
      "@frock/auto": {
        inputUsdPerMillion: 0.6,
        cachedInputUsdPerMillion: 0.012,
        outputUsdPerMillion: 2.4,
      },
      "@frock/deepseek-ai/deepseek-v4-flash-0731": {
        inputUsdPerMillion: 0.88,
        cachedInputUsdPerMillion: 0.028,
        outputUsdPerMillion: 2.64,
      },
      // Conversation summaries are billed to the account too.
      "@frock/structured": {
        inputUsdPerMillion: 0.6,
        cachedInputUsdPerMillion: 0.012,
        outputUsdPerMillion: 2.4,
      },
    });
    // A table that cannot be read lists nothing rather than failing the page.
    expect(
      await read(() => Promise.reject(new Error("authority unreachable"))),
    ).toEqual({});
  });

  test("rejects cross-origin mutations before dispatch", async () => {
    let calls = 0;
    const routes = billingRoutes(
      env,
      () =>
        account({
          async billingCheckout() {
            calls += 1;
            return { url: "https://checkout.stripe.com/c/test" };
          },
        }),
      rates,
    );
    const request = new Request(
      "https://app.frockbot.com/api/billing/checkout",
      {
        method: "POST",
        headers: {
          origin: "https://evil.example",
          "content-type": "application/json",
        },
        body: JSON.stringify({ id: "0123456789abcdef", kind: "subscription" }),
      },
    );
    const response = await routes.route(
      request,
      new URL(request.url),
      signedIn,
    );
    expect(response?.status).toBe(403);
    expect(calls).toBe(0);
  });

  test("webhook rejects missing signatures and oversized bodies before account dispatch", async () => {
    let calls = 0;
    const routes = billingRoutes(
      env,
      () => {
        calls += 1;
        return account();
      },
      rates,
    );
    const missing = new Request(
      "https://app.frockbot.com/api/billing/stripe/webhook",
      { method: "POST", body: "{}" },
    );
    expect(
      (await routes.publicRoute!(missing, new URL(missing.url), {
        client: "browser",
      }))!.status,
    ).toBe(400);
    const huge = new Request(
      "https://app.frockbot.com/api/billing/stripe/webhook",
      {
        method: "POST",
        headers: { "stripe-signature": "t=1,v1=" + "0".repeat(64) },
        body: "x".repeat(1_048_577),
      },
    );
    expect(
      (await routes.publicRoute!(huge, new URL(huge.url), {
        client: "browser",
      }))!.status,
    ).toBe(413);
    expect(calls).toBe(0);
  });

  test("reconciliation is admin-only and targets the explicitly named account", async () => {
    const seen: unknown[] = [];
    const routes = billingRoutes(
      env,
      (userId) =>
        account({
          async reconcileBilling(input) {
            seen.push({ userId, input });
          },
        }),
      rates,
    );
    const body = JSON.stringify({
      userId: "affected-user",
      command: {
        id: "reconcile-123456",
        reason: "support case evidence",
        suspended: false,
      },
    });
    const ordinary = new Request(
      "https://app.frockbot.com/api/billing/reconcile",
      {
        method: "POST",
        headers: {
          origin: "https://app.frockbot.com",
          "content-type": "application/json",
        },
        body,
      },
    );
    expect(
      (await routes.route(ordinary, new URL(ordinary.url), signedIn))?.status,
    ).toBe(403);
    expect(seen).toEqual([]);
    const adminRequest = new Request(
      "https://app.frockbot.com/api/billing/reconcile",
      {
        method: "POST",
        headers: {
          origin: "https://app.frockbot.com",
          "content-type": "application/json",
        },
        body,
      },
    );
    expect(
      (
        await routes.route(adminRequest, new URL(adminRequest.url), {
          ...signedIn,
          isAdmin: true,
        })
      )?.status,
    ).toBe(200);
    expect(seen).toEqual([
      {
        userId: "affected-user",
        input: {
          userId: "affected-user",
          command: {
            id: "reconcile-123456",
            reason: "support case evidence",
            suspended: false,
            actorId: "user-one",
          },
        },
      },
    ]);
  });
});
