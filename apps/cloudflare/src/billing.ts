import {
  BILLING_LAUNCH_BLOCKERS,
  hostedBillingEnabledV1,
} from "./billing-readiness.js";
import { COMPUTER_TARIFF } from "@frockbot/app/billing/computer";
import { decodeModelRates } from "@frockbot/app/billing/model";
import {
  BillingError,
  type UsageReservation,
  type UsageSettlement,
} from "@frockbot/app/billing/ledger";
import {
  AccountPayments,
  StripeClient,
  boundedText,
  object,
  stripeId,
  verifyStripeEvent,
  type StripeConfig,
} from "@frockbot/app/billing/stripe";
import {
  billingPage,
  billingScript,
  billingStyles,
} from "@frockbot/app/billing/page";
import type { BillingLedger } from "@frockbot/app/billing/ledger";
import type { BackendRouteContribution } from "./contracts.js";

export interface BillingEnv {
  BILLING_MODEL_RATES?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  STRIPE_MONTHLY_PRICE_ID?: string;
  BETTER_AUTH_URL?: string;
}
export function stripeConfig(env: BillingEnv): StripeConfig {
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
    secretKey: env.STRIPE_SECRET_KEY,
    webhookSecret: env.STRIPE_WEBHOOK_SECRET,
    monthlyPriceId: env.STRIPE_MONTHLY_PRICE_ID,
    origin,
  };
}
export function accountPayments(
  ledger: BillingLedger,
  env: BillingEnv,
  userId: string,
) {
  return new AccountPayments(
    ledger,
    new StripeClient(stripeConfig(env)),
    userId,
  );
}
export interface BillingAccountRpc {
  reconcileBilling(input: {
    userId: string;
    command: Parameters<BillingLedger["reconcile"]>[0];
  }): Promise<void>;
  readBilling(input: {
    userId: string;
    before?: number;
  }): Promise<ReturnType<BillingLedger["snapshot"]>>;
  billingCheckout(input: {
    userId: string;
    command: { id: string; kind: "subscription" | "topup"; cents?: number };
  }): Promise<{ url: string }>;
  billingPortal(input: {
    userId: string;
    commandId: string;
  }): Promise<{ url: string }>;
  billingWebhook(input: {
    userId: string;
    event: Record<string, unknown>;
  }): Promise<void>;
  reserveUsage(input: {
    userId: string;
    reservation: UsageReservation;
  }): Promise<{
    status: "reserved" | "settled" | "released";
    created: boolean;
  }>;
  settleUsage(input: {
    userId: string;
    settlement: UsageSettlement;
  }): Promise<void>;
  requirePaidAccount(input: { userId: string }): Promise<void>;
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
export function billingRoutes(
  env: BillingEnv,
  account: (userId: string) => BillingAccountRpc,
): BackendRouteContribution {
  return {
    packageId: "billing",
    async publicRoute(request, url) {
      if (
        request.method === "GET" &&
        ["/billing", "/billing.js", "/billing.css"].includes(url.pathname)
      ) {
        const type = url.pathname.endsWith(".js")
          ? "text/javascript"
          : url.pathname.endsWith(".css")
            ? "text/css"
            : "text/html";
        return new Response(
          url.pathname.endsWith(".js")
            ? billingScript
            : url.pathname.endsWith(".css")
              ? billingStyles
              : billingPage,
          {
            headers: {
              "content-type": `${type}; charset=utf-8`,
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
              "content-security-policy":
                "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
            },
          },
        );
      }
      if (url.pathname !== "/api/billing/stripe/webhook") return;
      if (request.method !== "POST") return new Response(null, { status: 405 });
      try {
        const config = stripeConfig(env);
        const event = await verifyStripeEvent(
          await boundedText(request),
          request.headers.get("stripe-signature"),
          config.webhookSecret,
        );
        const supported = new Set([
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
        if (!supported.has(String(event.type)))
          return Response.json({ received: true });
        const stripe = new StripeClient(config);
        const data = object(object(event.data).object);
        // Dispute payloads identify the charge rather than its customer.
        if (!data.customer && event.type === "charge.dispute.created") {
          const charge = await stripe.call(`charges/${stripeId(data.charge)}`);
          data.customer = charge.customer;
        }
        const customer = await stripe.call(
          `customers/${stripeId(data.customer)}`,
        );
        const userId = object(customer.metadata).frockbot_user_id;
        if (
          typeof userId !== "string" ||
          !/^[a-zA-Z0-9_-]{1,128}$/.test(userId)
        )
          throw new BillingError("Unknown payment account", 400);
        await account(userId).billingWebhook({ userId, event });
        return Response.json({ received: true });
      } catch (error) {
        return failure(error);
      }
    },
    async route(request, url, context) {
      if (
        !url.pathname.startsWith("/api/billing") &&
        !["/billing", "/billing.js", "/billing.css"].includes(url.pathname)
      )
        return;
      if (!context.userId || context.userId === "anonymous")
        return Response.json(
          { error: "Sign in to manage billing" },
          { status: 401 },
        );
      const headers = {
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
        "content-security-policy":
          "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'",
        "referrer-policy": "no-referrer",
      };
      if (request.method === "GET") {
        if (url.pathname === "/billing")
          return new Response(billingPage, {
            headers: { ...headers, "content-type": "text/html; charset=utf-8" },
          });
        if (url.pathname === "/billing.js")
          return new Response(billingScript, {
            headers: {
              ...headers,
              "content-type": "text/javascript; charset=utf-8",
            },
          });
        if (url.pathname === "/billing.css")
          return new Response(billingStyles, {
            headers: { ...headers, "content-type": "text/css; charset=utf-8" },
          });
      }
      try {
        const userId = context.userId;
        if (request.method === "GET" && url.pathname === "/api/billing") {
          const before = url.searchParams.has("before")
            ? Number(url.searchParams.get("before"))
            : undefined;
          if (
            before !== undefined &&
            (!Number.isSafeInteger(before) || before < 0)
          )
            throw new BillingError("Invalid usage cursor", 400);
          return Response.json(
            {
              ...(await account(userId).readBilling({
                userId,
                ...(before === undefined ? {} : { before }),
              })),
              modelRates: Object.fromEntries(
                Object.entries(decodeModelRates(env.BILLING_MODEL_RATES)).map(
                  ([model, rate]) => [
                    model,
                    {
                      inputUsdPerMillion: rate.inputMicrosPerToken * 2,
                      cachedInputUsdPerMillion:
                        rate.cachedInputMicrosPerToken * 2,
                      outputUsdPerMillion: rate.outputMicrosPerToken * 2,
                    },
                  ],
                ),
              ),
              computerRate: {
                activeUsdPerHour: COMPUTER_TARIFF.activeUsdPerHour,
                storageIncludedGb: COMPUTER_TARIFF.storageIncludedGb,
                viewerOpenSeconds: COMPUTER_TARIFF.viewerOpenSeconds,
                viewerRenewSeconds: COMPUTER_TARIFF.viewerRenewSeconds,
              },
              launchBlockers: BILLING_LAUNCH_BLOCKERS,
              // Whether this deployment meters at all. Off, and credit is
              // meaningless: nothing is charged and nothing is refused.
              metered: hostedBillingEnabledV1(env),
              paymentsAvailable:
                BILLING_LAUNCH_BLOCKERS.length === 0 &&
                !!(
                  env.STRIPE_SECRET_KEY &&
                  env.STRIPE_WEBHOOK_SECRET &&
                  env.STRIPE_MONTHLY_PRICE_ID
                ),
            },
            { headers },
          );
        }
        if (request.method !== "POST")
          return new Response(null, { status: 405 });
        const origin = request.headers.get("origin");
        if (
          origin &&
          origin !== new URL(env.BETTER_AUTH_URL ?? request.url).origin
        )
          throw new BillingError("Invalid request origin", 403);
        if (
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new BillingError("Expected JSON", 415);
        const body = object(JSON.parse(await boundedText(request, 4096)));
        if (url.pathname === "/api/billing/reconcile") {
          if (!context.isAdmin)
            throw new BillingError("Administrator access required", 403);
          if (
            typeof body.userId !== "string" ||
            !/^[a-zA-Z0-9_-]{1,128}$/.test(body.userId)
          )
            throw new BillingError("Invalid account", 400);
          const command = object(body.command);
          if (
            typeof command.id !== "string" ||
            typeof command.reason !== "string"
          )
            throw new BillingError("Invalid reconciliation", 400);
          await account(body.userId).reconcileBilling({
            userId: body.userId,
            command: {
              ...command,
              actorId: context.userId,
            } as unknown as Parameters<BillingLedger["reconcile"]>[0],
          });
          return Response.json({ ok: true }, { headers });
        }
        if (url.pathname === "/api/billing/checkout") {
          if (BILLING_LAUNCH_BLOCKERS.length)
            throw new BillingError(
              "Payments are not open yet. Launch qualification is still in progress.",
              503,
            );
          if (
            typeof body.id !== "string" ||
            !["subscription", "topup"].includes(String(body.kind)) ||
            (body.cents !== undefined && typeof body.cents !== "number")
          )
            throw new BillingError("Invalid checkout", 400);
          return Response.json(
            await account(userId).billingCheckout({
              userId,
              command: {
                id: body.id,
                kind: body.kind as "subscription" | "topup",
                ...(body.cents === undefined
                  ? {}
                  : { cents: body.cents as number }),
              },
            }),
            { headers },
          );
        }
        if (
          url.pathname === "/api/billing/portal" &&
          typeof body.id === "string"
        )
          return Response.json(
            await account(userId).billingPortal({ userId, commandId: body.id }),
            { headers },
          );
        return new Response(null, { status: 404 });
      } catch (error) {
        return failure(error);
      }
    },
  };
}
