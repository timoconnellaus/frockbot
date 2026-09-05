import { expect, test } from "bun:test";
import {
  TURN_TOOL_CATALOG_INDEX_KEY_V1,
  TURN_TOOL_CATALOG_PIN_PREFIX_V1,
  TURN_TOOL_CATALOG_TOTAL_BYTES_V1,
  TURN_TOOL_CATALOG_TURN_RETENTION_V1,
  turnToolCatalogPin,
  turnToolCatalogPinKeyV1,
  type ToolCatalogPinStorage,
} from "./tool-catalog-pin.js";

function fakeStorage(): {
  storage: ToolCatalogPinStorage;
  values: Map<string, unknown>;
} {
  const values = new Map<string, unknown>();
  const storage: ToolCatalogPinStorage = {
    get: async <T>(key: string) =>
      structuredClone(values.get(key)) as T | undefined,
    put: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    delete: async (key) => values.delete(key),
    transaction: async (fn) => fn(storage),
  };
  return { storage, values };
}

function pinKeys(values: Map<string, unknown>): string[] {
  return [...values.keys()].filter((key) =>
    key.startsWith(TURN_TOOL_CATALOG_PIN_PREFIX_V1),
  );
}

function storedBytes(values: Map<string, unknown>): number {
  return pinKeys(values).reduce(
    (sum, key) =>
      sum +
      new TextEncoder().encode(JSON.stringify(values.get(key))).byteLength,
    0,
  );
}

/** A catalog whose encoded size is close to `bytes`. */
function catalogOf(bytes: number, marker: string): unknown {
  return { marker, filler: "x".repeat(Math.max(0, bytes - 64)) };
}

test("reconstruction keeps the admitted Turn's schemas while new Turns see provider updates", async () => {
  const { storage } = fakeStorage();
  let current = {
    version: "20260905_00",
    inputSchema: { type: "object", required: ["query"] },
  };
  let reads = 0;
  const provider = async () => {
    reads++;
    return structuredClone(current);
  };
  const first = await turnToolCatalogPin(storage, "turn-one")(
    "account",
    provider,
  );
  current = {
    version: "20260906_00",
    inputSchema: { type: "object", required: ["search"] },
  };
  // A fresh host, backed only by durable state, must not consult the provider.
  expect(
    await turnToolCatalogPin(storage, "turn-one")("account", provider),
  ).toEqual(first);
  expect(reads).toBe(1);
  expect(
    await turnToolCatalogPin(storage, "turn-two")("account", provider),
  ).toEqual(current);
  expect(reads).toBe(2);
});

test("the oldest Turns' catalogs are reclaimed rather than accumulating forever", async () => {
  const { storage, values } = fakeStorage();
  const turns = TURN_TOOL_CATALOG_TURN_RETENTION_V1 + 6;
  for (let turn = 0; turn < turns; turn++) {
    await turnToolCatalogPin(storage, `turn-${String(turn).padStart(3, "0")}`)(
      "account",
      async () => catalogOf(400_000, `turn-${turn}`),
    );
  }
  expect(pinKeys(values)).toHaveLength(TURN_TOOL_CATALOG_TURN_RETENTION_V1);
  expect(storedBytes(values)).toBeLessThanOrEqual(
    TURN_TOOL_CATALOG_TOTAL_BYTES_V1,
  );
  // The oldest Turn's key is gone, the newest Turn's is present, and the index
  // reclaimed with them rather than growing a row per Turn forever.
  expect(values.has(turnToolCatalogPinKeyV1("turn-000", "account"))).toBe(
    false,
  );
  expect(
    values.has(
      turnToolCatalogPinKeyV1(
        `turn-${String(turns - 1).padStart(3, "0")}`,
        "account",
      ),
    ),
  ).toBe(true);
  const index = values.get(TURN_TOOL_CATALOG_INDEX_KEY_V1) as {
    entries: unknown[];
  };
  expect(index.entries).toHaveLength(TURN_TOOL_CATALOG_TURN_RETENTION_V1);
});

test("a large catalog reclaims by bytes long before the Bot's storage is exhausted", async () => {
  const { storage, values } = fakeStorage();
  // Nine 900 KB catalogs are more than the aggregate budget allows, so the
  // store settles well under it instead of writing every one of them.
  for (let turn = 0; turn < 9; turn++) {
    await turnToolCatalogPin(storage, `big-turn-${turn}`)("account", async () =>
      catalogOf(900_000, `big-${turn}`),
    );
  }
  expect(storedBytes(values)).toBeLessThanOrEqual(
    TURN_TOOL_CATALOG_TOTAL_BYTES_V1,
  );
  expect(pinKeys(values).length).toBeLessThan(9);
  expect(values.has(turnToolCatalogPinKeyV1("big-turn-0", "account"))).toBe(
    false,
  );
});

test("one Turn asking for more than the whole budget is refused visibly", async () => {
  const { storage, values } = fakeStorage();
  const pin = turnToolCatalogPin(storage, "greedy-turn");
  let connection = 0;
  const write = () =>
    pin(`account-${connection++}`, async () =>
      catalogOf(900_000, `connection-${connection}`),
    );
  // Its own catalogs are never reclaimed to make room for more of its own, so
  // the Turn is refused rather than filling the object.
  await expect(
    (async () => {
      for (let attempt = 0; attempt < 12; attempt++) await write();
    })(),
  ).rejects.toThrow("The Turn's tool catalogs exceed their durable limit");
  expect(storedBytes(values)).toBeLessThanOrEqual(
    TURN_TOOL_CATALOG_TOTAL_BYTES_V1,
  );
});

test("a single catalog over the per-pin limit is refused and stores nothing", async () => {
  const { storage, values } = fakeStorage();
  await expect(
    turnToolCatalogPin(storage, "turn-one")("account", async () =>
      catalogOf(1_200_000, "oversized"),
    ),
  ).rejects.toThrow("The Turn's tool catalog exceeds its limit");
  expect(pinKeys(values)).toHaveLength(0);
});

test("an unreadable index never refuses a Turn and is rebuilt on the next write", async () => {
  const { storage, values } = fakeStorage();
  values.set(TURN_TOOL_CATALOG_INDEX_KEY_V1, { schemaVersion: 9 });
  await turnToolCatalogPin(storage, "turn-one")("account", async () => ({
    tools: [],
  }));
  const index = values.get(TURN_TOOL_CATALOG_INDEX_KEY_V1) as {
    schemaVersion: number;
    entries: Array<{ turnId: string; connectionId: string; bytes: number }>;
  };
  expect(index.schemaVersion).toBe(1);
  expect(index.entries).toEqual([
    { turnId: "turn-one", connectionId: "account", bytes: expect.any(Number) },
  ]);
});
