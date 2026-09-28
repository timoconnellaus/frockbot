// Proves the stub payments Package credits an account through the ledger port
// from its test webhook, at most once, over a real FrockBot ledger. The
// white-label gate runs it against the installed tarballs; this repository's
// suite runs it against its own ledger (`apps/cloudflare/src/payments-seam.test.ts`).
import type {
  PaymentsLedgerPortV1,
  PaymentsRouteContextV1,
} from "@frockbot/core/contracts";
import { PAYMENTS_PACKAGE_V1 } from "./chooser.ts";

const SECRET = "wallet-pal-fixture-secret";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`Payments seam: ${message}`);
}

/** One account's ledger, as the proof reaches it. */
export interface ProvenAccountV1 {
  port: PaymentsLedgerPortV1;
  purchasedMicros(): number;
  canSpend(): boolean;
}

export async function provePaymentsPackageV1(
  account: ProvenAccountV1,
): Promise<void> {
  const payments = PAYMENTS_PACKAGE_V1.create(
    { WALLET_PAL_PAYMENTS_SECRET: SECRET },
    { productName: "Wallet Pal" },
  );
  // The gateway's half: an account command runs where the account's ledger is.
  const context: PaymentsRouteContextV1 = {
    sessionUserId: async () => undefined,
    account: (userId) => ({
      command: (name, input) =>
        payments.account!(account.port, userId).command(name, input),
    }),
  };
  const deliver = (body: unknown, secret = SECRET) => {
    const request = new Request(
      "https://wallet-pal.example/api/billing/provider/test-webhook",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-wallet-pal-secret": secret,
        },
        body: JSON.stringify(body),
      },
    );
    return payments.route!(request, new URL(request.url), context);
  };
  const paid = {
    event: "evt-1",
    userId: "user-1",
    payment: "pay-1",
    cents: 2_000,
  };

  check(
    !account.canSpend() && account.purchasedMicros() === 0,
    "the account starts with nothing to spend",
  );
  check(
    (await deliver(paid, "forged"))?.status === 401,
    "a forged event is refused",
  );
  check(account.purchasedMicros() === 0, "a forged event credited the account");
  check((await deliver(paid))?.status === 200, "the webhook was not received");
  check(
    account.purchasedMicros() === 20_000_000 && account.canSpend(),
    "the paid top-up was not credited through the port",
  );
  // Redelivered, and delivered again under another event id: once.
  await deliver(paid);
  await deliver({ ...paid, event: "evt-2" });
  check(
    account.purchasedMicros() === 20_000_000,
    "a payment was credited twice",
  );
  // The same event with another amount is refused, and credits nothing.
  let refused = false;
  await deliver({ ...paid, cents: 5_000 }).catch(() => {
    refused = true;
  });
  check(refused, "a changed event under a used receipt was accepted");
  check(account.purchasedMicros() === 20_000_000, "a changed event credited");
  const page = await payments.route!(
    new Request("https://wallet-pal.example/api/billing/provider/buy"),
    new URL("https://wallet-pal.example/api/billing/provider/buy"),
    context,
  );
  check(page?.status === 200, "the Package does not serve its own page");
  check(
    payments.actions({
      subscription: null,
      paidPeriod: null,
      subscribed: false,
      suspended: false,
      trialUsed: false,
    })[0]?.target.kind === "url",
    "the Billing page is not offered the Package's own page",
  );
}

if (import.meta.main) {
  const { Database } = await import("bun:sqlite");
  const { BillingLedger } = await import("@frockbot/app/billing/ledger");
  const database = new Database(":memory:");
  const ledger = new BillingLedger(
    {
      sql: {
        exec: (query: string, ...bindings: (string | number | null)[]) => {
          const rows = database.query(query).all(...bindings);
          return { toArray: () => rows as never[] };
        },
      },
      transactionSync: <T>(callback: () => T) =>
        database.transaction(callback)(),
    },
    "Wallet Pal",
    PAYMENTS_PACKAGE_V1.plan,
  );
  await provePaymentsPackageV1({
    port: ledger.paymentsPort(),
    purchasedMicros: () => ledger.balance().purchasedMicros,
    canSpend: () => ledger.balance().canSpend,
  });
  console.log(
    "The stub payments Package credited an account through the ledger port, once.",
  );
}
