import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  BillingLedger,
  CREDIT_EXHAUSTED_REASON_V1,
  type BillingStorage,
} from "./ledger";
import type { PaymentsPlanV1 } from "@frockbot/core/contracts";
import type { AccountUsage } from "./model";
import {
  createJevMeterV1,
  jevChargeMicrosV1,
  JEV_PRICING_VERSION,
  JEV_TARIFF,
} from "./jev";

/** Complimentary credit is what these draw on; the plan only has to exist. */
const PLAN: PaymentsPlanV1 = {
  subscription: { monthlyCents: 2_000, includedMicros: 15_000_000 },
  topUpCents: [1_000],
  purchasedCreditNeedsSubscription: true,
};

function storage(database = new Database(":memory:")): BillingStorage {
  return {
    sql: {
      exec<T extends Record<string, unknown>>(
        query: string,
        ...bindings: (string | number | null)[]
      ) {
        const rows = database.query(query).all(...bindings) as T[];
        return { toArray: () => rows };
      },
    },
    transactionSync<T>(callback: () => T): T {
      return database.transaction(callback)();
    },
  };
}

const NOW = Date.UTC(2026, 8, 24);
const REQUEST = {
  effectId: "exec-0123456789abcdef0123456789abcdef:jev:0",
  botId: "bot-1",
  sessionId: "session-1",
  maximumInputTokens: 65_536,
};

/** An account with complimentary credit, spendable without a subscription. */
function account(micros = 1_000_000) {
  const ledger = new BillingLedger(storage(), "FrockBot", PLAN, () => NOW);
  if (micros > 0) {
    ledger.grantComplimentary({
      id: "gift",
      micros,
      grantedBy: "admin@example.com",
      reason: "jev tests",
    });
  }
  const usage: AccountUsage = {
    reserve: (reservation) => Promise.resolve(ledger.reserve(reservation)),
    settle: (settlement) => Promise.resolve(ledger.settle(settlement)),
  };
  return { ledger, meter: createJevMeterV1(usage) };
}

function operation(ledger: BillingLedger) {
  return ledger.snapshot().usage[0] as {
    id: string;
    kind: string;
    status: string;
    botId: string;
    sessionId: string;
    reservedMicros: number;
    pricingVersion: string;
    unitRates: Record<string, number>;
    settlement: { costMicros: number; chargeMicros: number } | null;
  };
}

describe("the Jev tariff", () => {
  test("is Jev's input-token rate, doubled, rounded up to whole micro-dollars", () => {
    const tariff = JEV_TARIFF as Record<keyof typeof JEV_TARIFF, number>;
    expect(tariff.microsPerInputToken).toBe(
      tariff.providerMicrosPerInputToken * 2,
    );
    expect(jevChargeMicrosV1(0)).toBe(0);
    expect(jevChargeMicrosV1(1)).toBe(1);
    expect(jevChargeMicrosV1(1_500)).toBe(126);
    expect(jevChargeMicrosV1(1_000_000)).toBe(84_000);
  });
});

describe("the Jev meter", () => {
  test("holds the request's ceiling under its effect id and settles on the tokens Jev counted", async () => {
    const { ledger, meter } = account();

    const charge = await meter.reserve(REQUEST);
    expect(operation(ledger)).toMatchObject({
      id: `jev:${REQUEST.effectId}`,
      kind: "jev",
      status: "reserved",
      botId: "bot-1",
      sessionId: "session-1",
      reservedMicros: jevChargeMicrosV1(65_536),
      pricingVersion: JEV_PRICING_VERSION,
      unitRates: { microsPerInputToken: 0.084 },
    });
    await charge.charge(1_500);

    expect(operation(ledger)).toMatchObject({
      status: "settled",
      settlement: { costMicros: 63, chargeMicros: 126 },
    });
    expect(ledger.balance().complimentaryMicros).toBe(1_000_000 - 126);
  });

  test("never charges past the hold", async () => {
    const { ledger, meter } = account();
    await (
      await meter.reserve({ ...REQUEST, maximumInputTokens: 100 })
    ).charge(1_000);
    expect(operation(ledger).settlement?.chargeMicros).toBe(
      jevChargeMicrosV1(100),
    );
  });

  test("a re-run of the same request is not billed again", async () => {
    const { ledger, meter } = account();
    await (await meter.reserve(REQUEST)).charge(1_500);

    const rerun = await meter.reserve(REQUEST);
    await rerun.charge(1_500);
    await rerun.release();

    expect(ledger.snapshot().usage).toHaveLength(1);
    expect(ledger.balance().complimentaryMicros).toBe(1_000_000 - 126);
  });

  test("returns the hold when Jev refused the request", async () => {
    const { ledger, meter } = account();
    await (await meter.reserve(REQUEST)).release();

    expect(operation(ledger).status).toBe("released");
    expect(ledger.balance()).toMatchObject({
      complimentaryMicros: 1_000_000,
      reservedMicros: 0,
    });
  });

  test("refuses before Jev is asked when the account cannot pay", async () => {
    const { ledger, meter } = account(1_000);
    await expect(meter.reserve(REQUEST)).rejects.toThrow(
      CREDIT_EXHAUSTED_REASON_V1,
    );
    expect(ledger.snapshot().usage).toEqual([]);
  });
});
