import { describe, expect, test } from "bun:test";
import {
  AUTHORING_QUOTA_CONFIG_KEY,
  AUTHORING_QUOTA_DEFAULTS_V1,
  authoringQuotaCounterKey,
  authoringQuotaDayV1,
  decodeAuthoringQuotaConfigV1,
  decodeAuthoringQuotaReceiptV1,
  reserveAuthoringQuotaV1,
  type AuthoringQuotaStorage,
} from "./quota.ts";

function storage(initial: Record<string, unknown> = {}) {
  const values = new Map<string, unknown>(Object.entries(initial));
  // Durable Object transactions are serialized; this fake is too, so a
  // read-modify-write that is *not* wrapped in one can interleave here exactly
  // as it would in the object.
  let queue: Promise<unknown> = Promise.resolve();
  const store: AuthoringQuotaStorage & { values: Map<string, unknown> } = {
    values,
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
    put: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
    transaction: <T>(
      callback: (storage: AuthoringQuotaStorage) => Promise<T>,
    ) => {
      const run = queue.then(() => callback(store));
      queue = run.then(
        () => undefined,
        () => undefined,
      );
      return run;
    },
  };
  return store;
}

const REQUEST = {
  schemaVersion: 1 as const,
  userId: "user-1",
  botId: "bot-1",
  effectId: "author-0123456789abcdef",
  day: "2026-08-31",
  sourceBytes: 1_024,
  retainedGenerations: 3,
};

describe("the durable per-User authoring quota", () => {
  test("defaults to 50 retained generations, 100 a day, and 256 KB of source", () => {
    expect(AUTHORING_QUOTA_DEFAULTS_V1).toEqual({
      schemaVersion: 1,
      retainedGenerationsPerBot: 50,
      authoredPerUserPerDay: 100,
      maxSourceBytes: 256 * 1024,
    });
    expect(decodeAuthoringQuotaConfigV1(undefined)).toEqual(
      AUTHORING_QUOTA_DEFAULTS_V1,
    );
  });

  test("reserves a unit and counts it under quota:generations:<yyyy-mm-dd>", async () => {
    const store = storage();
    const receipt = await reserveAuthoringQuotaV1(store, REQUEST);

    expect(receipt).toMatchObject({ status: "reserved", used: 1, limit: 100 });
    expect(store.values.get(authoringQuotaCounterKey("2026-08-31"))).toEqual({
      day: "2026-08-31",
      count: 1,
    });
  });

  test("admits exactly one of two concurrent reservations at the limit", async () => {
    const store = storage({
      [AUTHORING_QUOTA_CONFIG_KEY]: {
        ...AUTHORING_QUOTA_DEFAULTS_V1,
        authoredPerUserPerDay: 100,
      },
      [authoringQuotaCounterKey("2026-08-31")]: {
        day: "2026-08-31",
        count: 99,
      },
    });

    // The counter is a read-modify-write across awaits; without a transaction
    // both reservations read 99 and both admit.
    const [first, second] = await Promise.all([
      reserveAuthoringQuotaV1(store, { ...REQUEST, effectId: "author-race-a" }),
      reserveAuthoringQuotaV1(store, { ...REQUEST, effectId: "author-race-b" }),
    ]);

    expect(
      [first.status, second.status].filter((status) => status === "reserved"),
    ).toHaveLength(1);
    expect(
      [first, second].filter((receipt) => receipt.status === "refused"),
    ).toMatchObject([{ limitName: "authored-per-day" }]);
    expect(store.values.get(authoringQuotaCounterKey("2026-08-31"))).toEqual({
      day: "2026-08-31",
      count: 100,
    });
  });

  test("is idempotent on the authoring effect id", async () => {
    const store = storage();
    const first = await reserveAuthoringQuotaV1(store, REQUEST);
    const second = await reserveAuthoringQuotaV1(store, REQUEST);

    expect(second).toEqual(first);
    expect(store.values.get(authoringQuotaCounterKey("2026-08-31"))).toEqual({
      day: "2026-08-31",
      count: 1,
    });
  });

  test("refuses rather than throws when the daily generation quota is spent", async () => {
    const store = storage({
      [AUTHORING_QUOTA_CONFIG_KEY]: {
        ...AUTHORING_QUOTA_DEFAULTS_V1,
        authoredPerUserPerDay: 2,
      },
    });
    await reserveAuthoringQuotaV1(store, { ...REQUEST, effectId: "author-a" });
    await reserveAuthoringQuotaV1(store, { ...REQUEST, effectId: "author-b" });
    const refused = await reserveAuthoringQuotaV1(store, {
      ...REQUEST,
      effectId: "author-c",
    });

    expect(refused).toMatchObject({
      status: "refused",
      limitName: "authored-per-day",
      used: 2,
      limit: 2,
    });
    expect(store.values.get(authoringQuotaCounterKey("2026-08-31"))).toEqual({
      day: "2026-08-31",
      count: 2,
    });
  });

  test("refuses source beyond the per-Package byte quota", async () => {
    const refused = await reserveAuthoringQuotaV1(storage(), {
      ...REQUEST,
      sourceBytes: 256 * 1024 + 1,
    });
    expect(refused).toMatchObject({
      status: "refused",
      limitName: "source-bytes",
    });
  });

  test("refuses once the Bot holds its retained-generation allowance", async () => {
    const refused = await reserveAuthoringQuotaV1(storage(), {
      ...REQUEST,
      retainedGenerations: 50,
    });
    expect(refused).toMatchObject({
      status: "refused",
      limitName: "retained-generations",
      limit: 50,
    });
  });

  test("replays a refusal instead of letting a retry through", async () => {
    const store = storage();
    const first = await reserveAuthoringQuotaV1(store, {
      ...REQUEST,
      sourceBytes: 256 * 1024 + 1,
    });
    const second = await reserveAuthoringQuotaV1(store, {
      ...REQUEST,
      sourceBytes: 1,
    });
    expect(second).toEqual(first);
  });

  test("decodes its receipt at the Durable Object RPC seam", () => {
    expect(
      decodeAuthoringQuotaReceiptV1({
        schemaVersion: 1,
        status: "reserved",
        effectId: "author-a",
        day: "2026-08-31",
        used: 1,
        limit: 100,
      }).status,
    ).toBe("reserved");
    expect(() =>
      decodeAuthoringQuotaReceiptV1({ schemaVersion: 2, status: "reserved" }),
    ).toThrow();
    expect(() =>
      decodeAuthoringQuotaReceiptV1({
        schemaVersion: 1,
        status: "refused",
        effectId: "author-a",
        day: "2026-08-31",
        limitName: "unknown-limit",
        reason: "no",
        used: 1,
        limit: 1,
      }),
    ).toThrow();
  });

  test("names the counter day in UTC", () => {
    expect(authoringQuotaDayV1(new Date("2026-08-31T23:59:59.999Z"))).toBe(
      "2026-08-31",
    );
    expect(() => authoringQuotaCounterKey("31-08-2026")).toThrow();
  });
});
