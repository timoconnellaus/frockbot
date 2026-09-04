import { defineGatewayContribution } from "@frockbot/kernel-contracts/contributions";
import type { Plugin } from "cordis";
import type { UsageReportV1 } from "./shared.js";
import {
  customCreditCentsV1,
  decodeStripeEventV1,
  type BillingViewV1,
  type StripeCommandKindV1,
  type StripeCommandPreparationV1,
  type StripeEventV1,
} from "./billing.js";
import { createStripeClientV1, StripeApiError } from "./stripe.js";

const STRIPE_WEBHOOK_PATH_V1 = "/api/billing/stripe/webhook";
const STRIPE_SIGNATURE_TOLERANCE_SECONDS_V1 = 300;
const STRIPE_WEBHOOK_MAX_BYTES_V1 = 1_048_576;
const STRIPE_EVENT_TYPES_V1 = new Set([
  "checkout.session.completed",
  "invoice.paid",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "charge.refunded",
]);
const BILLING_REQUEST_MAX_BYTES_V1 = 16_384;
const FIXED_CREDIT_LOOKUP_KEYS_V1 = new Map([
  [2_500, "frockbot_credit_25"],
  [5_000, "frockbot_credit_50"],
  [10_000, "frockbot_credit_100"],
  [50_000, "frockbot_credit_500"],
]);

export interface BillingGatewayHostV1 {
  readUsage(userId: string): Promise<UsageReportV1>;
  readBilling(userId: string): Promise<BillingViewV1>;
  applyStripeEvent(
    userId: string,
    event: StripeEventV1,
  ): Promise<{ applied: boolean }>;
  prepareStripeCommand(
    userId: string,
    input: {
      commandId: string;
      kind: StripeCommandKindV1;
      fingerprint: string;
    },
  ): Promise<StripeCommandPreparationV1>;
  recordStripeCustomer(userId: string, customerId: string): Promise<void>;
  completeStripeCommand(
    userId: string,
    commandId: string,
    resultUrl: string,
  ): Promise<void>;
  stripeSecretKey?: string;
  stripeWebhookSecret?: string;
  stripeFetch?: typeof fetch;
  now?: () => number;
}

export interface BillingBackendRouteContributionV1 {
  packageId: string;
  publicRoute?(
    request: Request,
    url: URL,
    context: { userId?: string },
  ): Promise<Response | undefined>;
  route(
    request: Request,
    url: URL,
    context: { userId?: string },
  ): Promise<Response | undefined>;
}

function jsonError(status: number, error: string): Response {
  return Response.json({ error }, { status });
}

function metadataUserId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const userId = (value as Record<string, unknown>).frockbot_user_id;
  return typeof userId === "string" && userId.length > 0 && userId.length <= 256
    ? userId
    : undefined;
}

function stripeEventUserIdV1(event: StripeEventV1): string | undefined {
  const object = event.data.object;
  const direct = metadataUserId(object.metadata);
  if (direct) return direct;
  const parent = object.parent;
  if (!parent || typeof parent !== "object" || Array.isArray(parent)) {
    return undefined;
  }
  const details = (parent as Record<string, unknown>).subscription_details;
  if (!details || typeof details !== "object" || Array.isArray(details)) {
    return undefined;
  }
  return metadataUserId((details as Record<string, unknown>).metadata);
}

function hexBytes(value: string): Uint8Array | undefined {
  if (!/^[0-9a-f]+$/iu.test(value) || value.length % 2 !== 0) return undefined;
  return Uint8Array.from(value.match(/.{2}/gu) ?? [], (byte) =>
    Number.parseInt(byte, 16),
  );
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left[index]! ^ right[index]!;
  }
  return difference === 0;
}

async function verifyStripeSignatureV1(input: {
  body: string;
  header: string | null;
  secret: string;
  now: number;
}): Promise<boolean> {
  const fields = (input.header ?? "").split(",").map((field) => field.trim());
  const timestampText = fields
    .find((field) => field.startsWith("t="))
    ?.slice(2);
  const timestamp = Number(timestampText);
  if (
    !Number.isSafeInteger(timestamp) ||
    Math.abs(Math.floor(input.now / 1_000) - timestamp) >
      STRIPE_SIGNATURE_TOLERANCE_SECONDS_V1
  ) {
    return false;
  }
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(input.secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(`${String(timestamp)}.${input.body}`),
    ),
  );
  return fields
    .filter((field) => field.startsWith("v1="))
    .map((field) => hexBytes(field.slice(3)))
    .some(
      (candidate) => candidate !== undefined && equalBytes(expected, candidate),
    );
}

function commandIdV1(value: unknown): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new Error("Billing command is invalid.");
  }
  return value;
}

async function billingCommandBodyV1(
  request: Request,
): Promise<Record<string, unknown>> {
  const contentLength = Number(request.headers.get("content-length") ?? 0);
  if (
    Number.isFinite(contentLength) &&
    contentLength > BILLING_REQUEST_MAX_BYTES_V1
  ) {
    throw new Error("Billing request is too large.");
  }
  const text = await request.text();
  if (
    new TextEncoder().encode(text).byteLength > BILLING_REQUEST_MAX_BYTES_V1
  ) {
    throw new Error("Billing request is too large.");
  }
  const value = JSON.parse(text) as unknown;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Billing request is invalid.");
  }
  return value as Record<string, unknown>;
}

function exactKeysV1(
  value: Record<string, unknown>,
  allowed: readonly string[],
): void {
  if (
    Reflect.ownKeys(value).some(
      (key) => typeof key !== "string" || !allowed.includes(key),
    )
  ) {
    throw new Error("Billing request has an unknown field.");
  }
}

async function stripeCustomerV1(input: {
  host: BillingGatewayHostV1;
  userId: string;
  commandId: string;
  preparation: StripeCommandPreparationV1;
  stripe: ReturnType<typeof createStripeClientV1>;
}): Promise<string> {
  if (input.preparation.customerId) return input.preparation.customerId;
  const customerId = await input.stripe.createCustomer({
    userId: input.userId,
    idempotencyKey: `frockbot-customer-${input.userId}`,
  });
  await input.host.recordStripeCustomer(input.userId, customerId);
  return customerId;
}

export function createBillingBackendContribution(
  host: BillingGatewayHostV1,
): BillingBackendRouteContributionV1 {
  return {
    packageId: "billing",
    async publicRoute(request, url) {
      if (url.pathname !== STRIPE_WEBHOOK_PATH_V1) return undefined;
      if (request.method !== "POST")
        return jsonError(405, "Method not allowed.");
      if (!host.stripeWebhookSecret) {
        return jsonError(503, "Billing is not configured.");
      }
      const contentLength = Number(request.headers.get("content-length") ?? 0);
      if (
        Number.isFinite(contentLength) &&
        contentLength > STRIPE_WEBHOOK_MAX_BYTES_V1
      ) {
        return jsonError(413, "Stripe webhook is too large.");
      }
      const body = await request.text();
      if (
        new TextEncoder().encode(body).byteLength > STRIPE_WEBHOOK_MAX_BYTES_V1
      ) {
        return jsonError(413, "Stripe webhook is too large.");
      }
      if (
        !(await verifyStripeSignatureV1({
          body,
          header: request.headers.get("stripe-signature"),
          secret: host.stripeWebhookSecret,
          now: (host.now ?? (() => Date.now()))(),
        }))
      ) {
        return jsonError(400, "Invalid Stripe signature.");
      }
      let event: StripeEventV1;
      try {
        event = decodeStripeEventV1(JSON.parse(body));
      } catch {
        return jsonError(400, "Invalid Stripe event.");
      }
      if (!STRIPE_EVENT_TYPES_V1.has(event.type)) {
        return Response.json({ received: true, applied: false });
      }
      const userId = stripeEventUserIdV1(event);
      if (!userId) return jsonError(400, "Stripe event has no User.");
      try {
        const result = await host.applyStripeEvent(userId, event);
        return Response.json({ received: true, applied: result.applied });
      } catch (error) {
        return jsonError(
          500,
          error instanceof Error ? error.message : "Stripe event failed.",
        );
      }
    },
    async route(request, url, context) {
      if (
        ![
          "/api/usage",
          "/api/billing",
          "/api/billing/checkout",
          "/api/billing/portal",
        ].includes(url.pathname) ||
        !context.userId
      ) {
        return undefined;
      }
      const userId = context.userId;
      if (url.pathname === "/api/usage") {
        if (request.method !== "GET")
          return jsonError(405, "Method not allowed.");
        try {
          return Response.json(await host.readUsage(userId));
        } catch (error) {
          return jsonError(
            500,
            error instanceof Error ? error.message : "Usage read failed.",
          );
        }
      }
      if (url.pathname === "/api/billing") {
        if (request.method !== "GET")
          return jsonError(405, "Method not allowed.");
        try {
          return Response.json(await host.readBilling(userId));
        } catch (error) {
          return jsonError(
            500,
            error instanceof Error ? error.message : "Billing read failed.",
          );
        }
      }
      if (request.method !== "POST")
        return jsonError(405, "Method not allowed.");
      if (!host.stripeSecretKey)
        return jsonError(503, "Billing is not configured.");
      const stripe = createStripeClientV1({
        secretKey: host.stripeSecretKey,
        ...(host.stripeFetch ? { fetch: host.stripeFetch } : {}),
      });
      try {
        const body = await billingCommandBodyV1(request);
        if (body.schemaVersion !== 1)
          throw new Error("Billing request is invalid.");
        const commandId = commandIdV1(body.commandId);
        const returnUrl = new URL(
          "/?settings=user-settings#billing",
          url.origin,
        ).href;

        if (url.pathname === "/api/billing/portal") {
          exactKeysV1(body, ["schemaVersion", "commandId"]);
          const preparation = await host.prepareStripeCommand(userId, {
            commandId,
            kind: "portal",
            fingerprint: "portal",
          });
          if (preparation.resultUrl) {
            return Response.json({
              schemaVersion: 1,
              url: preparation.resultUrl,
            });
          }
          if (!preparation.customerId) {
            return jsonError(409, "There is no subscription to manage yet.");
          }
          const resultUrl = await stripe.createPortal({
            customerId: preparation.customerId,
            idempotencyKey: `frockbot-${commandId}`,
            returnUrl,
          });
          await host.completeStripeCommand(userId, commandId, resultUrl);
          return Response.json({ schemaVersion: 1, url: resultUrl });
        }

        exactKeysV1(body, [
          "schemaVersion",
          "commandId",
          "kind",
          "amountCents",
        ]);
        if (body.kind !== "subscription" && body.kind !== "credit") {
          throw new Error("Billing choice is invalid.");
        }
        const kind: StripeCommandKindV1 =
          body.kind === "subscription"
            ? "checkout-subscription"
            : "checkout-credit";
        let amountCents: number | undefined;
        let lookupKey = "frockbot_basic_monthly";
        if (body.kind === "subscription") {
          if (body.amountCents !== undefined) {
            throw new Error("A subscription does not accept an amount.");
          }
          const current = await host.readBilling(userId);
          if (
            !["none", "canceled", "incomplete_expired"].includes(
              current.subscriptionStatus,
            )
          ) {
            return jsonError(409, "Basic is already active.");
          }
        } else {
          amountCents = customCreditCentsV1(body.amountCents);
          lookupKey = FIXED_CREDIT_LOOKUP_KEYS_V1.get(amountCents) ?? "";
        }
        const fingerprint = `${kind}:${String(amountCents ?? "monthly")}`;
        const preparation = await host.prepareStripeCommand(userId, {
          commandId,
          kind,
          fingerprint,
        });
        if (preparation.resultUrl) {
          return Response.json({
            schemaVersion: 1,
            url: preparation.resultUrl,
          });
        }
        const customerId = await stripeCustomerV1({
          host,
          userId,
          commandId,
          preparation,
          stripe,
        });
        const priceId = lookupKey
          ? await stripe.resolvePrice(lookupKey)
          : undefined;
        const resultUrl = await stripe.createCheckout({
          userId,
          customerId,
          idempotencyKey: `frockbot-${commandId}`,
          mode: body.kind === "subscription" ? "subscription" : "payment",
          successUrl: returnUrl,
          cancelUrl: returnUrl,
          ...(priceId ? { priceId } : {}),
          ...(!priceId && amountCents !== undefined
            ? { customAmountCents: amountCents }
            : {}),
        });
        await host.completeStripeCommand(userId, commandId, resultUrl);
        return Response.json({ schemaVersion: 1, url: resultUrl });
      } catch (error) {
        return jsonError(
          error instanceof StripeApiError ? 502 : 400,
          error instanceof Error ? error.message : "Billing request failed.",
        );
      }
    },
  };
}

export namespace createBillingBackendContribution {
  export function plugin(
    host: BillingGatewayHostV1,
    lifecycle: { mount(value: BillingBackendRouteContributionV1): () => void },
  ): Plugin {
    return () => lifecycle.mount(createBillingBackendContribution(host));
  }
}

export const backendContribution = defineGatewayContribution<
  BillingGatewayHostV1,
  BillingBackendRouteContributionV1
>({
  specifier: "@frockbot/plugin-billing/backend",
  create: createBillingBackendContribution.plugin,
});
