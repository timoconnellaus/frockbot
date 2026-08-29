import { describe, expect, test } from "bun:test";
import { randomSheepRecipeV1 } from "../shared.js";
import {
  clearPendingSheep,
  isDefinitiveFlockFailure,
  pendingCreateKey,
  pendingSheepKey,
  readPendingCreate,
  readPendingSheep,
  writePendingCreate,
  writePendingSheep,
} from "./pending-create.js";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  };
}

const sheep = randomSheepRecipeV1(() => 0);
const command = {
  schemaVersion: 1 as const,
  type: "bot/create" as const,
  commandId: "create-1",
  expectedRevision: 0,
  botId: "alpha",
  name: "Alpha",
  sheep,
};

describe("pending Flock commands", () => {
  test("binds uncertain Bot creation to the authenticated User", () => {
    const storage = memoryStorage();
    writePendingCreate("user-a", command, storage);
    expect(readPendingCreate("user-a", storage)).toEqual(command);
    expect(readPendingCreate("user-b", storage)).toBeUndefined();
    expect(storage.values.get(pendingCreateKey("user-a"))).toBe(
      JSON.stringify(command),
    );
  });

  test("persists the exact sheep command for lost-response replay", () => {
    const storage = memoryStorage();
    const update = {
      schemaVersion: 1 as const,
      type: "bot/update-sheep" as const,
      commandId: "sheep-1",
      expectedRevision: 3,
      botId: "alpha",
      sheep,
    };
    writePendingSheep("user-a", update, storage);
    expect(readPendingSheep("user-a", "alpha", storage)).toEqual(update);
    expect(readPendingSheep("user-b", "alpha", storage)).toBeUndefined();
    clearPendingSheep("user-a", "alpha", storage);
    expect(storage.values.has(pendingSheepKey("user-a", "alpha"))).toBe(false);
  });

  test("discards malformed state and classifies only explicit failures", () => {
    const storage = memoryStorage();
    storage.values.set(pendingCreateKey("user-a"), "{}");
    expect(readPendingCreate("user-a", storage)).toBeUndefined();
    expect(storage.values.has(pendingCreateKey("user-a"))).toBe(false);
    expect(isDefinitiveFlockFailure({ definitive: true })).toBe(true);
    expect(isDefinitiveFlockFailure(new Error("network"))).toBe(false);
  });
});
