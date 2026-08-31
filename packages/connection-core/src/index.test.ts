import { describe, expect, test } from "bun:test";
import {
  ConnectionDependencyRouter,
  decodeConnectionCommandIdV1,
  decodeConnectionCommandV1,
  decodeConnectionDependencyCommandV1,
  decodeConnectionDependencyResultV1,
  decodeConnectionModelCatalogV1,
  decodeRevokeConnectionResultV1,
  decodeStartConnectionResultV1,
  type ConnectionDependencyCommandV1,
} from "./index.js";

describe("Connection result contracts", () => {
  test("uses one recoverable command ID contract", () => {
    expect(decodeConnectionCommandIdV1("command-1")).toBe("command-1");
    expect(() =>
      decodeConnectionCommandV1({
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId: "lost response",
        connectionId: "connection-1",
      }),
    ).toThrow("commandId is invalid");
    expect(() => decodeConnectionCommandIdV1("lost response")).toThrow(
      "commandId is invalid",
    );
  });

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

  test("strictly decodes provider-neutral dependency commands and results", () => {
    const claim = {
      schemaVersion: 1,
      action: "claim",
      operationId: "operation-1",
      userId: "user-1",
      packageId: "mail",
      connectionId: "connection-1",
      botId: "bot-1",
      generation: "generation-1",
      requirement: {
        schemaVersion: 1,
        packageId: "mail",
        packageVersion: "1.0.0",
        capabilityId: "send",
        connectionTypeIds: ["oauth"],
      },
    } as const satisfies Extract<
      ConnectionDependencyCommandV1,
      { action: "claim" }
    >;
    expect(decodeConnectionDependencyCommandV1(claim)).toEqual(claim);
    expect(
      decodeConnectionDependencyResultV1({
        schemaVersion: 1,
        status: "pending",
        failure: "provider response is uncertain",
      }),
    ).toMatchObject({ status: "pending" });
    for (const invalid of [
      { ...claim, extra: true },
      { ...claim, requirement: { ...claim.requirement, extra: true } },
      { schemaVersion: 1, status: "claimed", failure: "not allowed" },
    ]) {
      expect(() =>
        "action" in invalid
          ? decodeConnectionDependencyCommandV1(invalid)
          : decodeConnectionDependencyResultV1(invalid),
      ).toThrow();
    }
  });

  test("routes only to a registered Connection-owning Contribution", async () => {
    const router = new ConnectionDependencyRouter();
    const command = {
      schemaVersion: 1,
      action: "read",
      operationId: "operation-1",
      userId: "user-1",
      packageId: "mail",
      connectionId: "connection-1",
      botId: "bot-1",
      generation: "generation-1",
    } as const;
    await expect(router.execute("missing", command)).resolves.toMatchObject({
      status: "unavailable",
    });
    const calls: unknown[] = [];
    router.register({
      packageId: "mail",
      executeDependency: (input) => {
        calls.push(input);
        return Promise.resolve({ schemaVersion: 1, status: "released" });
      },
    });
    await expect(router.execute("mail", command)).resolves.toMatchObject({
      status: "released",
    });
    expect(calls).toEqual([command]);
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
