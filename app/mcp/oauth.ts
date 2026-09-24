// Signing in to a remote MCP server, as the MCP authorization specification
// has a client do it: protected-resource metadata (RFC 9728), the
// authorization server's metadata (RFC 8414, or OpenID discovery), a client
// identity — a client metadata document when the server takes one, dynamic
// registration (RFC 7591) when it offers that — an authorization-code grant
// with PKCE S256 and the RFC 8707 resource on every request, refresh, and
// revocation (RFC 7009) when the server has an endpoint for it.
//
// The protocol is the official SDK's; this module is the edge around it, as
// `client.ts` is for the MCP session: every request goes through the same
// outbound classifier, under a deadline and a small body bound, and every
// failure becomes a sentence a person can act on. It holds nothing: the User
// Durable Object that calls it keeps every record and every secret.
import {
  checkResourceAllowed,
  discoverOAuthServerInfo,
  exchangeAuthorization,
  IssuerMismatchError,
  OAuthError,
  refreshAuthorization,
  registerClient,
  resourceUrlFromServerUrl,
  startAuthorization,
  type AuthorizationServerMetadata,
  type OAuthTokens,
} from "@modelcontextprotocol/client";
import {
  CONNECTION_RETURN_CLIENTS_V1,
  type ConnectionReturnClientV1,
} from "@frockbot/core/configuration";
import { withDeadlineV1 } from "@frockbot/core/deadline";
import { classifyOutboundUrlV1 } from "@frockbot/app/web/ssrf";
import {
  guardedMcpFetchV1,
  type McpAuthChallengeV1,
  type McpFetchV1,
} from "./client.js";

/** Where an authorization server sends the person back. */
export const MCP_OAUTH_CALLBACK_PATH = "/api/mcp/oauth/callback";
/** FrockBot's client metadata document, its `client_id` where one is taken. */
export const MCP_OAUTH_CLIENT_PATH = "/api/mcp/oauth/client";
/** How long a person has to finish signing in. */
export const MCP_SIGN_IN_TTL_MS_V1 = 10 * 60_000;
/** How long one request to an authorization server may take. */
const OAUTH_TIMEOUT_MS = 20_000;
/** The largest answer an authorization server may give. */
const OAUTH_MAX_BYTES = 64 * 1024;
/** The longest token FrockBot keeps. */
const MAX_TOKEN = 16_384;

const CLIENT_NAME = "FrockBot";

export const MCP_SIGN_IN_UNAVAILABLE_LINE_V1 =
  "This server doesn't offer a sign-in FrockBot can use. Give it an access token from the server instead.";

/** A sign-in that cannot go on, with the sentence a person reads. */
export class McpSignInError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "McpSignInError";
  }
}

/** What FrockBot keeps of an authorization server's metadata. */
export interface McpAuthorizationServerV1 {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  response_types_supported: string[];
  code_challenge_methods_supported: string[];
  registration_endpoint?: string;
  revocation_endpoint?: string;
  token_endpoint_auth_methods_supported?: string[];
  revocation_endpoint_auth_methods_supported?: string[];
  authorization_response_iss_parameter_supported?: boolean;
  client_id_metadata_document_supported?: boolean;
}

/** Where and how one MCP server's sign-in happens. Never a secret. */
export interface McpSignInServerV1 {
  /** The authorization server's URL, as its metadata was fetched for it. */
  authorizationServerUrl: string;
  metadata: McpAuthorizationServerV1;
  /** The RFC 8707 resource every request names. */
  resource: string;
  scope?: string;
}

/** FrockBot's identity at one authorization server. */
export interface McpSignInClientV1 {
  client_id: string;
  /** Only a server that insisted on a confidential client issues one. */
  client_secret?: string;
  token_endpoint_auth_method?: string;
}

export interface McpSignInTokensV1 {
  accessToken: string;
  /** Epoch milliseconds; absent when the server said nothing of expiry. */
  expiresAt?: number;
  refreshToken?: string;
}

/** Which of this deployment's return pages a callback path names. */
export function mcpOAuthCallbackPathV1(
  client?: ConnectionReturnClientV1,
): string {
  return client === undefined
    ? MCP_OAUTH_CALLBACK_PATH
    : `${MCP_OAUTH_CALLBACK_PATH}/${client}`;
}

/** The return client a callback path names, `undefined` for the plain page. */
export function mcpOAuthReturnClientV1(
  pathname: string,
): ConnectionReturnClientV1 | undefined | null {
  if (pathname === MCP_OAUTH_CALLBACK_PATH) return undefined;
  return (
    CONNECTION_RETURN_CLIENTS_V1.find(
      (client) => pathname === mcpOAuthCallbackPathV1(client),
    ) ?? null
  );
}

/**
 * Every address a server may send the person back to: the plain page and
 * each app's own. All are registered at once, so the identity FrockBot got
 * from a server serves a sign-in started from any of them.
 */
export function mcpOAuthRedirectUrisV1(origin: string): string[] {
  return [undefined, ...CONNECTION_RETURN_CLIENTS_V1].map(
    (client) => `${origin}${mcpOAuthCallbackPathV1(client)}`,
  );
}

/**
 * FrockBot's client metadata document: what an authorization server that
 * takes a URL as a `client_id` fetches to learn who is asking.
 */
export function mcpOAuthClientMetadataV1(origin: string) {
  return {
    client_id: `${origin}${MCP_OAUTH_CLIENT_PATH}`,
    client_name: CLIENT_NAME,
    client_uri: `${origin}/`,
    redirect_uris: mcpOAuthRedirectUrisV1(origin),
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * The seam every sign-in request goes through: classified as an MCP request
 * is, bounded in time and size, and read whole before it is handed back so
 * the deadline covers the body as well.
 */
export function mcpOAuthFetchV1(base?: McpFetchV1): McpFetchV1 {
  const guarded = guardedMcpFetchV1(
    base ?? ((input, init) => globalThis.fetch(input, init)),
  );
  return async (input, init = {}) => {
    const deadline = withDeadlineV1(OAUTH_TIMEOUT_MS, init.signal ?? undefined);
    try {
      const response = await guarded(input, {
        ...init,
        signal: deadline.signal,
      });
      const empty = [101, 204, 205, 304].includes(response.status);
      const body = empty ? null : await readBounded(response);
      return new Response(body, {
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      });
    } finally {
      deadline.clear();
    }
  };
}

async function readBounded(
  response: Response,
): Promise<Uint8Array<ArrayBuffer>> {
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array(0);
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > OAUTH_MAX_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new McpSignInError("The server's sign-in answer is too large.");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

function strings(value: unknown, limit = 64): string[] | undefined {
  return Array.isArray(value)
    ? value
        .filter(
          (item): item is string =>
            typeof item === "string" && item.length <= 256,
        )
        .slice(0, limit)
    : undefined;
}

function publicHttps(value: unknown): value is string {
  return (
    typeof value === "string" &&
    classifyOutboundUrlV1(value, { allowNonDefaultPort: true }).allowed
  );
}

/**
 * Finds where one server's sign-in happens and whether FrockBot can use it:
 * an authorization server whose metadata is published, whose endpoints are
 * public https ones, and which does PKCE with S256 — a server that says
 * nothing of PKCE is taken not to do it.
 */
export async function discoverMcpSignInV1(input: {
  url: string;
  challenge?: McpAuthChallengeV1;
  fetch?: McpFetchV1;
}): Promise<McpSignInServerV1> {
  const fetchFn = mcpOAuthFetchV1(input.fetch);
  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(input.url, {
      ...(input.challenge?.resourceMetadataUrl
        ? { resourceMetadataUrl: new URL(input.challenge.resourceMetadataUrl) }
        : {}),
      fetchFn,
    });
  } catch {
    throw new McpSignInError(MCP_SIGN_IN_UNAVAILABLE_LINE_V1);
  }
  const found = info.authorizationServerMetadata as
    Record<string, unknown> | undefined;
  const challengeMethods = strings(found?.code_challenge_methods_supported);
  const responseTypes = strings(found?.response_types_supported);
  if (
    !found ||
    typeof found.issuer !== "string" ||
    !publicHttps(found.authorization_endpoint) ||
    !publicHttps(found.token_endpoint) ||
    !challengeMethods?.includes("S256") ||
    !responseTypes?.includes("code")
  ) {
    throw new McpSignInError(MCP_SIGN_IN_UNAVAILABLE_LINE_V1);
  }
  const optionalUrl = (value: unknown) =>
    publicHttps(value) ? value : undefined;
  const registration = optionalUrl(found.registration_endpoint);
  const revocation = optionalUrl(found.revocation_endpoint);
  const tokenMethods = strings(found.token_endpoint_auth_methods_supported);
  const revocationMethods = strings(
    found.revocation_endpoint_auth_methods_supported,
  );
  const metadata: McpAuthorizationServerV1 = {
    issuer: found.issuer.slice(0, 2_048),
    authorization_endpoint: found.authorization_endpoint,
    token_endpoint: found.token_endpoint,
    response_types_supported: responseTypes,
    code_challenge_methods_supported: challengeMethods,
    ...(registration ? { registration_endpoint: registration } : {}),
    ...(revocation ? { revocation_endpoint: revocation } : {}),
    ...(tokenMethods
      ? { token_endpoint_auth_methods_supported: tokenMethods }
      : {}),
    ...(revocationMethods
      ? { revocation_endpoint_auth_methods_supported: revocationMethods }
      : {}),
    ...(found.authorization_response_iss_parameter_supported === true
      ? { authorization_response_iss_parameter_supported: true }
      : {}),
    ...(found.client_id_metadata_document_supported === true
      ? { client_id_metadata_document_supported: true }
      : {}),
  };
  // The token is for this server and no other (RFC 8707). A server whose
  // metadata names a resource this address is not under is refused, which is
  // what stops one server lending out another's sign-in.
  const requested = resourceUrlFromServerUrl(input.url);
  let resource = requested.href;
  const declared = info.resourceMetadata?.resource;
  if (declared !== undefined) {
    if (
      !checkResourceAllowed({
        requestedResource: requested,
        configuredResource: declared,
      })
    ) {
      throw new McpSignInError(
        "This server's sign-in is for a different server.",
      );
    }
    resource = new URL(declared).href;
  }
  const scope =
    input.challenge?.scope ??
    strings(info.resourceMetadata?.scopes_supported)?.join(" ");
  return {
    authorizationServerUrl: info.authorizationServerUrl,
    metadata,
    resource,
    ...(scope && scope.length <= 1_024 ? { scope } : {}),
  };
}

function sdkMetadata(server: McpSignInServerV1): AuthorizationServerMetadata {
  // What FrockBot keeps is the part of the document the SDK reads.
  return server.metadata as unknown as AuthorizationServerMetadata;
}

/**
 * FrockBot's identity at a server: a public client registered for every
 * return address where the server offers registration, which every server
 * that signs in MCP clients has offered longest; otherwise its client
 * metadata document, where the server takes a URL as a `client_id`.
 */
export async function registerMcpClientV1(input: {
  server: McpSignInServerV1;
  origin: string;
  fetch?: McpFetchV1;
}): Promise<McpSignInClientV1> {
  const document = mcpOAuthClientMetadataV1(input.origin);
  if (!input.server.metadata.registration_endpoint) {
    if (
      input.server.metadata.client_id_metadata_document_supported === true &&
      new URL(input.origin).protocol === "https:"
    ) {
      return { client_id: document.client_id };
    }
    throw new McpSignInError(
      "This server's sign-in doesn't let FrockBot register with it. Give it an access token from the server instead.",
    );
  }
  const { client_id: _clientId, ...clientMetadata } = document;
  let registered: Awaited<ReturnType<typeof registerClient>>;
  try {
    registered = await registerClient(input.server.authorizationServerUrl, {
      metadata: sdkMetadata(input.server),
      clientMetadata,
      ...(input.server.scope ? { scope: input.server.scope } : {}),
      fetchFn: mcpOAuthFetchV1(input.fetch),
    });
  } catch {
    throw new McpSignInError(
      "The server wouldn't register FrockBot for its sign-in. Try again later, or give it an access token instead.",
    );
  }
  if (!registered.client_id || registered.client_id.length > 2_048) {
    throw new McpSignInError(MCP_SIGN_IN_UNAVAILABLE_LINE_V1);
  }
  return {
    client_id: registered.client_id,
    ...(registered.client_secret
      ? { client_secret: registered.client_secret.slice(0, MAX_TOKEN) }
      : {}),
    ...(registered.token_endpoint_auth_method
      ? { token_endpoint_auth_method: registered.token_endpoint_auth_method }
      : {}),
  };
}

/** The address a person signs in at, and the PKCE verifier kept for it. */
export async function authorizeMcpSignInV1(input: {
  server: McpSignInServerV1;
  client: McpSignInClientV1;
  redirectUri: string;
  state: string;
}): Promise<{ authorizationUrl: string; codeVerifier: string }> {
  const started = await startAuthorization(
    input.server.authorizationServerUrl,
    {
      metadata: sdkMetadata(input.server),
      clientInformation: input.client,
      redirectUrl: input.redirectUri,
      state: input.state,
      resource: new URL(input.server.resource),
      ...(input.server.scope ? { scope: input.server.scope } : {}),
    },
  );
  return {
    authorizationUrl: started.authorizationUrl.href,
    codeVerifier: started.codeVerifier,
  };
}

function signInFailure(error: unknown): McpSignInError {
  if (error instanceof McpSignInError) return error;
  if (error instanceof IssuerMismatchError) {
    return new McpSignInError(
      "The sign-in came back from a different server than it went to. Sign in again.",
    );
  }
  if (error instanceof OAuthError) {
    return new McpSignInError(
      `The server refused the sign-in (${String(error.code).slice(0, 64)}). Sign in again.`,
    );
  }
  return new McpSignInError(
    "The server's sign-in couldn't be reached. Try again later.",
  );
}

function tokensOf(
  tokens: OAuthTokens,
  now: number,
  previousRefresh?: string,
): McpSignInTokensV1 {
  if (
    tokens.token_type.toLowerCase() !== "bearer" ||
    !tokens.access_token ||
    tokens.access_token.length > MAX_TOKEN
  ) {
    throw new McpSignInError(
      "The server issued a kind of token FrockBot can't use.",
    );
  }
  const refresh = tokens.refresh_token ?? previousRefresh;
  const seconds = tokens.expires_in;
  return {
    accessToken: tokens.access_token,
    ...(typeof seconds === "number" && Number.isFinite(seconds) && seconds > 0
      ? { expiresAt: now + Math.floor(seconds) * 1_000 }
      : {}),
    ...(refresh && refresh.length <= MAX_TOKEN
      ? { refreshToken: refresh }
      : {}),
  };
}

/** The authorization code, traded once for tokens. */
export async function exchangeMcpSignInV1(input: {
  server: McpSignInServerV1;
  client: McpSignInClientV1;
  code: string;
  iss?: string;
  codeVerifier: string;
  redirectUri: string;
  fetch?: McpFetchV1;
  now: number;
}): Promise<McpSignInTokensV1> {
  try {
    return tokensOf(
      await exchangeAuthorization(input.server.authorizationServerUrl, {
        metadata: sdkMetadata(input.server),
        clientInformation: input.client,
        authorizationCode: input.code,
        ...(input.iss === undefined ? {} : { iss: input.iss }),
        codeVerifier: input.codeVerifier,
        redirectUri: input.redirectUri,
        resource: new URL(input.server.resource),
        fetchFn: mcpOAuthFetchV1(input.fetch),
      }),
      input.now,
    );
  } catch (error) {
    throw signInFailure(error);
  }
}

/** A fresh access token for the refresh token. A new one replaces the old. */
export async function refreshMcpSignInV1(input: {
  server: McpSignInServerV1;
  client: McpSignInClientV1;
  refreshToken: string;
  fetch?: McpFetchV1;
  now: number;
}): Promise<McpSignInTokensV1> {
  try {
    return tokensOf(
      await refreshAuthorization(input.server.authorizationServerUrl, {
        metadata: sdkMetadata(input.server),
        clientInformation: input.client,
        refreshToken: input.refreshToken,
        resource: new URL(input.server.resource),
        fetchFn: mcpOAuthFetchV1(input.fetch),
      }),
      input.now,
      input.refreshToken,
    );
  } catch (error) {
    throw signInFailure(error);
  }
}

/**
 * What telling a server a token is done with came to. `revoked` is its
 * success, which by RFC 7009 is also its answer for a token it no longer
 * knows; `refused` is any other answer it gave, which asking again would not
 * change; `unsupported` is a server with nowhere to ask; `unreachable` is no
 * answer at all, the one worth asking again.
 */
export type McpRevocationV1 =
  "revoked" | "refused" | "unsupported" | "unreachable";

/** Tells the server a token is done with (RFC 7009). */
export async function revokeMcpSignInV1(input: {
  server: McpSignInServerV1;
  client: McpSignInClientV1;
  token: string;
  hint: "access_token" | "refresh_token";
  fetch?: McpFetchV1;
}): Promise<McpRevocationV1> {
  const endpoint = input.server.metadata.revocation_endpoint;
  if (!endpoint) return "unsupported";
  const body = new URLSearchParams({
    token: input.token,
    token_type_hint: input.hint,
  });
  const headers = new Headers({
    "content-type": "application/x-www-form-urlencoded",
    accept: "application/json",
  });
  const secret = input.client.client_secret;
  const methods =
    input.server.metadata.revocation_endpoint_auth_methods_supported ?? [];
  if (
    secret &&
    (methods.length === 0 || methods.includes("client_secret_basic"))
  ) {
    headers.set(
      "authorization",
      `Basic ${btoa(`${encodeURIComponent(input.client.client_id)}:${encodeURIComponent(secret)}`)}`,
    );
  } else {
    body.set("client_id", input.client.client_id);
    if (secret) body.set("client_secret", secret);
  }
  try {
    const response = await mcpOAuthFetchV1(input.fetch)(endpoint, {
      method: "POST",
      headers,
      body,
    });
    if (response.ok) return "revoked";
    // A server in trouble, or one asking us to slow down, may answer later.
    return response.status >= 500 || response.status === 429
      ? "unreachable"
      : "refused";
  } catch {
    return "unreachable";
  }
}

const ACCESS_PREFIX = "mcp-oauth-access:v1:";

/**
 * The credential a Turn leases for a signed-in server: its access token and
 * when that expires. The refresh token is never part of it.
 */
export function encodeMcpAccessSecretV1(tokens: McpSignInTokensV1): string {
  return `${ACCESS_PREFIX}${JSON.stringify({
    accessToken: tokens.accessToken,
    ...(tokens.expiresAt === undefined ? {} : { expiresAt: tokens.expiresAt }),
  })}`;
}

export function decodeMcpAccessSecretV1(secret: string): {
  accessToken: string;
  expiresAt?: number;
} {
  if (!secret.startsWith(ACCESS_PREFIX)) {
    throw new Error("MCP sign-in credential is invalid");
  }
  const value = JSON.parse(secret.slice(ACCESS_PREFIX.length)) as {
    accessToken?: unknown;
    expiresAt?: unknown;
  };
  if (
    typeof value.accessToken !== "string" ||
    !value.accessToken ||
    (value.expiresAt !== undefined && !Number.isFinite(value.expiresAt))
  ) {
    throw new Error("MCP sign-in credential is invalid");
  }
  return {
    accessToken: value.accessToken,
    ...(value.expiresAt === undefined
      ? {}
      : { expiresAt: value.expiresAt as number }),
  };
}

/**
 * What the User object keeps sealed beside a signed-in server's credential:
 * what refreshing it takes, and the tokens that revoking it names.
 */
export interface McpSignInGrantV1 {
  server: McpSignInServerV1;
  client: McpSignInClientV1;
  accessToken: string;
  refreshToken?: string;
}

/** What the User object keeps sealed for a sign-in still in the browser. */
export interface McpSignInAttemptSecretV1 {
  server: McpSignInServerV1;
  client: McpSignInClientV1;
  codeVerifier: string;
}

function decodeServer(value: unknown): McpSignInServerV1 {
  const server = value as Partial<McpSignInServerV1> | undefined;
  const metadata = server?.metadata;
  if (
    typeof server?.authorizationServerUrl !== "string" ||
    typeof server.resource !== "string" ||
    (server.scope !== undefined && typeof server.scope !== "string") ||
    !metadata ||
    typeof metadata.issuer !== "string" ||
    typeof metadata.authorization_endpoint !== "string" ||
    typeof metadata.token_endpoint !== "string"
  ) {
    throw new Error("MCP sign-in record is invalid");
  }
  return server as McpSignInServerV1;
}

function decodeClient(value: unknown): McpSignInClientV1 {
  const client = value as Partial<McpSignInClientV1> | undefined;
  if (
    typeof client?.client_id !== "string" ||
    (client.client_secret !== undefined &&
      typeof client.client_secret !== "string")
  ) {
    throw new Error("MCP sign-in record is invalid");
  }
  return client as McpSignInClientV1;
}

export function decodeMcpSignInGrantV1(plaintext: string): McpSignInGrantV1 {
  const value = JSON.parse(plaintext) as Partial<McpSignInGrantV1>;
  if (
    typeof value.accessToken !== "string" ||
    (value.refreshToken !== undefined && typeof value.refreshToken !== "string")
  ) {
    throw new Error("MCP sign-in record is invalid");
  }
  return {
    server: decodeServer(value.server),
    client: decodeClient(value.client),
    accessToken: value.accessToken,
    ...(value.refreshToken ? { refreshToken: value.refreshToken } : {}),
  };
}

export function decodeMcpSignInAttemptSecretV1(
  plaintext: string,
): McpSignInAttemptSecretV1 {
  const value = JSON.parse(plaintext) as Partial<McpSignInAttemptSecretV1>;
  if (typeof value.codeVerifier !== "string") {
    throw new Error("MCP sign-in record is invalid");
  }
  return {
    server: decodeServer(value.server),
    client: decodeClient(value.client),
    codeVerifier: value.codeVerifier,
  };
}
