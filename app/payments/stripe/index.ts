/**
 * Stripe, as a payments Package (`core/contracts/payments-package.ts`).
 *
 * The hosted deployment's build: `apps/cloudflare/src/payments.ts` names it,
 * and `#payments` resolves there unless a profile chooses another. Its switch
 * is `STRIPE_SECRET_KEY`: without it nothing is metered, and the Billing page
 * says payments are not available. `scripts/check-payments-package-imports.ts`
 * keeps everything Stripe inside this directory and that chooser.
 *
 * Routes, under `/api/billing/provider/`:
 * - `checkout` — the signed-in person starts a subscription or a top-up
 *   Checkout Session, and is answered its URL;
 * - `portal` — the signed-in person opens the Customer Portal;
 * - `webhook` — Stripe's signed events, which the account they name applies
 *   through the ledger port, at most once by event id.
 *
 * It also answers at the addresses Stripe and installed clients already use
 * (`EARLIER_PATHS_V1`), so moving behind the seam changed nothing a
 * deployment had registered.
 */
import type {
  PaymentsAccountV1,
  PaymentsActionV1,
  PaymentsPackageBuildV1,
  PaymentsRouteContextV1,
} from "@frockbot/core/contracts";
import { BillingError } from "@frockbot/app/billing/errors";
import {
  AccountPayments,
  STRIPE_PLAN_V1,
  StripeClient,
  boundedText,
  deleteAccountCustomersV1,
  object,
  stripeId,
  verifyStripeEvent,
  type StripeConfig,
} from "./stripe.js";

export { STRIPE_PLAN_V1 };

/** What a Worker must hand the Stripe Package. */
export interface StripeEnvironmentV1 {
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_MONTHLY_PRICE_ID?: string;
  /** The deployment's own origin, which Checkout and the portal return to. */
  BETTER_AUTH_URL?: string;
}

export function stripeConfig(
  env: StripeEnvironmentV1,
  productName: string,
): StripeConfig {
  if (
    !env.STRIPE_SECRET_KEY ||
    !env.STRIPE_WEBHOOK_SECRET ||
    !env.STRIPE_MONTHLY_PRICE_ID ||
    !env.BETTER_AUTH_URL
  )
    throw new BillingError(
      "Payments are not available yet. Please check back soon.",
      503,
    );
  const origin = new URL(env.BETTER_AUTH_URL).origin;
  if (!/^price_[a-zA-Z0-9]+$/.test(env.STRIPE_MONTHLY_PRICE_ID))
    throw new BillingError("Payment plan is not configured", 503);
  return {
    productName,
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    monthlyPriceId: env.STRIPE_MONTHLY_PRICE_ID,
    origin,
  };
}

const CHECKOUT_PATH = "/api/billing/provider/checkout";
const PORTAL_PATH = "/api/billing/provider/portal";
const WEBHOOK_PATH = "/api/billing/provider/webhook";

/**
 * Where Stripe's webhook endpoint and installed clients reached this Package
 * before it had routes of its own: the registered endpoint is configuration
 * in Stripe, and an installed app is updated on its own schedule. Each is
 * served exactly as its provider route.
 */
const EARLIER_PATHS_V1 = {
  "/api/billing/checkout": CHECKOUT_PATH,
  "/api/billing/portal": PORTAL_PATH,
  "/api/billing/stripe/webhook": WEBHOOK_PATH,
} as const;

const SUBSCRIBE_V1: PaymentsActionV1 = {
  purpose: "subscribe",
  label: "Subscribe",
  target: {
    kind: "command",
    path: CHECKOUT_PATH,
    body: { kind: "subscription" },
  },
  opens: "browser",
  hosts: ["checkout.stripe.com"],
};
const TOP_UP_V1: PaymentsActionV1 = {
  purpose: "top-up",
  label: "Add",
  target: { kind: "command", path: CHECKOUT_PATH, body: { kind: "topup" } },
  opens: "browser",
  hosts: ["checkout.stripe.com"],
};
const MANAGE_V1: PaymentsActionV1 = {
  purpose: "manage",
  label: "Plan, invoices & card",
  target: { kind: "command", path: PORTAL_PATH },
  opens: "browser",
  hosts: ["billing.stripe.com"],
};

/**
 * What the Billing page offers. A subscription that lapsed or is past due is
 * mended in the portal, not bought again; top-ups are for a paid account.
 */
export function stripeActionsV1(
  account: PaymentsAccountV1,
): PaymentsActionV1[] {
  const canSubscribe =
    !account.subscription ||
    ["canceled", "incomplete_expired"].includes(account.subscription.status);
  return [
    ...(canSubscribe ? [SUBSCRIBE_V1] : []),
    ...(account.subscribed ? [TOP_UP_V1] : []),
    ...(account.subscription ? [MANAGE_V1] : []),
  ];
}

const SUPPORTED_EVENTS_V1 = new Set([
  "invoice.paid",
  "invoice.payment_failed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "checkout.session.completed",
  "checkout.session.async_payment_succeeded",
  "charge.refunded",
  "charge.dispute.created",
]);

const COMMAND_HEADERS_V1 = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "content-security-policy":
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
  "referrer-policy": "no-referrer",
};

/** The provider route a request is for, whichever address it came to. */
function route(url: URL): string {
  return (
    (EARLIER_PATHS_V1 as Record<string, string>)[url.pathname] ?? url.pathname
  );
}

function failure(error: unknown) {
  return Response.json(
    {
      error:
        error instanceof Error
          ? error.message
          : "Billing is temporarily unavailable",
    },
    {
      status: error instanceof BillingError ? error.status : 503,
      headers: { "cache-control": "no-store" },
    },
  );
}

async function webhook(
  env: StripeEnvironmentV1,
  productName: string,
  request: Request,
  context: PaymentsRouteContextV1,
): Promise<Response> {
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    const config = stripeConfig(env, productName);
    const event = await verifyStripeEvent(
      await boundedText(request),
      request.headers.get("stripe-signature"),
      config.webhookSecret,
    );
    if (!SUPPORTED_EVENTS_V1.has(String(event.type)))
      return Response.json({ received: true });
    const stripe = new StripeClient(config);
    const data = object(object(event.data).object);
    // Dispute payloads identify the charge rather than its customer.
    if (!data.customer && event.type === "charge.dispute.created") {
      const charge = await stripe.call(`charges/${stripeId(data.charge)}`);
      data.customer = charge.customer;
    }
    const customer = await stripe.call(`customers/${stripeId(data.customer)}`);
    // Deleting an account deletes its customer, and Stripe then reports
    // the subscription that took with it. There is nobody left to tell,
    // and refusing would only have Stripe retry for days.
    if (customer.deleted === true) return Response.json({ received: true });
    const userId = object(customer.metadata).frockbot_user_id;
    if (typeof userId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(userId))
      throw new BillingError("Unknown payment account", 400);
    await context
      .account(userId, { signedIn: false })
      .command("webhook", { event });
    return Response.json({ received: true });
  } catch (error) {
    // An event that raced the account's deletion has nothing to apply to.
    if (error instanceof Error && error.name === "AccountDeletedError")
      return Response.json({ received: true });
    return failure(error);
  }
}

async function command(
  env: StripeEnvironmentV1,
  request: Request,
  url: URL,
  context: PaymentsRouteContextV1,
): Promise<Response> {
  const userId = await context.sessionUserId();
  if (!userId)
    return Response.json(
      { error: "Sign in to manage billing" },
      { status: 401 },
    );
  if (request.method !== "POST") return new Response(null, { status: 405 });
  try {
    const origin = request.headers.get("origin");
    if (origin && origin !== new URL(env.BETTER_AUTH_URL ?? request.url).origin)
      throw new BillingError("Invalid request origin", 403);
    if (!request.headers.get("content-type")?.startsWith("application/json"))
      throw new BillingError("Expected JSON", 415);
    const body = object(JSON.parse(await boundedText(request, 4096)));
    const account = context.account(userId, { signedIn: true });
    if (route(url) === CHECKOUT_PATH) {
      if (
        typeof body.id !== "string" ||
        !["subscription", "topup"].includes(String(body.kind)) ||
        (body.cents !== undefined && typeof body.cents !== "number")
      )
        throw new BillingError("Invalid checkout", 400);
      return Response.json(
        await account.command("checkout", {
          id: body.id,
          kind: body.kind as "subscription" | "topup",
          ...(body.cents === undefined ? {} : { cents: body.cents as number }),
        }),
        { headers: COMMAND_HEADERS_V1 },
      );
    }
    if (typeof body.id !== "string") return new Response(null, { status: 404 });
    return Response.json(
      await account.command("portal", { commandId: body.id }),
      { headers: COMMAND_HEADERS_V1 },
    );
  } catch (error) {
    return failure(error);
  }
}

export const STRIPE_PAYMENTS_PACKAGE_V1: PaymentsPackageBuildV1<StripeEnvironmentV1> =
  {
    id: "stripe",
    // Every Stripe setting is optional: the secret key is the switch, and a
    // deployment without it ships billing switched off.
    required: [],
    plan: STRIPE_PLAN_V1,
    live: (env) => !!env.STRIPE_SECRET_KEY?.trim(),
    create(env, { productName }) {
      return {
        available: !!(
          env.STRIPE_SECRET_KEY &&
          env.STRIPE_WEBHOOK_SECRET &&
          env.STRIPE_MONTHLY_PRICE_ID
        ),
        providerName: "Stripe",
        actions: stripeActionsV1,
        paths: Object.keys(
          EARLIER_PATHS_V1,
        ) as (keyof typeof EARLIER_PATHS_V1)[],
        async route(request, url, context) {
          const path = route(url);
          if (path === WEBHOOK_PATH)
            return webhook(env, productName, request, context);
          if (path === CHECKOUT_PATH || path === PORTAL_PATH)
            return command(env, request, url, context);
          return undefined;
        },
        account(ledger, userId) {
          return {
            async command(name, input) {
              const payments = new AccountPayments(
                ledger,
                new StripeClient(stripeConfig(env, productName)),
                userId,
              );
              const given = object(input);
              if (name === "checkout")
                return payments.checkout(
                  given as {
                    id: string;
                    kind: "subscription" | "topup";
                    cents?: number;
                  },
                );
              if (name === "portal")
                return payments.portal(String(given.commandId));
              if (name === "webhook") {
                await payments.webhook(object(given.event));
                return null;
              }
              throw new BillingError("Unknown payment command", 404);
            },
          };
        },
        /**
         * The Stripe customer, which ends the subscription with it. With
         * Stripe unconfigured there is nothing to reach — unless the ledger
         * recorded a customer, which means payments were on once and a live
         * subscription may still be charging. That is refused, and retried,
         * until someone restores the configuration: finishing the deletion
         * around it would leave the person paying for an account that no
         * longer exists.
         */
        async deleteAccount(userId, record) {
          const recorded = record<string>("customer");
          let config: StripeConfig;
          try {
            config = stripeConfig(env, productName);
          } catch (error) {
            if (recorded === undefined) return;
            throw new Error(
              `payments are not configured, so customer ${recorded} cannot be deleted`,
              { cause: error },
            );
          }
          await deleteAccountCustomersV1(
            new StripeClient(config),
            userId,
            recorded,
          );
        },
      };
    },
  };
