import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  BillingLedger,
  CREDIT_EXHAUSTED_REASON_V1,
  type BillingStorage,
} from "./ledger";
import type { AccountUsage } from "./model";
import { createSearchMeterV1, SEARCH_TARIFF } from "./search";

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
const SEARCH = {
  effectId: "web-search-0123456789abcdef0123456789abcdef",
  botId: "bot-1",
  sessionId: "session-1",
};

/** An account with complimentary credit, spendable without a subscription. */
function account(micros = 1_000_000) {
  const ledger = new BillingLedger(storage(), () => NOW);
  if (micros > 0) {
    ledger.grantComplimentary({
      id: "gift",
      micros,
      grantedBy: "admin@example.com",
      reason: "search tests",
    });
  }
  const usage: AccountUsage = {
    reserve: (reservation) => Promise.resolve(ledger.reserve(reservation)),
    settle: (settlement) => Promise.resolve(ledger.settle(settlement)),
  };
  return { ledger, meter: createSearchMeterV1(usage) };
}

function operation(ledger: BillingLedger) {
  return ledger.snapshot().usage[0] as {
    id: string;
    kind: string;
    status: string;
    botId: string;
    sessionId: string;
    reservedMicros: number;
    unitRates: Record<string, number>;
    settlement: { costMicros: number; chargeMicros: number } | null;
  };
}

describe("the search tariff", () => {
  test("is Brave's flat rate, doubled", () => {
    const { providerMicrosPerSearch, microsPerSearch, usdPerSearch } =
      SEARCH_TARIFF as Record<keyof typeof SEARCH_TARIFF, number>;
    expect(providerMicrosPerSearch).toBe(5_000);
    expect(microsPerSearch).toBe(providerMicrosPerSearch * 2);
    expect(usdPerSearch * 1_000_000).toBe(microsPerSearch);
  });
});

describe("the search meter", () => {
  test("holds one search's price under its effect id and charges it once answered", async () => {
    const { ledger, meter } = account();

    const charge = await meter.reserve(SEARCH);
    expect(operation(ledger)).toMatchObject({
      id: `search:${SEARCH.effectId}`,
      kind: "search",
      status: "reserved",
      botId: "bot-1",
      sessionId: "session-1",
      reservedMicros: 10_000,
      unitRates: { microsPerSearch: 10_000 },
    });
    await charge.charge();

    expect(operation(ledger)).toMatchObject({
      status: "settled",
      settlement: { costMicros: 5_000, chargeMicros: 10_000 },
    });
    expect(ledger.balance().complimentaryMicros).toBe(990_000);
  });

  test("a re-run of the same search is not billed again", async () => {
    // `web_search` is idempotent: recovery re-runs it under the same effect id.
    const { ledger, meter } = account();
    await (await meter.reserve(SEARCH)).charge();

    const rerun = await meter.reserve(SEARCH);
    await rerun.charge();
    await rerun.release();

    expect(ledger.snapshot().usage).toHaveLength(1);
    expect(ledger.balance().complimentaryMicros).toBe(990_000);
  });

  test("settles a search whose first run never learned its outcome", async () => {
    // The first run was evicted mid-request: its hold is still reserved, and
    // the re-run is the one that settles it.
    const { ledger, meter } = account();
    await meter.reserve(SEARCH);

    await (await meter.reserve(SEARCH)).charge();

    expect(operation(ledger).status).toBe("settled");
    expect(ledger.balance().complimentaryMicros).toBe(990_000);
  });

  test("returns the hold when the provider refused the search", async () => {
    const { ledger, meter } = account();
    await (await meter.reserve(SEARCH)).release();

    expect(operation(ledger).status).toBe("released");
    expect(ledger.balance()).toMatchObject({
      complimentaryMicros: 1_000_000,
      reservedMicros: 0,
    });
  });

  test("refuses before anything is asked when the account cannot pay", async () => {
    const { ledger, meter } = account(5_000);
    await expect(meter.reserve(SEARCH)).rejects.toThrow(
      CREDIT_EXHAUSTED_REASON_V1,
    );
    expect(ledger.snapshot().usage).toEqual([]);
  });
});
