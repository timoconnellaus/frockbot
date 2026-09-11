export const BILLING_PLAN = {
  currency: "usd",
  monthlyCents: 2900,
  includedMicros: 15_000_000,
  topUpCents: [1000, 2500, 5000],
  pricingVersion: "2026-09-09",
} as const;

/**
 * The two refusals a person is told in the conversation, so they are written
 * for the person. `run-failure-copy` carries them through verbatim.
 */
export const SUBSCRIPTION_REQUIRED_REASON_V1 =
  "A paid FrockBot subscription is required. Open Billing to subscribe or update your payment method.";
export const CREDIT_EXHAUSTED_REASON_V1 =
  "You have no usage credit left. Open Billing to add more.";

export type GrantKind = "included" | "purchased" | "complimentary";

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

export class BillingError extends Error {
  constructor(
    message: string,
    readonly status = 402,
  ) {
    super(message);
    this.name = "BillingError";
  }
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
  kind: "model" | "computer";
  maximumMicros: number;
  botId?: string;
  sessionId?: string;
  description: string;
  pricingVersion: string;
  unitRates?: Record<string, number>;
}
export interface UsageSettlement {
  id: string;
  costMicros: number;
  chargeMicros: number;
  quantities: Record<string, number>;
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
export interface SubscriptionState {
  customerId: string;
  subscriptionId: string;
  status: string;
  periodStart: number;
  periodEnd: number;
  cancelAtPeriodEnd: boolean;
}
export interface PaidAccessState {
  subscriptionId: string;
  periodStart: number;
  periodEnd: number;
}

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
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => `${JSON.stringify(k)}:${stable(v)}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

/** Account-owned tables. Every balance mutation and its receipt commit together. */
export class BillingLedger {
  constructor(
    private readonly storage: BillingStorage,
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
    if (!this.subscribed())
      throw new BillingError(SUBSCRIPTION_REQUIRED_REASON_V1);
  }
  /**
   * The grants a reservation may draw on, cheapest to spend first: monthly
   * credit expires soonest, complimentary credit was a gift, purchased credit
   * carries forward. Without a subscription only complimentary credit counts.
   */
  private spendable(subscribed: boolean): Grant[] {
    return this.rows<Grant>(
      `SELECT id, kind, remaining, expires FROM billing_grants WHERE remaining > 0 AND (expires IS NULL OR expires > ?)${
        subscribed ? "" : " AND kind = 'complimentary'"
      } ORDER BY CASE kind WHEN 'included' THEN 0 WHEN 'complimentary' THEN 1 ELSE 2 END, expires, created, id`,
      this.now(),
    );
  }
  reserve(input: UsageReservation) {
    identifier(input.id);
    amount(input.maximumMicros, "reservation");
    if (
      !["model", "computer"].includes(input.kind) ||
      !input.description ||
      input.description.length > 300 ||
      !input.pricingVersion
    )
      throw new BillingError("Invalid usage reservation", 400);
    return this.storage.transactionSync(() => {
      const fingerprint = stable(input);
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
      const subscribed = this.subscribed();
      if (this.get<boolean>("suspended"))
        throw new BillingError(SUBSCRIPTION_REQUIRED_REASON_V1);
      const grants = this.spendable(subscribed);
      const available = grants.reduce((total, g) => total + g.remaining, 0);
      if (!subscribed && available === 0)
        throw new BillingError(SUBSCRIPTION_REQUIRED_REASON_V1);
      let needed = input.maximumMicros;
      if (available < needed)
        throw new BillingError(CREDIT_EXHAUSTED_REASON_V1);
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
      return { status: "reserved" as const, created: true };
    });
  }
  settle(input: UsageSettlement) {
    amount(input.costMicros, "provider cost");
    amount(input.chargeMicros, "usage charge");
    for (const value of Object.values(input.quantities))
      if (!Number.isFinite(value) || value < 0)
        throw new BillingError("Invalid usage quantities", 400);
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
    return {
      includedMicros: sum("included"),
      purchasedMicros: sum("purchased"),
      complimentaryMicros,
      reservedMicros:
        this.rows<{ micros: number }>(
          "SELECT COALESCE(SUM(maximum), 0) AS micros FROM billing_operations WHERE status = 'reserved'",
        )[0]?.micros ?? 0,
      subscribed,
      canSpend: !suspended && (subscribed || complimentaryMicros > 0),
      suspended,
    };
  }
  snapshot(before?: number) {
    const now = this.now();
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
      paidAccess: this.get<PaidAccessState>("paidAccess") ?? null,
      summaries: this.rows<SqlRow>(
        "SELECT kind, bot_id AS botId, date(created / 1000, 'unixepoch') AS day, SUM(COALESCE(json_extract(settlement, '$.chargeMicros'), 0)) AS chargeMicros, COUNT(*) AS operations FROM billing_operations WHERE created >= ? GROUP BY day, kind, bot_id ORDER BY day DESC LIMIT 100",
        now - 31 * 86_400_000,
      ),
      payments: this.rows<SqlRow>(
        "SELECT id, kind, original AS creditMicros, expires, created FROM billing_grants ORDER BY created DESC LIMIT 100",
      ),
      plan: BILLING_PLAN,
      subscription: this.subscription() ?? null,
      usage,
    };
  }
}
