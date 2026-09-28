import { describe, expect, test } from "bun:test";
import type { PaymentsAccountV1 } from "@frockbot/core/contracts";
import { STRIPE_PAYMENTS_PACKAGE_V1, stripeActionsV1 } from "./index";

const CONFIGURED = {
  STRIPE_SECRET_KEY: "sk_test",
  STRIPE_WEBHOOK_SECRET: "whsec_test",
  STRIPE_MONTHLY_PRICE_ID: "price_monthly",
  BETTER_AUTH_URL: "https://app.frockbot.com",
};

function account(
  overrides: Partial<PaymentsAccountV1> = {},
): PaymentsAccountV1 {
  return {
    subscription: null,
    paidPeriod: null,
    subscribed: false,
    suspended: false,
    ...overrides,
  };
}

const subscription = (status: string) => ({
  customerId: "cus_1",
  subscriptionId: "sub_1",
  status,
  periodStart: 1,
  periodEnd: 2,
  cancelAtPeriodEnd: false,
});

describe("the Stripe payments Package", () => {
  test("sells the US$20 plan with US$15 included, and three top-ups tied to it", () => {
    expect(STRIPE_PAYMENTS_PACKAGE_V1.plan).toEqual({
      subscription: { monthlyCents: 2_000, includedMicros: 15_000_000 },
      topUpCents: [1_000, 2_500, 5_000],
      purchasedCreditNeedsSubscription: true,
    });
    expect(STRIPE_PAYMENTS_PACKAGE_V1.required).toEqual([]);
  });

  test("is live on its secret key alone, and available with all three settings", () => {
    expect(STRIPE_PAYMENTS_PACKAGE_V1.live({})).toBe(false);
    expect(STRIPE_PAYMENTS_PACKAGE_V1.live({ STRIPE_SECRET_KEY: " " })).toBe(
      false,
    );
    expect(STRIPE_PAYMENTS_PACKAGE_V1.live({ STRIPE_SECRET_KEY: "sk" })).toBe(
      true,
    );
    const create = (env: object) =>
      STRIPE_PAYMENTS_PACKAGE_V1.create(env, { productName: "FrockBot" });
    expect(create(CONFIGURED).available).toBe(true);
    expect(create({ STRIPE_SECRET_KEY: "sk" }).available).toBe(false);
    expect(create({}).providerName).toBe("Stripe");
  });

  test("offers the plan to a new account, top-ups and the portal to a subscriber, and mends a lapsed one", () => {
    const purposes = (overrides: Partial<PaymentsAccountV1>) =>
      stripeActionsV1(account(overrides)).map((action) => action.purpose);
    expect(purposes({})).toEqual(["subscribe"]);
    expect(
      purposes({ subscribed: true, subscription: subscription("active") }),
    ).toEqual(["top-up", "manage"]);
    expect(purposes({ subscription: subscription("past_due") })).toEqual([
      "manage",
    ]);
    expect(purposes({ subscription: subscription("canceled") })).toEqual([
      "subscribe",
      "manage",
    ]);
    const [topUp, manage] = stripeActionsV1(
      account({ subscribed: true, subscription: subscription("active") }),
    );
    expect(topUp).toMatchObject({
      label: "Add",
      target: { kind: "command", path: "/api/billing/provider/checkout" },
      hosts: ["checkout.stripe.com"],
    });
    expect(manage).toMatchObject({
      label: "Plan, invoices & card",
      target: { kind: "command", path: "/api/billing/provider/portal" },
      hosts: ["billing.stripe.com"],
    });
  });

  test("serves only its own paths, and its account half only its own commands", async () => {
    const payments = STRIPE_PAYMENTS_PACKAGE_V1.create(CONFIGURED, {
      productName: "FrockBot",
    });
    const request = new Request(
      "https://app.frockbot.com/api/billing/provider/elsewhere",
    );
    expect(
      await payments.route!(request, new URL(request.url), {
        sessionUserId: async () => "user-one",
        account: () => {
          throw new Error("no account is asked");
        },
      }),
    ).toBeUndefined();
    const ledger = {} as Parameters<NonNullable<typeof payments.account>>[0];
    await expect(
      payments.account!(ledger, "user-one").command("refund", {}),
    ).rejects.toThrow("Unknown payment command");
  });

  test("an account with a recorded customer cannot be deleted around unconfigured payments", async () => {
    const unconfigured = STRIPE_PAYMENTS_PACKAGE_V1.create(
      {},
      { productName: "FrockBot" },
    );
    await expect(
      unconfigured.deleteAccount!(
        "user-one",
        <T>(key: string) =>
          (key === "customer" ? "cus_1" : undefined) as T | undefined,
      ),
    ).rejects.toThrow(/cus_1 cannot be deleted/);
    await unconfigured.deleteAccount!("user-one", () => undefined);
  });
});
