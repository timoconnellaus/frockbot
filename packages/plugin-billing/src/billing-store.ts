import {
  BASIC_ALLOWANCE_MICROS_V1,
  BILLING_HISTORY_MAX_ROWS_V1,
  type BillingViewV1,
  type StripeCommandKindV1,
  type StripeCommandPreparationV1,
  type StripeEventV1,
} from "./billing.js";
import type { UsageSqlV1 } from "./store.js";

interface BillingAccountRow extends Record<
  string,
  ArrayBuffer | string | number | null
> {
  stripe_customer_id: string | null;
  stripe_subscription_id: string | null;
  subscription_status: string;
  subscription_event_created: number;
  period_start: string | null;
  period_end: string | null;
  allowance_used_micros: number;
  credit_balance_micros: number;
}

interface CreditPaymentRow extends Record<
  string,
  ArrayBuffer | string | number | null
> {
  checkout_session_id: string;
  credited_micros: number;
  refunded_micros: number;
  applied_micros: number;
}

export interface BillingStoreOptionsV1 {
  sql: UsageSqlV1;
  transactionSync?<T>(closure: () => T): T;
  now?: () => number;
}

export class BillingStoreV1 {
  private readonly sql: UsageSqlV1;
  private readonly transactionSync: <T>(closure: () => T) => T;
  private readonly now: () => number;
  private opened = false;

  constructor(options: BillingStoreOptionsV1) {
    this.sql = options.sql;
    this.transactionSync = options.transactionSync ?? ((closure) => closure());
    this.now = options.now ?? (() => Date.now());
  }

  open(): void {
    if (this.opened) return;
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS billing_account (" +
        "id INTEGER PRIMARY KEY CHECK (id = 1), stripe_customer_id TEXT, " +
        "stripe_subscription_id TEXT, subscription_status TEXT NOT NULL, " +
        "subscription_event_created INTEGER NOT NULL, " +
        "period_start TEXT, period_end TEXT, allowance_used_micros INTEGER NOT NULL, " +
        "credit_balance_micros INTEGER NOT NULL)",
    );
    this.sql.exec(
      "INSERT OR IGNORE INTO billing_account (id, subscription_status, subscription_event_created, allowance_used_micros, credit_balance_micros) " +
        "VALUES (1, 'none', 0, 0, 0)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS billing_history (" +
        "event_id TEXT PRIMARY KEY, type TEXT NOT NULL, occurred_at TEXT NOT NULL, " +
        "amount_micros INTEGER NOT NULL, description TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS billing_stripe_events (" +
        "event_id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS billing_credit_payments (" +
        "payment_intent_id TEXT PRIMARY KEY, checkout_session_id TEXT NOT NULL, " +
        "credited_micros INTEGER NOT NULL, refunded_micros INTEGER NOT NULL, " +
        "applied_micros INTEGER NOT NULL)",
    );
    this.sql.exec(
      "CREATE TABLE IF NOT EXISTS billing_commands (" +
        "command_id TEXT PRIMARY KEY, kind TEXT NOT NULL, fingerprint TEXT NOT NULL, " +
        "status TEXT NOT NULL, result_url TEXT, created_at TEXT NOT NULL)",
    );
    this.opened = true;
  }

  applyStripeEvent(event: StripeEventV1): { applied: boolean } {
    this.open();
    return this.transactionSync(() => {
      const alreadyApplied = Number(
        this.sql
          .exec<{ n: number }>(
            "SELECT count(*) AS n FROM billing_stripe_events WHERE event_id = ?",
            event.id,
          )
          .toArray()[0]?.n ?? 0,
      );
      if (alreadyApplied > 0) return { applied: false };

      let amountMicros = 0;
      let description = event.type;
      if (event.type === "checkout.session.completed") {
        const object = event.data.object;
        const mode = String(object.mode ?? "");
        const paymentStatus = String(object.payment_status ?? "");
        const metadata = this.metadata(object.metadata);
        if (
          mode === "payment" &&
          paymentStatus === "paid" &&
          metadata.frockbot_kind === "credit"
        ) {
          const cents = this.nonNegativeInteger(
            object.amount_total,
            "amount_total",
          );
          const paymentIntentId = this.identifier(
            object.payment_intent,
            "payment_intent",
          );
          const sessionId = this.identifier(object.id, "checkout session id");
          const creditedMicros = cents * 10_000;
          amountMicros = this.reconcileCreditPayment({
            paymentIntentId,
            checkoutSessionId: sessionId,
            creditedMicros,
          });
          this.sql.exec(
            "UPDATE billing_account SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = 1",
            this.optionalIdentifier(object.customer),
          );
          description = `${this.formatDollars(cents)} credit purchase`;
        } else {
          if (mode === "subscription") {
            this.sql.exec(
              "UPDATE billing_account SET stripe_customer_id = COALESCE(stripe_customer_id, ?), " +
                "stripe_subscription_id = COALESCE(?, stripe_subscription_id) WHERE id = 1",
              this.optionalIdentifier(object.customer),
              this.optionalIdentifier(object.subscription),
            );
          }
          description = "Checkout completed";
        }
      } else if (event.type === "customer.subscription.updated") {
        const object = event.data.object;
        const account = this.account();
        if (event.created >= Number(account.subscription_event_created)) {
          this.sql.exec(
            "UPDATE billing_account SET stripe_customer_id = COALESCE(stripe_customer_id, ?), " +
              "stripe_subscription_id = ?, subscription_status = ?, subscription_event_created = ? WHERE id = 1",
            this.optionalIdentifier(object.customer),
            this.identifier(object.id, "subscription id"),
            this.identifier(object.status, "subscription status"),
            event.created,
          );
        }
        description = `Basic subscription ${String(object.status ?? "updated")}`;
      } else if (event.type === "customer.subscription.deleted") {
        const object = event.data.object;
        const account = this.account();
        if (event.created >= Number(account.subscription_event_created)) {
          this.sql.exec(
            "UPDATE billing_account SET stripe_customer_id = COALESCE(stripe_customer_id, ?), " +
              "stripe_subscription_id = ?, subscription_status = 'canceled', " +
              "subscription_event_created = ? WHERE id = 1",
            this.optionalIdentifier(object.customer),
            this.identifier(object.id, "subscription id"),
            event.created,
          );
        }
        description = "Basic subscription canceled";
      } else if (event.type === "invoice.paid") {
        const object = event.data.object;
        const period = this.invoicePeriod(object);
        const account = this.account();
        const subscriptionId = this.invoiceSubscriptionId(object);
        if (!subscriptionId)
          throw new Error("Stripe invoice has no subscription");
        const previousPeriod = String(account.period_start ?? "");
        const newerPeriod = period.start > previousPeriod;
        const currentPeriod = period.start === previousPeriod;
        const newerStatus =
          event.created >= Number(account.subscription_event_created);
        this.sql.exec(
          "UPDATE billing_account SET stripe_customer_id = COALESCE(stripe_customer_id, ?), " +
            "stripe_subscription_id = ?, subscription_status = ?, subscription_event_created = ?, " +
            "period_start = ?, period_end = ?, allowance_used_micros = ? WHERE id = 1",
          this.optionalIdentifier(object.customer),
          subscriptionId,
          newerStatus ? "active" : String(account.subscription_status),
          newerStatus
            ? event.created
            : Number(account.subscription_event_created),
          newerPeriod ? period.start : account.period_start,
          newerPeriod || currentPeriod ? period.end : account.period_end,
          newerPeriod ? 0 : Number(account.allowance_used_micros),
        );
        description = "Basic monthly allowance renewed";
      } else if (event.type === "charge.refunded") {
        const object = event.data.object;
        const metadata = this.metadata(object.metadata);
        if (metadata.frockbot_kind === "credit") {
          const paymentIntentId = this.identifier(
            object.payment_intent,
            "payment_intent",
          );
          const refundedCents = this.nonNegativeInteger(
            object.amount_refunded,
            "amount_refunded",
          );
          amountMicros = this.reconcileCreditPayment({
            paymentIntentId,
            refundedMicros: refundedCents * 10_000,
          });
          description = `${this.formatDollars(refundedCents)} credit refund`;
        } else {
          description = "Charge refunded";
        }
      }

      const appliedAt = new Date(event.created * 1_000).toISOString();
      this.sql.exec(
        "INSERT INTO billing_stripe_events (event_id, applied_at) VALUES (?, ?)",
        this.identifier(event.id, "event id"),
        appliedAt,
      );
      this.sql.exec(
        "INSERT INTO billing_history (event_id, type, occurred_at, amount_micros, description) " +
          "VALUES (?, ?, ?, ?, ?)",
        this.identifier(event.id, "event id"),
        this.identifier(event.type, "event type"),
        appliedAt,
        amountMicros,
        description,
      );
      this.sql.exec(
        "DELETE FROM billing_history WHERE event_id IN (" +
          "SELECT event_id FROM billing_history ORDER BY occurred_at DESC, event_id DESC LIMIT -1 OFFSET ?)",
        BILLING_HISTORY_MAX_ROWS_V1,
      );
      return { applied: true };
    });
  }

  read(): BillingViewV1 {
    this.open();
    const account = this.account();
    const subscriptionStatus = String(account.subscription_status);
    const subscribed = !["none", "canceled", "incomplete_expired"].includes(
      subscriptionStatus,
    );
    const active = this.hasCurrentAllowance(account);
    const allowanceMicros = active ? BASIC_ALLOWANCE_MICROS_V1 : 0;
    const allowanceUsedMicros = active
      ? Number(account.allowance_used_micros)
      : 0;
    const allowanceRemainingMicros = Math.max(
      0,
      allowanceMicros - allowanceUsedMicros,
    );
    const creditBalanceMicros = Number(account.credit_balance_micros);
    const availableMicros = allowanceRemainingMicros + creditBalanceMicros;
    const history = this.sql
      .exec<{
        event_id: string;
        type: string;
        occurred_at: string;
        amount_micros: number;
        description: string;
      }>(
        "SELECT event_id, type, occurred_at, amount_micros, description " +
          "FROM billing_history ORDER BY occurred_at DESC, event_id DESC LIMIT ?",
        BILLING_HISTORY_MAX_ROWS_V1,
      )
      .toArray()
      .map((entry) => ({
        eventId: String(entry.event_id),
        type: String(entry.type),
        occurredAt: String(entry.occurred_at),
        amountMicros: Number(entry.amount_micros),
        description: String(entry.description),
      }));
    return {
      schemaVersion: 1,
      plan: subscribed ? "basic" : "none",
      subscriptionStatus,
      ...(account.period_start
        ? { currentPeriodStart: String(account.period_start) }
        : {}),
      ...(account.period_end
        ? { currentPeriodEnd: String(account.period_end) }
        : {}),
      allowanceMicros,
      allowanceUsedMicros,
      allowanceRemainingMicros,
      creditBalanceMicros,
      availableMicros,
      canStartTurn: availableMicros > 0,
      history,
    };
  }

  prepareStripeCommand(input: {
    commandId: string;
    kind: StripeCommandKindV1;
    fingerprint: string;
  }): StripeCommandPreparationV1 {
    this.open();
    return this.transactionSync(() => {
      const existing = this.sql
        .exec<{
          kind: string;
          fingerprint: string;
          status: string;
          result_url: string | null;
        }>(
          "SELECT kind, fingerprint, status, result_url FROM billing_commands WHERE command_id = ?",
          input.commandId,
        )
        .toArray()[0];
      if (existing) {
        if (
          existing.kind !== input.kind ||
          existing.fingerprint !== input.fingerprint
        ) {
          throw new Error("Billing command id was already used.");
        }
        return {
          status: existing.status === "complete" ? "complete" : "pending",
          ...(existing.result_url
            ? { resultUrl: String(existing.result_url) }
            : {}),
          ...this.customerProjection(),
        };
      }
      this.sql.exec(
        "INSERT INTO billing_commands (command_id, kind, fingerprint, status, result_url, created_at) " +
          "VALUES (?, ?, ?, 'pending', NULL, ?)",
        input.commandId,
        input.kind,
        input.fingerprint,
        new Date(this.now()).toISOString(),
      );
      return { status: "pending", ...this.customerProjection() };
    });
  }

  recordStripeCustomer(customerId: string): void {
    this.open();
    this.sql.exec(
      "UPDATE billing_account SET stripe_customer_id = COALESCE(stripe_customer_id, ?) WHERE id = 1",
      this.identifier(customerId, "Customer id"),
    );
  }

  completeStripeCommand(commandId: string, resultUrl: string): void {
    this.open();
    this.sql.exec(
      "UPDATE billing_commands SET status = 'complete', result_url = ? WHERE command_id = ?",
      this.identifier(resultUrl, "result URL", 2_048),
      this.identifier(commandId, "command id"),
    );
  }

  private customerProjection(): { customerId?: string } {
    const customerId = this.account().stripe_customer_id;
    return customerId ? { customerId: String(customerId) } : {};
  }

  private account(): BillingAccountRow {
    return this.sql
      .exec<BillingAccountRow>(
        "SELECT stripe_customer_id, stripe_subscription_id, subscription_status, " +
          "subscription_event_created, period_start, period_end, allowance_used_micros, credit_balance_micros " +
          "FROM billing_account WHERE id = 1",
      )
      .toArray()[0]!;
  }

  private hasCurrentAllowance(account: BillingAccountRow): boolean {
    if (!["active", "trialing"].includes(String(account.subscription_status))) {
      return false;
    }
    const now = this.now();
    const start = account.period_start
      ? Date.parse(String(account.period_start))
      : NaN;
    const end = account.period_end
      ? Date.parse(String(account.period_end))
      : NaN;
    return (
      Number.isFinite(start) &&
      Number.isFinite(end) &&
      start <= now &&
      now < end
    );
  }

  debit(costMicros: number): void {
    this.open();
    if (!Number.isSafeInteger(costMicros) || costMicros < 0) {
      throw new Error("billing debit is invalid");
    }
    if (costMicros === 0) return;
    const account = this.account();
    const remainingAllowance = this.hasCurrentAllowance(account)
      ? Math.max(
          0,
          BASIC_ALLOWANCE_MICROS_V1 - Number(account.allowance_used_micros),
        )
      : 0;
    const fromAllowance = Math.min(costMicros, remainingAllowance);
    this.sql.exec(
      "UPDATE billing_account SET allowance_used_micros = allowance_used_micros + ?, " +
        "credit_balance_micros = credit_balance_micros - ? WHERE id = 1",
      fromAllowance,
      costMicros - fromAllowance,
    );
  }

  private reconcileCreditPayment(input: {
    paymentIntentId: string;
    checkoutSessionId?: string;
    creditedMicros?: number;
    refundedMicros?: number;
  }): number {
    const existing = this.sql
      .exec<CreditPaymentRow>(
        "SELECT checkout_session_id, credited_micros, refunded_micros, applied_micros " +
          "FROM billing_credit_payments WHERE payment_intent_id = ?",
        input.paymentIntentId,
      )
      .toArray()[0];
    const checkoutSessionId =
      input.checkoutSessionId ??
      (existing
        ? String(existing.checkout_session_id)
        : `pending:${input.paymentIntentId}`);
    const creditedMicros =
      input.creditedMicros ?? Number(existing?.credited_micros ?? 0);
    const refundedMicros = Math.max(
      input.refundedMicros ?? 0,
      Number(existing?.refunded_micros ?? 0),
    );
    const previouslyApplied = Number(existing?.applied_micros ?? 0);
    const appliedMicros = creditedMicros - refundedMicros;
    const adjustment = appliedMicros - previouslyApplied;
    this.sql.exec(
      "INSERT INTO billing_credit_payments " +
        "(payment_intent_id, checkout_session_id, credited_micros, refunded_micros, applied_micros) " +
        "VALUES (?, ?, ?, ?, ?) ON CONFLICT(payment_intent_id) DO UPDATE SET " +
        "checkout_session_id = excluded.checkout_session_id, credited_micros = excluded.credited_micros, " +
        "refunded_micros = excluded.refunded_micros, applied_micros = excluded.applied_micros",
      input.paymentIntentId,
      checkoutSessionId,
      creditedMicros,
      refundedMicros,
      appliedMicros,
    );
    if (adjustment !== 0) {
      this.sql.exec(
        "UPDATE billing_account SET credit_balance_micros = credit_balance_micros + ? WHERE id = 1",
        adjustment,
      );
    }
    return adjustment;
  }

  private invoicePeriod(object: Record<string, unknown>): {
    start: string;
    end: string;
  } {
    const lines = object.lines;
    if (lines && typeof lines === "object" && !Array.isArray(lines)) {
      const data = (lines as { data?: unknown }).data;
      const first = Array.isArray(data) ? data[0] : undefined;
      if (first && typeof first === "object" && !Array.isArray(first)) {
        const period = (first as { period?: unknown }).period;
        if (period && typeof period === "object" && !Array.isArray(period)) {
          const row = period as Record<string, unknown>;
          return {
            start: this.epochTimestamp(row.start, "invoice period start"),
            end: this.epochTimestamp(row.end, "invoice period end"),
          };
        }
      }
    }
    return {
      start: this.epochTimestamp(object.period_start, "invoice period start"),
      end: this.epochTimestamp(object.period_end, "invoice period end"),
    };
  }

  private invoiceSubscriptionId(
    object: Record<string, unknown>,
  ): string | null {
    const direct = this.optionalIdentifier(object.subscription);
    if (direct) return direct;
    const parent = object.parent;
    if (!parent || typeof parent !== "object" || Array.isArray(parent))
      return null;
    const details = (parent as { subscription_details?: unknown })
      .subscription_details;
    if (!details || typeof details !== "object" || Array.isArray(details)) {
      return null;
    }
    return this.optionalIdentifier(
      (details as Record<string, unknown>).subscription,
    );
  }

  private epochTimestamp(value: unknown, label: string): string {
    if (!Number.isSafeInteger(value) || (value as number) <= 0) {
      throw new Error(`Stripe ${label} is invalid`);
    }
    return new Date((value as number) * 1_000).toISOString();
  }

  private metadata(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter(
        (entry): entry is [string, string] => typeof entry[1] === "string",
      ),
    );
  }

  private identifier(value: unknown, label: string, maximum = 512): string {
    if (
      typeof value !== "string" ||
      value.length === 0 ||
      value.length > maximum
    ) {
      throw new Error(`Stripe ${label} is invalid`);
    }
    return value;
  }

  private optionalIdentifier(value: unknown): string | null {
    return typeof value === "string" && value.length > 0 && value.length <= 512
      ? value
      : null;
  }

  private nonNegativeInteger(value: unknown, label: string): number {
    if (!Number.isSafeInteger(value) || (value as number) < 0) {
      throw new Error(`Stripe ${label} is invalid`);
    }
    return value as number;
  }

  private formatDollars(cents: number): string {
    return cents % 100 === 0
      ? `$${String(cents / 100)}`
      : `$${(cents / 100).toFixed(2)}`;
  }
}
