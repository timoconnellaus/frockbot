import { describe, expect, test } from "bun:test";
import { decodeSessionEvent } from "./types.js";

const base = {
  seq: 1,
  timestamp: "2026-09-02T00:00:00.000Z",
  turn: 1,
  step: 1,
  effectId: "catalog-effect-1",
};

describe("Catalog change session events", () => {
  test("decode the exact install intent and outcome", () => {
    expect(
      decodeSessionEvent({
        ...base,
        type: "package/catalog-change-intent",
        action: "install",
        catalogId: "parcel-tracking",
        contentHash: "a".repeat(64),
      }),
    ).toMatchObject({ action: "install", catalogId: "parcel-tracking" });
    expect(
      decodeSessionEvent({
        ...base,
        type: "package/catalog-changed",
        action: "install",
        packageId: "parcel-tracking",
        contentHash: "a".repeat(64),
        generationId: "generation-2",
      }),
    ).toMatchObject({ packageId: "parcel-tracking" });
  });

  test("refuses mixed install/remove identities and unknown fields", () => {
    expect(() =>
      decodeSessionEvent({
        ...base,
        type: "package/catalog-change-intent",
        action: "remove",
        packageId: "parcel-tracking",
        contentHash: "a".repeat(64),
      }),
    ).toThrow("identity is invalid");
    expect(() =>
      decodeSessionEvent({
        ...base,
        type: "package/catalog-changed",
        action: "remove",
        packageId: "parcel-tracking",
        generationId: "generation-2",
        source: "secret",
      }),
    ).toThrow("invalid fields");
  });
});
