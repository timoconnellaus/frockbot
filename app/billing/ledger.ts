import {
  createSpendingTablesV1,
  recordAttributionV1,
  rollUpSettlementV1,
  spendLimitReachedV1,
  spentSinceV1,
} from "./spending.js";
import { BillingError, stable } from "./errors.js";
import type {
  PaymentsAccountV1,
  PaymentsLedgerEffectsV1,
  PaymentsLedgerPortV1,
  PaymentsPaidPeriodV1,
  PaymentsPlanV1,
  PaymentsSubscriptionV1,
} from "@frockbot/core/contracts";

/**
 * The version of FrockBot's usage tariff a charge was priced under, where no
 * more specific table priced it. The plan a deployment sells is its payments
 * Package's; what usage costs is not.
 */
export { BillingError, stable };

export const USAGE_PRICING_VERSION_V1 = "2026-09-09";

/**
 * The `billing_state` keys the ledger owns. A payments Package keeps its own
 * records beside them and may name none of these.
 */
const LEDGER_STATE_KEYS_V1 = new Set([
  "subscription",
  "paidAccess",
  "suspended",
  "trialUsed",
]);
function providerRecordKey(key: string): string {
  if (
    typeof key !== "string" ||
    !/^[a-zA-Z0-9:_./-]{1,200}$/.test(key) ||
    LEDGER_STATE_KEYS_V1.has(key) ||
    key.startsWith("spike:")
  )
    throw new BillingError("Invalid payment record", 400);
  return key;
}
/**
 * A provider's own ids for its events and payments. No colon, so none can be
 * one of the ledger's own `<kind>:<id>` receipts or grants.
 */
function providerKey(value: string, label: string): string {
  if (typeof value !== "string" || !/^[a-zA-Z0-9_.-]{1,160}$/.test(value))
    throw new BillingError(`Invalid ${label}`, 400);
  return value;
}

/**
 * The two refusals a person is told in the conversation, so they are written
 * for the person. `run-failure-copy` carries them through verbatim.
 */
export function subscriptionRequiredReasonV1(productName: string): string {
  return `A paid ${productName} subscription is required. Open Billing to subscribe or update your payment method.`;
}

/**
 * That sentence, whichever product wrote it: the product name is the one part
 * that varies, and it is a short plain name.
 */
export const SUBSCRIPTION_REQUIRED_REASON_PATTERN_V1 =
  /A paid [^.\n<>]{1,80} subscription is required\. Open Billing to subscribe or update your payment method\./;
/**
 * Connected apps run on the deployment's own provider account, which any plan
 * covers and no plan at all does not.
 */
export function connectedAppsPlanRequiredReasonV1(productName: string): string {
  return `Connected apps need a ${productName} plan. Open Billing to choose one.`;
}
export const CREDIT_EXHAUSTED_REASON_V1 =
  "You have no usage credit left. Open Billing to add more.";
/**
 * A plan's Jev fair use spent, with no credit behind it. Every Turn needs Jev
 * and Jev has no permissive failure mode, so the Turn stops and says why.
 */
export const JEV_FAIR_USE_EXHAUSTED_REASON_V1 =
  "This month's Jev fair use is used up and you have no usage credit left, so your Bots can't reply. Open Billing to add credit.";
/**
 * A Bot's or a Routine's own daily limit. Its subject is whoever is reading
 * it: the message about a Routine already names the Routine.
 */
export const DAILY_LIMIT_REASON_V1 =
  "It reached its daily spending limit and is paused until midnight. You can raise the limit under Spending in Billing.";

/**
 * `jev` is a plan's monthly Jev fair use: spendable by Jev alone, and by Jev
 * before anything else.
 */
export type GrantKind = "included" | "purchased" | "complimentary" | "jev";

/** Credit an administrator gave an account by hand. Spendable without a subscription. */
export interface ComplimentaryGrant {
  /** The admin's idempotency key; the grant is `complimentary:<id>`. */
  id: string;
  micros: number;
  grantedBy: string;
  reason: string;
}

export interface BillingBalance {
  includedMicros: number;
  purchasedMicros: number;
  complimentaryMicros: number;
  reservedMicros: number;
  /** A paid subscription period is current: top-ups can be bought and spent. */
  subscribed: boolean;
  /** A model call would be admitted: subscribed, or complimentary credit remains. */
  canSpend: boolean;
  suspended: boolean;
}

type SqlRow = Record<string, string | number | null | ArrayBuffer>;
export interface BillingSql {
  exec<T extends SqlRow>(
    query: string,
    ...bindings: (string | number | null)[]
  ): { toArray(): T[] };
}
export interface BillingStorage {
  sql: BillingSql;
  transactionSync<T>(callback: () => T): T;
}
export interface UsageReservation {
  id: string;
  kind: "model" | "computer" | "search" | "jev";
  maximumMicros: number;
  botId?: string;
  sessionId?: string;
  description: string;
  pricingVersion: string;
  unitRates?: Record<string, number>;
  /**
   * Jev the product asks for itself — Turn supervision — rather than Jev the
   * account asked for. A plan without a Jev fair-use allowance covers it in
   * full: the reservation answers `covered` and nothing is recorded.
   */
  platform?: true;
  /**
   * Work that costs nothing whatever the account holds: a local model on the
   * person's own Mac. It is recorded, so it shows on Spending at no charge,
   * and it is never refused for want of credit, a plan or a daily limit.
   * Only a zero reservation may be free.
   */
  free?: true;
  /**
   * Why the money was spent, for the Spending page. Descriptive only: it is
   * not part of the charge's identity, so a retry that resolves it
   * differently — a Routine renamed in between — is still the same charge.
   */
  attribution?: UsageAttributionV1;
}

/**
 * What started the work a charge paid for. The four a Turn can have (see
 * `StoredRunCauseV1`), plus two that are not a Turn: a person using the
 * Computer directly, and a Plugin calling a model from its own page.
 */
export type SpendCauseKindV1 =
  "chat" | "routine" | "group" | "voice" | "email" | "desktop" | "plugin";
export const SPEND_CAUSE_KINDS_V1: readonly SpendCauseKindV1[] = [
  "chat",
  "routine",
  "group",
  "voice",
  "email",
  "desktop",
  "plugin",
];
export interface SpendCauseV1 {
  kind: SpendCauseKindV1;
  /** The Bot whose conversation, Routine or Computer it was. */
  botId: string;
  /** A Routine's, a Group Chat's or a Plugin's id. */
  id?: string;
  label?: string;
  /** How a Routine was fired. */
  trigger?: string;
}
/** What a charge bought, as a person reads it. */
export type SpendCategoryV1 =
  "model" | "summary" | "search" | "computer" | "jev";
export interface UsageAttributionV1 {
  /** The Turn the charge was made in. */
  runId?: string;
  cause?: SpendCauseV1;
  /** A model call that summarised the conversation rather than answering. */
  summary?: boolean;
  /** The Plugin that made the call, when it was not the Bot's own loop. */
  pluginId?: string;
  /** The model the call asked for. */
  model?: string;
}
/**
 * How a hosted model call was priced. `served`: at the rate of the model that
 * answered. `capped`: that model is priced above its route, so the route's
 * ceiling was charged. `unpriced`: that model has no rate, or the Gateway did
 * not name it, so the ceiling was charged — a table to fix. `cached`: the
 * Gateway answered from its cache and no provider ran.
 */
export type UsagePricingV1 = "served" | "capped" | "unpriced" | "cached";
export const USAGE_PRICINGS_V1: readonly UsagePricingV1[] = [
  "served",
  "capped",
  "unpriced",
  "cached",
];

export interface UsageSettlement {
  id: string;
  costMicros: number;
  chargeMicros: number;
  quantities: Record<string, number>;
  pricing?: UsagePricingV1;
  /** `<provider>/<model>` as the Gateway named the model that answered. */
  servedModel?: string;
  /** The customer's per-token rates this settlement charged at. */
  unitRates?: Record<string, number>;
}
interface Grant extends SqlRow {
  id: string;
  kind: string;
  remaining: number;
  expires: number | null;
}
interface Operation extends SqlRow {
  id: string;
  fingerprint: string;
  status: string;
  maximum: number;
  allocations: string;
  settlement: string | null;
}
export type SubscriptionState = PaymentsSubscriptionV1;
export type PaidAccessState = PaymentsPaidPeriodV1;

function amount(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > 1_000_000_000_000)
    throw new BillingError(`Invalid ${label}`, 400);
  return value;
}
function timestamp(value: number, label: string) {
  if (!Number.isSafeInteger(value) || value < 0)
    throw new BillingError(`Invalid ${label}`, 400);
  return value;
}
function identifier(value: string) {
  if (typeof value !== "string" || !/^[a-zA-Z0-9:_./-]{1,200}$/.test(value))
    throw new BillingError("Invalid billing identifier", 400);
  return value;
}

/** Account-owned tables. Every balance mutation and its receipt commit together. */
export class BillingLedger {
  constructor(
    private readonly storage: BillingStorage,
    /** The product a subscription is to, as a refusal names it. */
    private readonly productName: string,
    /** What the deployment's payments Package sells. */
    private readonly plan: PaymentsPlanV1,
    private readonly now: () => number = Date.now,
  ) {
    const sql = storage.sql;
    sql.exec(
      `CREATE TABLE IF NOT EXISTS billing_state (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS billing_grants (id TEXT PRIMARY KEY, kind TEXT NOT NULL, original INTEGER NOT NULL, remaining INTEGER NOT NULL, expires INTEGER, created INTEGER NOT NULL, fingerprint TEXT NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS billing_operations (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, status TEXT NOT NULL, maximum INTEGER NOT NULL, allocations TEXT NOT NULL, settlement TEXT, kind TEXT NOT NULL, bot_id TEXT, session_id TEXT, description TEXT NOT NULL, pricing_version TEXT NOT NULL, created INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE TABLE IF NOT EXISTS billing_receipts (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, created INTEGER NOT NULL)`,
    );
    sql.exec(
      `CREATE INDEX IF NOT EXISTS billing_operations_created ON billing_operations(created)`,
    );
    createSpendingTablesV1(sql);
  }
  private rows<T extends SqlRow>(
    query: string,
    ...bindings: (string | number | null)[]
  ) {
    return this.storage.sql.exec<T>(query, ...bindings).toArray();
  }
  get<T>(key: string): T | undefined {
    const row = this.rows<{ value: string }>(
      "SELECT value FROM billing_state WHERE key = ?",
      key,
    )[0];
    return row ? (JSON.parse(row.value) as T) : undefined;
  }
  set(key: string, value: unknown) {
    this.storage.sql.exec(
      "INSERT INTO billing_state(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
      key,
      JSON.stringify(value),
    );
  }
  receipt(id: string, fingerprint: string): boolean {
    identifier(id);
    const row = this.rows<{ fingerprint: string }>(
      "SELECT fingerprint FROM billing_receipts WHERE id = ?",
      id,
    )[0];
    if (row && row.fingerprint !== fingerprint)
      throw new BillingError("Billing key reused with different data", 409);
    return !!row;
  }
  once<T>(id: string, input: unknown, callback: () => T): T | undefined {
    return this.storage.transactionSync(() => {
      const fingerprint = stable(input);
      if (this.receipt(id, fingerprint)) return undefined;
      const result = callback();
      this.storage.sql.exec(
        "INSERT INTO billing_receipts VALUES (?, ?, ?)",
        id,
        fingerprint,
        this.now(),
      );
      return result;
    });
  }
  grant(id: string, kind: GrantKind, micros: number, expires: number | null) {
    identifier(id);
    amount(micros, "credit");
    if (expires !== null) timestamp(expires, "expiry");
    this.storage.transactionSync(() => {
      const fingerprint = stable({ kind, micros, expires });
      const old = this.rows<{ fingerprint: string }>(
        "SELECT fingerprint FROM billing_grants WHERE id = ?",
        id,
      )[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new BillingError(
            "Credit grant conflicts with existing payment",
            409,
          );
        return;
      }
      this.storage.sql.exec(
        "INSERT INTO billing_grants VALUES (?, ?, ?, ?, ?, ?, ?)",
        id,
        kind,
        micros,
        micros,
        expires,
        this.now(),
        fingerprint,
      );
    });
  }
  /**
   * Admin-granted credit. Idempotent by the admin's id: the same command
   * again is a no-op, a different amount or reason under the same id is a
   * conflict, so a double-tapped button never grants twice.
   */
  grantComplimentary(command: ComplimentaryGrant) {
    identifier(command.id);
    amount(command.micros, "credit");
    if (command.micros === 0) throw new BillingError("Invalid credit", 400);
    if (
      !command.grantedBy ||
      command.grantedBy.length > 512 ||
      !command.reason ||
      command.reason.length > 300
    )
      throw new BillingError("Invalid credit grant", 400);
    this.once(`complimentary:${command.id}`, command, () =>
      this.grant(
        `complimentary:${command.id}`,
        "complimentary",
        command.micros,
        null,
      ),
    );
  }
  subscription(): SubscriptionState | undefined {
    return this.get<SubscriptionState>("subscription");
  }
  /** Whether a paid subscription period is current and the account is not suspended. */
  subscribed(): boolean {
    const subscription = this.subscription();
    const paid = this.get<PaidAccessState>("paidAccess");
    return !!(
      subscription &&
      subscription.status === "active" &&
      paid &&
      paid.subscriptionId === subscription.subscriptionId &&
      paid.periodStart <= this.now() &&
      paid.periodEnd > this.now() &&
      !this.get<boolean>("suspended")
    );
  }
  requireSubscription() {
    if (this.subscribed()) return;
    // A deployment that sells no subscription asks only for spendable credit.
    if (this.plan.subscriptions.length === 0) {
      const balance = this.balance();
      if (balance.suspended)
        throw new BillingError(subscriptionRequiredReasonV1(this.productName));
      if (balance.canSpend) return;
      throw new BillingError(CREDIT_EXHAUSTED_REASON_V1);
    }
    throw new BillingError(subscriptionRequiredReasonV1(this.productName));
  }
  /**
   * Refuses an account on no plan, or suspended, in the words the person
   * reads. A trial is a plan; so is the smallest one. A deployment that sells
   * no subscription asks for none.
   */
  requirePlan() {
    if (this.plan.subscriptions.length === 0) return;
    if (this.subscribed()) return;
    if (this.trial() && !this.get<boolean>("suspended")) return;
    throw new BillingError(connectedAppsPlanRequiredReasonV1(this.productName));
  }
  /**
   * The grants a reservation may draw on, cheapest to spend first: monthly
   * credit expires soonest, complimentary credit was a gift, purchased credit
   * carries forward. Without a subscription only complimentary credit counts,
   * and purchased credit too where the plan does not tie it to one.
   */
  private spendable(subscribed: boolean, jev: boolean): Grant[] {
    return this.rows<Grant>(
      `SELECT id, kind, remaining, expires FROM billing_grants WHERE remaining > 0 AND (expires IS NULL OR expires > ?)${
        jev ? "" : " AND kind != 'jev'"
      }${
        subscribed
          ? ""
          : this.plan.purchasedCreditNeedsSubscription
            ? " AND kind = 'complimentary'"
            : " AND kind IN ('complimentary', 'purchased')"
      } ORDER BY CASE kind WHEN 'jev' THEN 0 WHEN 'included' THEN 1 WHEN 'complimentary' THEN 2 ELSE 3 END, expires, created, id`,
      this.now(),
    );
  }
  /**
   * The plan whose Jev fair use governs this account: its subscription's,
   * lapsed or not, so a lapsed plan that metered Jev still meters it.
   */
  private jevFairUsePlan() {
    const planId = this.subscription()?.planId;
    const plan = this.plan.subscriptions.find((each) => each.id === planId);
    return plan?.jevFairUseMicros === undefined ? undefined : plan;
  }
  /**
   * Hold a charge's maximum against the account's credit. `dayStart` is the
   * person's last midnight: given it, a charge for background work a daily
   * limit has already stopped is refused. A charge already reserved is never
   * refused again: its retry is the same charge.
   */
  reserve(
    input: UsageReservation,
    dayStart?: number,
  ): {
    status: "reserved" | "settled" | "released" | "covered";
    created: boolean;
  } {
    identifier(input.id);
    amount(input.maximumMicros, "reservation");
    if (
      !["model", "computer", "search", "jev"].includes(input.kind) ||
      (input.platform !== undefined &&
        (input.platform !== true || input.kind !== "jev")) ||
      !input.description ||
      input.description.length > 300 ||
      !input.pricingVersion
    )
      throw new BillingError("Invalid usage reservation", 400);
    const { attribution, ...charge } = input;
    return this.storage.transactionSync(() => {
      if (input.platform && !this.jevFairUsePlan())
        return { status: "covered" as const, created: false };
      const fingerprint = stable(charge);
      const old = this.rows<Operation>(
        "SELECT * FROM billing_operations WHERE id = ?",
        input.id,
      )[0];
      if (old) {
        if (old.fingerprint !== fingerprint)
          throw new BillingError("Usage key reused with different data", 409);
        return {
          status: old.status as "reserved" | "settled" | "released",
          created: false,
        };
      }
      if (input.free && input.maximumMicros !== 0)
        throw new BillingError("Invalid usage reservation", 400);
      const free = input.free === true;
      if (
        !free &&
        dayStart !== undefined &&
        spendLimitReachedV1(this.storage.sql, input, attribution, dayStart)
      )
        throw new BillingError(DAILY_LIMIT_REASON_V1);
      const subscribed = this.subscribed();
      if (!free && this.get<boolean>("suspended"))
        throw new BillingError(subscriptionRequiredReasonV1(this.productName));
      const grants = free ? [] : this.spendable(subscribed, input.kind === "jev");
      const available = grants.reduce((total, g) => total + g.remaining, 0);
      if (
        !free &&
        !subscribed &&
        available === 0 &&
        this.plan.subscriptions.length > 0
      )
        throw new BillingError(subscriptionRequiredReasonV1(this.productName));
      let needed = input.maximumMicros;
      if (available < needed)
        throw new BillingError(
          input.kind === "jev" && subscribed && this.jevFairUsePlan()
            ? JEV_FAIR_USE_EXHAUSTED_REASON_V1
            : CREDIT_EXHAUSTED_REASON_V1,
        );
      const allocations: { id: string; micros: number }[] = [];
      for (const grant of grants) {
        const micros = Math.min(needed, grant.remaining);
        if (micros === 0) break;
        this.storage.sql.exec(
          "UPDATE billing_grants SET remaining = remaining - ? WHERE id = ?",
          micros,
          grant.id,
        );
        allocations.push({ id: grant.id, micros });
        needed -= micros;
      }
      this.storage.sql.exec(
        "INSERT INTO billing_operations VALUES (?, ?, 'reserved', ?, ?, NULL, ?, ?, ?, ?, ?, ?)",
        input.id,
        fingerprint,
        input.maximumMicros,
        JSON.stringify(allocations),
        input.kind,
        input.botId ?? null,
        input.sessionId ?? null,
        input.description,
        input.pricingVersion,
        this.now(),
      );
      recordAttributionV1(this.storage.sql, input, attribution);
      return { status: "reserved" as const, created: true };
    });
  }
  settle(input: UsageSettlement) {
    amount(input.costMicros, "provider cost");
    amount(input.chargeMicros, "usage charge");
    for (const value of Object.values(input.quantities))
      if (!Number.isFinite(value) || value < 0)
        throw new BillingError("Invalid usage quantities", 400);
    for (const value of Object.values(input.unitRates ?? {}))
      if (!Number.isFinite(value) || value < 0)
        throw new BillingError("Invalid usage rates", 400);
    if (
      (input.pricing !== undefined &&
        !USAGE_PRICINGS_V1.includes(input.pricing)) ||
      (input.servedModel !== undefined &&
        (typeof input.servedModel !== "string" ||
          !input.servedModel ||
          input.servedModel.length > 300))
    )
      throw new BillingError("Invalid usage pricing", 400);
    return this.storage.transactionSync(() => {
      const operation = this.rows<Operation>(
        "SELECT * FROM billing_operations WHERE id = ?",
        input.id,
      )[0];
      if (!operation) throw new BillingError("Usage was not reserved", 409);
      const settlement = stable(input);
      if (operation.status !== "reserved") {
        if (operation.settlement !== settlement)
          throw new BillingError(
            "Usage settlement conflicts with its receipt",
            409,
          );
        return;
      }
      if (input.chargeMicros > operation.maximum)
        throw new BillingError(
          "Usage exceeded its reserved limit; reconciliation required",
          409,
        );
      let charge = input.chargeMicros;
      const allocations = JSON.parse(operation.allocations) as {
        id: string;
        micros: number;
      }[];
      for (const allocation of allocations) {
        const spent = Math.min(charge, allocation.micros);
        charge -= spent;
        // Refund to the original grant, even if expired. Never renew monthly credit.
        this.storage.sql.exec(
          "UPDATE billing_grants SET remaining = remaining + ? WHERE id = ?",
          allocation.micros - spent,
          allocation.id,
        );
      }
      this.storage.sql.exec(
        "UPDATE billing_operations SET status = ?, settlement = ? WHERE id = ?",
        input.chargeMicros === 0 && input.costMicros === 0
          ? "released"
          : "settled",
        settlement,
        input.id,
      );
      // The rollup is what the Spending page reads, and nothing else: a
      // failure there leaves a gap in it, never an unsettled charge.
      try {
        rollUpSettlementV1(this.storage.sql, input);
      } catch {
        // Recorded on the operation all the same.
      }
    });
  }
  reconcile(command: {
    id: string;
    reason: string;
    actorId?: string;
    settlement?: UsageSettlement;
    suspended?: boolean;
    revokeGrantId?: string;
  }) {
    if (
      !command.reason ||
      command.reason.length < 10 ||
      command.reason.length > 1000 ||
      (!command.settlement &&
        command.suspended === undefined &&
        !command.revokeGrantId)
    )
      throw new BillingError(
        "A reconciliation needs an action and an evidence reference",
        400,
      );
    this.once(`reconcile:${identifier(command.id)}`, command, () => {
      if (command.settlement) this.settle(command.settlement);
      if (command.revokeGrantId) {
        const id = identifier(command.revokeGrantId);
        if (
          !this.rows<Grant>("SELECT * FROM billing_grants WHERE id = ?", id)
            .length
        )
          throw new BillingError("Credit grant does not exist", 404);
        // A later settlement can return unused holds, but this grant stays expired.
        this.storage.sql.exec(
          "UPDATE billing_grants SET remaining = 0, expires = 0 WHERE id = ?",
          id,
        );
      }
      if (command.suspended !== undefined) {
        if (typeof command.suspended !== "boolean")
          throw new BillingError("Invalid account suspension", 400);
        this.set("suspended", command.suspended);
      }
    });
  }
  /**
   * The one way a payments Package reaches this account. It reads the
   * subscription and keeps its own records; it credits the account only inside
   * `apply`, under the provider event's receipt.
   */
  paymentsPort(): PaymentsLedgerPortV1 {
    const account = (): PaymentsAccountV1 => ({
      subscription: this.subscription() ?? null,
      paidPeriod: this.get<PaidAccessState>("paidAccess") ?? null,
      subscribed: this.subscribed(),
      suspended: this.get<boolean>("suspended") ?? false,
      trialUsed: this.get<boolean>("trialUsed") ?? false,
    });
    const record = <T>(key: string) => this.get<T>(providerRecordKey(key));
    const remember = (key: string, value: unknown) =>
      this.set(providerRecordKey(key), value);
    // Handed to `apply`'s callback and live only while it runs, so a Package
    // that kept it cannot credit the account outside an event's transaction.
    let applying = false;
    const within =
      <A extends unknown[]>(effect: (...args: A) => void) =>
      (...args: A) => {
        if (!applying)
          throw new BillingError(
            "Payment effects apply only inside apply",
            409,
          );
        effect(...args);
      };
    const effects: PaymentsLedgerEffectsV1 = {
      account,
      record,
      remember: within(remember),
      recordSubscription: within((subscription: PaymentsSubscriptionV1) =>
        this.recordSubscription(subscription),
      ),
      recordPaidPeriod: within((period: PaymentsPaidPeriodV1) =>
        this.recordPaidPeriod(period),
      ),
      grantPurchased: within(
        (grant: { readonly key: string; readonly micros: number }) => {
          amount(grant.micros, "credit");
          if (grant.micros === 0) throw new BillingError("Invalid credit", 400);
          this.grant(
            `topup:${providerKey(grant.key, "payment reference")}`,
            "purchased",
            grant.micros,
            null,
          );
        },
      ),
      grantTrial: within(
        (trial: {
          readonly subscriptionId: string;
          readonly expires: number;
        }) => this.grantTrial(trial),
      ),
      suspend: within(() => this.set("suspended", true)),
    };
    return {
      account,
      record,
      remember,
      requireSubscription: () => this.requireSubscription(),
      applied: (receipt, evidence) =>
        this.receipt(providerKey(receipt, "payment receipt"), stable(evidence)),
      apply: (receipt, evidence, apply) => {
        this.once(providerKey(receipt, "payment receipt"), evidence, () => {
          applying = true;
          try {
            const result: unknown = apply(effects);
            // Awaited effects would land after the receipt committed, with
            // nothing credited: the receipt must not be spent on them.
            if (result instanceof Promise) {
              result.catch(() => undefined);
              throw new BillingError(
                "Payment effects apply synchronously",
                500,
              );
            }
          } finally {
            applying = false;
          }
        });
      },
    };
  }
  private recordSubscription(subscription: PaymentsSubscriptionV1) {
    identifier(subscription.customerId);
    identifier(subscription.subscriptionId);
    timestamp(subscription.periodStart, "subscription period");
    timestamp(subscription.periodEnd, "subscription period");
    if (subscription.trialEnd !== null)
      timestamp(subscription.trialEnd, "trial end");
    if (
      typeof subscription.status !== "string" ||
      !/^[a-z_]{1,40}$/.test(subscription.status) ||
      subscription.periodEnd <= subscription.periodStart ||
      typeof subscription.cancelAtPeriodEnd !== "boolean"
    )
      throw new BillingError("Invalid subscription", 400);
    this.subscriptionPlan(subscription.planId);
    const existing = this.subscription();
    if (
      existing &&
      existing.subscriptionId !== subscription.subscriptionId &&
      existing.periodStart > subscription.periodStart
    )
      throw new BillingError("Old subscription event", 409);
    this.set("subscription", {
      customerId: subscription.customerId,
      subscriptionId: subscription.subscriptionId,
      planId: subscription.planId,
      status: subscription.status,
      periodStart: subscription.periodStart,
      periodEnd: subscription.periodEnd,
      trialEnd: subscription.trialEnd,
      cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    } satisfies SubscriptionState);
  }
  private subscriptionPlan(planId: string) {
    const plan = this.plan.subscriptions.find((each) => each.id === planId);
    if (!plan)
      throw new BillingError(
        this.plan.subscriptions.length
          ? "This deployment sells no such plan"
          : "This deployment sells no subscription",
        409,
      );
    return plan;
  }
  /**
   * A trial's credit: the plan's, spendable without a paid period because it
   * is complimentary, and gone when the trial ends. Once per account.
   */
  private grantTrial(trial: {
    readonly subscriptionId: string;
    readonly expires: number;
  }) {
    identifier(trial.subscriptionId);
    timestamp(trial.expires, "trial end");
    if (!this.plan.trial)
      throw new BillingError("This deployment offers no trial", 409);
    const subscription = this.subscription();
    if (
      subscription?.subscriptionId === trial.subscriptionId &&
      this.subscriptionPlan(subscription.planId).trial === false
    )
      throw new BillingError("This plan has no trial", 409);
    const id = `trial:${trial.subscriptionId}`;
    // The same trial again is nothing; another subscription's is a second.
    if (
      this.get<boolean>("trialUsed") &&
      !this.rows("SELECT id FROM billing_grants WHERE id = ?", id).length
    )
      throw new BillingError("This account has had its trial", 409);
    this.grant(
      id,
      "complimentary",
      this.plan.trial.creditMicros,
      trial.expires,
    );
    this.set("trialUsed", true);
  }
  /**
   * A paid period grants the plan's allowance for it and advances paid access,
   * never backwards: a delayed event for an earlier period grants that
   * period's allowance, already expired or soon to be, and leaves access alone.
   */
  private recordPaidPeriod(period: PaymentsPaidPeriodV1) {
    identifier(period.subscriptionId);
    timestamp(period.periodStart, "paid period");
    timestamp(period.periodEnd, "paid period");
    if (period.periodEnd <= period.periodStart)
      throw new BillingError("Invalid paid period", 400);
    const plan = this.subscriptionPlan(period.planId);
    const paid = this.get<PaidAccessState>("paidAccess");
    if (
      !paid ||
      period.periodEnd > paid.periodEnd ||
      (period.periodStart === paid.periodStart &&
        period.periodEnd === paid.periodEnd &&
        period.subscriptionId !== paid.subscriptionId)
    )
      this.set("paidAccess", {
        subscriptionId: period.subscriptionId,
        planId: period.planId,
        periodStart: period.periodStart,
        periodEnd: period.periodEnd,
      } satisfies PaidAccessState);
    const periodKey = `${period.subscriptionId}:${Math.floor(period.periodStart / 1000)}`;
    // A plan that includes no credit grants none, rather than an empty
    // allowance that would read as a spent month.
    if (plan.includedMicros > 0)
      this.grant(
        `monthly:${periodKey}`,
        "included",
        plan.includedMicros,
        period.periodEnd,
      );
    if (plan.jevFairUseMicros)
      this.grant(
        `jev:${periodKey}`,
        "jev",
        plan.jevFairUseMicros,
        period.periodEnd,
      );
    // A paid month ends the trial before it, early ("Start now") or on time,
    // and the trial's credit ends with it.
    this.storage.sql.exec(
      "UPDATE billing_grants SET expires = ? WHERE id = ? AND expires > ?",
      period.periodStart,
      `trial:${period.subscriptionId}`,
      period.periodStart,
    );
  }
  /** What the account can spend right now. Cheap: three small reads. */
  balance(): BillingBalance {
    const grants = this.rows<Grant>(
      "SELECT id, kind, remaining, expires FROM billing_grants WHERE expires IS NULL OR expires > ?",
      this.now(),
    );
    const sum = (kind: GrantKind) =>
      grants
        .filter((g) => g.kind === kind)
        .reduce((n, g) => n + g.remaining, 0);
    const subscribed = this.subscribed();
    const suspended = this.get<boolean>("suspended") ?? false;
    const complimentaryMicros = sum("complimentary");
    const purchasedMicros = sum("purchased");
    return {
      includedMicros: sum("included"),
      purchasedMicros,
      complimentaryMicros,
      reservedMicros:
        this.rows<{ micros: number }>(
          "SELECT COALESCE(SUM(maximum), 0) AS micros FROM billing_operations WHERE status = 'reserved'",
        )[0]?.micros ?? 0,
      subscribed,
      canSpend:
        !suspended &&
        (subscribed ||
          complimentaryMicros > 0 ||
          (!this.plan.purchasedCreditNeedsSubscription && purchasedMicros > 0)),
      suspended,
    };
  }
  /**
   * The trial a first subscription starts with, while it runs: its credit is
   * the complimentary grant the trial invoice made, spendable without a paid
   * period and gone when the trial ends.
   */
  trial(): { endsAt: number; creditMicros: number } | null {
    const subscription = this.subscription();
    if (
      subscription?.status !== "trialing" ||
      subscription.trialEnd === null ||
      subscription.trialEnd <= this.now()
    )
      return null;
    const grant = this.rows<{ original: number }>(
      "SELECT original FROM billing_grants WHERE id = ?",
      `trial:${subscription.subscriptionId}`,
    )[0];
    return {
      endsAt: subscription.trialEnd,
      creditMicros: grant?.original ?? this.plan.trial?.creditMicros ?? 0,
    };
  }
  /**
   * The month's Jev fair use, where the plan meters Jev: every live allowance
   * as granted, and what is left of them.
   */
  jevFairUse(): { remainingMicros: number; grantedMicros: number } | null {
    if (!this.jevFairUsePlan()) return null;
    const row = this.rows<{ remaining: number; granted: number }>(
      "SELECT COALESCE(SUM(remaining), 0) AS remaining, COALESCE(SUM(original), 0) AS granted FROM billing_grants WHERE kind = 'jev' AND expires > ?",
      this.now(),
    )[0];
    return {
      remainingMicros: row?.remaining ?? 0,
      grantedMicros: row?.granted ?? 0,
    };
  }
  snapshot(before?: number) {
    const now = this.now();
    const subscription = this.subscription();
    const usage = this.rows<SqlRow>(
      "SELECT rowid AS cursor, id, status, kind, bot_id AS botId, session_id AS sessionId, description, pricing_version AS pricingVersion, fingerprint, created, maximum AS reservedMicros, settlement FROM billing_operations WHERE rowid < ? ORDER BY rowid DESC LIMIT 100",
      before ?? Number.MAX_SAFE_INTEGER,
    ).map(({ fingerprint, ...row }) => ({
      ...row,
      unitRates:
        (JSON.parse(fingerprint as string) as UsageReservation).unitRates ??
        null,
      settlement: row.settlement
        ? (JSON.parse(row.settlement as string) as UsageSettlement)
        : null,
    }));
    return {
      ...this.balance(),
      // The full mark for `includedMicros`: every live monthly allowance as
      // granted. A plan change leaves the old month's allowance running
      // beside the new one, so the current plan's figure alone is not it.
      includedGrantedMicros:
        this.rows<{ micros: number }>(
          "SELECT COALESCE(SUM(original), 0) AS micros FROM billing_grants WHERE kind = 'included' AND expires > ?",
          now,
        )[0]?.micros ?? 0,
      paidAccess: this.get<PaidAccessState>("paidAccess") ?? null,
      spentLast30DaysMicros: spentSinceV1(
        this.storage.sql,
        now - 30 * 86_400_000,
      ),
      payments: this.rows<SqlRow>(
        "SELECT id, kind, original AS creditMicros, expires, created FROM billing_grants ORDER BY created DESC LIMIT 100",
      ),
      jevFairUse: this.jevFairUse(),
      plan: this.plan,
      trial: this.trial(),
      trialUsed: this.get<boolean>("trialUsed") ?? false,
      subscription: subscription ?? null,
      usage,
    };
  }
}
