import { expect, test } from "bun:test";
import {
  DEFAULT_PACKAGES_MARKER_CLEANUP_RECEIPT_KEY,
  DEFAULT_PACKAGES_MARKER_KEY,
  cleanDefaultPackagesMarkerV1,
  isRetiredDefaultPackagesMarker,
} from "./default-packages-marker-cleanup.js";

function fixture(entries: [string, unknown][] = []) {
  const values = new Map(entries);
  const tx = {
    async get(key: string) {
      return values.get(key);
    },
    async put(key: string, value: unknown) {
      values.set(key, value);
    },
    async delete(key: string) {
      return values.delete(key);
    },
  };
  const storage = {
    async get(key: string) {
      return values.get(key);
    },
    async transaction(body: (storage: unknown) => Promise<void>) {
      await body(tx);
    },
  } as unknown as DurableObjectStorage;
  return { values, storage };
}

test("retired markers are exactly the pre-ledger schemaVersion objects", () => {
  expect(isRetiredDefaultPackagesMarker({ schemaVersion: 1 })).toBe(true);
  expect(isRetiredDefaultPackagesMarker({ schemaVersion: 2 })).toBe(true);
  expect(isRetiredDefaultPackagesMarker({ schemaVersion: 3 })).toBe(true);
  expect(
    isRetiredDefaultPackagesMarker({
      schemaVersion: 4,
      seededPackageIds: ["web"],
    }),
  ).toBe(false);
  expect(isRetiredDefaultPackagesMarker({ schemaVersion: 4 })).toBe(false);
  expect(isRetiredDefaultPackagesMarker(undefined)).toBe(false);
});

test("constructor cleanup deletes a retired marker once and leaves a v4 ledger", async () => {
  const { values, storage } = fixture([
    [DEFAULT_PACKAGES_MARKER_KEY, { schemaVersion: 2 }],
    ["user-configuration", { schemaVersion: 1, revision: 38 }],
  ]);

  await cleanDefaultPackagesMarkerV1(
    storage,
    new Date("2026-09-20T00:00:00.000Z"),
  );
  expect(values.has(DEFAULT_PACKAGES_MARKER_KEY)).toBe(false);
  expect(values.get("user-configuration")).toEqual({
    schemaVersion: 1,
    revision: 38,
  });
  expect(values.get(DEFAULT_PACKAGES_MARKER_CLEANUP_RECEIPT_KEY)).toEqual({
    at: "2026-09-20T00:00:00.000Z",
    removed: true,
  });

  values.set(DEFAULT_PACKAGES_MARKER_KEY, { schemaVersion: 1 });
  await cleanDefaultPackagesMarkerV1(storage);
  expect(values.get(DEFAULT_PACKAGES_MARKER_KEY)).toEqual({
    schemaVersion: 1,
  });
});

test("a v4 ledger and a missing marker are left alone", async () => {
  const ledger = {
    schemaVersion: 4,
    seededPackageIds: ["web"],
  };
  const withLedger = fixture([[DEFAULT_PACKAGES_MARKER_KEY, ledger]]);
  await cleanDefaultPackagesMarkerV1(withLedger.storage);
  expect(withLedger.values.get(DEFAULT_PACKAGES_MARKER_KEY)).toEqual(ledger);
  expect(
    withLedger.values.get(DEFAULT_PACKAGES_MARKER_CLEANUP_RECEIPT_KEY),
  ).toEqual({
    at: expect.any(String),
    removed: false,
  });

  const empty = fixture();
  await cleanDefaultPackagesMarkerV1(empty.storage);
  expect(empty.values.has(DEFAULT_PACKAGES_MARKER_KEY)).toBe(false);
  expect(
    empty.values.get(DEFAULT_PACKAGES_MARKER_CLEANUP_RECEIPT_KEY),
  ).toMatchObject({ removed: false });
});
