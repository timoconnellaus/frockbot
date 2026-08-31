import { describe, expect, test } from "bun:test";
import {
  createPkcePairV1,
  decodeMcpAuthorizationServerMetadataV1,
  decodeMcpProtectedResourceMetadataV1,
  McpAuthorizationError,
  McpOAuthClient,
  mcpAuthorizationServerMetadataUrlsV1,
  mcpAuthorizeUrlV1,
  mcpCanonicalResourceV1,
  mcpCodeChallengeV1,
  mcpResourceMetadataUrlsV1,
  parseResourceMetadataChallengeV1,
} from "./oauth.js";
import type { McpFetch } from "./mcp-client.js";

const ISSUER = "https://auth.example.test";

function metadata(overrides: Record<string, unknown> = {}) {
  return {
    issuer: ISSUER,
    authorization_endpoint: `${ISSUER}/authorize`,
    token_endpoint: `${ISSUER}/token`,
    registration_endpoint: `${ISSUER}/register`,
    revocation_endpoint: `${ISSUER}/revoke`,
    code_challenge_methods_supported: ["S256"],
    ...overrides,
  };
}

describe("discovery URLs", () => {
  test("insert the server's path after the well-known segment, then fall back", () => {
    expect(
      mcpResourceMetadataUrlsV1(new URL("https://mcp.example.test/tenant/mcp")),
    ).toEqual([
      "https://mcp.example.test/.well-known/oauth-protected-resource/tenant/mcp",
      "https://mcp.example.test/.well-known/oauth-protected-resource",
    ]);
  });

  test("collapse to the two bare documents for a server at the origin", () => {
    expect(
      mcpResourceMetadataUrlsV1(new URL("https://mcp.example.test/")),
    ).toEqual([
      "https://mcp.example.test/.well-known/oauth-protected-resource",
    ]);
  });

  test("try RFC 8414 insertion, then both OpenID variants, for a path issuer", () => {
    expect(
      mcpAuthorizationServerMetadataUrlsV1(new URL(`${ISSUER}/tenant`)),
    ).toEqual([
      `${ISSUER}/.well-known/oauth-authorization-server/tenant`,
      `${ISSUER}/.well-known/openid-configuration/tenant`,
      `${ISSUER}/tenant/.well-known/openid-configuration`,
    ]);
  });
});

describe("protected resource metadata", () => {
  test("is refused when it names no authorization server", () => {
    expect(() =>
      decodeMcpProtectedResourceMetadataV1({
        resource: "https://mcp.example.test/mcp",
      }),
    ).toThrow(/no authorization server/);
  });

  test("is refused when it names no resource", () => {
    expect(() =>
      decodeMcpProtectedResourceMetadataV1({
        authorization_servers: [ISSUER],
      }),
    ).toThrow(/no resource/);
  });
});

describe("authorization server metadata", () => {
  test("is refused when the issuer is not the one it was fetched for", () => {
    expect(() =>
      decodeMcpAuthorizationServerMetadataV1(
        metadata({ issuer: "https://elsewhere.example.test" }),
        ISSUER,
      ),
    ).toThrow(/not the issuer it was fetched for/);
  });

  test("is refused when an endpoint sits on another origin", () => {
    for (const key of [
      "authorization_endpoint",
      "token_endpoint",
      "registration_endpoint",
      "revocation_endpoint",
    ]) {
      expect(() =>
        decodeMcpAuthorizationServerMetadataV1(
          metadata({ [key]: "https://elsewhere.example.test/x" }),
          ISSUER,
        ),
      ).toThrow(/different origin from its issuer/);
    }
  });

  test("is refused when an endpoint is not https", () => {
    expect(() =>
      decodeMcpAuthorizationServerMetadataV1(
        metadata({ token_endpoint: "http://auth.example.test/token" }),
        ISSUER,
      ),
    ).toThrow(/token endpoint is invalid/);
  });

  test("is refused when an endpoint names a private address", () => {
    expect(() =>
      decodeMcpAuthorizationServerMetadataV1(
        { ...metadata(), issuer: "https://127.0.0.1", token_endpoint: "x" },
        "https://127.0.0.1",
      ),
    ).toThrow(/invalid/);
  });

  test("is refused when the server does not advertise S256 PKCE", () => {
    expect(() =>
      decodeMcpAuthorizationServerMetadataV1(
        metadata({ code_challenge_methods_supported: ["plain"] }),
        ISSUER,
      ),
    ).toThrow(/S256/);
    expect(() =>
      decodeMcpAuthorizationServerMetadataV1(
        metadata({ code_challenge_methods_supported: undefined }),
        ISSUER,
      ),
    ).toThrow(/S256/);
  });

  test("decodes a well-formed document", () => {
    expect(
      decodeMcpAuthorizationServerMetadataV1(metadata(), ISSUER),
    ).toMatchObject({
      issuer: ISSUER,
      tokenEndpoint: `${ISSUER}/token`,
      revocationEndpoint: `${ISSUER}/revoke`,
    });
  });
});

describe("PKCE", () => {
  test("produces an S256 challenge that is the base64url SHA-256 of the verifier", async () => {
    const pair = await createPkcePairV1();
    expect(pair.codeChallengeMethod).toBe("S256");
    expect(pair.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(pair.codeChallenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await mcpCodeChallengeV1(pair.codeVerifier)).toBe(
      pair.codeChallenge,
    );
  });

  test("matches the RFC 7636 appendix B vector", async () => {
    expect(
      await mcpCodeChallengeV1("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"),
    ).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });

  test("gives a different verifier every time", async () => {
    const first = await createPkcePairV1();
    const second = await createPkcePairV1();
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });
});

describe("the resource indicator", () => {
  test("is the canonical server URI: lowercased, no query, no trailing slash", () => {
    expect(
      mcpCanonicalResourceV1(new URL("HTTPS://MCP.Example.Test/mcp/?x=1#y")),
    ).toBe("https://mcp.example.test/mcp");
  });

  test("is on the authorization request, beside the PKCE challenge", () => {
    const url = new URL(
      mcpAuthorizeUrlV1({
        authorizationEndpoint: `${ISSUER}/authorize`,
        clientId: "client-1",
        redirectUri: "https://bot.example.test/callback",
        state: "signed-state",
        codeChallenge: "challenge",
        resource: "https://mcp.example.test/mcp",
        scope: "mcp:tools",
      }),
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      client_id: "client-1",
      redirect_uri: "https://bot.example.test/callback",
      state: "signed-state",
      code_challenge: "challenge",
      code_challenge_method: "S256",
      resource: "https://mcp.example.test/mcp",
      scope: "mcp:tools",
    });
  });
});

describe("the WWW-Authenticate challenge", () => {
  test("yields the resource_metadata URL a 401 named", () => {
    expect(
      parseResourceMetadataChallengeV1(
        'Bearer realm="mcp", resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"',
      ),
    ).toBe("https://mcp.example.test/.well-known/oauth-protected-resource/mcp");
  });

  test("is undefined when the header names none", () => {
    expect(
      parseResourceMetadataChallengeV1('Bearer realm="mcp"'),
    ).toBeUndefined();
    expect(parseResourceMetadataChallengeV1(null)).toBeUndefined();
  });
});

/** A fake authorization server that records every request it was sent. */
function authorizationServer(options: {
  register?: Record<string, unknown>;
  token?: Record<string, unknown>;
  tokenStatus?: number;
  revokeStatus?: number;
}) {
  const seen: Array<{ url: string; body: string; method: string }> = [];
  const fetchImpl: McpFetch = async (input, init) => {
    const url = String(input);
    const body =
      typeof init?.body === "string" ? init.body : String(init?.body ?? "");
    seen.push({ url, body, method: init?.method ?? "GET" });
    if (url.endsWith("/.well-known/oauth-protected-resource/mcp")) {
      return Response.json({
        resource: "https://mcp.example.test/mcp",
        authorization_servers: [ISSUER],
        scopes_supported: ["mcp:tools"],
      });
    }
    if (url.endsWith("/.well-known/oauth-authorization-server")) {
      return Response.json(metadata());
    }
    if (url.endsWith("/register")) {
      return Response.json(options.register ?? { client_id: "client-1" }, {
        status: 201,
      });
    }
    if (url.endsWith("/token")) {
      return Response.json(
        options.token ?? {
          access_token: "access-1",
          token_type: "Bearer",
          expires_in: 3_600,
          refresh_token: "refresh-1",
        },
        { status: options.tokenStatus ?? 200 },
      );
    }
    if (url.endsWith("/revoke")) {
      return new Response(null, { status: options.revokeStatus ?? 200 });
    }
    return new Response("not found", { status: 404 });
  };
  return { seen, client: new McpOAuthClient({ fetch: fetchImpl }) };
}

describe("the OAuth client", () => {
  test("discovers the resource and its authorization server", async () => {
    const { client } = authorizationServer({});
    const resource = await client.discoverProtectedResource({
      serverUrl: new URL("https://mcp.example.test/mcp"),
    });
    expect(resource.authorizationServers).toEqual([ISSUER]);
    const server = await client.discoverAuthorizationServer(ISSUER);
    expect(server.tokenEndpoint).toBe(`${ISSUER}/token`);
  });

  test("refuses metadata that describes a different resource", async () => {
    const fetchImpl: McpFetch = async () =>
      Response.json({
        resource: "https://other.example.test/mcp",
        authorization_servers: [ISSUER],
      });
    const client = new McpOAuthClient({ fetch: fetchImpl });
    await expect(
      client.discoverProtectedResource({
        serverUrl: new URL("https://mcp.example.test/mcp"),
      }),
    ).rejects.toThrow(/not the server it was fetched for/);
  });

  test("registers as a public client", async () => {
    const { client, seen } = authorizationServer({});
    expect(
      await client.register({
        registrationEndpoint: `${ISSUER}/register`,
        redirectUri: "https://bot.example.test/callback",
      }),
    ).toEqual({ clientId: "client-1" });
    const body = JSON.parse(seen.at(-1)!.body) as Record<string, unknown>;
    expect(body).toMatchObject({
      token_endpoint_auth_method: "none",
      redirect_uris: ["https://bot.example.test/callback"],
      grant_types: ["authorization_code", "refresh_token"],
    });
    expect(body).not.toHaveProperty("client_secret");
  });

  test("refuses a confidential client durably, with its own code", async () => {
    const { client } = authorizationServer({
      register: { client_id: "client-1", client_secret: "s3cret" },
    });
    const failure = await client
      .register({
        registrationEndpoint: `${ISSUER}/register`,
        redirectUri: "https://bot.example.test/callback",
      })
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(McpAuthorizationError);
    expect((failure as McpAuthorizationError).code).toBe(
      "unsupported-client-authentication",
    );
  });

  test("sends the verifier and the resource on the code exchange", async () => {
    const { client, seen } = authorizationServer({});
    const tokens = await client.exchangeCode({
      tokenEndpoint: `${ISSUER}/token`,
      clientId: "client-1",
      code: "code-1",
      codeVerifier: "verifier-1",
      redirectUri: "https://bot.example.test/callback",
      resource: "https://mcp.example.test/mcp",
    });
    expect(tokens.accessToken).toBe("access-1");
    expect(tokens.refreshToken).toBe("refresh-1");
    expect(tokens.expiresAt).toBeGreaterThan(Date.now());
    const form = Object.fromEntries(new URLSearchParams(seen.at(-1)!.body));
    expect(form).toEqual({
      grant_type: "authorization_code",
      code: "code-1",
      redirect_uri: "https://bot.example.test/callback",
      client_id: "client-1",
      code_verifier: "verifier-1",
      resource: "https://mcp.example.test/mcp",
    });
  });

  test("sends the resource on the refresh too, so the new token is bound as well", async () => {
    const { client, seen } = authorizationServer({});
    await client.refresh({
      tokenEndpoint: `${ISSUER}/token`,
      clientId: "client-1",
      refreshToken: "refresh-1",
      resource: "https://mcp.example.test/mcp",
      scope: "mcp:tools",
    });
    const form = Object.fromEntries(new URLSearchParams(seen.at(-1)!.body));
    expect(form).toEqual({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      client_id: "client-1",
      resource: "https://mcp.example.test/mcp",
      scope: "mcp:tools",
    });
  });

  test("reports a refused token request rather than inventing a token", async () => {
    const { client } = authorizationServer({
      tokenStatus: 400,
      token: { error: "invalid_grant", error_description: "code is spent" },
    });
    await expect(
      client.exchangeCode({
        tokenEndpoint: `${ISSUER}/token`,
        clientId: "client-1",
        code: "code-1",
        codeVerifier: "verifier-1",
        redirectUri: "https://bot.example.test/callback",
        resource: "https://mcp.example.test/mcp",
      }),
    ).rejects.toThrow(/invalid_grant: code is spent/);
  });

  test("counts an unknown token as revoked, and a server error as not", async () => {
    const revoke = (status: number) =>
      authorizationServer({ revokeStatus: status }).client.revoke({
        revocationEndpoint: `${ISSUER}/revoke`,
        token: "refresh-1",
        tokenTypeHint: "refresh_token",
        clientId: "client-1",
      });
    expect(await revoke(200)).toBe(true);
    expect(await revoke(503)).toBe(false);
  });

  test("sends the RFC 7009 form on revocation", async () => {
    const { client, seen } = authorizationServer({});
    await client.revoke({
      revocationEndpoint: `${ISSUER}/revoke`,
      token: "refresh-1",
      tokenTypeHint: "refresh_token",
      clientId: "client-1",
    });
    expect(Object.fromEntries(new URLSearchParams(seen.at(-1)!.body))).toEqual({
      token: "refresh-1",
      token_type_hint: "refresh_token",
      client_id: "client-1",
    });
  });

  test("refuses a metadata document past the byte ceiling", async () => {
    const oversized = JSON.stringify({
      resource: "https://mcp.example.test/mcp",
      authorization_servers: [ISSUER],
      padding: "x".repeat(4_000),
    });
    const fetchImpl: McpFetch = async () =>
      new Response(oversized, {
        headers: { "content-type": "application/json" },
      });
    const client = new McpOAuthClient({
      fetch: fetchImpl,
      maxMetadataBytes: 512,
    });
    await expect(
      client.discoverProtectedResource({
        serverUrl: new URL("https://mcp.example.test/mcp"),
      }),
    ).rejects.toThrow(/too large/);
  });
});
