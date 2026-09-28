/**
 * Payments, as everything above them speaks to them.
 *
 * Billing is FrockBot's: the account-owned credit ledger, its grants,
 * reservations and settlement, metering and the Spending page. What a
 * deployment chooses is how people pay for credit — the plan it sells, the
 * pages a purchase opens and the provider events that confirm one. That is the
 * payments Package, and this file is its published contract.
 *
 * Two builds ship here: `app/payments/stripe` and `app/payments/none`, a
 * deployment that does not bill. Each has one chooser beside the bindings —
 * `apps/cloudflare/src/payments.ts` and `payments.none.ts` — and a
 * deployment's generated wrangler config decides which one `#payments`
 * resolves to, the way `#auth-package` is chosen. A white-label writes a third
 * in its own repository: a chooser module exporting `PAYMENTS_PACKAGE_V1` and
 * `PaymentsPackageEnvironmentV1`, which its profile names by path
 * (ADR 0038 §1).
 *
 * A Package never touches ledger storage. It credits an account only through
 * `PaymentsLedgerPortV1`, inside `apply`, where every change a provider event
 * makes commits at most once, together, under that event's receipt.
 */

/** What a deployment sells. Amounts are US cents; credit is micro-dollars. */
export interface PaymentsPlanV1 {
  /**
   * The monthly subscription: its price and the credit each paid month
   * includes, which expires at the period's end. None when the deployment
   * sells no subscription.
   */
  readonly subscription: {
    readonly monthlyCents: number;
    readonly includedMicros: number;
  } | null;
  /** The top-up amounts a person may buy, smallest first. */
  readonly topUpCents: readonly number[];
  /** Whether purchased credit is spendable only while subscribed. */
  readonly purchasedCreditNeedsSubscription: boolean;
}

/**
 * A subscription as its provider last described it. `status` is the
 * provider's word; `active` is the one that, with a paid period, lets the
 * account spend.
 */
export interface PaymentsSubscriptionV1 {
  readonly customerId: string;
  readonly subscriptionId: string;
  readonly status: string;
  readonly periodStart: number;
  readonly periodEnd: number;
  readonly cancelAtPeriodEnd: boolean;
}

/** One period of a subscription the provider confirmed was paid. */
export interface PaymentsPaidPeriodV1 {
  readonly subscriptionId: string;
  /** Epoch milliseconds. */
  readonly periodStart: number;
  readonly periodEnd: number;
}

/** The account as a Package may read it. */
export interface PaymentsAccountV1 {
  readonly subscription: PaymentsSubscriptionV1 | null;
  readonly paidPeriod: PaymentsPaidPeriodV1 | null;
  /** A paid period is current, its subscription active, and nothing suspended. */
  readonly subscribed: boolean;
  readonly suspended: boolean;
}

/**
 * The changes one provider event may make, inside `apply`. Each is checked by
 * the ledger, and a refusal from any of them rolls back the whole event.
 */
export interface PaymentsLedgerEffectsV1 {
  account(): PaymentsAccountV1;
  record<T>(key: string): T | undefined;
  remember(key: string, value: unknown): void;
  /**
   * The subscription's current state, which ends it when its status is no
   * longer `active`. An event about a different subscription that started
   * before the one recorded is refused, so a late event cannot roll it back.
   */
  recordSubscription(subscription: PaymentsSubscriptionV1): void;
  /**
   * A paid period: the plan's included credit for it, once per subscription
   * and period start, and paid access up to its end unless a later period is
   * already recorded.
   */
  recordPaidPeriod(period: PaymentsPaidPeriodV1): void;
  /**
   * Purchased credit, which never expires. `key` is the provider's own
   * reference for the payment and makes the grant at-most-once: the same key
   * again is nothing, and the same key with another amount is refused.
   */
  grantPurchased(grant: {
    readonly key: string;
    readonly micros: number;
  }): void;
  /** Stops paid work pending review: a refund or a dispute. */
  suspend(): void;
}

/**
 * One account's ledger, as a Package reaches it. Provider records — its own
 * customer id, a checkout it started — live beside the ledger under keys the
 * Package names; the ledger's own keys are refused.
 */
export interface PaymentsLedgerPortV1 {
  account(): PaymentsAccountV1;
  /** Refuses, in the words the person reads, an account that is not subscribed. */
  requireSubscription(): void;
  record<T>(key: string): T | undefined;
  remember(key: string, value: unknown): void;
  /**
   * Whether `receipt` was already applied. The same receipt with other
   * evidence is refused rather than answered.
   */
  applied(receipt: string, evidence: unknown): boolean;
  /**
   * Applies one provider event at most once. `receipt` is the provider's own
   * id for the event and `evidence` what it said; both are kept. The effects
   * run in one transaction with the receipt, so a retry after a failure
   * applies them whole or not at all, and one after a success applies nothing.
   */
  apply(
    receipt: string,
    evidence: unknown,
    effects: (ledger: PaymentsLedgerEffectsV1) => void,
  ): void;
}

/** Where the Billing page offers an action. */
export type PaymentsActionPurposeV1 = "subscribe" | "top-up" | "manage";

/**
 * One thing the Billing page offers, as data. The page draws it where its
 * purpose says, and takes it by opening a page:
 *
 * - `url`: the page opens that URL. A path is on the deployment's own origin.
 * - `command`: the page POSTs `{ id, ...body }` as the signed-in person — with
 *   `cents`, the chosen amount, for a top-up — to that path under the
 *   Package's routes, and opens the `url` it answers. A page that needs to
 *   know who the person is gets there this way, since the browser it opens in
 *   may hold no session.
 *
 * `hosts` is every host the opened page may be on; the page refuses any other,
 * and always allows the deployment's own.
 */
export interface PaymentsActionV1 {
  readonly purpose: PaymentsActionPurposeV1;
  /** The button's words; a top-up's is followed by the chosen amount. */
  readonly label: string;
  readonly target:
    | { readonly kind: "url"; readonly url: string }
    | {
        readonly kind: "command";
        readonly path: `/api/billing/provider/${string}`;
        readonly body?: Readonly<Record<string, string>>;
      };
  /** In the system browser, or a web view inside the app. */
  readonly opens: "browser" | "in-app";
  readonly hosts: readonly string[];
}

/**
 * Where a Package's routes run: the gateway, for every request under
 * `/api/billing/provider/`.
 */
export interface PaymentsRouteContextV1 {
  /** The signed-in, admitted User the request is, or nobody. */
  sessionUserId(): Promise<string | undefined>;
  /**
   * Runs one of the Package's account commands in that account's ledger
   * authority, where `account()` answers it. `signedIn` is for a command the
   * person asked for, which a closing account refuses; a provider event is
   * not. Rejects with an error named `AccountDeletedError` for an account
   * already deleted.
   */
  account(
    userId: string,
    options: { readonly signedIn: boolean },
  ): { command(name: string, input: unknown): Promise<unknown> };
}

/** An account's commands, run inside its ledger authority. */
export interface PaymentsAccountCommandsV1 {
  /** Input and answer cross an RPC boundary, so both are plain data. */
  command(name: string, input: unknown): Promise<unknown>;
}

/** One payments Package, over one Worker environment. */
export interface PaymentsPackageV1 {
  /**
   * Whether purchases can be made now. False keeps every action disabled and
   * says payments are not available.
   */
  readonly available: boolean;
  /** Who handles payments, as the Billing page credits them; none says nothing. */
  readonly providerName: string | null;
  /** What the Billing page offers this account. */
  actions(account: PaymentsAccountV1): readonly PaymentsActionV1[];
  /** `/api/billing/provider/*`, or nothing for a path it does not serve. */
  route?(
    request: Request,
    url: URL,
    context: PaymentsRouteContextV1,
  ): Promise<Response | undefined>;
  /** The account half, for the commands its routes send. */
  account?(
    ledger: PaymentsLedgerPortV1,
    userId: string,
  ): PaymentsAccountCommandsV1;
  /**
   * Deleting an account: whatever the provider holds for it, so nothing keeps
   * charging a person who no longer has one. Idempotent. `record` reads what
   * the Package remembered for the account.
   */
  deleteAccount?(
    userId: string,
    record: <T>(key: string) => T | undefined,
  ): Promise<void>;
}

/** What a payments Package is given beyond `env`. */
export interface PaymentsPackageDependenciesV1 {
  /** The product a purchase is for, as a checkout names it. */
  readonly productName: string;
}

/** One `env` string a payments Package reads, and what it is for. */
export interface PaymentsPackageSettingV1 {
  readonly name: string;
  readonly why: string;
}

/** The two implementations of payments this repository ships. */
export const BUILT_IN_PAYMENTS_PACKAGE_IDS_V1 = ["stripe", "none"] as const;
export type BuiltInPaymentsPackageIdV1 =
  (typeof BUILT_IN_PAYMENTS_PACKAGE_IDS_V1)[number];

export function isBuiltInPaymentsPackageIdV1(
  id: string,
): id is BuiltInPaymentsPackageIdV1 {
  return (BUILT_IN_PAYMENTS_PACKAGE_IDS_V1 as readonly string[]).includes(id);
}

/**
 * Which implementation of payments a deployment built: one of the two this
 * repository ships, or the name a white-label's own Package gives itself.
 */
export type PaymentsPackageIdV1 = BuiltInPaymentsPackageIdV1 | (string & {});

/** One implementation of payments, as a deployment's choosing file names it. */
export interface PaymentsPackageBuildV1<EnvironmentV1> {
  readonly id: PaymentsPackageIdV1;
  /** Every `env` string a deployment that built this Package must be given. */
  readonly required: readonly PaymentsPackageSettingV1[];
  readonly plan: PaymentsPlanV1;
  /**
   * Whether this deployment bills: meters usage, and requires a paid account
   * to spend. Read on every metered call, so it reads `env` and nothing else.
   */
  live(environment: EnvironmentV1): boolean;
  /**
   * The Package over this Worker's bindings. Given an environment it is not
   * configured for, it answers `available: false` and refuses its routes with
   * a reason, rather than failing to construct.
   */
  create(
    environment: EnvironmentV1,
    dependencies: PaymentsPackageDependenciesV1,
  ): PaymentsPackageV1;
}
