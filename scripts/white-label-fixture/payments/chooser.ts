// A STUB of a white-label's own payments Package chooser: what its profile
// names by path and the generator aliases `#payments` to. It takes no real
// payment. It sells credit on its own page and credits an account from a test
// webhook, through the ledger port and nothing else — which is what the
// fixture proves a Package written outside this repository, against nothing
// but the published `@frockbot/core/contracts`, can do.
import type {
  PaymentsActionV1,
  PaymentsPackageBuildV1,
  PaymentsRouteContextV1,
} from "@frockbot/core/contracts";

/** What the Worker's `env` must hand this Package. */
export interface PaymentsPackageEnvironmentV1 {
  WALLET_PAL_PAYMENTS_SECRET?: string;
}

const WEBHOOK_PATH = "/api/billing/provider/test-webhook";
const PAGE_PATH = "/api/billing/provider/buy";

const BUY_V1: PaymentsActionV1 = {
  purpose: "top-up",
  label: "Buy",
  target: { kind: "url", url: PAGE_PATH },
  opens: "in-app",
  hosts: [],
};

/** The test webhook's body: one paid top-up for one account. */
interface TestPaymentV1 {
  event: string;
  userId: string;
  payment: string;
  cents: number;
}

function testPayment(value: unknown): TestPaymentV1 | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { event, userId, payment, cents } = value as Record<string, unknown>;
  return typeof event === "string" &&
    typeof userId === "string" &&
    typeof payment === "string" &&
    typeof cents === "number" &&
    Number.isSafeInteger(cents) &&
    cents > 0
    ? { event, userId, payment, cents }
    : undefined;
}

async function webhook(
  secret: string | undefined,
  request: Request,
  context: PaymentsRouteContextV1,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  if (!secret || request.headers.get("x-wallet-pal-secret") !== secret)
    return Response.json({ error: "Unsigned payment event" }, { status: 401 });
  const payment = testPayment(await request.json().catch(() => undefined));
  if (!payment)
    return Response.json({ error: "Invalid payment event" }, { status: 400 });
  await context
    .account(payment.userId, { signedIn: false })
    .command("credit", payment);
  return Response.json({ received: true });
}

export const PAYMENTS_PACKAGE_V1: PaymentsPackageBuildV1<PaymentsPackageEnvironmentV1> =
  {
    id: "wallet-pal-stub",
    required: [
      {
        name: "WALLET_PAL_PAYMENTS_SECRET",
        why: "Authenticates the test payment webhook.",
      },
    ],
    plan: {
      subscriptions: [],
      trial: null,
      topUpCents: [500, 2_000],
      purchasedCreditNeedsSubscription: false,
    },
    live: (environment) => !!environment.WALLET_PAL_PAYMENTS_SECRET,
    create: (environment) => ({
      available: !!environment.WALLET_PAL_PAYMENTS_SECRET,
      providerName: "Wallet Pal",
      actions: () => [BUY_V1],
      async route(request, url, context) {
        if (url.pathname === WEBHOOK_PATH)
          return webhook(
            environment.WALLET_PAL_PAYMENTS_SECRET,
            request,
            context,
          );
        if (url.pathname === PAGE_PATH)
          return new Response("<!doctype html><title>Buy credit</title>", {
            headers: { "content-type": "text/html; charset=utf-8" },
          });
        return undefined;
      },
      account: (ledger) => ({
        async command(name, input) {
          const payment = testPayment(input);
          if (name !== "credit" || !payment)
            throw new Error("Unknown payment command");
          ledger.apply(payment.event, payment, (effects) =>
            effects.grantPurchased({
              key: payment.payment,
              micros: payment.cents * 10_000,
            }),
          );
          return null;
        },
      }),
    }),
  };
