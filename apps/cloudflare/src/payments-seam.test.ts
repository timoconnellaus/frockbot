import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { join } from "node:path";
import type { PaymentsPackageBuildV1 } from "@frockbot/core/contracts";
import { BillingLedger } from "@frockbot/app/billing/ledger";

// The white-label fixture's stub payments Package, as an outside repository
// writes it: loaded by path, the way a profile names it, and credited into
// this repository's own ledger through the port.
const FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "scripts",
  "white-label-fixture",
  "payments",
);

test("an outside payments Package credits an account through the ledger port, once", async () => {
  const { PAYMENTS_PACKAGE_V1 } = (await import(
    join(FIXTURE, "chooser.ts")
  )) as {
    PAYMENTS_PACKAGE_V1: PaymentsPackageBuildV1<object>;
  };
  const { provePaymentsPackageV1 } = (await import(
    join(FIXTURE, "prove.ts")
  )) as {
    provePaymentsPackageV1: (account: {
      port: ReturnType<BillingLedger["paymentsPort"]>;
      purchasedMicros(): number;
      canSpend(): boolean;
    }) => Promise<void>;
  };
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
  // No subscription is sold, so purchased credit is spendable on its own.
  expect(ledger.balance()).toMatchObject({
    subscribed: false,
    canSpend: true,
    purchasedMicros: 20_000_000,
  });
  expect(ledger.snapshot().payments).toMatchObject([
    { id: "topup:pay-1", kind: "purchased", creditMicros: 20_000_000 },
  ]);
});
