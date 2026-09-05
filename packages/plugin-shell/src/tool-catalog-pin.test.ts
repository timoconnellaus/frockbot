import { expect, test } from "bun:test";
import {
  turnToolCatalogPin,
  type ToolCatalogPinStorage,
} from "./tool-catalog-pin.js";

test("reconstruction keeps the admitted Turn's schemas while new Turns see provider updates", async () => {
  const values = new Map<string, unknown>();
  const storage: ToolCatalogPinStorage = {
    get: async <T>(key: string) =>
      structuredClone(values.get(key)) as T | undefined,
    put: async (key, value) => {
      values.set(key, structuredClone(value));
    },
    transaction: async (fn) => fn(storage),
  };
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
