import { describe, expect, test } from "bun:test";
import {
  decodeConnectionModelCatalogV1,
  decodeRevokeConnectionResultV1,
  decodeStartConnectionResultV1,
} from "./index.js";

describe("Connection result contracts", () => {
  test("bounds advisory model catalogs", () => {
    const model = {
      providerModelId: "model:cloud",
      displayName: "Model",
      capabilities: { tools: false, vision: false, reasoning: false },
      source: "discovered",
    };

    expect(() =>
      decodeConnectionModelCatalogV1({
        schemaVersion: 1,
        generation: "catalog-1",
        state: "fresh",
        models: Array.from({ length: 101 }, () => model),
      }),
    ).toThrow("Connection model catalog is invalid");
  });

  test("requires exact versioned Connection start variants", () => {
    expect(
      decodeStartConnectionResultV1({
        schemaVersion: 1,
        status: "ready",
        connectionId: "gmail-1",
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "ready",
      connectionId: "gmail-1",
    });
    expect(
      decodeStartConnectionResultV1({
        schemaVersion: 1,
        status: "authorization-required",
        connectionId: "gmail-1",
        redirectUrl: "https://connect.example/authorize",
        expiresAt: "2026-08-29T00:05:00.000Z",
      }),
    ).toMatchObject({ status: "authorization-required" });

    for (const result of [
      { schemaVersion: 1, connectionId: "gmail-1" },
      { schemaVersion: 2, status: "ready", connectionId: "gmail-1" },
      {
        schemaVersion: 1,
        status: "ready",
        connectionId: "gmail-1",
        redirectUrl: "https://connect.example/authorize",
      },
    ]) {
      expect(() => decodeStartConnectionResultV1(result)).toThrow(
        "Connection result is invalid",
      );
    }
  });

  test("requires an exact versioned revocation result", () => {
    expect(
      decodeRevokeConnectionResultV1({
        schemaVersion: 1,
        status: "revoked",
      }),
    ).toEqual({ schemaVersion: 1, status: "revoked" });
    for (const result of [
      { status: "revoked" },
      { schemaVersion: 2, status: "revoked" },
      { schemaVersion: 1, status: "revoked", extra: true },
    ]) {
      expect(() => decodeRevokeConnectionResultV1(result)).toThrow(
        "revocation result is invalid",
      );
    }
  });
});
