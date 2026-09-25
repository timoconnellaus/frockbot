// A real MCP server for tests, reached through a `fetch` rather than a
// socket: the official server SDK behind its web-standard streamable HTTP
// transport, stateless, so each request is served by a fresh instance.
import {
  Server,
  WebStandardStreamableHTTPServerTransport,
} from "@modelcontextprotocol/server";
import type { McpFetchV1 } from "./client.js";

export interface FakeMcpToolV1 {
  name: string;
  description: string;
  inputSchema?: Record<string, unknown>;
  run(args: Record<string, unknown>): {
    content: { type: "text"; text: string }[];
    isError?: boolean;
  };
}

export interface FakeMcpServerV1 {
  /** Where the server answers. */
  readonly url: string;
  readonly fetch: McpFetchV1;
  /** Every tool call the server ran, in order. */
  readonly calls: { name: string; args: Record<string, unknown> }[];
  /** Every Authorization header the server was sent. */
  readonly authorizations: (string | null)[];
  tools: FakeMcpToolV1[];
  /** The bearer token the server accepts; absent accepts anything. */
  token?: string;
  /** Decides the Authorization header instead of `token`, when set. */
  accepts?: (authorization: string | null) => boolean;
  /** What a refusal's `WWW-Authenticate` says. */
  challenge?: string;
  /** Answer every request with this status instead of serving it. */
  status?: number;
}

export function createFakeMcpServerV1(
  options: {
    url?: string;
    tools?: FakeMcpToolV1[];
    token?: string;
    instructions?: string;
  } = {},
): FakeMcpServerV1 {
  const url = options.url ?? "https://mcp.example.test/mcp";
  const state: FakeMcpServerV1 = {
    url,
    calls: [],
    authorizations: [],
    tools: options.tools ?? [],
    ...(options.token ? { token: options.token } : {}),
    fetch: async (input, init) => {
      const request = new Request(input, init);
      state.authorizations.push(request.headers.get("authorization"));
      if (state.status !== undefined) {
        return new Response("refused", { status: state.status });
      }
      if (new URL(request.url).href !== url) {
        return new Response("not found", { status: 404 });
      }
      const authorization = request.headers.get("authorization");
      if (
        state.accepts
          ? !state.accepts(authorization)
          : state.token && authorization !== `Bearer ${state.token}`
      ) {
        return new Response("unauthorized", {
          status: 401,
          headers: { "www-authenticate": state.challenge ?? "Bearer" },
        });
      }
      const server = new Server(
        { name: "fake-mcp", version: "1.2.3" },
        {
          capabilities: { tools: {} },
          ...(options.instructions
            ? { instructions: options.instructions }
            : {}),
        },
      );
      server.setRequestHandler("tools/list", () => ({
        tools: state.tools.map((tool) => ({
          name: tool.name,
          description: tool.description,
          inputSchema: (tool.inputSchema ?? {
            type: "object",
            properties: {},
          }) as { type: "object" },
        })),
      }));
      server.setRequestHandler("tools/call", (call) => {
        const tool = state.tools.find(
          (candidate) => candidate.name === call.params.name,
        );
        const args = (call.params.arguments ?? {}) as Record<string, unknown>;
        state.calls.push({ name: call.params.name, args });
        if (!tool) {
          return {
            content: [{ type: "text", text: "no such tool" }],
            isError: true,
          };
        }
        return tool.run(args);
      });
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined,
        enableJsonResponse: true,
      });
      await server.connect(transport);
      try {
        return await transport.handleRequest(request);
      } finally {
        await server.close().catch(() => undefined);
      }
    },
  };
  return state;
}

/**
 * An MCP server behind its own OAuth authorization server, as the MCP
 * authorization specification describes one: protected-resource metadata on
 * the server, authorization-server metadata, dynamic registration, an
 * authorization-code grant with PKCE S256, refresh tokens that rotate, and
 * revocation. `approve` stands in for the person signing in: it takes the
 * address FrockBot sent them to and answers where the server sends them back.
 */
export interface FakeMcpAuthorizationServerV1 {
  readonly server: FakeMcpServerV1;
  /** Everything a test reaches: the MCP server and its authorization server. */
  readonly fetch: McpFetchV1;
  readonly issuer: string;
  readonly registrations: Record<string, unknown>[];
  readonly revoked: string[];
  readonly tokenRequests: URLSearchParams[];
  /** Access tokens the MCP server takes. */
  readonly accessTokens: Set<string>;
  /** Seconds an access token lives; absent says nothing of expiry. */
  expiresIn?: number;
  /** Whether the metadata offers a client metadata document. */
  clientMetadataDocuments: boolean;
  /** Whether the metadata offers dynamic registration. */
  registration: boolean;
  /** Answer every revocation with this status instead of honouring it. */
  revocationStatus?: number;
  approve(authorizationUrl: string): string;
  deny(authorizationUrl: string): string;
}

async function s256(verifier: string): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
  );
  return btoa(String.fromCharCode(...digest))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function createFakeMcpAuthorizationServerV1(
  options: { tools?: FakeMcpToolV1[]; issuer?: string } = {},
): FakeMcpAuthorizationServerV1 {
  const server = createFakeMcpServerV1(
    options.tools ? { tools: options.tools } : {},
  );
  const mcp = new URL(server.url);
  const issuer = options.issuer ?? "https://auth.example.test";
  const resourceMetadata = `${mcp.origin}/.well-known/oauth-protected-resource${mcp.pathname}`;
  const codes = new Map<
    string,
    {
      clientId: string;
      redirectUri: string;
      challenge: string;
      resource: string | null;
    }
  >();
  const refreshTokens = new Set<string>();
  let issued = 0;
  const fake: FakeMcpAuthorizationServerV1 = {
    server,
    issuer,
    registrations: [],
    revoked: [],
    tokenRequests: [],
    accessTokens: new Set(),
    expiresIn: 3600,
    clientMetadataDocuments: false,
    registration: true,
    approve(authorizationUrl) {
      const url = new URL(authorizationUrl);
      const code = `code-${++issued}`;
      codes.set(code, {
        clientId: url.searchParams.get("client_id") ?? "",
        redirectUri: url.searchParams.get("redirect_uri") ?? "",
        challenge: url.searchParams.get("code_challenge") ?? "",
        resource: url.searchParams.get("resource"),
      });
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", code);
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return back.href;
    },
    deny(authorizationUrl) {
      const url = new URL(authorizationUrl);
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("error", "access_denied");
      back.searchParams.set("state", url.searchParams.get("state") ?? "");
      return back.href;
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const url = new URL(request.url);
      if (url.href === resourceMetadata) {
        return Response.json({
          resource: server.url,
          authorization_servers: [issuer],
          scopes_supported: ["tools"],
        });
      }
      if (url.origin !== issuer) return server.fetch(input, init);
      const issue = (rotatedFrom?: string) => {
        if (rotatedFrom) refreshTokens.delete(rotatedFrom);
        const access = `access-${++issued}`;
        const refresh = `refresh-${issued}`;
        fake.accessTokens.add(access);
        refreshTokens.add(refresh);
        return Response.json({
          access_token: access,
          token_type: "Bearer",
          refresh_token: refresh,
          ...(fake.expiresIn === undefined
            ? {}
            : { expires_in: fake.expiresIn }),
        });
      };
      switch (url.pathname) {
        case "/.well-known/oauth-authorization-server":
          return Response.json({
            issuer,
            authorization_endpoint: `${issuer}/authorize`,
            token_endpoint: `${issuer}/token`,
            revocation_endpoint: `${issuer}/revoke`,
            ...(fake.registration
              ? { registration_endpoint: `${issuer}/register` }
              : {}),
            ...(fake.clientMetadataDocuments
              ? { client_id_metadata_document_supported: true }
              : {}),
            response_types_supported: ["code"],
            grant_types_supported: ["authorization_code", "refresh_token"],
            code_challenge_methods_supported: ["S256"],
            token_endpoint_auth_methods_supported: ["none"],
          });
        case "/register": {
          const body = (await request.json()) as Record<string, unknown>;
          fake.registrations.push(body);
          return Response.json(
            { ...body, client_id: `client-${fake.registrations.length}` },
            { status: 201 },
          );
        }
        case "/token": {
          const form = new URLSearchParams(await request.text());
          fake.tokenRequests.push(form);
          if (form.get("resource") !== server.url) {
            return Response.json({ error: "invalid_target" }, { status: 400 });
          }
          if (form.get("grant_type") === "authorization_code") {
            const code = form.get("code") ?? "";
            const grant = codes.get(code);
            codes.delete(code);
            if (
              !grant ||
              grant.clientId !== form.get("client_id") ||
              grant.redirectUri !== form.get("redirect_uri") ||
              grant.resource !== server.url ||
              grant.challenge !== (await s256(form.get("code_verifier") ?? ""))
            ) {
              return Response.json({ error: "invalid_grant" }, { status: 400 });
            }
            return issue();
          }
          if (form.get("grant_type") === "refresh_token") {
            const refresh = form.get("refresh_token") ?? "";
            if (!refreshTokens.has(refresh)) {
              return Response.json({ error: "invalid_grant" }, { status: 400 });
            }
            return issue(refresh);
          }
          return Response.json(
            { error: "unsupported_grant_type" },
            { status: 400 },
          );
        }
        case "/revoke": {
          if (fake.revocationStatus !== undefined) {
            return new Response(null, { status: fake.revocationStatus });
          }
          const form = new URLSearchParams(await request.text());
          const token = form.get("token") ?? "";
          fake.revoked.push(token);
          refreshTokens.delete(token);
          fake.accessTokens.delete(token);
          return new Response(null, { status: 200 });
        }
        default:
          return new Response("not found", { status: 404 });
      }
    },
  };
  server.accepts = (authorization) =>
    authorization !== null &&
    authorization.startsWith("Bearer ") &&
    fake.accessTokens.has(authorization.slice("Bearer ".length));
  server.challenge = `Bearer resource_metadata="${resourceMetadata}", scope="tools"`;
  return fake;
}
