/**
 * The durable state one `mcp-remote-oauth` Connection carries, beside its
 * server record, in the User Durable Object.
 *
 * Three shapes, and the split between them is the whole security argument:
 *
 * - {@link McpOAuthRecordV1} is the *non-secret* half — the endpoints, the
 *   registered `client_id`, the resource indicator, and which credential
 *   generation currently holds the access and refresh tokens. It is safe to
 *   read, and nothing in it opens anything.
 * - {@link McpOAuthPendingV1} is one authorization in flight. It holds the PKCE
 *   verifier, which is why it is keyed by `authorizationStateId` and consumed
 *   transactionally: a second callback presenting a spent id finds nothing and
 *   changes nothing.
 * - {@link McpAuthorizationStartsV1} is the per-User start quota, in a fixed
 *   window, because discovery costs outbound requests and a durable record.
 *
 * The tokens themselves are in neither. They are sealed credential generations
 * in the keyring (ADR 0008): the access token under the Connection's own id, so
 * a Bot's mount can lease it, and the refresh token under a derived id that has
 * no active generation at all — which is what makes it unleasable rather than
 * merely un-leased.
 */

export const MCP_OAUTH_RECORD_PREFIX = "mcp-oauth:";
export const MCP_OAUTH_PENDING_PREFIX = "mcp-oauth-pending:";
export const MCP_OAUTH_STARTS_KEY = "mcp-oauth-starts";

export function mcpOAuthRecordKeyV1(connectionId: string): string {
  return `${MCP_OAUTH_RECORD_PREFIX}${connectionId}`;
}

export function mcpOAuthPendingKeyV1(authorizationStateId: string): string {
  return `${MCP_OAUTH_PENDING_PREFIX}${authorizationStateId}`;
}

/**
 * Where the refresh token's sealed generation lives.
 *
 * A derived Connection id rather than a second field on the same one, because
 * `plugin-credentials` leases *the active generation of a Connection id* and
 * nothing else. This id never has an active generation — the refresh token is
 * staged and never activated — so `leaseToolCredential` cannot reach it even by
 * mistake, and `openLease` has nothing to open. The User Durable Object reads
 * it with `readStagedApiKey`, which needs no lease and never leaves the object.
 */
/**
 * The Connection id a *fresh* authorization will create.
 *
 * Derived from the command id rather than random, because the signed callback
 * state has to name the Connection before the User Durable Object has minted
 * one — and an identity the gateway guesses and the object invents separately
 * is two identities. Deriving it also makes a replayed start idempotent: the
 * second one finds the Connection the first created instead of adding another.
 */
export function mcpAuthorizationConnectionIdV1(commandId: string): string {
  return `mcp-${commandId}`.slice(0, 128);
}

export function mcpRefreshCredentialIdV1(connectionId: string): string {
  return `${connectionId}#refresh`;
}

export interface McpOAuthRecordV1 {
  schemaVersion: 1;
  connectionId: string;
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  clientId: string;
  /** The RFC 8707 resource indicator every token for this server is bound to. */
  resource: string;
  scope?: string;
  redirectUri: string;
  /** The Connection generation whose sealed access token is active. */
  accessGeneration?: string;
  /** The staged, never-activated generation holding the refresh token. */
  refreshGeneration?: string;
  /** When the access token expires, epoch milliseconds. */
  accessExpiresAt?: number;
  updatedAt: string;
}

export interface McpOAuthPendingV1 {
  schemaVersion: 1;
  authorizationStateId: string;
  connectionId: string;
  /** PKCE, RFC 7636. Never in the state token, never sent to a client. */
  codeVerifier: string;
  clientId: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  authorizationEndpoint: string;
  registrationEndpoint?: string;
  issuer: string;
  resource: string;
  scope?: string;
  redirectUri: string;
  /** The Connection generation this authorization will activate on success. */
  generation: string;
  returnTarget: "browser" | "desktop";
  nativeReturnNonce?: string;
  expiresAt: number;
  createdAt: string;
}

export interface McpAuthorizationStartsV1 {
  schemaVersion: 1;
  windowStartedAt: number;
  count: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const permitted = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!permitted.has(key)) {
      throw new Error(`${label} carries unknown field "${key}"`);
    }
  }
}

function text(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function optionalText(
  value: unknown,
  label: string,
  maximum: number,
): string | undefined {
  return value === undefined ? undefined : text(value, label, maximum);
}

function epoch(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new Error(`${label} is invalid`);
  }
  return value as number;
}

export function decodeMcpOAuthRecordV1(input: unknown): McpOAuthRecordV1 {
  const value = record(input, "MCP OAuth record");
  exact(
    value,
    [
      "schemaVersion",
      "connectionId",
      "issuer",
      "authorizationEndpoint",
      "tokenEndpoint",
      "registrationEndpoint",
      "revocationEndpoint",
      "clientId",
      "resource",
      "scope",
      "redirectUri",
      "accessGeneration",
      "refreshGeneration",
      "accessExpiresAt",
      "updatedAt",
    ],
    "MCP OAuth record",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("MCP OAuth record schemaVersion is unsupported");
  }
  const registrationEndpoint = optionalText(
    value.registrationEndpoint,
    "MCP OAuth registration endpoint",
    2_048,
  );
  const revocationEndpoint = optionalText(
    value.revocationEndpoint,
    "MCP OAuth revocation endpoint",
    2_048,
  );
  const scope = optionalText(value.scope, "MCP OAuth scope", 1_024);
  const accessGeneration = optionalText(
    value.accessGeneration,
    "MCP OAuth access generation",
    128,
  );
  const refreshGeneration = optionalText(
    value.refreshGeneration,
    "MCP OAuth refresh generation",
    128,
  );
  return {
    schemaVersion: 1,
    connectionId: text(value.connectionId, "MCP OAuth connectionId", 128),
    issuer: text(value.issuer, "MCP OAuth issuer", 2_048),
    authorizationEndpoint: text(
      value.authorizationEndpoint,
      "MCP OAuth authorization endpoint",
      2_048,
    ),
    tokenEndpoint: text(value.tokenEndpoint, "MCP OAuth token endpoint", 2_048),
    ...(registrationEndpoint === undefined ? {} : { registrationEndpoint }),
    ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
    clientId: text(value.clientId, "MCP OAuth client id", 512),
    resource: text(value.resource, "MCP OAuth resource", 2_048),
    ...(scope === undefined ? {} : { scope }),
    redirectUri: text(value.redirectUri, "MCP OAuth redirect uri", 2_048),
    ...(accessGeneration === undefined ? {} : { accessGeneration }),
    ...(refreshGeneration === undefined ? {} : { refreshGeneration }),
    ...(value.accessExpiresAt === undefined
      ? {}
      : { accessExpiresAt: epoch(value.accessExpiresAt, "MCP OAuth expiry") }),
    updatedAt: text(value.updatedAt, "MCP OAuth updatedAt", 64),
  };
}

export function decodeMcpOAuthPendingV1(input: unknown): McpOAuthPendingV1 {
  const value = record(input, "MCP OAuth pending authorization");
  exact(
    value,
    [
      "schemaVersion",
      "authorizationStateId",
      "connectionId",
      "codeVerifier",
      "clientId",
      "tokenEndpoint",
      "revocationEndpoint",
      "authorizationEndpoint",
      "registrationEndpoint",
      "issuer",
      "resource",
      "scope",
      "redirectUri",
      "generation",
      "returnTarget",
      "nativeReturnNonce",
      "expiresAt",
      "createdAt",
    ],
    "MCP OAuth pending authorization",
  );
  if (value.schemaVersion !== 1) {
    throw new Error(
      "MCP OAuth pending authorization schemaVersion is unsupported",
    );
  }
  if (value.returnTarget !== "browser" && value.returnTarget !== "desktop") {
    throw new Error("MCP OAuth pending authorization returnTarget is invalid");
  }
  const revocationEndpoint = optionalText(
    value.revocationEndpoint,
    "MCP OAuth revocation endpoint",
    2_048,
  );
  const registrationEndpoint = optionalText(
    value.registrationEndpoint,
    "MCP OAuth registration endpoint",
    2_048,
  );
  const scope = optionalText(value.scope, "MCP OAuth scope", 1_024);
  const nativeReturnNonce = optionalText(
    value.nativeReturnNonce,
    "MCP OAuth nativeReturnNonce",
    128,
  );
  return {
    schemaVersion: 1,
    authorizationStateId: text(
      value.authorizationStateId,
      "MCP OAuth authorizationStateId",
      128,
    ),
    connectionId: text(value.connectionId, "MCP OAuth connectionId", 128),
    codeVerifier: text(value.codeVerifier, "MCP OAuth code verifier", 256),
    clientId: text(value.clientId, "MCP OAuth client id", 512),
    tokenEndpoint: text(value.tokenEndpoint, "MCP OAuth token endpoint", 2_048),
    ...(revocationEndpoint === undefined ? {} : { revocationEndpoint }),
    authorizationEndpoint: text(
      value.authorizationEndpoint,
      "MCP OAuth authorization endpoint",
      2_048,
    ),
    ...(registrationEndpoint === undefined ? {} : { registrationEndpoint }),
    issuer: text(value.issuer, "MCP OAuth issuer", 2_048),
    resource: text(value.resource, "MCP OAuth resource", 2_048),
    ...(scope === undefined ? {} : { scope }),
    redirectUri: text(value.redirectUri, "MCP OAuth redirect uri", 2_048),
    generation: text(value.generation, "MCP OAuth generation", 128),
    returnTarget: value.returnTarget,
    ...(nativeReturnNonce === undefined ? {} : { nativeReturnNonce }),
    expiresAt: epoch(value.expiresAt, "MCP OAuth pending expiry"),
    createdAt: text(value.createdAt, "MCP OAuth createdAt", 64),
  };
}

export function decodeMcpAuthorizationStartsV1(
  input: unknown,
): McpAuthorizationStartsV1 {
  const value = record(input, "MCP authorization start ledger");
  exact(
    value,
    ["schemaVersion", "windowStartedAt", "count"],
    "MCP authorization start ledger",
  );
  if (value.schemaVersion !== 1) {
    throw new Error("MCP authorization start ledger is unsupported");
  }
  return {
    schemaVersion: 1,
    windowStartedAt: epoch(value.windowStartedAt, "window start"),
    count: epoch(value.count, "start count"),
  };
}
