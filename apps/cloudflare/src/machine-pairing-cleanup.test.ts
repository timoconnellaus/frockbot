import { expect, test } from "bun:test";
import {
  MACHINE_PAIRING_CLEANUP_RECEIPT_KEY,
  cleanRetiredMachinePairingsV1,
  type MachinePairingCleanupStorageV1,
} from "./machine-pairing-cleanup.js";

function fixture(entries: [string, unknown][]) {
  const values = new Map(entries);
  let lists = 0;
  const storage: MachinePairingCleanupStorageV1 = {
    async get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    async put(key, value) {
      values.set(key, value);
    },
    async delete(keys) {
      return keys.filter((key) => values.delete(key)).length;
    },
    async list<T>(options: { prefix: string; limit: number }) {
      lists++;
      const keys = [...values.keys()]
        .filter((key) => key.startsWith(options.prefix))
        .sort()
        .slice(0, options.limit);
      return new Map(keys.map((key) => [key, values.get(key) as T]));
    },
  };
  return { values, storage, lists: () => lists };
}

test("deletes every unspent pairing offer and nothing else, once", async () => {
  const offers: [string, unknown][] = Array.from({ length: 300 }, (_, i) => [
    `machine-pair:m-${i}`,
    { schemaVersion: 1, machineId: `m-${i}` },
  ]);
  const machine = { schemaVersion: 1, machineId: "m-kept" };
  const { values, storage, lists } = fixture([
    ...offers,
    ["machine:m-kept", machine],
    ["machine-queue:m-kept:0001", { commandId: "c" }],
  ]);

  await cleanRetiredMachinePairingsV1(
    storage,
    new Date("2026-09-30T00:00:00.000Z"),
  );

  expect(
    [...values.keys()].filter((key) => key.startsWith("machine-pair:")),
  ).toEqual([]);
  expect(values.get("machine:m-kept")).toEqual(machine);
  expect(values.has("machine-queue:m-kept:0001")).toBe(true);
  expect(values.get(MACHINE_PAIRING_CLEANUP_RECEIPT_KEY)).toEqual({
    at: "2026-09-30T00:00:00.000Z",
    removed: 300,
  });

  const walked = lists();
  values.set("machine-pair:late", {});
  await cleanRetiredMachinePairingsV1(storage);
  expect(lists()).toBe(walked);
});
