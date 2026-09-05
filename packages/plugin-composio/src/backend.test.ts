import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  callbackFailureResponse,
  connectionCompletionResponse,
  createComposioBackendContribution as createRoutes,
  createConfiguredComposioBackendContribution,
  decodeAuthorizationState,
  encodeAuthorizationState,
} from "./backend.js";
import type { ComposioClient } from "./composio-client.js";
import {
  ComposioConnectionCoordinator,
  type ComposioConnectionStore,
  type ComposioConnectionCoordinatorConfig,
} from "./connections.js";

function createComposioBackendContribution(
  config: Omit<ComposioConnectionCoordinatorConfig, "store"> & {
    authorizationStateSecret: string;
    storeFor(userId: string): ComposioConnectionStore;
  },
) {
  return createRoutes({
    authorizationStateSecret: config.authorizationStateSecret,
    connectionsFor: (userId) =>
      new ComposioConnectionCoordinator({
        ...config,
        store: config.storeFor(userId),
      }),
  });
}

describe("configured Composio backend", () => {
  const configuredHost = (secrets: Record<string, string>) => ({
    callbackBaseUrl: "https://bot.frockbot.com",
    readSecret: (name: string) => secrets[name],
    composioRequest: async () => undefined,
  });

  test("advertises nothing without a strong dedicated authorization-state secret", async () => {
    const invalidSecrets: Array<Record<string, string>> = [
      {
        COMPOSIO_API_KEY: "api-secret",
        COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-config",
        BETTER_AUTH_SECRET: "unrelated-auth-secret-with-enough-length",
      },
      {
        COMPOSIO_API_KEY: "api-secret",
        COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-config",
        FROCKBOT_AUTHORIZATION_STATE_SECRET: "too-short",
      },
      {
        COMPOSIO_API_KEY: "api-secret",
        COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-config",
        FROCKBOT_AUTHORIZATION_STATE_SECRET:
          "replace-with-an-independent-random-secret",
      },
      {
        COMPOSIO_API_KEY: "api-secret",
        COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-config",
        FROCKBOT_AUTHORIZATION_STATE_SECRET: "x".repeat(32),
      },
      {
        COMPOSIO_API_KEY: "api-secret",
        COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-config",
        FROCKBOT_AUTHORIZATION_STATE_SECRET: "0123456789abcdef".repeat(4),
      },
      {
        COMPOSIO_API_KEY: "api-secret",
        COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-config",
        BETTER_AUTH_SECRET: "shared-trust-authority-secret-0001",
        FROCKBOT_AUTHORIZATION_STATE_SECRET:
          "shared-trust-authority-secret-0001",
      },
    ];
    for (const secrets of invalidSecrets) {
      const contribution = createConfiguredComposioBackendContribution(
        configuredHost(secrets),
      );
      const url = new URL(
        "https://bot.frockbot.com/api/plugins/composio/callback",
      );
      expect(
        await contribution.publicRoute?.(new Request(url), url, {
          client: "browser",
        }),
      ).toBeUndefined();
      expect(
        await contribution.route(new Request(url), url, { client: "browser" }),
      ).toBeUndefined();
    }

    expect(
      createConfiguredComposioBackendContribution(
        configuredHost({
          COMPOSIO_API_KEY: "api-secret",
          COMPOSIO_GMAIL_AUTH_CONFIG_ID: "gmail-config",
          BETTER_AUTH_SECRET: "better-auth-secret-that-is-independent",
          FROCKBOT_AUTHORIZATION_STATE_SECRET:
            "6f0d6ae3ec5c4c448ef2ccdd08b0d4d834422c873244420f8879b6a2e99504fa",
        }),
      ).packageId,
    ).toBe("composio");
  });
});

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

describe("Composio callback failures", () => {
  test("returns the browser to the app with the reason instead of raw JSON", () => {
    const response = callbackFailureResponse(
      new URL("https://bot.frockbot.com/api/plugins/composio/callback"),
      "authorization state has expired",
    );

    expect(response.status).toBe(303);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin).toBe("https://bot.frockbot.com");
    expect(location.pathname).toBe("/");
    expect(location.searchParams.get("connection")).toBe("composio-failed");
    expect(location.searchParams.get("connection_reason")).toBe(
      "authorization state has expired",
    );
  });

  test("keeps a JSON body for the desktop target", async () => {
    const response = callbackFailureResponse(
      new URL("https://bot.frockbot.com/api/plugins/composio/callback"),
      "authorization state has expired",
      "desktop",
    );

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      error: "authorization state has expired",
    });
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

describe("public Connect callback security", () => {
  const secret = "an-independent-random-secret-0123456789";
  function fixture() {
    const calls: Array<{ userId: string; input: unknown }> = [];
    const contribution = createConfiguredComposioBackendContribution({
      readSecret: (name) =>
        name === "COMPOSIO_API_KEY"
          ? "backend-only-secret"
          : name === "FROCKBOT_AUTHORIZATION_STATE_SECRET"
            ? secret
            : undefined,
      composioRequest: async (userId, input) => {
        calls.push({ userId, input });
        return { returnTarget: "browser", status: "ready" };
      },
    });
    return { calls, contribution };
  }
  async function signed(expiresAt = Date.now() + 600_000, key = secret) {
    return encodeAuthorizationState(
      {
        schemaVersion: 1,
        authorizationStateId: "opaque-state",
        userId: "owner",
        connectionId: "opaque-connection",
        returnTarget: "browser",
        expiresAt,
      },
      key,
    );
  }
  test("dispatches before session auth using only verified state identity", async () => {
    const { calls, contribution } = fixture();
    const url = new URL(
      `https://bot.test/api/plugins/composio/callback?connected_account_id=ca_one&user_id=attacker&connectionId=attacker&state=${encodeURIComponent(await signed())}`,
    );
    const response = await contribution.publicRoute!(new Request(url), url, {
      userId: "attacker",
      client: "browser",
    });
    expect(response?.status).toBe(303);
    expect(calls).toEqual([
      {
        userId: "owner",
        input: {
          schemaVersion: 1,
          operation: "complete",
          connectionId: "opaque-connection",
          connectedAccountId: "ca_one",
          authorizationStateId: "opaque-state",
        },
      },
    ]);
    expect(JSON.stringify(calls)).not.toContain("backend-only-secret");
  });
  test("missing, expired, forged, and wrong-method callbacks never resolve a User DO", async () => {
    for (const state of [
      "",
      await signed(Date.now() - 1),
      await signed(Date.now() + 600_000, "another-independent-random-secret"),
    ]) {
      const { calls, contribution } = fixture();
      const url = new URL(
        `https://bot.test/api/plugins/composio/callback?connected_account_id=ca_one&state=${encodeURIComponent(state)}`,
      );
      await contribution.publicRoute!(new Request(url), url, {
        client: "browser",
      });
      expect(calls).toHaveLength(0);
    }
    const { calls, contribution } = fixture();
    const url = new URL(
      `https://bot.test/api/plugins/composio/callback?state=${encodeURIComponent(await signed())}`,
    );
    expect(
      (
        await contribution.publicRoute!(
          new Request(url.toString(), { method: "POST" }),
          url,
          { client: "browser" },
        )
      )?.status,
    ).toBe(405);
    expect(calls).toHaveLength(0);
  });
  test("no API key advertises an empty catalog and no callback", async () => {
    const contribution = createConfiguredComposioBackendContribution({
      readSecret: () => undefined,
    });
    const url = new URL("https://bot.test/api/plugins/composio/catalog");
    const response = await contribution.route(new Request(url), url, {
      userId: "owner",
      client: "browser",
    });
    if (!response) throw new Error("Expected catalog");
    const body: unknown = await response.json();
    expect(body).toEqual({ schemaVersion: 1, items: [] });
    expect(
      await contribution.publicRoute?.(new Request(url), url, {
        client: "browser",
      }),
    ).toBeUndefined();
  });
});
