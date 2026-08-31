/**
 * The `mcp-oauth` grant driver: everything the MCP authorization specification
 * asks of a client, written against the published spec rather than an SDK.
 *
 * `@modelcontextprotocol/sdk` is not a dependency of this repository and its
 * OAuth helper carries a Node HTTP client and a filesystem token store, both of
 * which this Package must never reach for. What FrockBot needs is narrow —
 * discover, register, authorize, exchange, refresh, revoke — and every byte of
 * it is bounded, https-only, and passed through the same SSRF classifier the
 * MCP endpoint itself is held to.
 *
 * The specification this implements (revisions 2025-06-18 and 2025-11-25):
 *
 * - **RFC 9728** protected-resource metadata, discovered path-aware from the
 *   MCP server URL or named by the `resource_metadata` parameter of the
 *   `WWW-Authenticate` header on a 401.
 * - **RFC 8414** authorization-server metadata, tried in the order the spec
 *   sets out, with `issuer` checked against the URL it was fetched from.
 * - **RFC 7591** dynamic client registration, as a *public* client
 *   (`token_endpoint_auth_method: "none"`). A server that insists on a client
 *   secret is refused durably: a secret in a Connection setting is a secret in
 *   a projection.
 * - **PKCE** with `S256`, mandatory. The verifier is generated in the User
 *   Durable Object, stored in the pending record, and never leaves it.
 * - **RFC 8707** `resource` indicators on both the authorization request and
 *   every token request, so the token the server issues is bound to this MCP
 *   server and useless anywhere else.
 * - **RFC 7009** token revocation on disconnect, when the server advertises an
 *   endpoint.
 *
 * Nothing here touches durable state or secrets storage: this module composes
 * and decodes requests, and the User Durable Object that calls it owns every
 * record and every sealed credential.
 */
import { McpProtocolError, type McpFetch } from "./mcp-client.js";
import { decodeOutboundMcpUrlV1 } from "./ssrf.js";

/** The driver id the manifest names for the `mcp-remote-oauth` grant. */
export const MCP_OAUTH_DRIVER_ID = "mcp-oauth";

/**
 * A metadata document is small. Bounding it is not a nicety: these are the
 * first bytes a User's Durable Object reads from a URL a User named, and an
 * unbounded read there is an unbounded read inside the authority.
 */
export const MAX_MCP_METADATA_BYTES_V1 = 64 * 1024;

/** How long an authorization may sit pending before its state expires. */
export const MCP_AUTHORIZATION_TTL_MS_V1 = 10 * 60_000;

/**
 * The per-User ceiling on authorization starts inside one window. A start
 * costs outbound discovery requests and a durable pending record, so it is a
 * quota like every other; exceeding it is a visible refusal.
 */
export const MAX_MCP_AUTHORIZATION_STARTS_V1 = 24;
export const MCP_AUTHORIZATION_START_WINDOW_MS_V1 = 60 * 60_000;

/**
 * How long before expiry an access token is refreshed on the way out. A lease
 * lives five minutes; a token that expires inside the next minute would expire
 * mid-mount, so it is replaced before it is handed over.
 */
export const MCP_ACCESS_REFRESH_SKEW_MS_V1 = 60_000;

/** What this client calls itself when it registers. */
const CLIENT_NAME = "FrockBot";

export interface McpProtectedResourceMetadataV1 {
  resource: string;
  authorizationServers: string[];
  scopesSupported?: string[];
}

export interface McpAuthorizationServerMetadataV1 {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  codeChallengeMethodsSupported: string[];
  tokenEndpointAuthMethodsSupported?: string[];
  scopesSupported?: string[];
}

export interface McpOAuthTokenSetV1 {
  accessToken: string;
  tokenType: string;
  /** Absolute, as an epoch millisecond. Absent when the server declared none. */
  expiresAt?: number;
  refreshToken?: string;
  scope?: string;
}

/**
 * An authorization the client cannot complete. Separate from
 * `McpProtocolError` because none of these are the MCP protocol: they are the
 * authorization server's answers, and the code is what the durable record
 * branches on.
 */
export class McpAuthorizationError extends Error {
  readonly code:
    | "authorization-discovery"
    | "unsupported-client-authentication"
    | "authorization-failed";

  constructor(
    message: string,
    code: McpAuthorizationError["code"] = "authorization-failed",
  ) {
    super(message);
    this.code = code;
  }
}

/**
 * The 401 an MCP server answers with when it wants a token — the whole of the
 * `needs-auth` classification, and the beginning of discovery.
 *
 * `WWW-Authenticate: Bearer realm="…", resource_metadata="https://…"`
 * (RFC 9728 §5.1). The header is the server's, so it is parsed defensively and
 * the URL it names is still put through the outbound classifier before it is
 * fetched.
 */
export function parseResourceMetadataChallengeV1(
  header: string | null,
): string | undefined {
  if (!header) return undefined;
  const match = header.match(
    /(?:^|[\s,])resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,]+))/i,
  );
  const value = match?.[1] ?? match?.[2];
  return value && value.length <= 2_048 ? value : undefined;
}

/**
 * Where a server's protected-resource metadata lives, in the order RFC 9728
 * §3.1 requires. A server URL with a path inserts that path *after* the
 * well-known segment; the bare well-known document is the fallback, which is
 * what a server mounted at the origin publishes.
 */
export function mcpResourceMetadataUrlsV1(serverUrl: URL): string[] {
  const path = serverUrl.pathname.replace(/\/+$/, "");
  const urls =
    path && path !== "/"
      ? [`${serverUrl.origin}/.well-known/oauth-protected-resource${path}`]
      : [];
  urls.push(`${serverUrl.origin}/.well-known/oauth-protected-resource`);
  return urls;
}

/**
 * Where an issuer's authorization-server metadata lives, in the order the MCP
 * specification requires: RFC 8414 path insertion first, then the OpenID
 * Connect variants, then the path-appended OpenID document. An issuer with no
 * path collapses the four to two, which is the common case.
 */
export function mcpAuthorizationServerMetadataUrlsV1(issuer: URL): string[] {
  const path = issuer.pathname.replace(/\/+$/, "");
  if (!path || path === "/") {
    return [
      `${issuer.origin}/.well-known/oauth-authorization-server`,
      `${issuer.origin}/.well-known/openid-configuration`,
    ];
  }
  return [
    `${issuer.origin}/.well-known/oauth-authorization-server${path}`,
    `${issuer.origin}/.well-known/openid-configuration${path}`,
    `${issuer.origin}${path}/.well-known/openid-configuration`,
  ];
}

/**
 * The canonical resource indicator (RFC 8707 §2, as the MCP specification
 * narrows it): the server's URI with its scheme and host lowercased, its path
 * kept, and no fragment. The query is dropped — a resource identity that
 * changes with a query string is not an identity.
 */
export function mcpCanonicalResourceV1(serverUrl: URL): string {
  const path = serverUrl.pathname.replace(/\/+$/, "");
  return `${serverUrl.protocol.toLowerCase()}//${serverUrl.host.toLowerCase()}${path}`;
}

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export interface McpPkcePairV1 {
  /** 43–128 characters of the unreserved set, per RFC 7636 §4.1. */
  codeVerifier: string;
  codeChallenge: string;
  codeChallengeMethod: "S256";
}

/**
 * One PKCE pair. `S256` only: RFC 7636 permits `plain`, and the MCP
 * specification does not — a `plain` challenge is the same secret twice.
 */
export async function createPkcePairV1(
  randomBytes: (length: number) => Uint8Array = (length) =>
    crypto.getRandomValues(new Uint8Array(length)),
): Promise<McpPkcePairV1> {
  const codeVerifier = base64Url(randomBytes(32));
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return {
    codeVerifier,
    codeChallenge: base64Url(new Uint8Array(digest)),
    codeChallengeMethod: "S256",
  };
}

export async function mcpCodeChallengeV1(
  codeVerifier: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(codeVerifier),
  );
  return base64Url(new Uint8Array(digest));
}

function metadataRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new McpAuthorizationError(
      `${label} is invalid`,
      "authorization-discovery",
    );
  }
  return value as Record<string, unknown>;
}

function stringList(value: unknown, maximum = 64): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter(
    (item): item is string =>
      typeof item === "string" && item.length > 0 && item.length <= 512,
  );
  return items.slice(0, maximum);
}

/**
 * An https URL from a metadata document, put through the same outbound
 * classifier every MCP request is. A metadata document is attacker-influenced
 * input the moment a User names a server, so a `http://` or private-address
 * endpoint is refused here rather than fetched.
 */
function metadataUrl(value: unknown, label: string): URL {
  try {
    return decodeOutboundMcpUrlV1(value);
  } catch (error) {
    throw new McpAuthorizationError(
      `${label} is invalid: ${error instanceof Error ? error.message : "unknown"}`,
      "authorization-discovery",
    );
  }
}

export function decodeMcpProtectedResourceMetadataV1(
  input: unknown,
): McpProtectedResourceMetadataV1 {
  const value = metadataRecord(input, "MCP protected resource metadata");
  const resource = value.resource;
  if (typeof resource !== "string" || resource.length === 0) {
    throw new McpAuthorizationError(
      "MCP protected resource metadata names no resource",
      "authorization-discovery",
    );
  }
  const servers = stringList(value.authorization_servers, 8) ?? [];
  if (servers.length === 0) {
    throw new McpAuthorizationError(
      "MCP protected resource metadata names no authorization server",
      "authorization-discovery",
    );
  }
  const scopes = stringList(value.scopes_supported);
  return {
    resource,
    authorizationServers: servers,
    ...(scopes && scopes.length > 0 ? { scopesSupported: scopes } : {}),
  };
}

/**
 * The authorization-server metadata, checked against the URL it came from.
 *
 * Two rules carry the weight. `issuer` must be the issuer this document was
 * fetched for — RFC 8414 §3.3 makes a mismatch a mix-up attack, not a typo.
 * And every endpoint must share the issuer's origin: a document that could
 * point the token request at a third host is a document that could be served
 * by one host and redeemed at another.
 */
export function decodeMcpAuthorizationServerMetadataV1(
  input: unknown,
  issuerIdentifier: string,
): McpAuthorizationServerMetadataV1 {
  const value = metadataRecord(input, "MCP authorization server metadata");
  const declared = value.issuer;
  if (typeof declared !== "string") {
    throw new McpAuthorizationError(
      "MCP authorization server metadata declares no issuer",
      "authorization-discovery",
    );
  }
  const declaredIssuer = metadataUrl(declared, "authorization server issuer");
  // RFC 8414 §3.3 compares the *strings*, not two normalized URLs: this is the
  // mix-up-attack defence, and a comparison that normalizes is a comparison an
  // attacker chooses the normalization for.
  if (declared !== issuerIdentifier) {
    throw new McpAuthorizationError(
      `MCP authorization server metadata declares issuer "${declared}", which is not the issuer it was fetched for`,
      "authorization-discovery",
    );
  }
  const authorizationEndpoint = metadataUrl(
    value.authorization_endpoint,
    "authorization endpoint",
  );
  const tokenEndpoint = metadataUrl(value.token_endpoint, "token endpoint");
  const registrationEndpoint =
    value.registration_endpoint === undefined
      ? undefined
      : metadataUrl(value.registration_endpoint, "registration endpoint");
  const revocationEndpoint =
    value.revocation_endpoint === undefined
      ? undefined
      : metadataUrl(value.revocation_endpoint, "revocation endpoint");
  for (const [endpoint, label] of [
    [authorizationEndpoint, "authorization endpoint"],
    [tokenEndpoint, "token endpoint"],
    ...(registrationEndpoint
      ? ([[registrationEndpoint, "registration endpoint"]] as const)
      : []),
    ...(revocationEndpoint
      ? ([[revocationEndpoint, "revocation endpoint"]] as const)
      : []),
  ] as ReadonlyArray<readonly [URL, string]>) {
    if (endpoint.origin !== declaredIssuer.origin) {
      throw new McpAuthorizationError(
        `MCP authorization server ${label} is on a different origin from its issuer`,
        "authorization-discovery",
      );
    }
  }
  // The 2025-11-25 revision makes this a pre-flight refusal rather than a
  // best-effort: an absent `code_challenge_methods_supported` means the server
  // does not support PKCE at all (RFC 8414 §2), and an MCP client must not
  // proceed without it.
  const challengeMethods = stringList(value.code_challenge_methods_supported);
  if (!challengeMethods || !challengeMethods.includes("S256")) {
    throw new McpAuthorizationError(
      "MCP authorization server does not advertise the S256 PKCE challenge method, which this client requires",
      "authorization-discovery",
    );
  }
  const authMethods = stringList(value.token_endpoint_auth_methods_supported);
  const scopes = stringList(value.scopes_supported);
  return {
    issuer: declared,
    authorizationEndpoint: authorizationEndpoint.toString(),
    tokenEndpoint: tokenEndpoint.toString(),
    ...(registrationEndpoint
      ? { registrationEndpoint: registrationEndpoint.toString() }
      : {}),
    ...(revocationEndpoint
      ? { revocationEndpoint: revocationEndpoint.toString() }
      : {}),
    codeChallengeMethodsSupported: challengeMethods,
    ...(authMethods ? { tokenEndpointAuthMethodsSupported: authMethods } : {}),
    ...(scopes && scopes.length > 0 ? { scopesSupported: scopes } : {}),
  };
}

/**
 * The authorize URL, built here and only here.
 *
 * The model never composes an authorization link and the client never receives
 * the parts to build one: this returns a complete URL, minted by the host,
 * carrying the signed state and the PKCE challenge that bind it to one pending
 * record.
 */
export function mcpAuthorizeUrlV1(input: {
  authorizationEndpoint: string;
  clientId: string;
  redirectUri: string;
  state: string;
  codeChallenge: string;
  resource: string;
  scope?: string;
}): string {
  const url = new URL(input.authorizationEndpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", input.clientId);
  url.searchParams.set("redirect_uri", input.redirectUri);
  url.searchParams.set("state", input.state);
  url.searchParams.set("code_challenge", input.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  // RFC 8707: the token this authorization produces is for this MCP server and
  // nothing else. Sent here as well as at the token endpoint, because an
  // authorization server that honours it only at one of the two would issue an
  // over-broad token at the other.
  url.searchParams.set("resource", input.resource);
  if (input.scope) url.searchParams.set("scope", input.scope);
  return url.toString();
}

interface JsonResponse {
  status: number;
  body: Record<string, unknown>;
}

export interface McpOAuthClientConfig {
  fetch: McpFetch;
  now?: () => number;
  maxMetadataBytes?: number;
}

/**
 * Read a JSON body under a byte ceiling, refusing anything past it rather than
 * truncating. Deliberately the same shape as `McpClient`'s reader: an
 * authorization server is exactly as untrusted as an MCP server.
 */
async function boundedJson(
  response: Response,
  maximum: number,
): Promise<Record<string, unknown>> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximum) {
    throw new McpAuthorizationError(
      "MCP authorization response is too large",
      "authorization-discovery",
    );
  }
  const reader = response.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let text = "";
  let length = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      length += chunk.value.byteLength;
      if (length > maximum) {
        throw new McpAuthorizationError(
          "MCP authorization response is too large",
          "authorization-discovery",
        );
      }
      text += decoder.decode(chunk.value, { stream: true });
    }
  } finally {
    reader.releaseLock();
  }
  text += decoder.decode();
  if (!text.trim()) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpAuthorizationError(
      "MCP authorization response is not JSON",
      "authorization-discovery",
    );
  }
  return metadataRecord(parsed, "MCP authorization response");
}

function errorDetail(body: Record<string, unknown>, status: number): string {
  const code = typeof body.error === "string" ? body.error : undefined;
  const description =
    typeof body.error_description === "string"
      ? body.error_description
      : undefined;
  const detail = [code, description].filter(Boolean).join(": ");
  return detail ? `${status} ${detail}`.slice(0, 500) : String(status);
}

/**
 * Everything that leaves the deployment for an authorization server. It holds
 * no state and no secret: the caller supplies each value and keeps every one
 * of them.
 */
export class McpOAuthClient {
  private readonly maxMetadataBytes: number;
  private readonly now: () => number;

  constructor(private readonly config: McpOAuthClientConfig) {
    this.maxMetadataBytes =
      config.maxMetadataBytes ?? MAX_MCP_METADATA_BYTES_V1;
    this.now = config.now ?? (() => Date.now());
  }

  private async getJson(url: URL): Promise<JsonResponse> {
    const response = await this.config.fetch(url.toString(), {
      method: "GET",
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      await response.body?.cancel();
      return { status: response.status, body: {} };
    }
    return {
      status: response.status,
      body: await boundedJson(response, this.maxMetadataBytes),
    };
  }

  private async postForm(
    url: URL,
    form: Record<string, string>,
  ): Promise<JsonResponse> {
    const body = new URLSearchParams(form);
    const response = await this.config.fetch(url.toString(), {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    return {
      status: response.status,
      body: await boundedJson(response, this.maxMetadataBytes),
    };
  }

  /**
   * The protected-resource document for one MCP server: the `resource_metadata`
   * the server named on its 401 when it named one, else the path-aware
   * well-known locations in order.
   */
  async discoverProtectedResource(input: {
    serverUrl: URL;
    resourceMetadataUrl?: string;
  }): Promise<McpProtectedResourceMetadataV1> {
    const candidates = input.resourceMetadataUrl
      ? [input.resourceMetadataUrl]
      : mcpResourceMetadataUrlsV1(input.serverUrl);
    let lastStatus = 0;
    for (const candidate of candidates) {
      const url = metadataUrl(candidate, "protected resource metadata URL");
      const found = await this.getJson(url);
      if (found.status === 200) {
        const metadata = decodeMcpProtectedResourceMetadataV1(found.body);
        // RFC 9728 §3.3, and the whole of the anti-impersonation rule: the
        // `resource` the document declares must be the resource it was fetched
        // for. When the URL came from the server's own `WWW-Authenticate`
        // header, that comparison is against the MCP endpoint the client
        // called — a header naming someone else's metadata document is exactly
        // the attack the rule exists for.
        metadataUrl(metadata.resource, "resource identifier");
        if (
          mcpCanonicalResourceV1(new URL(metadata.resource)) !==
          mcpCanonicalResourceV1(input.serverUrl)
        ) {
          throw new McpAuthorizationError(
            `MCP protected resource metadata declares resource "${metadata.resource}", which is not the server it was fetched for`,
            "authorization-discovery",
          );
        }
        return metadata;
      }
      lastStatus = found.status;
    }
    throw new McpAuthorizationError(
      `MCP server published no protected resource metadata (${lastStatus || "unreachable"})`,
      "authorization-discovery",
    );
  }

  /** The authorization-server document for one issuer, tried in spec order. */
  async discoverAuthorizationServer(
    issuerUrl: string,
  ): Promise<McpAuthorizationServerMetadataV1> {
    const issuer = metadataUrl(issuerUrl, "authorization server issuer");
    let lastStatus = 0;
    for (const candidate of mcpAuthorizationServerMetadataUrlsV1(issuer)) {
      const found = await this.getJson(new URL(candidate));
      if (found.status === 200) {
        return decodeMcpAuthorizationServerMetadataV1(found.body, issuerUrl);
      }
      lastStatus = found.status;
    }
    throw new McpAuthorizationError(
      `MCP authorization server published no metadata (${lastStatus || "unreachable"})`,
      "authorization-discovery",
    );
  }

  /**
   * RFC 7591 dynamic registration, as a public client.
   *
   * A server that answers with a `client_secret` is refused: FrockBot would
   * have to keep that secret somewhere, and the only somewhere a Connection
   * offers is a projection every client can read. The refusal is durable and
   * carries its own code, so a User reads "this server needs a client secret"
   * rather than "authorization failed".
   */
  async register(input: {
    registrationEndpoint: string;
    redirectUri: string;
    scope?: string;
  }): Promise<{ clientId: string }> {
    const response = await this.config.fetch(input.registrationEndpoint, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        client_name: CLIENT_NAME,
        redirect_uris: [input.redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        ...(input.scope ? { scope: input.scope } : {}),
      }),
    });
    const body = await boundedJson(response, this.maxMetadataBytes);
    if (response.status !== 200 && response.status !== 201) {
      throw new McpAuthorizationError(
        `MCP client registration failed: ${errorDetail(body, response.status)}`,
        "authorization-discovery",
      );
    }
    const clientId = body.client_id;
    if (typeof clientId !== "string" || clientId.length === 0) {
      throw new McpAuthorizationError(
        "MCP client registration returned no client_id",
        "authorization-discovery",
      );
    }
    if (typeof body.client_secret === "string" && body.client_secret) {
      throw new McpAuthorizationError(
        "The authorization server issued a confidential client. FrockBot registers as a public client, because a client secret would have to live in a Connection setting every client can read.",
        "unsupported-client-authentication",
      );
    }
    return { clientId: clientId.slice(0, 512) };
  }

  /** The authorization-code grant, with the stored verifier and the resource. */
  async exchangeCode(input: {
    tokenEndpoint: string;
    clientId: string;
    code: string;
    codeVerifier: string;
    redirectUri: string;
    resource: string;
  }): Promise<McpOAuthTokenSetV1> {
    return this.token(input.tokenEndpoint, {
      grant_type: "authorization_code",
      code: input.code,
      redirect_uri: input.redirectUri,
      client_id: input.clientId,
      code_verifier: input.codeVerifier,
      resource: input.resource,
    });
  }

  /** The refresh grant. Same audience binding; a new refresh token replaces the old when one is returned. */
  async refresh(input: {
    tokenEndpoint: string;
    clientId: string;
    refreshToken: string;
    resource: string;
    scope?: string;
  }): Promise<McpOAuthTokenSetV1> {
    return this.token(input.tokenEndpoint, {
      grant_type: "refresh_token",
      refresh_token: input.refreshToken,
      client_id: input.clientId,
      resource: input.resource,
      ...(input.scope ? { scope: input.scope } : {}),
    });
  }

  private async token(
    tokenEndpoint: string,
    form: Record<string, string>,
  ): Promise<McpOAuthTokenSetV1> {
    const url = metadataUrl(tokenEndpoint, "token endpoint");
    const { status, body } = await this.postForm(url, form);
    if (status !== 200) {
      throw new McpAuthorizationError(
        `MCP token request failed: ${errorDetail(body, status)}`,
      );
    }
    const accessToken = body.access_token;
    if (typeof accessToken !== "string" || accessToken.length === 0) {
      throw new McpAuthorizationError("MCP token response carried no token");
    }
    if (accessToken.length > 8_192) {
      throw new McpAuthorizationError("MCP access token is too large");
    }
    const expiresIn = body.expires_in;
    const refreshToken = body.refresh_token;
    const scope = body.scope;
    const tokenType = body.token_type;
    return {
      accessToken,
      tokenType:
        typeof tokenType === "string" && tokenType ? tokenType : "Bearer",
      ...(typeof expiresIn === "number" && Number.isFinite(expiresIn)
        ? { expiresAt: this.now() + Math.max(0, Math.floor(expiresIn)) * 1_000 }
        : {}),
      ...(typeof refreshToken === "string" &&
      refreshToken.length > 0 &&
      refreshToken.length <= 8_192
        ? { refreshToken }
        : {}),
      ...(typeof scope === "string" && scope.length <= 1_024 ? { scope } : {}),
    };
  }

  /**
   * RFC 7009 revocation. The specification makes an unknown token a *success*,
   * so anything but a transport failure or a server error counts as revoked;
   * only the absence of an endpoint leaves the Connection needing
   * reconciliation.
   */
  async revoke(input: {
    revocationEndpoint: string;
    token: string;
    tokenTypeHint: "access_token" | "refresh_token";
    clientId: string;
  }): Promise<boolean> {
    const url = metadataUrl(input.revocationEndpoint, "revocation endpoint");
    try {
      const { status } = await this.postForm(url, {
        token: input.token,
        token_type_hint: input.tokenTypeHint,
        client_id: input.clientId,
      });
      return status >= 200 && status < 400;
    } catch {
      return false;
    }
  }
}

/**
 * Whether an MCP failure is the server asking for authorization. The status is
 * the whole of it — a 401 is a token the User can replace, and everything else
 * is a server that is not there — and the `WWW-Authenticate` header carries
 * where the metadata lives when the server names it.
 */
export function mcpAuthorizationRequiredV1(
  error: unknown,
): { resourceMetadataUrl?: string } | undefined {
  if (!(error instanceof McpProtocolError) || error.status !== 401) {
    return undefined;
  }
  const named = parseResourceMetadataChallengeV1(error.wwwAuthenticate ?? null);
  return named ? { resourceMetadataUrl: named } : {};
}
