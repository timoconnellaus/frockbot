import { describe, expect, test } from "bun:test";
import {
  seedHostedModelRatesV1,
  type HostedModelRatesV1,
} from "@frockbot/app/billing/rates";
import {
  createHostedModelRatesReaderV1,
  currentHostedModelRatesV1,
  hostedModelRatesViewV1,
  MODEL_RATES_SEED_RECEIPT_KEY,
  reportUnpricedServedModelV1,
  saveHostedModelRatesV1,
  seedHostedModelRatesStorageV1,
  type HostedModelRatesAuthorityV1,
} from "./model-rates.js";

/** The synchronous key-value API, ordered and with a transaction that rolls back. */
class MemoryStorage {
  values = new Map<string, unknown>();
  readonly kv = {
    get: <T>(key: string): T | undefined =>
      structuredClone(this.values.get(key)) as T | undefined,
    put: (key: string, value: unknown): void => {
      this.values.set(key, structuredClone(value));
    },
    list: <T>(options: {
      prefix?: string;
      reverse?: boolean;
      limit?: number;
    }): Iterable<[string, T]> => {
      const keys = [...this.values.keys()]
        .filter((key) => key.startsWith(options.prefix ?? ""))
        .toSorted();
      if (options.reverse) keys.reverse();
      return keys
        .slice(0, options.limit ?? keys.length)
        .map((key) => [key, structuredClone(this.values.get(key)) as T]);
    },
  };

  transactionSync<T>(callback: () => T): T {
    const before = new Map(this.values);
    try {
      return callback();
    } catch (error) {
      this.values = before;
      throw error;
    }
  }
}

const at = (iso: string) => () => new Date(iso);
const ADMIN = "owner@example.com";

function save(
  storage: MemoryStorage,
  baseVersion: number,
  served: Record<string, unknown> = {},
  when = "2026-09-25T00:00:00.000Z",
) {
  const seed = seedHostedModelRatesV1(when);
  return saveHostedModelRatesV1(
    storage,
    {
      schemaVersion: 1,
      command: {
        schemaVersion: 1,
        type: "deployment/save-model-rates",
        baseVersion,
        routes: seed.routes,
        served,
      },
      createdBy: ADMIN,
    },
    at(when),
  );
}

describe("the rate table in the deployment authority", () => {
  test("is seeded once, receipted, and a restart repeats nothing", () => {
    const storage = new MemoryStorage();
    seedHostedModelRatesStorageV1(storage, at("2026-09-24T00:00:00.000Z"));
    const seeded = currentHostedModelRatesV1(storage);
    expect(seeded).toEqual(seedHostedModelRatesV1("2026-09-24T00:00:00.000Z"));
    expect(storage.values.get(MODEL_RATES_SEED_RECEIPT_KEY)).toEqual({
      at: "2026-09-24T00:00:00.000Z",
      seeded: 1,
    });

    seedHostedModelRatesStorageV1(storage, at("2026-09-30T00:00:00.000Z"));
    expect(currentHostedModelRatesV1(storage)).toEqual(seeded);
  });

  test("never overwrites a table an administrator already saved", () => {
    const storage = new MemoryStorage();
    seedHostedModelRatesStorageV1(storage);
    expect(save(storage, 1).status).toBe("applied");
    storage.values.delete(MODEL_RATES_SEED_RECEIPT_KEY);

    seedHostedModelRatesStorageV1(storage, at("2026-09-30T00:00:00.000Z"));

    expect(currentHostedModelRatesV1(storage).version).toBe(2);
    expect(storage.values.get(MODEL_RATES_SEED_RECEIPT_KEY)).toMatchObject({
      seeded: 0,
    });
  });

  test("each save is a new version; the old one stays as it was", () => {
    const storage = new MemoryStorage();
    seedHostedModelRatesStorageV1(storage, at("2026-09-24T00:00:00.000Z"));
    const first = currentHostedModelRatesV1(storage);

    const written = save(storage, 1);

    expect(written).toMatchObject({
      status: "applied",
      value: { version: 2, createdBy: ADMIN, served: {} },
    });
    const view = hostedModelRatesViewV1(storage);
    expect(view.current.version).toBe(2);
    expect(view.history.map((table) => table.version)).toEqual([2, 1]);
    expect(view.history[1]).toEqual(first);
  });

  test("a save over a version someone else moved is a conflict and writes nothing", () => {
    const storage = new MemoryStorage();
    seedHostedModelRatesStorageV1(storage);
    save(storage, 1);

    expect(save(storage, 1)).toEqual({
      status: "conflict",
      currentRevision: 2,
    });
    expect(hostedModelRatesViewV1(storage).history).toHaveLength(2);
  });

  test("a malformed table is refused before anything is written", () => {
    const storage = new MemoryStorage();
    seedHostedModelRatesStorageV1(storage);

    expect(() =>
      save(storage, 1, {
        "custom-together/model": {
          inputMicrosPerToken: 1,
          cachedInputMicrosPerToken: 2,
          outputMicrosPerToken: 1,
        },
      }),
    ).toThrow("cached input above uncached input");
    expect(currentHostedModelRatesV1(storage).version).toBe(1);
  });

  test("keeps an unpriced model until a version prices it", () => {
    const storage = new MemoryStorage();
    seedHostedModelRatesStorageV1(storage);
    const report = (servedModel: string | null, iso: string) =>
      reportUnpricedServedModelV1(
        storage,
        { schemaVersion: 1, servedModel, route: "@frock/auto", version: 1 },
        at(iso),
      );
    report("custom-together/new-model", "2026-09-24T01:00:00.000Z");
    report("custom-together/new-model", "2026-09-24T02:00:00.000Z");
    report(null, "2026-09-24T03:00:00.000Z");

    expect(hostedModelRatesViewV1(storage).unpriced).toEqual([
      {
        schemaVersion: 1,
        servedModel: null,
        route: "@frock/auto",
        version: 1,
        firstSeenAt: "2026-09-24T03:00:00.000Z",
        lastSeenAt: "2026-09-24T03:00:00.000Z",
      },
      {
        schemaVersion: 1,
        servedModel: "custom-together/new-model",
        route: "@frock/auto",
        version: 1,
        firstSeenAt: "2026-09-24T01:00:00.000Z",
        lastSeenAt: "2026-09-24T02:00:00.000Z",
      },
    ]);

    save(storage, 1, {
      "custom-together/new-model": {
        inputMicrosPerToken: 1,
        cachedInputMicrosPerToken: 0.5,
        outputMicrosPerToken: 2,
      },
    });
    expect(
      hostedModelRatesViewV1(storage).unpriced.map((row) => row.servedModel),
    ).toEqual([null]);
  });
});

describe("a Bot object's copy of the rate table", () => {
  function authority(tables: HostedModelRatesV1[]) {
    const calls = { reads: 0, reports: [] as unknown[] };
    let failing = false;
    const rpc: HostedModelRatesAuthorityV1 = {
      readModelRates: async () => {
        calls.reads += 1;
        if (failing) throw new Error("authority unreachable");
        return tables[0];
      },
      reportUnpricedServedModel: async (input) => {
        calls.reports.push(input);
      },
    };
    return {
      rpc,
      calls,
      fail: (value: boolean) => {
        failing = value;
      },
    };
  }

  test("reads the authority at most once a minute, and shares a read in flight", async () => {
    let now = 0;
    const tables = [seedHostedModelRatesV1("2026-09-24T00:00:00.000Z")];
    const { rpc, calls } = authority(tables);
    const reader = createHostedModelRatesReaderV1(() => rpc, {
      now: () => now,
    });

    await Promise.all([reader.rates(), reader.rates(), reader.limits()]);
    now = 59_999;
    await reader.rates();
    expect(calls.reads).toBe(1);

    tables[0] = { ...tables[0]!, version: 2 };
    now = 60_000;
    expect((await reader.rates()).version).toBe(2);
    expect(calls.reads).toBe(2);
  });

  test("the Gateway's bounds are each route's own", async () => {
    const table = seedHostedModelRatesV1("2026-09-24T00:00:00.000Z");
    table.routes["@frock/small"] = {
      ...table.routes["@frock/auto"]!,
      maximumOutputTokens: 1_024,
    };
    const { rpc } = authority([table]);
    const limits = await createHostedModelRatesReaderV1(() => rpc).limits();
    expect(limits["@frock/auto"]).toEqual({
      inputTokens: 400_000,
      outputTokens: 16_384,
    });
    expect(limits["@frock/small"]).toEqual({
      inputTokens: 400_000,
      outputTokens: 1_024,
    });
  });

  test("keeps pricing from the copy it holds when the authority cannot be read", async () => {
    let now = 0;
    const { rpc, fail } = authority([
      seedHostedModelRatesV1("2026-09-24T00:00:00.000Z"),
    ]);
    const reader = createHostedModelRatesReaderV1(() => rpc, {
      now: () => now,
    });
    await reader.rates();
    fail(true);
    now = 120_000;
    expect((await reader.rates()).version).toBe(1);
  });

  test("a Bot that has never read the table is refused, and tries again next time", async () => {
    const { rpc, calls, fail } = authority([
      seedHostedModelRatesV1("2026-09-24T00:00:00.000Z"),
    ]);
    const reader = createHostedModelRatesReaderV1(() => rpc);
    fail(true);
    await expect(reader.rates()).rejects.toThrow("authority unreachable");
    fail(false);
    expect((await reader.rates()).version).toBe(1);
    expect(calls.reads).toBe(2);
  });

  test("reports an unpriced model once a minute, not once a call", async () => {
    let now = 0;
    const { rpc, calls } = authority([
      seedHostedModelRatesV1("2026-09-24T00:00:00.000Z"),
    ]);
    const reader = createHostedModelRatesReaderV1(() => rpc, {
      now: () => now,
    });
    const report = {
      servedModel: "custom-together/new-model",
      route: "@frock/auto",
      version: 1,
    };
    await reader.reportUnpriced(report);
    await reader.reportUnpriced(report);
    now = 60_000;
    await reader.reportUnpriced(report);
    expect(calls.reports).toEqual([
      { schemaVersion: 1, ...report },
      { schemaVersion: 1, ...report },
    ]);
  });
});
