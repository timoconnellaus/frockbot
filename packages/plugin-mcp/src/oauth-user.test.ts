/**
 * The `mcp-oauth` driver as the User Durable Object runs it: start, callback,
 * refresh on the way out of a lease, and revoke.
 *
 * Everything here goes through the real Settings and Credential Contributions
 * against an in-memory storage, so the assertions are about durable state —
 * which credential generation is active, which is merely staged, what the
 * Connection projection says — rather than about calls made.
 */
import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  createCredentialUserBackendContribution,
  type CredentialStorage,
  type CredentialTransaction,
} from "@frockbot/plugin-credentials/user";
import {
  createUserSettingsBackendContribution,
  type UserSettingsStorage,
  type UserSettingsTransaction,
} from "@frockbot/plugin-settings/user";
import { createMcpUserBackendContribution } from "./user.js";
import { mcpCodeChallengeV1 } from "./oauth.js";
import {
  mcpOAuthPendingKeyV1,
  mcpOAuthRecordKeyV1,
  mcpRefreshCredentialIdV1,
  decodeMcpOAuthRecordV1,
} from "./oauth-records.js";

const ACCOUNT = "account-1";
const SERVER = "https://mcp.example.test/mcp";
const ISSUER = "https://auth.example.test";
const REDIRECT = "https://bot.example.test/api/plugins/mcp/callback";

class MemoryStorage implements UserSettingsStorage, CredentialStorage {
  readonly values = new Map<string, unknown>();
  alarm?: number;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") this.values.set(keyOrEntries, value);
    else {
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        this.values.set(key, entry);
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  async transaction<T>(
    callback: (
      storage: UserSettingsTransaction & CredentialTransaction,
    ) => Promise<T>,
  ): Promise<T> {
    const before = new Map(this.values);
    try {
      return await callback(this);
    } catch (error) {
      this.values.clear();
      for (const [key, entry] of before) this.values.set(key, entry);
      throw error;
    }
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm ?? null);
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = Number(scheduledTime);
    return Promise.resolve();
  }
}

function keyring(): string {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 5);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return JSON.stringify({
    schemaVersion: 1,
    currentKeyId: "primary",
    keys: {
      primary: btoa(binary)
        .replaceAll("+", "-")
        .replaceAll("/", "_")
        .replace(/=+$/, ""),
    },
  });
}

interface WorldOptions {
  /** Omit the registration endpoint, so the `client-id` setting must be used. */
  withoutRegistration?: boolean;
  withoutRevocation?: boolean;
  revokeStatus?: number;
  /** Refuse every token request, as a server with a spent grant does. */
  tokenStatus?: number;
  accessTokenLifetimeSeconds?: number;
}

/**
 * One authorization server and one MCP server behind it. The MCP endpoint
 * answers only the exact bearer token the token endpoint last issued, which is
 * what makes "the Bot's tools came back after a refresh" a real assertion.
 */
function world(options: WorldOptions = {}) {
  const state = {
    live: new Set<string>(),
    refreshTokens: new Set<string>(),
    codes: new Map<string, { challenge: string; resource: string }>(),
    issued: 0,
    exchanges: 0,
    refreshes: 0,
    revocations: 0,
    lastTokenForm: {} as Record<string, string>,
    mcpBearers: [] as string[],
  };
  const fetchImpl = (async (
    input: string | URL | Request,
    init?: RequestInit,
  ) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    const form = new URLSearchParams(
      typeof init?.body === "string" ? init.body : "",
    );
    if (url.origin === ISSUER) {
      if (url.pathname === "/.well-known/oauth-authorization-server") {
        return Response.json({
          issuer: ISSUER,
          authorization_endpoint: `${ISSUER}/authorize`,
          token_endpoint: `${ISSUER}/token`,
          ...(options.withoutRegistration
            ? {}
            : { registration_endpoint: `${ISSUER}/register` }),
          ...(options.withoutRevocation
            ? {}
            : { revocation_endpoint: `${ISSUER}/revoke` }),
          code_challenge_methods_supported: ["S256"],
          token_endpoint_auth_methods_supported: ["none"],
          scopes_supported: ["mcp:tools"],
        });
      }
      if (url.pathname === "/register") {
        return Response.json(
          { client_id: "registered-client" },
          { status: 201 },
        );
      }
      if (url.pathname === "/token") {
        state.lastTokenForm = Object.fromEntries(form);
        if (options.tokenStatus) {
          return Response.json(
            { error: "invalid_grant" },
            { status: options.tokenStatus },
          );
        }
        const token = `access-${++state.issued}`;
        if (form.get("grant_type") === "authorization_code") {
          state.exchanges += 1;
          const issuedCode = state.codes.get(form.get("code") ?? "");
          state.codes.delete(form.get("code") ?? "");
          if (!issuedCode) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          if (
            (await mcpCodeChallengeV1(form.get("code_verifier") ?? "")) !==
            issuedCode.challenge
          ) {
            return Response.json({ error: "invalid_grant" }, { status: 400 });
          }
          if (form.get("resource") !== issuedCode.resource) {
            return Response.json({ error: "invalid_target" }, { status: 400 });
          }
          state.live.add(token);
          state.refreshTokens.add("refresh-1");
          return Response.json({
            access_token: token,
            token_type: "Bearer",
            expires_in: options.accessTokenLifetimeSeconds ?? 3_600,
            refresh_token: "refresh-1",
          });
        }
        state.refreshes += 1;
        if (!state.refreshTokens.has(form.get("refresh_token") ?? "")) {
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        }
        state.live.clear();
        state.live.add(token);
        return Response.json({
          access_token: token,
          token_type: "Bearer",
          expires_in: options.accessTokenLifetimeSeconds ?? 3_600,
        });
      }
      if (url.pathname === "/revoke") {
        state.revocations += 1;
        state.refreshTokens.delete(form.get("token") ?? "");
        return new Response(null, { status: options.revokeStatus ?? 200 });
      }
      return new Response("not found", { status: 404 });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") {
      return Response.json({
        resource: SERVER,
        authorization_servers: [ISSUER],
        scopes_supported: ["mcp:tools"],
      });
    }
    // The MCP endpoint itself.
    const bearer = (headers.get("authorization") ?? "").replace(/^Bearer /, "");
    state.mcpBearers.push(bearer);
    if (!state.live.has(bearer)) {
      return new Response(JSON.stringify({ error: "Unauthorized" }), {
        status: 401,
        headers: {
          "content-type": "application/json",
          "www-authenticate": `Bearer resource_metadata="https://mcp.example.test/.well-known/oauth-protected-resource/mcp"`,
        },
      });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.id === undefined) return new Response("", { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result:
        body.method === "initialize"
          ? {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "Example" },
            }
          : { tools: [{ name: "echo", inputSchema: { type: "object" } }] },
    });
  }) as typeof fetch;
  return { state, fetchImpl };
}

async function fixture(options: WorldOptions = {}) {
  const { state, fetchImpl } = world(options);
  const storage = new MemoryStorage();
  const settings = createUserSettingsBackendContribution({
    storage,
    availablePackages: [{ packageId: "mcp", version: "0.0.1" }],
  });
  await settings.executeConfiguration({
    schemaVersion: 1,
    userId: ACCOUNT,
    command: {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-1",
      expectedRevision: 0,
      packageId: "mcp",
      version: "0.0.1",
    },
  });
  const credentials = createCredentialUserBackendContribution({
    storage,
    keyring: keyring(),
  });
  let id = 0;
  let clock = Date.parse("2026-09-01T00:00:00.000Z");
  const mcp = createMcpUserBackendContribution({
    storage,
    settings,
    credentials,
    fetch: fetchImpl,
    randomId: () => `gen-${++id}`,
    now: () => clock,
  });
  const read = async (connectionId: string): Promise<ConnectionView> => {
    const connection = await settings.getConnection(ACCOUNT, connectionId);
    expect(connection).toBeDefined();
    return connection!;
  };
  /** Play the User's browser: follow the authorize URL, mint a code. */
  const authorize = async (redirectUrl: string): Promise<string> => {
    const url = new URL(redirectUrl);
    const code = `code-${url.searchParams.get("state")!.slice(0, 8)}`;
    state.codes.set(code, {
      challenge: url.searchParams.get("code_challenge")!,
      resource: url.searchParams.get("resource")!,
    });
    return code;
  };
  return {
    storage,
    settings,
    credentials,
    mcp,
    read,
    state,
    authorize,
    advance: (ms: number) => {
      clock += ms;
    },
    now: () => clock,
  };
}

const START = {
  commandId: "connect-1",
  label: "Example",
  settings: { url: SERVER, transport: "streamable-http" as const },
  redirectUri: REDIRECT,
  callbackState: "signed-state-token",
  authorizationStateId: "auth-state-1",
  returnTarget: "browser" as const,
};

async function connect(world: Awaited<ReturnType<typeof fixture>>) {
  const started = await world.mcp.startAuthorization(ACCOUNT, {
    ...START,
    authorizationStateExpiresAt: world.now() + 600_000,
  });
  expect(started.status).toBe("authorization-required");
  const code = await world.authorize(
    (started as { redirectUrl: string }).redirectUrl,
  );
  const completed = await world.mcp.completeAuthorization(ACCOUNT, {
    authorizationStateId: START.authorizationStateId,
    connectionId: started.connectionId,
    returnTarget: "browser",
    code,
  });
  return { started, completed, connectionId: started.connectionId };
}

describe("starting an authorization", () => {
  test("mints a host-authored URL and records the pending authorization first", async () => {
    const world = await fixture();
    const started = await world.mcp.startAuthorization(ACCOUNT, {
      ...START,
      authorizationStateExpiresAt: world.now() + 600_000,
    });

    expect(started.status).toBe("authorization-required");
    const url = new URL((started as { redirectUrl: string }).redirectUrl);
    expect(url.origin + url.pathname).toBe(`${ISSUER}/authorize`);
    expect(url.searchParams.get("state")).toBe(START.callbackState);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("resource")).toBe(SERVER);
    expect(url.searchParams.get("client_id")).toBe("registered-client");
    expect(url.searchParams.get("scope")).toBe("mcp:tools");

    // The verifier is durable and never on the wire to the client.
    const pending = world.storage.values.get(
      mcpOAuthPendingKeyV1(START.authorizationStateId),
    ) as { codeVerifier: string };
    expect(pending.codeVerifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(JSON.stringify(started)).not.toContain(pending.codeVerifier);

    // The Connection exists, in `authorizing`, before the browser leaves.
    expect((await world.read(started.connectionId)).state).toBe("authorizing");
  });

  test("uses the client-id setting when the server offers no registration", async () => {
    const world = await fixture({ withoutRegistration: true });
    const started = await world.mcp.startAuthorization(ACCOUNT, {
      ...START,
      settings: { ...START.settings, "client-id": "preregistered" },
      authorizationStateExpiresAt: world.now() + 600_000,
    });
    expect(
      new URL(
        (started as { redirectUrl: string }).redirectUrl,
      ).searchParams.get("client_id"),
    ).toBe("preregistered");
  });

  test("refuses a server that offers neither registration nor a client-id", async () => {
    const world = await fixture({ withoutRegistration: true });
    await expect(
      world.mcp.startAuthorization(ACCOUNT, {
        ...START,
        authorizationStateExpiresAt: world.now() + 600_000,
      }),
    ).rejects.toThrow(/no dynamic client registration/);
    // And the refusal is durable on the Connection, not only thrown.
    const connections = (await world.settings.read(ACCOUNT)).connections;
    expect(connections[0]).toMatchObject({ state: "failed" });
  });

  test("charges a per-User quota, and refuses past it", async () => {
    const world = await fixture();
    for (let attempt = 0; attempt < 24; attempt += 1) {
      await world.mcp
        .startAuthorization(ACCOUNT, {
          ...START,
          commandId: `connect-${attempt}`,
          authorizationStateId: `auth-state-${attempt}`,
          authorizationStateExpiresAt: world.now() + 600_000,
        })
        .catch(() => undefined);
    }
    await expect(
      world.mcp.startAuthorization(ACCOUNT, {
        ...START,
        commandId: "connect-over",
        authorizationStateId: "auth-state-over",
        authorizationStateExpiresAt: world.now() + 600_000,
      }),
    ).rejects.toThrow(/at most 24 MCP authorizations an hour/);
  });
});

describe("completing an authorization", () => {
  test("exchanges the code and reaches ready only after the handshake", async () => {
    const world = await fixture();
    const { completed, connectionId } = await connect(world);

    expect(completed).toMatchObject({
      returnTarget: "browser",
      status: "ready",
    });
    expect(world.state.exchanges).toBe(1);
    expect(world.state.lastTokenForm.resource).toBe(SERVER);
    expect(world.state.lastTokenForm.grant_type).toBe("authorization_code");
    const connection = await world.read(connectionId);
    expect(connection.state).toBe("ready");
    expect(connection.safeMetadata).toMatchObject({ serverName: "Example" });
    // The handshake carried the bearer the token endpoint issued.
    expect(world.state.mcpBearers).toContain("access-1");
  });

  test("seals the access token leasably and the refresh token not at all", async () => {
    const world = await fixture();
    const { connectionId } = await connect(world);

    const record = decodeMcpOAuthRecordV1(
      world.storage.values.get(mcpOAuthRecordKeyV1(connectionId)),
    );
    expect(record.accessGeneration).toBeDefined();
    expect(record.refreshGeneration).toBe(record.accessGeneration!);

    // The access token leases.
    const lease = await world.mcp.leaseToolCredential({
      accountId: ACCOUNT,
      connectionId,
      effectId: "effect-1",
      connectionGeneration: (await world.read(connectionId)).generation!,
    });
    expect(
      await world.credentials.openLease({
        accountId: ACCOUNT,
        packageId: "mcp",
        lease,
      }),
    ).toBe("access-1");

    // The refresh token has no active generation at all, so there is nothing
    // to lease: it is unleasable, not merely un-leased.
    await expect(
      world.credentials.lease({
        accountId: ACCOUNT,
        connectionId: mcpRefreshCredentialIdV1(connectionId),
        packageId: "mcp",
        effectId: "effect-refresh",
        expiresAt: new Date(world.now() + 60_000).toISOString(),
        expectedGeneration: record.refreshGeneration!,
      }),
    ).rejects.toThrow(/unavailable/);
  });

  test("is a no-op the second time the same state is presented", async () => {
    const world = await fixture();
    const { connectionId, started } = await connect(world);
    expect(world.state.exchanges).toBe(1);

    const replay = await world.mcp.completeAuthorization(ACCOUNT, {
      authorizationStateId: START.authorizationStateId,
      connectionId: started.connectionId,
      returnTarget: "browser",
      code: "code-replayed",
    });
    expect(replay).toMatchObject({ status: "ready" });
    // No second token request, and the Connection is untouched.
    expect(world.state.exchanges).toBe(1);
    expect((await world.read(connectionId)).state).toBe("ready");
  });

  test("refuses a state whose Connection is not the one the record names", async () => {
    const world = await fixture();
    const started = await world.mcp.startAuthorization(ACCOUNT, {
      ...START,
      authorizationStateExpiresAt: world.now() + 600_000,
    });
    const completed = await world.mcp.completeAuthorization(ACCOUNT, {
      authorizationStateId: START.authorizationStateId,
      connectionId: "mcp-someone-elses",
      returnTarget: "browser",
      code: "code-1",
    });
    expect(completed.status).toBe("failed");
    expect(world.state.exchanges).toBe(0);
    expect((await world.read(started.connectionId)).state).toBe("authorizing");
  });

  test("leaves the Connection failed when the authorization server refuses", async () => {
    const world = await fixture();
    const started = await world.mcp.startAuthorization(ACCOUNT, {
      ...START,
      authorizationStateExpiresAt: world.now() + 600_000,
    });
    const completed = await world.mcp.completeAuthorization(ACCOUNT, {
      authorizationStateId: START.authorizationStateId,
      connectionId: started.connectionId,
      returnTarget: "browser",
      error: "access_denied",
    });
    expect(completed.status).toBe("failed");
    const connection = await world.read(started.connectionId);
    expect(connection.state).toBe("failed");
    expect(connection.failure).toContain("access_denied");
  });
});

describe("refresh on lease open", () => {
  test("refreshes silently when the access token is about to expire", async () => {
    const world = await fixture({ accessTokenLifetimeSeconds: 120 });
    const { connectionId } = await connect(world);
    const generation = (await world.read(connectionId)).generation!;

    // Inside the skew window: the token would expire mid-lease.
    world.advance(90_000);
    const lease = await world.mcp.leaseToolCredential({
      accountId: ACCOUNT,
      connectionId,
      effectId: "effect-after-refresh",
      connectionGeneration: generation,
    });
    expect(world.state.refreshes).toBe(1);
    expect(world.state.lastTokenForm).toMatchObject({
      grant_type: "refresh_token",
      refresh_token: "refresh-1",
      resource: SERVER,
    });
    expect(
      await world.credentials.openLease({
        accountId: ACCOUNT,
        packageId: "mcp",
        lease,
      }),
    ).toBe("access-2");

    // The Connection generation is untouched, so a Turn already pinned to it
    // is not re-resolved by a refresh.
    expect((await world.read(connectionId)).generation).toBe(generation);
  });

  test("does not refresh a token with time left on it", async () => {
    const world = await fixture({ accessTokenLifetimeSeconds: 3_600 });
    const { connectionId } = await connect(world);
    await world.mcp.leaseToolCredential({
      accountId: ACCOUNT,
      connectionId,
      effectId: "effect-fresh",
      connectionGeneration: (await world.read(connectionId)).generation!,
    });
    expect(world.state.refreshes).toBe(0);
  });

  test("refuses the lease and records needs-auth when the refresh fails", async () => {
    const world = await fixture({ accessTokenLifetimeSeconds: 120 });
    const { connectionId } = await connect(world);
    world.advance(90_000);
    // The server forgets the refresh token, as one does after a User revokes.
    world.state.refreshTokens.clear();

    await expect(
      world.mcp.leaseToolCredential({
        accountId: ACCOUNT,
        connectionId,
        effectId: "effect-dead",
        connectionGeneration: (await world.read(connectionId)).generation!,
      }),
    ).rejects.toThrow(/could not be refreshed/);

    const status = await world.mcp.readServerStatus(ACCOUNT);
    expect(status.servers[0]).toMatchObject({
      state: "needs-auth",
      failure: { code: "unauthorized" },
    });
  });
});

describe("revoking", () => {
  test("revokes at the server, then forgets everything, and reports revoked", async () => {
    const world = await fixture();
    const { connectionId } = await connect(world);

    expect(await world.mcp.revokeAuthorization(ACCOUNT, connectionId)).toEqual({
      schemaVersion: 1,
      status: "revoked",
    });
    expect(world.state.revocations).toBe(1);
    expect((await world.read(connectionId)).state).toBe("revoked");
    expect(
      world.storage.values.get(mcpOAuthRecordKeyV1(connectionId)),
    ).toBeUndefined();
    // And the server record is gone with it, as `RemoveMcpAccount` requires.
    expect((await world.mcp.readServerStatus(ACCOUNT)).servers).toHaveLength(0);
  });

  test("reports reconciliation-required when the server advertises no endpoint", async () => {
    const world = await fixture({ withoutRevocation: true });
    const { connectionId } = await connect(world);

    expect(await world.mcp.revokeAuthorization(ACCOUNT, connectionId)).toEqual({
      schemaVersion: 1,
      status: "reconciliation-required",
    });
    expect((await world.read(connectionId)).state).toBe(
      "reconciliation-required",
    );
  });

  test("reports reconciliation-required when the server refuses the revocation", async () => {
    const world = await fixture({ revokeStatus: 503 });
    const { connectionId } = await connect(world);
    expect(
      (await world.mcp.revokeAuthorization(ACCOUNT, connectionId)).status,
    ).toBe("reconciliation-required");
  });

  test("disconnecting with revokeUpstream revokes at the server too", async () => {
    const world = await fixture();
    const { connectionId } = await connect(world);

    await world.mcp.executeConnection(ACCOUNT, {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "disconnect-1",
      connectionId,
      revokeUpstream: true,
    });
    expect(world.state.revocations).toBe(1);
    expect((await world.read(connectionId)).state).toBe("revoked");
  });

  test("disconnecting without it drops only FrockBot's copy", async () => {
    const world = await fixture();
    const { connectionId } = await connect(world);

    await world.mcp.executeConnection(ACCOUNT, {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "disconnect-2",
      connectionId,
      revokeUpstream: false,
    });
    expect(world.state.revocations).toBe(0);
    expect((await world.read(connectionId)).state).toBe("revoked");
  });
});
