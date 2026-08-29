import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  connectionCompletionResponse,
  createComposioBackendContribution,
  decodeAuthorizationState,
  encodeAuthorizationState,
} from "./backend.js";
import type { ComposioClient } from "./composio-client.js";
import type { ComposioConnectionStore } from "./connections.js";

describe("Composio authorization return handoff", () => {
  test("returns desktop authorization to the fixed native protocol", () => {
    const response = connectionCompletionResponse(
      new URL("https://bot.frockbot.com/api/plugins/composio/callback"),
      "desktop",
      "ready",
      "native-1",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(
      "com.frockbot.desktop:/connections?status=ready&nonce=native-1",
    );
  });

  test("returns browser authorization to the hosted application", () => {
    const response = connectionCompletionResponse(
      new URL("https://bot.frockbot.com/api/plugins/composio/callback"),
      "browser",
      "failed",
    );
    expect(response.headers.get("location")).toBe(
      "https://bot.frockbot.com/?connection=composio-failed",
    );
  });

  test("signs desktop state over User, Connection, and native return nonce", async () => {
    const state = await encodeAuthorizationState(
      {
        schemaVersion: 1,
        authorizationStateId: "state-1",
        userId: "user-1",
        connectionId: "connection-1",
        returnTarget: "desktop",
        expiresAt: Date.now() + 60_000,
        nativeReturnNonce: "native-1",
      },
      "state-secret",
    );
    await expect(
      decodeAuthorizationState(state, "state-secret"),
    ).resolves.toMatchObject({
      userId: "user-1",
      connectionId: "connection-1",
      nativeReturnNonce: "native-1",
    });
    const [payload, signature] = state.split(".");
    if (!payload || !signature) throw new Error("expected signed state parts");
    const tamperedSignature = `${signature[0] === "a" ? "b" : "a"}${signature.slice(1)}`;
    await expect(
      decodeAuthorizationState(
        `${payload}.${tamperedSignature}`,
        "state-secret",
      ),
    ).rejects.toThrow("invalid");
  });
});

describe("Composio revoke route", () => {
  test("rejects invalid Connection identifiers before resolving storage", async () => {
    let storeLookups = 0;
    const contribution = createComposioBackendContribution({
      client: {} as ComposioClient,
      callbackBaseUrl: "https://bot.frockbot.com",
      authorizationStateSecret: "state-secret",
      connectionTypes: {},
      storeFor() {
        storeLookups += 1;
        throw new Error("invalid routes must not resolve storage");
      },
    });
    const invalidIdentifiers = [
      "%",
      "invalid%2Fidentifier",
      "-leading-hyphen",
      "a".repeat(129),
      "constructor",
      "prototype",
      "__proto__",
    ];

    for (const identifier of invalidIdentifiers) {
      const url = new URL(
        `https://bot.frockbot.com/api/plugins/composio/connections/${identifier}/revoke`,
      );
      const response = await contribution.route(
        new Request(url, { method: "POST" }),
        url,
        { userId: "user-1", client: "browser" },
      );
      expect(response?.status).toBe(400);
      if (!response) throw new Error("Composio revoke route was not handled");
      const body: unknown = await response.json();
      expect(body).toEqual({ error: "connectionId is invalid" });
    }
    expect(storeLookups).toBe(0);
  });

  test("passes one decoded valid Connection identifier to revocation", async () => {
    let claimedConnectionId: string | undefined;
    const connection: ConnectionView = {
      connectionId: "connection-1",
      packageId: "composio",
      connectionTypeId: "gmail",
      displayName: "Gmail",
      state: "revoked",
      safeMetadata: {},
    };
    const store = {
      claimConnectionRevocation(_userId: string, connectionId: string) {
        claimedConnectionId = connectionId;
        return Promise.resolve({ phase: "done" as const, connection });
      },
    } as unknown as ComposioConnectionStore;
    const contribution = createComposioBackendContribution({
      client: {} as ComposioClient,
      callbackBaseUrl: "https://bot.frockbot.com",
      authorizationStateSecret: "state-secret",
      connectionTypes: {},
      storeFor: () => store,
    });
    const url = new URL(
      "https://bot.frockbot.com/api/plugins/composio/connections/connection%2D1/revoke",
    );

    const response = await contribution.route(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          schemaVersion: 1,
          type: "connection/revoke",
        }),
      }),
      url,
      { userId: "user-1", client: "browser" },
    );

    expect(response?.status).toBe(200);
    if (!response) throw new Error("Composio revoke route was not handled");
    const body: unknown = await response.json();
    expect(body).toEqual({ schemaVersion: 1, status: "revoked" });
    expect(claimedConnectionId).toBe("connection-1");
  });
});

describe("Composio Connection start route", () => {
  test("rejects reserved and unconfigured identifiers before resolving storage", async () => {
    let storeLookups = 0;
    const contribution = createComposioBackendContribution({
      client: {} as ComposioClient,
      callbackBaseUrl: "https://bot.frockbot.com",
      authorizationStateSecret: "state-secret",
      connectionTypes: {
        gmail: {
          authConfigId: "gmail-auth",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
      storeFor() {
        storeLookups += 1;
        throw new Error("invalid routes must not resolve storage");
      },
    });
    const invalidCommands = [
      { commandId: "__proto__", connectionTypeId: "gmail" },
      { commandId: "constructor", connectionTypeId: "gmail" },
      { commandId: "connection-1", connectionTypeId: "constructor" },
      { commandId: "connection-1", connectionTypeId: "prototype" },
      { commandId: "connection-1", connectionTypeId: "__proto__" },
      { commandId: "connection-1", connectionTypeId: "unconfigured" },
    ];

    for (const input of invalidCommands) {
      const url = new URL(
        "https://bot.frockbot.com/api/plugins/composio/connections",
      );
      const response = await contribution.route(
        new Request(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            type: "connection/start",
            ...input,
          }),
        }),
        url,
        { userId: "user-1", client: "browser" },
      );
      expect(response?.status).toBe(400);
    }
    expect(storeLookups).toBe(0);
  });

  test("rejects unsupported and inexact command envelopes before storage", async () => {
    let storeLookups = 0;
    const contribution = createComposioBackendContribution({
      client: {} as ComposioClient,
      callbackBaseUrl: "https://bot.frockbot.com",
      authorizationStateSecret: "state-secret",
      connectionTypes: {
        gmail: {
          authConfigId: "gmail-auth",
          displayName: "Gmail",
          toolkitSlug: "gmail",
        },
      },
      storeFor() {
        storeLookups += 1;
        throw new Error("invalid commands must not resolve storage");
      },
    });
    for (const body of [
      {
        schemaVersion: 2,
        type: "connection/start",
        commandId: "connection-1",
        connectionTypeId: "gmail",
      },
      {
        schemaVersion: 1,
        type: "connection/start",
        commandId: "connection-1",
        connectionTypeId: "gmail",
        extra: true,
      },
    ]) {
      const url = new URL(
        "https://bot.frockbot.com/api/plugins/composio/connections",
      );
      const response = await contribution.route(
        new Request(url, { method: "POST", body: JSON.stringify(body) }),
        url,
        { userId: "user-1", client: "browser" },
      );
      expect(response?.status).toBe(400);
    }
    const revokeUrl = new URL(
      "https://bot.frockbot.com/api/plugins/composio/connections/connection-1/revoke",
    );
    const revokeResponse = await contribution.route(
      new Request(revokeUrl, {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          type: "connection/revoke",
          extra: true,
        }),
      }),
      revokeUrl,
      { userId: "user-1", client: "browser" },
    );
    expect(revokeResponse?.status).toBe(400);
    expect(storeLookups).toBe(0);
  });
});
