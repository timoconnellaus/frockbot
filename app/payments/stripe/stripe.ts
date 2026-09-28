import { BillingError } from "@frockbot/app/billing/errors";
import { boundedText, object } from "@frockbot/app/billing/wire";
import type {
  PaymentsLedgerPortV1,
  PaymentsPlanV1,
  PaymentsSubscriptionV1,
} from "@frockbot/core/contracts";
import { withDeadlineV1 } from "@frockbot/core/deadline";

/**
 * FrockBot's plans. The markup is in the usage rates, so Standard includes as
 * much usage as it costs and Plus more. A first subscription starts with a
 * 7-day trial carrying US$3 of credit; top-ups are spendable only while
 * subscribed. Each plan is also a Stripe price (`STRIPE_MONTHLY_PRICE_ID`,
 * `STRIPE_PLUS_PRICE_ID`), and a subscription on any other is refused.
 */
export const STRIPE_PLAN_V1 = {
  subscriptions: [
    {
      id: "standard",
      name: "Standard",
      monthlyCents: 2000,
      includedMicros: 20_000_000,
    },
    {
      id: "plus",
      name: "Plus",
      monthlyCents: 5000,
      includedMicros: 60_000_000,
    },
  ],
  trial: { days: 7, creditMicros: 3_000_000 },
  topUpCents: [1000, 2500, 5000],
  purchasedCreditNeedsSubscription: true,
} as const satisfies PaymentsPlanV1;

export type StripePlanIdV1 =
  (typeof STRIPE_PLAN_V1.subscriptions)[number]["id"];
export function stripePlanV1(id: StripePlanIdV1) {
  return STRIPE_PLAN_V1.subscriptions.find((plan) => plan.id === id)!;
}

export interface StripeConfig {
  /** What a checkout names the credit it sells: the product's. */
  productName: string;
  secretKey: string;
  webhookSecret: string;
  monthlyPriceId: string;
  /** Absent, Plus is not offered. */
  plusPriceId?: string;
  origin: string;
}

/** The Stripe price a plan is sold at, if this deployment sells it. */
export function planPriceIdV1(
  config: StripeConfig,
  plan: StripePlanIdV1,
): string | undefined {
  return plan === "standard" ? config.monthlyPriceId : config.plusPriceId;
}
function planForPrice(
  config: StripeConfig,
  priceId: string,
): StripePlanIdV1 | undefined {
  if (priceId === config.monthlyPriceId) return "standard";
  if (config.plusPriceId && priceId === config.plusPriceId) return "plus";
  return undefined;
}
export function isStripePlanV1(value: unknown): value is StripePlanIdV1 {
  return STRIPE_PLAN_V1.subscriptions.some((plan) => plan.id === value);
}
type StripeObject = Record<string, unknown>;
export { boundedText, object };
export function stripeId(value: unknown): string {
  const id = typeof value === "string" ? value : object(value).id;
  if (typeof id !== "string" || !/^[a-z]+_[a-zA-Z0-9_]+$/.test(id))
    throw new BillingError("Invalid payment identifier", 400);
  return id;
}
export class StripeClient {
  constructor(
    readonly config: StripeConfig,
    private readonly request: typeof fetch = (input, init) =>
      fetch(input, init),
  ) {}
  async call(
    path: string,
    fields?: Record<string, string>,
    key?: string,
  ): Promise<StripeObject> {
    const deadline = withDeadlineV1(20_000);
    let response: Response;
    let body: string;
    try {
      response = await this.request(`https://api.stripe.com/v1/${path}`, {
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
        signal: deadline.signal,
      });
      body = await boundedText(response);
    } finally {
      deadline.clear();
    }
    if (!response.ok)
      throw new BillingError(
        "Stripe could not complete this request. Please try again.",
        response.status === 429 ? 429 : 502,
      );
    return object(JSON.parse(body));
  }

  /**
   * Deletes one object. Stripe treats a DELETE as idempotent by definition
   * and takes no idempotency key for one, so a retry after an unclear answer
   * is safe: the object is either deleted now or already gone.
   */
  async remove(path: string): Promise<"deleted" | "absent"> {
    const deadline = withDeadlineV1(20_000);
    let response: Response;
    try {
      response = await this.request(`https://api.stripe.com/v1/${path}`, {
        method: "DELETE",
        headers: {
          authorization: `Bearer ${this.config.secretKey}`,
          "Stripe-Version": "2025-02-24.acacia",
        },
        signal: deadline.signal,
      });
      await boundedText(response);
    } finally {
      deadline.clear();
    }
    if (response.status === 404) return "absent";
    if (!response.ok)
      throw new BillingError(
        "Stripe could not complete this request. Please try again.",
        response.status === 429 ? 429 : 502,
      );
    return "deleted";
  }
}

/**
 * Deletes every Stripe customer that belongs to one User, which ends any
 * subscription at once — Stripe cancels a deleted customer's subscriptions
 * immediately, with no proration. Stripe keeps its own record of payments
 * already made; that is Stripe's, not ours to erase.
 *
 * The customer the ledger recorded is deleted by id. Stripe is also searched
 * by the `frockbot_user_id` the customer was created with, because a creation
 * whose answer was lost leaves a customer the ledger never recorded. Search
 * lags writes by up to a minute, which the recorded id covers.
 */
export async function deleteAccountCustomersV1(
  stripe: StripeClient,
  userId: string,
  recorded: string | undefined,
): Promise<{ deleted: number }> {
  const ids = new Set<string>(recorded ? [stripeId(recorded)] : []);
  // The id is interpolated into Stripe's query language; one that would need
  // escaping is not an id this application issued.
  if (/^[A-Za-z0-9_-]{1,128}$/.test(userId)) {
    const query = encodeURIComponent(
      `metadata['frockbot_user_id']:'${userId}'`,
    );
    const found = await stripe.call(
      `customers/search?query=${query}&limit=100`,
    );
    if (!Array.isArray(found.data))
      throw new BillingError("Invalid payment response", 502);
    for (const customer of found.data) ids.add(stripeId(object(customer).id));
  }
  let deleted = 0;
  for (const id of ids) {
    if ((await stripe.remove(`customers/${id}`)) === "deleted") deleted += 1;
  }
  return { deleted };
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
  plan?: StripePlanIdV1;
  /** Whether the subscription starts with the account's one trial. */
  trial?: boolean;
  created: number;
  sessionId?: string;
  url?: string;
}

/** Stripe effects retain their intent before dispatch, including uncertain responses. */
export class AccountPayments {
  constructor(
    private readonly ledger: PaymentsLedgerPortV1,
    private readonly stripe: StripeClient,
    private readonly userId: string,
    private readonly now: () => number = Date.now,
  ) {}
  private async customer(): Promise<string> {
    const existing = this.ledger.record<string>("customer");
    if (existing) return existing;
    const started = this.ledger.record<number>("customerIntent") ?? this.now();
    this.ledger.remember("customerIntent", started);
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
    this.ledger.remember("customer", id);
    return id;
  }
  async checkout(command: {
    id: string;
    kind: "subscription" | "topup";
    cents?: number;
    plan?: StripePlanIdV1;
  }) {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(command.id))
      throw new BillingError("Invalid checkout request", 400);
    if (!["subscription", "topup"].includes(command.kind))
      throw new BillingError("Invalid purchase", 400);
    const plan =
      command.kind === "subscription"
        ? (command.plan ?? "standard")
        : undefined;
    if (plan !== undefined) {
      if (!isStripePlanV1(plan)) throw new BillingError("Invalid plan", 400);
      if (!planPriceIdV1(this.stripe.config, plan))
        throw new BillingError("That plan is not available yet", 409);
    }
    const cents =
      plan !== undefined ? stripePlanV1(plan).monthlyCents : command.cents;
    if (
      command.kind === "topup" &&
      !(STRIPE_PLAN_V1.topUpCents as readonly number[]).includes(cents ?? 0)
    )
      throw new BillingError("Choose a $10, $25 or $50 top-up", 400);
    const key = `checkout:${command.id}`;
    let intent = this.ledger.record<PaymentIntentRecord>(key);
    if (
      intent &&
      (intent.kind !== command.kind ||
        intent.cents !== cents ||
        (intent.plan ??
          (intent.kind === "subscription" ? "standard" : undefined)) !== plan)
    )
      throw new BillingError("Checkout key was reused", 409);
    if (intent?.url) return { url: intent.url };
    if (!intent) {
      if (command.kind === "subscription") {
        const subscription = this.ledger.account().subscription;
        if (
          subscription &&
          !["canceled", "incomplete_expired"].includes(subscription.status)
        )
          throw new BillingError(
            "Manage your existing subscription in the billing portal.",
            409,
          );
        const pending = this.ledger.record<PaymentIntentRecord>(
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
          const current = this.ledger.record<PaymentIntentRecord>(
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
        ...(plan === undefined
          ? {}
          : {
              plan,
              // One trial per account, and never after a subscription.
              trial:
                !this.ledger.account().trialUsed &&
                !this.ledger.account().subscription,
            }),
        created: this.now(),
      };
      // No await between claiming the single subscription slot and its intent.
      this.ledger.remember(key, intent);
      if (command.kind === "subscription")
        this.ledger.remember("pendingSubscription", intent);
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
      const price = planPriceIdV1(
        this.stripe.config,
        intent.plan ?? "standard",
      );
      if (!price) throw new BillingError("That plan is not available yet", 409);
      fields["line_items[0][price]"] = price;
      fields["subscription_data[metadata][frockbot_user_id]"] = this.userId;
      if (intent.trial)
        fields["subscription_data[trial_period_days]"] = String(
          STRIPE_PLAN_V1.trial.days,
        );
    } else {
      fields["line_items[0][price_data][currency]"] = "usd";
      fields["line_items[0][price_data][unit_amount]"] = String(intent.cents);
      fields["line_items[0][price_data][product_data][name]"] =
        `${this.stripe.config.productName} usage credit`;
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
    this.ledger.remember(key, saved);
    if (intent.kind === "subscription")
      this.ledger.remember("pendingSubscription", saved);
    return { url };
  }
  async portal(commandId: string) {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(commandId))
      throw new BillingError("Invalid portal request", 400);
    const customer = this.ledger.record<string>("customer");
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
  /**
   * Moves a subscription to a plan. An upgrade charges the new plan in full
   * now and restarts the billing month, so its allowance is granted at once;
   * a downgrade takes the lower price from the next renewal. During a trial,
   * either plan ends the trial now and charges its first month: how a person
   * whose trial credit ran out starts paying early. Nothing prorates, which
   * the ledger does not model.
   */
  async changePlan(command: { id: string; plan: StripePlanIdV1 }) {
    if (!/^[a-zA-Z0-9_-]{16,100}$/.test(command.id))
      throw new BillingError("Invalid plan change", 400);
    if (!isStripePlanV1(command.plan))
      throw new BillingError("Invalid plan", 400);
    const price = planPriceIdV1(this.stripe.config, command.plan);
    if (!price) throw new BillingError("That plan is not available yet", 409);
    const key = `planChange:${command.id}`;
    let intent = this.ledger.record<{
      id: string;
      plan: StripePlanIdV1;
      subscriptionId: string;
      itemId: string;
      mode: "upgrade" | "downgrade" | "endTrial";
      created: number;
    }>(key);
    if (intent && intent.plan !== command.plan)
      throw new BillingError("Plan change key was reused", 409);
    if (!intent) {
      const account = this.ledger.account();
      const recorded = account.subscription;
      const trialing =
        recorded?.status === "trialing" &&
        recorded.trialEnd !== null &&
        recorded.trialEnd > this.now();
      if (!recorded || (!trialing && !account.subscribed))
        throw new BillingError("Subscribe before changing plan", 409);
      if (!trialing && recorded.planId === command.plan)
        return { plan: command.plan };
      // The item a change replaces the price of is Stripe's to name.
      const current = await this.subscription(recorded.subscriptionId);
      intent = {
        id: command.id,
        plan: command.plan,
        subscriptionId: current.subscriptionId,
        itemId: current.itemId,
        mode: trialing
          ? "endTrial"
          : stripePlanV1(command.plan).monthlyCents >
              stripePlanV1(current.planId as StripePlanIdV1).monthlyCents
            ? "upgrade"
            : "downgrade",
        created: this.now(),
      };
      this.ledger.remember(key, intent);
    }
    // Stripe forgets an idempotency key after a day; past that, a retry could
    // charge twice.
    if (this.now() - intent.created > 23 * 3600_000)
      throw new BillingError(
        "Plan change needs reconciliation. Please contact support.",
        409,
      );
    await this.stripe.call(
      `subscriptions/${intent.subscriptionId}`,
      {
        "items[0][id]": intent.itemId,
        "items[0][price]": price,
        proration_behavior: "none",
        ...(intent.mode === "upgrade"
          ? {
              billing_cycle_anchor: "now",
              payment_behavior: "error_if_incomplete",
            }
          : intent.mode === "endTrial"
            ? { trial_end: "now", payment_behavior: "error_if_incomplete" }
            : {}),
      },
      `frockbot:plan:${this.userId}:${intent.id}`,
    );
    return { plan: command.plan };
  }
  /** A subscription as Stripe describes it, with the item a plan change replaces. */
  private async subscription(
    id: string,
  ): Promise<PaymentsSubscriptionV1 & { itemId: string }> {
    const subscription = await this.stripe.call(`subscriptions/${id}`);
    if (
      stripeId(subscription.customer) !== this.ledger.record<string>("customer")
    )
      throw new BillingError("Subscription belongs to another account", 409);
    const items = object(subscription.items).data;
    if (!Array.isArray(items) || items.length !== 1)
      throw new BillingError("Unexpected subscription items", 409);
    const item = object(items[0]);
    const price = object(item.price);
    const plan = planForPrice(this.stripe.config, stripeId(price.id));
    if (
      !plan ||
      price.currency !== "usd" ||
      price.unit_amount !== stripePlanV1(plan).monthlyCents ||
      item.quantity !== 1 ||
      object(price.recurring).interval !== "month"
    )
      throw new BillingError(
        "Subscription price does not match the configured plan",
        409,
      );
    const start = Number(subscription.current_period_start) * 1000;
    const end = Number(subscription.current_period_end) * 1000;
    const trialEnd =
      subscription.trial_end === null || subscription.trial_end === undefined
        ? null
        : Number(subscription.trial_end) * 1000;
    if (
      !Number.isSafeInteger(start) ||
      !Number.isSafeInteger(end) ||
      end <= start ||
      (trialEnd !== null && !Number.isSafeInteger(trialEnd)) ||
      typeof subscription.status !== "string"
    )
      throw new BillingError("Invalid subscription period", 502);
    return {
      customerId: stripeId(subscription.customer),
      subscriptionId: id,
      itemId: stripeId(item.id),
      planId: plan,
      status: subscription.status,
      periodStart: start,
      periodEnd: end,
      trialEnd,
      cancelAtPeriodEnd: subscription.cancel_at_period_end === true,
    };
  }
  async webhook(event: StripeObject) {
    const eventId = stripeId(event.id);
    const type = String(event.type);
    const data = object(object(event.data).object);
    const customer = this.ledger.record<string>("customer");
    if (!customer || stripeId(data.customer) !== customer)
      throw new BillingError("Payment customer does not match account", 409);
    if (this.ledger.applied(eventId, event)) return;
    // A later event may finish its Stripe read first. Retry instead of overwriting it.
    const revision = this.ledger.record<number>("stripeRevision") ?? 0;
    let subscription: PaymentsSubscriptionV1 | undefined;
    let purchase: { key: string; micros: number } | undefined;
    let trial: { subscriptionId: string; expires: number } | undefined;
    let paidPeriod:
      | {
          subscriptionId: string;
          planId: string;
          periodStart: number;
          periodEnd: number;
        }
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
      const reason = String(invoice.billing_reason);
      // An upgrade restarts the billing month and invoices the new plan in
      // full; any other plan change invoices nothing until renewal.
      if (
        [
          "subscription_create",
          "subscription_cycle",
          "subscription_update",
        ].includes(reason)
      ) {
        const lines = object(invoice.lines);
        if (lines.has_more === true || !Array.isArray(lines.data))
          throw new BillingError("Invoice needs reconciliation", 409);
        const matching = lines.data.map(object).flatMap((line) => {
          if (line.type !== "subscription" || line.proration) return [];
          const plan = planForPrice(
            this.stripe.config,
            stripeId(object(line.price).id),
          );
          return plan ? [{ line, plan }] : [];
        });
        if (
          (matching.length !== 1 && reason !== "subscription_update") ||
          matching.length > 1 ||
          (matching[0] && matching[0].line.quantity !== 1)
        )
          throw new BillingError("Invoice allowance is ambiguous", 409);
        const paid = matching[0];
        if (paid) {
          const period = object(paid.line.period);
          const start = Number(period.start) * 1000;
          const end = Number(period.end) * 1000;
          if (
            !Number.isSafeInteger(start) ||
            !Number.isSafeInteger(end) ||
            end <= start ||
            start > this.now()
          )
            throw new BillingError("Invalid invoice period", 409);
          // The line's own amount: tax, where charged, sits outside it.
          if (paid.line.amount === 0) {
            // A trial's opening invoice is marked paid for nothing. It grants
            // the trial credit, never the plan's allowance or a paid period.
            if (
              reason === "subscription_create" &&
              subscription.trialEnd !== null &&
              end <= subscription.trialEnd
            )
              trial = { subscriptionId, expires: subscription.trialEnd };
          } else if (paid.line.amount === stripePlanV1(paid.plan).monthlyCents)
            // The ledger grants the plan's allowance for the paid period.
            paidPeriod = {
              subscriptionId,
              planId: paid.plan,
              periodStart: start,
              periodEnd: end,
            };
          else
            throw new BillingError(
              "Invoice amount does not match the plan",
              409,
            );
        }
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
      const intent = this.ledger.record<PaymentIntentRecord>(
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
        purchase = { key: stripeId(session.id), micros: intent.cents * 10_000 };
      }
      if (intent.kind === "subscription" && session.subscription) {
        subscription = await this.subscription(stripeId(session.subscription));
        completedSubscriptionIntentId = intent.id;
      }
    }
    this.ledger.apply(eventId, event, (ledger) => {
      if ((ledger.record<number>("stripeRevision") ?? 0) !== revision)
        throw new BillingError("Payment state changed; retry event", 409);
      if (subscription) {
        ledger.recordSubscription(subscription);
        if (paidPeriod) ledger.recordPaidPeriod(paidPeriod);
      }
      if (purchase) ledger.grantPurchased(purchase);
      if (trial) ledger.grantTrial(trial);
      if (
        completedSubscriptionIntentId &&
        ledger.record<PaymentIntentRecord>("pendingSubscription")?.id ===
          completedSubscriptionIntentId
      )
        ledger.remember("pendingSubscription", null);
      if (type === "charge.refunded" || type === "charge.dispute.created")
        ledger.suspend();
      ledger.remember("stripeRevision", revision + 1);
    });
  }
}
