import {
  BILLING_PLAN,
  BillingError,
  BillingLedger,
  stable,
  type SubscriptionState,
} from "./ledger.js";

export interface StripeConfig {
  secretKey: string;
  webhookSecret: string;
  monthlyPriceId: string;
  origin: string;
}
type StripeObject = Record<string, unknown>;
export function object(value: unknown): StripeObject {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new BillingError("Invalid payment response", 502);
  return value as StripeObject;
}
export function stripeId(value: unknown): string {
  const id = typeof value === "string" ? value : object(value).id;
  if (typeof id !== "string" || !/^[a-z]+_[a-zA-Z0-9_]+$/.test(id))
    throw new BillingError("Invalid payment identifier", 400);
  return id;
}
export async function boundedText(
  response: Response | Request,
  maximum = 1_048_576,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) {
        await reader.cancel();
        throw new BillingError("Payment payload is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(result);
}

export class StripeClient {
  constructor(
    readonly config: StripeConfig,
    private readonly request: typeof fetch = fetch,
  ) {}
  async call(
    path: string,
    fields?: Record<string, string>,
    key?: string,
  ): Promise<StripeObject> {
    const response = await this.request(`https://api.stripe.com/v1/${path}`, {
      method: fields ? "POST" : "GET",
      headers: {
        authorization: `Bearer ${this.config.secretKey}`,
        "Stripe-Version": "2025-02-24.acacia",
        ...(fields
          ? { "content-type": "application/x-www-form-urlencoded" }
          : {}),
        ...(key ? { "Idempotency-Key": key } : {}),
      },
      ...(fields ? { body: new URLSearchParams(fields) } : {}),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await boundedText(response);
    if (!response.ok)
      throw new BillingError(
        "Stripe could not complete this request. Please try again.",
        response.status === 429 ? 429 : 502,
      );
    return object(JSON.parse(body));
  }
}

export async function verifyStripeEvent(
  raw: string,
  signature: string | null,
  secret: string,
  now = Date.now(),
): Promise<StripeObject> {
  if (!secret || !signature)
    throw new BillingError("Missing payment signature", 400);
  const parts = signature.split(",").map((part) => part.trim().split("="));
  const timestamps = parts.filter(([key]) => key === "t");
  const timestamp = timestamps[0]?.[1];
  if (
    timestamps.length !== 1 ||
    !timestamp ||
    !/^\d+$/.test(timestamp) ||
    Math.abs(now / 1000 - Number(timestamp)) > 300
  )
    throw new BillingError("Expired payment signature", 400);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  let valid = false;
  for (const [kind, value] of parts) {
    if (kind !== "v1" || !value || !/^[0-9a-f]{64}$/.test(value)) continue;
    const bytes = Uint8Array.from(value.match(/../g)!, (hex) =>
      Number.parseInt(hex, 16),
    );
    valid =
      (await crypto.subtle.verify(
        "HMAC",
        key,
        bytes,
        new TextEncoder().encode(`${timestamp}.${raw}`),
      )) || valid;
  }
  if (!valid) throw new BillingError("Invalid payment signature", 400);
  const event = object(JSON.parse(raw));
  stripeId(event.id);
  if (typeof event.type !== "string" || !Number.isSafeInteger(event.created))
    throw new BillingError("Invalid payment event", 400);
  object(object(event.data).object);
  return event;
}

interface PaymentIntentRecord {
  id: string;
  kind: "subscription" | "topup";
  cents: number;
  created: number;
  sessionId?: string;
  url?: string;
}

/** Stripe effects retain their intent before dispatch, including uncertain responses. */
export class AccountPayments {
  constructor(
    private readonly ledger: BillingLedger,
    private readonly stripe: StripeClient,
    private readonly userId: string,
    private readonly now: () => number = Date.now,
  ) {}
  private async customer(): Promise<string> {
    const existing = this.ledger.get<string>("customer");
    if (existing) return existing;
    const started = this.ledger.get<number>("customerIntent") ?? this.now();
    this.ledger.set("customerIntent", started);
    if (this.now() - started > 23 * 3600_000)
      throw new BillingError(
        "Payment setup needs reconciliation. Please contact support.",
        409,
      );
    const customer = await this.stripe.call(
      "customers",
      { "metadata[frockbot_user_id]": this.userId },
      `frockbot:customer:${this.userId}`,
    );
    const id = stripeId(customer.id);
    this.ledger.set("customer", id);
    return id;
  }
  async checkout(command: {
    id: string;
    kind: "subscription" | "topup";
    cents?: number;
  }) {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(command.id))
      throw new BillingError("Invalid checkout request", 400);
    if (!["subscription", "topup"].includes(command.kind))
      throw new BillingError("Invalid purchase", 400);
    const cents =
      command.kind === "subscription"
        ? BILLING_PLAN.monthlyCents
        : command.cents;
    if (
      command.kind === "topup" &&
      !(BILLING_PLAN.topUpCents as readonly number[]).includes(cents ?? 0)
    )
      throw new BillingError("Choose a $10, $25 or $50 top-up", 400);
    const key = `checkout:${command.id}`;
    let intent = this.ledger.get<PaymentIntentRecord>(key);
    if (intent && (intent.kind !== command.kind || intent.cents !== cents))
      throw new BillingError("Checkout key was reused", 409);
    if (intent?.url) return { url: intent.url };
    if (!intent) {
      if (command.kind === "subscription") {
        const subscription = this.ledger.subscription();
        if (
          subscription &&
          !["canceled", "incomplete_expired"].includes(subscription.status)
        )
          throw new BillingError(
            "Manage your existing subscription in the billing portal.",
            409,
          );
        const pending = this.ledger.get<PaymentIntentRecord>(
          "pendingSubscription",
        );
        if (pending) {
          if (!pending.sessionId)
            throw new BillingError(
              "Your previous checkout is still being confirmed. Please retry that checkout.",
              409,
            );
          const session = await this.stripe.call(
            `checkout/sessions/${pending.sessionId}`,
          );
          if (session.status !== "expired") {
            if (session.status === "open" && typeof session.url === "string")
              return { url: session.url };
            throw new BillingError(
              "Your subscription payment is being confirmed.",
              409,
            );
          }
          const current = this.ledger.get<PaymentIntentRecord>(
            "pendingSubscription",
          );
          if (
            !current ||
            current.id !== pending.id ||
            current.sessionId !== pending.sessionId
          )
            throw new BillingError(
              "Another subscription checkout is already in progress.",
              409,
            );
        }
      } else this.ledger.requireSubscription();
      intent = {
        id: command.id,
        kind: command.kind,
        cents: cents!,
        created: this.now(),
      };
      // No await between claiming the single subscription slot and its intent.
      this.ledger.set(key, intent);
      if (command.kind === "subscription")
        this.ledger.set("pendingSubscription", intent);
    }
    // Stripe requires expires_at to remain at least 30 minutes ahead of the
    // request. The stable one-hour deadline leaves room for safe retries.
    if (this.now() - intent.created > 25 * 60_000)
      throw new BillingError(
        "Checkout needs reconciliation. Please contact support.",
        409,
      );
    const customer = await this.customer();
    const fields: Record<string, string> = {
      customer,
      mode: intent.kind === "subscription" ? "subscription" : "payment",
      success_url: `${this.stripe.config.origin}/billing?checkout=success`,
      cancel_url: `${this.stripe.config.origin}/billing?checkout=cancelled`,
      client_reference_id: this.userId,
      "metadata[frockbot_user_id]": this.userId,
      "metadata[frockbot_checkout_id]": intent.id,
      "metadata[frockbot_kind]": intent.kind,
      "line_items[0][quantity]": "1",
      "payment_method_types[0]": "card",
      expires_at: String(Math.floor(intent.created / 1000) + 3600),
    };
    if (intent.kind === "subscription") {
      fields["line_items[0][price]"] = this.stripe.config.monthlyPriceId;
      fields["subscription_data[metadata][frockbot_user_id]"] = this.userId;
    } else {
      fields["line_items[0][price_data][currency]"] = "usd";
      fields["line_items[0][price_data][unit_amount]"] = String(intent.cents);
      fields["line_items[0][price_data][product_data][name]"] =
        "FrockBot usage credit";
    }
    const session = await this.stripe.call(
      "checkout/sessions",
      fields,
      `frockbot:checkout:${this.userId}:${intent.id}`,
    );
    const url = session.url;
    if (
      typeof url !== "string" ||
      new URL(url).origin !== "https://checkout.stripe.com"
    )
      throw new BillingError("Stripe did not return a checkout link", 502);
    const saved = { ...intent, sessionId: stripeId(session.id), url };
    this.ledger.set(key, saved);
    if (intent.kind === "subscription")
      this.ledger.set("pendingSubscription", saved);
    return { url };
  }
  async portal(commandId: string) {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(commandId))
      throw new BillingError("Invalid portal request", 400);
    const customer = this.ledger.get<string>("customer");
    if (!customer)
      throw new BillingError(
        "Subscribe before opening the billing portal",
        409,
      );
    const session = await this.stripe.call(
      "billing_portal/sessions",
      { customer, return_url: `${this.stripe.config.origin}/billing` },
      `frockbot:portal:${this.userId}:${commandId}`,
    );
    if (
      typeof session.url !== "string" ||
      new URL(session.url).origin !== "https://billing.stripe.com"
    )
      throw new BillingError("Invalid billing portal link", 502);
    return { url: session.url };
  }
  private async subscription(id: string): Promise<SubscriptionState> {
    const subscription = await this.stripe.call(`subscriptions/${id}`);
    if (stripeId(subscription.customer) !== this.ledger.get<string>("customer"))
      throw new BillingError("Subscription belongs to another account", 409);
    const items = object(subscription.items).data;
    if (!Array.isArray(items) || items.length !== 1)
      throw new BillingError("Unexpected subscription items", 409);
    const item = object(items[0]);
    const price = object(item.price);
    if (
      stripeId(price.id) !== this.stripe.config.monthlyPriceId ||
      price.currency !== "usd" ||
      price.unit_amount !== BILLING_PLAN.monthlyCents ||
      item.quantity !== 1 ||
      object(price.recurring).interval !== "month"
    )
      throw new BillingError(
        "Subscription price does not match the FrockBot plan",
        409,
      );
    const start = Number(subscription.current_period_start) * 1000;
    const end = Number(subscription.current_period_end) * 1000;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      end <= start ||
      typeof subscription.status !== "string"
    )
      throw new BillingError("Invalid subscription period", 502);
    return {
      customerId: stripeId(subscription.customer),
      subscriptionId: id,
      status: subscription.status,
      periodStart: start,
      periodEnd: end,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    };
  }
  async webhook(event: StripeObject) {
    const eventId = stripeId(event.id);
    const type = String(event.type);
    const data = object(object(event.data).object);
    const customer = this.ledger.get<string>("customer");
    if (!customer || stripeId(data.customer) !== customer)
      throw new BillingError("Payment customer does not match account", 409);
    const fingerprint = stable(event);
    if (this.ledger.receipt(eventId, fingerprint)) return;
    // A later event may finish its Stripe read first. Retry instead of overwriting it.
    const revision = this.ledger.get<number>("stripeRevision") ?? 0;
    let subscription: SubscriptionState | undefined;
    let grant:
      | {
          id: string;
          kind: "included" | "purchased";
          micros: number;
          expires: number | null;
        }
      | undefined;
    let paidPeriod:
      | { subscriptionId: string; periodStart: number; periodEnd: number }
      | undefined;
    let completedSubscriptionIntentId: string | undefined;
    if (type === "invoice.paid") {
      const invoice = await this.stripe.call(`invoices/${stripeId(data.id)}`);
      if (
        invoice.status !== "paid" ||
        invoice.currency !== "usd" ||
        stripeId(invoice.customer) !== customer
      )
        throw new BillingError("Invoice is not paid", 409);
      const subscriptionId = stripeId(invoice.subscription);
      subscription = await this.subscription(subscriptionId);
      if (
        ["subscription_create", "subscription_cycle"].includes(
          String(invoice.billing_reason),
        )
      ) {
        const lines = object(invoice.lines);
        if (lines.has_more === true || !Array.isArray(lines.data))
          throw new BillingError("Invoice needs reconciliation", 409);
        const matching = lines.data
          .map(object)
          .filter(
            (line) =>
              line.type === "subscription" &&
              !line.proration &&
              stripeId(object(line.price).id) ===
                this.stripe.config.monthlyPriceId,
          );
        if (matching.length !== 1 || matching[0]!.quantity !== 1)
          throw new BillingError("Invoice allowance is ambiguous", 409);
        const period = object(matching[0]!.period);
        const start = Number(period.start) * 1000;
        const end = Number(period.end) * 1000;
        if (
          !Number.isSafeInteger(start) ||
          !Number.isSafeInteger(end) ||
          end <= start ||
          start > this.now()
        )
          throw new BillingError("Invalid invoice period", 409);
        grant = {
          id: `monthly:${subscriptionId}:${period.start}`,
          kind: "included",
          micros: BILLING_PLAN.includedMicros,
          expires: end,
        };
        paidPeriod = { subscriptionId, periodStart: start, periodEnd: end };
      }
    } else if (type.startsWith("customer.subscription.")) {
      subscription = await this.subscription(stripeId(data.id));
    } else if (type === "invoice.payment_failed") {
      subscription = await this.subscription(stripeId(data.subscription));
    } else if (
      [
        "checkout.session.completed",
        "checkout.session.async_payment_succeeded",
      ].includes(type)
    ) {
      const session = await this.stripe.call(
        `checkout/sessions/${stripeId(data.id)}`,
      );
      if (
        stripeId(session.customer) !== customer ||
        session.client_reference_id !== this.userId
      )
        throw new BillingError("Checkout account mismatch", 409);
      const meta = object(session.metadata);
      const intent = this.ledger.get<PaymentIntentRecord>(
        `checkout:${String(meta.frockbot_checkout_id)}`,
      );
      if (!intent || (intent.sessionId && intent.sessionId !== session.id))
        throw new BillingError("Unknown checkout", 409);
      if (intent.kind === "topup" && session.payment_status === "paid") {
        if (
          session.mode !== "payment" ||
          session.currency !== "usd" ||
          session.amount_total !== intent.cents
        )
          throw new BillingError("Top-up amount does not match payment", 409);
        grant = {
          id: `topup:${stripeId(session.id)}`,
          kind: "purchased",
          micros: intent.cents * 10_000,
          expires: null,
        };
      }
      if (intent.kind === "subscription" && session.subscription) {
        subscription = await this.subscription(stripeId(session.subscription));
        completedSubscriptionIntentId = intent.id;
      }
    }
    this.ledger.once(eventId, event, () => {
      if ((this.ledger.get<number>("stripeRevision") ?? 0) !== revision)
        throw new BillingError("Payment state changed; retry event", 409);
      if (subscription) {
        const existing = this.ledger.subscription();
        if (
          existing &&
          existing.subscriptionId !== subscription.subscriptionId &&
          existing.periodStart > subscription.periodStart
        )
          throw new BillingError("Old subscription event", 409);
        this.ledger.set("subscription", subscription);
        if (paidPeriod) {
          const paid = this.ledger.get<{
            subscriptionId: string;
            periodStart: number;
            periodEnd: number;
          }>("paidAccess");
          if (
            !paid ||
            paidPeriod.periodEnd > paid.periodEnd ||
            (paidPeriod.periodStart === paid.periodStart &&
              paidPeriod.periodEnd === paid.periodEnd &&
              paidPeriod.subscriptionId !== paid.subscriptionId)
          ) {
            this.ledger.set("paidAccess", paidPeriod);
          }
        }
      }
      if (grant)
        this.ledger.grant(grant.id, grant.kind, grant.micros, grant.expires);
      if (
        completedSubscriptionIntentId &&
        this.ledger.get<PaymentIntentRecord>("pendingSubscription")?.id ===
          completedSubscriptionIntentId
      )
        this.ledger.set("pendingSubscription", null);
      if (type === "charge.refunded" || type === "charge.dispute.created")
        this.ledger.set("suspended", true);
      this.ledger.set("stripeRevision", revision + 1);
    });
  }
}
