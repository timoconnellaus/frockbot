import { describe, expect, test } from "bun:test";
import {
  McpUnauthorizedError,
  withMcpSessionV1,
  type McpFetchV1,
} from "./client.js";
import {
  authorizeMcpSignInV1,
  decodeMcpAccessSecretV1,
  discoverMcpSignInV1,
  encodeMcpAccessSecretV1,
  exchangeMcpSignInV1,
  MCP_SIGN_IN_UNAVAILABLE_LINE_V1,
  mcpOAuthClientMetadataV1,
  mcpOAuthRedirectUrisV1,
  mcpOAuthReturnClientV1,
  McpSignInError,
  refreshMcpSignInV1,
  registerMcpClientV1,
  revokeMcpSignInV1,
} from "./oauth.js";
import {
  createFakeMcpAuthorizationServerV1,
  createFakeMcpServerV1,
} from "./testing.js";

const ORIGIN = "https://bot.frockbot.test";
const now = Date.parse("2026-09-24T00:00:00.000Z");

async function challengeOf(fetch: McpFetchV1, url: string) {
  try {
    await withMcpSessionV1({ url, fetch }, async () => undefined);
  } catch (error) {
    if (error instanceof McpUnauthorizedError) return error.challenge;
  }
  throw new Error("expected a refusal");
}

describe("signing in to an MCP server", () => {
  test("discovers, registers, authorizes with PKCE and trades the code once", async () => {
    const auth = createFakeMcpAuthorizationServerV1();
    const challenge = await challengeOf(auth.fetch, auth.server.url);
    expect(challenge).toEqual({
      resourceMetadataUrl:
        "https://mcp.example.test/.well-known/oauth-protected-resource/mcp",
      scope: "tools",
    });
    const server = await discoverMcpSignInV1({
      url: auth.server.url,
      challenge,
      fetch: auth.fetch,
    });
    expect(server).toMatchObject({
      authorizationServerUrl: "https://auth.example.test",
      resource: "https://mcp.example.test/mcp",
      scope: "tools",
      metadata: {
        issuer: "https://auth.example.test",
        registration_endpoint: "https://auth.example.test/register",
        revocation_endpoint: "https://auth.example.test/revoke",
      },
    });
    const client = await registerMcpClientV1({
      server,
      origin: ORIGIN,
      fetch: auth.fetch,
    });
    expect(client).toEqual({
      client_id: "client-1",
      token_endpoint_auth_method: "none",
    });
    // A public client, registered for every page a sign-in may come back to.
    expect(auth.registrations[0]).toMatchObject({
      client_name: "FrockBot",
      token_endpoint_auth_method: "none",
      redirect_uris: mcpOAuthRedirectUrisV1(ORIGIN),
      grant_types: ["authorization_code", "refresh_token"],
    });
    const redirectUri = `${ORIGIN}/api/mcp/oauth/callback/android`;
    const started = await authorizeMcpSignInV1({
      server,
      client,
      redirectUri,
      state: "signed-state",
    });
    const authorize = new URL(started.authorizationUrl);
    expect(authorize.origin + authorize.pathname).toBe(
      "https://auth.example.test/authorize",
    );
    expect(Object.fromEntries(authorize.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: redirectUri,
      state: "signed-state",
      code_challenge_method: "S256",
      resource: "https://mcp.example.test/mcp",
      scope: "tools",
    });
    const back = new URL(auth.approve(started.authorizationUrl));
    const exchange = () =>
      exchangeMcpSignInV1({
        server,
        client,
        code: back.searchParams.get("code")!,
        codeVerifier: started.codeVerifier,
        redirectUri,
        fetch: auth.fetch,
        now,
      });
    const tokens = await exchange();
    expect(tokens).toEqual({
      accessToken: "access-2",
      refreshToken: "refresh-2",
      expiresAt: now + 3_600_000,
    });
    // The code is good once, and the server says so.
    await expect(exchange()).rejects.toThrow("invalid_grant");
    await withMcpSessionV1(
      { url: auth.server.url, token: tokens.accessToken, fetch: auth.fetch },
      async (session) => {
        expect(await session.listTools()).toEqual([]);
      },
    );
  });

  test("refreshes with rotation and revokes", async () => {
    const auth = createFakeMcpAuthorizationServerV1();
    const server = await discoverMcpSignInV1({
      url: auth.server.url,
      fetch: auth.fetch,
    });
    const client = await registerMcpClientV1({
      server,
      origin: ORIGIN,
      fetch: auth.fetch,
    });
    const started = await authorizeMcpSignInV1({
      server,
      client,
      redirectUri: `${ORIGIN}/api/mcp/oauth/callback`,
      state: "s",
    });
    const tokens = await exchangeMcpSignInV1({
      server,
      client,
      code: new URL(auth.approve(started.authorizationUrl)).searchParams.get(
        "code",
      )!,
      codeVerifier: started.codeVerifier,
      redirectUri: `${ORIGIN}/api/mcp/oauth/callback`,
      fetch: auth.fetch,
      now,
    });
    const refreshed = await refreshMcpSignInV1({
      server,
      client,
      refreshToken: tokens.refreshToken!,
      fetch: auth.fetch,
      now,
    });
    expect(refreshed.refreshToken).not.toBe(tokens.refreshToken);
    expect(auth.tokenRequests.at(-1)?.get("resource")).toBe(
      "https://mcp.example.test/mcp",
    );
    // The rotated-out refresh token is dead.
    await expect(
      refreshMcpSignInV1({
        server,
        client,
        refreshToken: tokens.refreshToken!,
        fetch: auth.fetch,
        now,
      }),
    ).rejects.toBeInstanceOf(McpSignInError);
    expect(
      await revokeMcpSignInV1({
        server,
        client,
        token: refreshed.refreshToken!,
        hint: "refresh_token",
        fetch: auth.fetch,
      }),
    ).toBe(true);
    expect(auth.revoked).toEqual([refreshed.refreshToken!]);
  });

  test("uses a client metadata document where the server takes nothing else", async () => {
    const auth = createFakeMcpAuthorizationServerV1();
    auth.clientMetadataDocuments = true;
    auth.registration = false;
    const server = await discoverMcpSignInV1({
      url: auth.server.url,
      fetch: auth.fetch,
    });
    expect(
      await registerMcpClientV1({ server, origin: ORIGIN, fetch: auth.fetch }),
    ).toEqual({ client_id: `${ORIGIN}/api/mcp/oauth/client` });
    expect(auth.registrations).toEqual([]);
    // A local deployment has no https address to be fetched at.
    await expect(
      registerMcpClientV1({
        server,
        origin: "http://127.0.0.1:8787",
        fetch: auth.fetch,
      }),
    ).rejects.toThrow("doesn't let FrockBot register");
    expect(mcpOAuthClientMetadataV1(ORIGIN)).toMatchObject({
      client_id: `${ORIGIN}/api/mcp/oauth/client`,
      redirect_uris: mcpOAuthRedirectUrisV1(ORIGIN),
      token_endpoint_auth_method: "none",
    });
  });

  test("refuses a server with no sign-in, or one FrockBot cannot register with", async () => {
    const plain = createFakeMcpServerV1({ token: "sk" });
    await expect(
      discoverMcpSignInV1({ url: plain.url, fetch: plain.fetch }),
    ).rejects.toThrow(MCP_SIGN_IN_UNAVAILABLE_LINE_V1);
    const auth = createFakeMcpAuthorizationServerV1();
    auth.registration = false;
    const server = await discoverMcpSignInV1({
      url: auth.server.url,
      fetch: auth.fetch,
    });
    await expect(
      registerMcpClientV1({ server, origin: ORIGIN, fetch: auth.fetch }),
    ).rejects.toThrow("doesn't let FrockBot register");
  });

  test("refuses metadata that names another server's resource", async () => {
    const auth = createFakeMcpAuthorizationServerV1();
    const fetch: typeof auth.fetch = async (input, init) => {
      const url = new URL(typeof input === "string" ? input : input.href);
      if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
        return Response.json({
          resource: "https://elsewhere.example.test/mcp",
          authorization_servers: [auth.issuer],
        });
      }
      return auth.fetch(input, init);
    };
    await expect(
      discoverMcpSignInV1({ url: auth.server.url, fetch }),
    ).rejects.toThrow("different server");
  });
});

describe("the sign-in's pieces", () => {
  test("keeps only the access token and its expiry in the leased credential", () => {
    const secret = encodeMcpAccessSecretV1({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: 5,
    });
    expect(secret).not.toContain("refresh");
    expect(decodeMcpAccessSecretV1(secret)).toEqual({
      accessToken: "access",
      expiresAt: 5,
    });
    expect(() => decodeMcpAccessSecretV1("access")).toThrow();
  });

  test("names each return page", () => {
    expect(mcpOAuthReturnClientV1("/api/mcp/oauth/callback")).toBeUndefined();
    expect(mcpOAuthReturnClientV1("/api/mcp/oauth/callback/macos-dev")).toBe(
      "macos-dev",
    );
    expect(mcpOAuthReturnClientV1("/api/mcp/oauth/callback/ios")).toBe("ios");
    expect(
      mcpOAuthReturnClientV1("/api/mcp/oauth/callback/windows"),
    ).toBeNull();
    expect(mcpOAuthRedirectUrisV1(ORIGIN)).toEqual([
      `${ORIGIN}/api/mcp/oauth/callback`,
      `${ORIGIN}/api/mcp/oauth/callback/android`,
      `${ORIGIN}/api/mcp/oauth/callback/macos`,
      `${ORIGIN}/api/mcp/oauth/callback/macos-dev`,
      `${ORIGIN}/api/mcp/oauth/callback/ios`,
      `${ORIGIN}/api/mcp/oauth/callback/ios-dev`,
    ]);
  });
});
