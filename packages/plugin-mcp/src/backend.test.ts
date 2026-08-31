/**
 * The gateway Contribution's authorization routes.
 *
 * The one thing these tests exist to hold down: the callback's identity comes
 * from the signed state and from nowhere else. It is a `publicRoute`, so it
 * runs before the gateway has authenticated anyone, and a query parameter must
 * never be able to name the User whose Durable Object is opened.
 */
import { describe, expect, test } from "bun:test";
import { encodeAuthorizationState } from "@frockbot/connection-core";
import {
  createMcpBackendContribution,
  MCP_CALLBACK_ROUTE,
  MCP_CONNECTIONS_ROUTE,
  type McpAuthorizationCompletionRequestV1,
  type McpAuthorizationStartRequestV1,
} from "./backend.js";

const SECRET = "an-independent-random-secret-0123456789";
const ORIGIN = "https://bot.example.test";

function host(overrides: Record<string, unknown> = {}) {
  const starts: McpAuthorizationStartRequestV1[] = [];
  const completions: Array<{
    userId: string;
    completion: McpAuthorizationCompletionRequestV1;
  }> = [];
  const revocations: Array<{ userId: string; connectionId: string }> = [];
  const contribution = createMcpBackendContribution({
    readMcpServers: () => Promise.reject(new Error("not used")) as never,
    executeMcpCommand: () => Promise.reject(new Error("not used")) as never,
    readSecret: (name) =>
      name === "FROCKBOT_AUTHORIZATION_STATE_SECRET" ? SECRET : undefined,
    startMcpAuthorization: (userId, start) => {
      starts.push(start);
      return Promise.resolve({
        schemaVersion: 1,
        status: "authorization-required",
        connectionId: start.connectionId ?? `mcp-${start.commandId}`,
        redirectUrl: "https://auth.example.test/authorize?state=x",
        expiresAt: new Date(Date.now() + 600_000).toISOString(),
      });
    },
    completeMcpAuthorization: (userId, completion) => {
      completions.push({ userId, completion });
      return Promise.resolve({
        returnTarget: completion.returnTarget,
        status: "ready" as const,
        ...(completion.nativeReturnNonce
          ? { nativeReturnNonce: completion.nativeReturnNonce }
          : {}),
      });
    },
    revokeMcpAuthorization: (userId, connectionId) => {
      revocations.push({ userId, connectionId });
      return Promise.resolve({ schemaVersion: 1, status: "revoked" as const });
    },
    ...overrides,
  });
  return { contribution, starts, completions, revocations };
}

function callbackRequest(query: string) {
  const url = new URL(`${ORIGIN}${MCP_CALLBACK_ROUTE}?${query}`);
  return { request: new Request(url), url };
}

async function state(overrides: Record<string, unknown> = {}) {
  return encodeAuthorizationState(
    {
      schemaVersion: 1,
      authorizationStateId: "auth-state-1",
      userId: "user-1",
      connectionId: "mcp-1",
      returnTarget: "browser",
      expiresAt: Date.now() + 600_000,
      ...overrides,
    } as Parameters<typeof encodeAuthorizationState>[0],
    SECRET,
  );
}

describe("the OAuth callback", () => {
  test("takes its User from the signed state, never from the request", async () => {
    const { contribution, completions } = host();
    const signed = await state();
    const { request, url } = callbackRequest(
      `code=code-1&state=${encodeURIComponent(signed)}&user=someone-else`,
    );

    const response = await contribution.publicRoute!(request, url, {
      // A different User is presented on the context, and it is ignored.
      userId: "attacker",
      client: "browser",
    });

    expect(response!.status).toBe(303);
    expect(response!.headers.get("location")).toBe(
      `${ORIGIN}/?connection=mcp-ready`,
    );
    expect(completions).toHaveLength(1);
    expect(completions[0]!.userId).toBe("user-1");
    expect(completions[0]!.completion).toMatchObject({
      authorizationStateId: "auth-state-1",
      connectionId: "mcp-1",
      code: "code-1",
    });
  });

  test("refuses a forged state", async () => {
    const { contribution, completions } = host();
    const forged = await encodeAuthorizationState(
      {
        schemaVersion: 1,
        authorizationStateId: "auth-state-1",
        userId: "user-2",
        connectionId: "mcp-1",
        returnTarget: "browser",
        expiresAt: Date.now() + 600_000,
      },
      "a-different-independent-random-secret-1",
    );
    const { request, url } = callbackRequest(
      `code=code-1&state=${encodeURIComponent(forged)}`,
    );
    const response = await contribution.publicRoute!(request, url, {
      client: "browser",
    });
    expect(response!.status).toBe(400);
    expect(completions).toHaveLength(0);
  });

  test("refuses an absent state", async () => {
    const { contribution, completions } = host();
    const { request, url } = callbackRequest("code=code-1");
    const response = await contribution.publicRoute!(request, url, {
      client: "browser",
    });
    expect(response!.status).toBe(400);
    expect(completions).toHaveLength(0);
  });

  test("refuses an expired state", async () => {
    const { contribution, completions } = host();
    const signed = await state({ expiresAt: Date.now() - 1_000 });
    const { request, url } = callbackRequest(
      `code=code-1&state=${encodeURIComponent(signed)}`,
    );
    const response = await contribution.publicRoute!(request, url, {
      client: "browser",
    });
    expect(response!.status).toBe(400);
    expect(completions).toHaveLength(0);
  });

  test("carries an authorization-server error through as a failure", async () => {
    const { contribution, completions } = host();
    const signed = await state();
    const { request, url } = callbackRequest(
      `error=access_denied&state=${encodeURIComponent(signed)}`,
    );
    await contribution.publicRoute!(request, url, { client: "browser" });
    expect(completions[0]!.completion).toMatchObject({
      error: "access_denied",
    });
    expect(completions[0]!.completion.code).toBeUndefined();
  });

  test("returns a desktop deep link when the state says so", async () => {
    const { contribution } = host();
    const signed = await state({
      returnTarget: "desktop",
      nativeReturnNonce: "nonce-1",
    });
    const { request, url } = callbackRequest(
      `code=code-1&state=${encodeURIComponent(signed)}`,
    );
    const response = await contribution.publicRoute!(request, url, {
      client: "browser",
    });
    expect(response!.headers.get("location")).toBe(
      "com.frockbot.desktop:/connections?status=ready&nonce=nonce-1",
    );
  });

  test("is the only route exposed publicly", async () => {
    const { contribution } = host();
    const url = new URL(`${ORIGIN}${MCP_CONNECTIONS_ROUTE}`);
    expect(
      await contribution.publicRoute!(
        new Request(url, { method: "POST" }),
        url,
        { client: "browser" },
      ),
    ).toBeUndefined();
  });
});

describe("starting an authorization over the route", () => {
  test("requires a session and mints a state that names that User", async () => {
    const { contribution, starts } = host();
    const url = new URL(`${ORIGIN}${MCP_CONNECTIONS_ROUTE}`);
    const body = {
      schemaVersion: 1,
      type: "connection/start",
      commandId: "connect-1",
      connectionTypeId: "mcp-remote-oauth",
      label: "Example",
      settings: { url: "https://mcp.example.test/mcp" },
    };

    expect(
      (await contribution.route(
        new Request(url, { method: "POST", body: JSON.stringify(body) }),
        url,
        { client: "browser" },
      ))!.status,
    ).toBe(401);

    const response = await contribution.route(
      new Request(url, { method: "POST", body: JSON.stringify(body) }),
      url,
      { userId: "user-1", client: "browser" },
    );
    expect(response!.status).toBe(201);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      commandId: "connect-1",
      redirectUri: `${ORIGIN}${MCP_CALLBACK_ROUTE}`,
      returnTarget: "browser",
    });
    // The signed state is opaque here and never returned to the client except
    // inside the host-authored redirect URL.
    expect(starts[0]!.callbackState.split(".")).toHaveLength(2);
  });

  test("refuses a command with fields this build does not know", async () => {
    const { contribution } = host();
    const url = new URL(`${ORIGIN}${MCP_CONNECTIONS_ROUTE}`);
    const response = await contribution.route(
      new Request(url, {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          type: "connection/start",
          commandId: "connect-1",
          connectionTypeId: "mcp-remote-oauth",
          redirectUrl: "https://attacker.example.test",
        }),
      }),
      url,
      { userId: "user-1", client: "browser" },
    );
    expect(response!.status).toBe(400);
  });

  test("requires a native nonce from a desktop client, and none from a browser", async () => {
    const { contribution } = host();
    const url = new URL(`${ORIGIN}${MCP_CONNECTIONS_ROUTE}`);
    const command = {
      schemaVersion: 1,
      type: "connection/start",
      commandId: "connect-1",
      connectionTypeId: "mcp-remote-oauth",
    };
    expect(
      (await contribution.route(
        new Request(url, { method: "POST", body: JSON.stringify(command) }),
        url,
        { userId: "user-1", client: "desktop" },
      ))!.status,
    ).toBe(400);
    expect(
      (await contribution.route(
        new Request(url, {
          method: "POST",
          body: JSON.stringify({ ...command, nativeReturnNonce: "nonce-1" }),
        }),
        url,
        { userId: "user-1", client: "browser" },
      ))!.status,
    ).toBe(400);
  });
});

describe("revoking over the route", () => {
  test("requires a session, and names the Connection from the path", async () => {
    const { contribution, revocations } = host();
    const url = new URL(`${ORIGIN}/api/plugins/mcp/connections/mcp-1/revoke`);
    const response = await contribution.route(
      new Request(url, { method: "POST" }),
      url,
      { userId: "user-1", client: "browser" },
    );
    expect(await response!.json()).toEqual({
      schemaVersion: 1,
      status: "revoked",
    });
    expect(revocations).toEqual([{ userId: "user-1", connectionId: "mcp-1" }]);
  });
});

describe("a deployment with no signing secret", () => {
  test("has no authorization door at all, rather than an unsigned one", async () => {
    const { contribution } = host({ readSecret: () => undefined });
    for (const path of [
      MCP_CONNECTIONS_ROUTE,
      MCP_CALLBACK_ROUTE,
      "/api/plugins/mcp/connections/mcp-1/revoke",
    ]) {
      const url = new URL(`${ORIGIN}${path}`);
      const response = await contribution.route(
        new Request(url, { method: "POST" }),
        url,
        { userId: "user-1", client: "browser" },
      );
      expect(response!.status).toBe(503);
    }
  });

  test("refuses a secret that is the session secret", async () => {
    const { contribution } = host({
      readSecret: () => SECRET,
    });
    const url = new URL(`${ORIGIN}${MCP_CONNECTIONS_ROUTE}`);
    const response = await contribution.route(
      new Request(url, { method: "POST" }),
      url,
      { userId: "user-1", client: "browser" },
    );
    expect(response!.status).toBe(503);
  });
});
