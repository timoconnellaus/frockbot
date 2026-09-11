import { describe, expect, test } from "bun:test";
import { BILLING_PLAN } from "@frockbot/app/billing/ledger";
import {
  billingRoutes,
  type BillingAccountRpc,
  type BillingEnv,
} from "./billing";
import { billingPage, billingScript } from "@frockbot/app/billing/page";

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
        suspended: false,
        includedMicros: 0,
        purchasedMicros: 0,
        reservedMicros: 0,
        summaries: [],
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
      "US$29",
      "US$15",
      "US$10",
      "US$25",
      "US$50",
      "Hosted model rates",
      "Usage by day &amp; Bot",
      "Credit history",
      "Recent usage",
    ])
      expect(billingPage).toContain(text);
  });
  test("requires authentication for both the billing page and account API", async () => {
    const routes = billingRoutes(env, () => account());
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
    const routes = billingRoutes(env, (userId) => {
      seen.push(userId);
      return account();
    });
    const request = new Request("https://app.frockbot.com/api/billing");
    const response = await routes.route(
      request,
      new URL(request.url),
      signedIn,
    );
    expect(seen).toEqual(["user-one"]);
    expect(response?.headers.get("cache-control")).toBe("no-store");
    expect(await response?.json()).toMatchObject({
      plan: { monthlyCents: 2900 },
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

  test("rejects cross-origin mutations before dispatch", async () => {
    let calls = 0;
    const routes = billingRoutes(env, () =>
      account({
        async billingCheckout() {
          calls += 1;
          return { url: "https://checkout.stripe.com/c/test" };
        },
      }),
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
    const routes = billingRoutes(env, () => {
      calls += 1;
      return account();
    });
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
    const routes = billingRoutes(env, (userId) =>
      account({
        async reconcileBilling(input) {
          seen.push({ userId, input });
        },
      }),
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
