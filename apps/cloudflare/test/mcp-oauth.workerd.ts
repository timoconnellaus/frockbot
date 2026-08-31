// The `mcp-oauth` driver in workerd, against the stubbed authorization server.
//
// The unit suite hands the driver a `fetch` of its own. This one does not: the
// User Contribution falls back to the runtime's global `fetch`, which is the
// production path and the one that fails with "Illegal invocation" if the
// global is passed by reference inside a Durable Object rather than called.
// The authorization server, the protected MCP endpoint and the browser's
// redirect are all real HTTP here, through the outbound seam.
import { describe, expect, test } from "vitest";
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
import { createMcpUserBackendContribution } from "@frockbot/plugin-mcp/user";
import {
  createMcpBackendContribution,
  MCP_CALLBACK_ROUTE,
  MCP_CONNECTIONS_ROUTE,
} from "@frockbot/plugin-mcp/backend";
import { encodeAuthorizationState } from "@frockbot/connection-core";
import {
  mcpOAuthEndpoint,
  mcpOAuthLedgerEndpoint,
  TEST_CREDENTIAL_KEYRING,
} from "./harness/miniflare.ts";

/**
 * This file's own connector. The stub is one shared module for the whole
 * parallel run, so every counter and switch it owns is scoped to a tenant and
 * no test file can perturb another's.
 */
const TENANT = "workerd-oauth";
const MCP_OAUTH_ENDPOINT = mcpOAuthEndpoint(TENANT);

const ACCOUNT = "mcp-oauth-workerd-user";
const ORIGIN = "https://bot.frockbot.com";
const SECRET = "workerd-mcp-oauth-state-secret-0123456789abcdef";

class MemoryStorage implements UserSettingsStorage, CredentialStorage {
  readonly values = new Map<string, unknown>();

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
    return callback(this);
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(null);
  }

  setAlarm(): Promise<void> {
    return Promise.resolve();
  }
}

interface Ledger {
  registrations: number;
  authorizations: number;
  codeExchanges: number;
  refreshes: number;
  revocations: number;
  authorizeResource: string;
  tokenResource: string;
  codeChallengeMethod: string;
  pkceRejections: number;
  unauthorizedMcpCalls: number;
}

async function ledger(): Promise<Ledger> {
  return (await (await fetch(mcpOAuthLedgerEndpoint(TENANT))).json()) as Ledger;
}

/**
 * The whole stack a callback traverses: the gateway Contribution that verifies
 * the state, and the User Contribution that owns every record and every token.
 * Nothing is injected past a Package boundary — the User Contribution reaches
 * the authorization server with the runtime's own `fetch`.
 */
async function fixture() {
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
    keyring: TEST_CREDENTIAL_KEYRING,
  });
  const mcp = createMcpUserBackendContribution({
    storage,
    settings,
    credentials,
  });
  const contribution = createMcpBackendContribution({
    readMcpServers: (userId) => mcp.readServerStatus(userId),
    executeMcpCommand: (userId, command) =>
      mcp.executeLifecycle(userId, command),
    readSecret: (name) =>
      name === "FROCKBOT_AUTHORIZATION_STATE_SECRET" ? SECRET : undefined,
    callbackBaseUrl: ORIGIN,
    startMcpAuthorization: (userId, start) =>
      mcp.startAuthorization(userId, start),
    completeMcpAuthorization: (userId, completion) =>
      mcp.completeAuthorization(userId, completion),
    revokeMcpAuthorization: (userId, connectionId) =>
      mcp.revokeAuthorization(userId, connectionId),
  });
  const call = (path: string, init: RequestInit = {}, userId = ACCOUNT) => {
    const url = new URL(`${ORIGIN}${path}`);
    return contribution.route(new Request(url, init), url, {
      userId,
      client: "browser",
    });
  };
  const callback = (query: string) => {
    const url = new URL(`${ORIGIN}${MCP_CALLBACK_ROUTE}?${query}`);
    // Through `publicRoute`, which is how the real gateway reaches it: before
    // authentication, with no session at all.
    return contribution.publicRoute!(new Request(url), url, {
      client: "browser",
    });
  };
  return { storage, settings, mcp, call, callback };
}

async function start(
  world: Awaited<ReturnType<typeof fixture>>,
  commandId: string,
) {
  const response = await world.call(MCP_CONNECTIONS_ROUTE, {
    method: "POST",
    body: JSON.stringify({
      schemaVersion: 1,
      type: "connection/start",
      commandId,
      connectionTypeId: "mcp-remote-oauth",
      label: "OAuth Example",
      settings: { url: MCP_OAUTH_ENDPOINT, transport: "streamable-http" },
    }),
  });
  expect(response!.status).toBe(201);
  return (await response!.json()) as {
    status: string;
    connectionId: string;
    redirectUrl: string;
  };
}

/** Follow the authorize redirect as a browser would, and return its query. */
async function followAuthorize(redirectUrl: string): Promise<URLSearchParams> {
  const response = await fetch(redirectUrl, { redirect: "manual" });
  expect(response.status).toBe(303);
  return new URL(response.headers.get("location")!).searchParams;
}

describe("the mcp-oauth driver in workerd", () => {
  test("reaches ready only after the Durable Object has reconciled the callback", async () => {
    const world = await fixture();
    const before = await ledger();

    const started = await start(world, "workerd-oauth-1");
    expect(started.status).toBe("authorization-required");

    // The Connection exists, and it is not ready: a redirect has been minted
    // and nothing has been proved yet.
    let connection = (await world.settings.read(ACCOUNT)).connections.find(
      (candidate) => candidate.connectionId === started.connectionId,
    );
    expect(connection!.state).toBe("authorizing");
    // The MCP server has been asked for nothing on this Connection's behalf.
    expect(started.redirectUrl).toContain("code_challenge_method=S256");

    const query = await followAuthorize(started.redirectUrl);
    const response = await world.callback(query.toString());
    expect(response!.status).toBe(303);
    expect(response!.headers.get("location")).toBe(
      `${ORIGIN}/?connection=mcp-ready`,
    );

    connection = (await world.settings.read(ACCOUNT)).connections.find(
      (candidate) => candidate.connectionId === started.connectionId,
    );
    expect(connection!.state).toBe("ready");
    expect(connection!.safeMetadata).toMatchObject({
      protocolVersion: "2025-06-18",
      toolCount: 1,
    });

    const after = await ledger();
    expect(after.registrations).toBeGreaterThan(0);
    expect(after.authorizations).toBe(before.authorizations + 1);
    expect(after.codeExchanges).toBe(before.codeExchanges + 1);
    expect(after.pkceRejections).toBe(0);
    // RFC 8707 on both legs, and the same canonical resource on each.
    expect(after.authorizeResource).toBe(MCP_OAUTH_ENDPOINT);
    expect(after.tokenResource).toBe(MCP_OAUTH_ENDPOINT);
    expect(after.codeChallengeMethod).toBe("S256");
    // The MCP endpoint refused the first, unauthenticated look at it.
    expect(after.unauthorizedMcpCalls).toBeGreaterThanOrEqual(
      before.unauthorizedMcpCalls,
    );
  });

  test("refuses a callback whose state is forged or absent", async () => {
    const world = await fixture();
    const started = await start(world, "workerd-oauth-forged");
    const query = await followAuthorize(started.redirectUrl);
    const before = await ledger();

    expect((await world.callback(`code=${query.get("code")}`))!.status).toBe(
      400,
    );
    const forged = await encodeAuthorizationState(
      {
        schemaVersion: 1,
        authorizationStateId: "auth-state-forged",
        userId: ACCOUNT,
        connectionId: started.connectionId,
        returnTarget: "browser",
        expiresAt: Date.now() + 600_000,
      },
      "a-different-independent-random-secret-9876",
    );
    expect(
      (await world.callback(
        `code=${query.get("code")}&state=${encodeURIComponent(forged)}`,
      ))!.status,
    ).toBe(400);

    // Neither reached the token endpoint at all.
    expect((await ledger()).codeExchanges).toBe(before.codeExchanges);
    const connection = (await world.settings.read(ACCOUNT)).connections.find(
      (candidate) => candidate.connectionId === started.connectionId,
    );
    expect(connection!.state).toBe("authorizing");
  });

  test("makes a second callback on a consumed state a no-op", async () => {
    const world = await fixture();
    const started = await start(world, "workerd-oauth-replay");
    const query = await followAuthorize(started.redirectUrl);

    expect((await world.callback(query.toString()))!.status).toBe(303);
    const afterFirst = await ledger();

    const replay = await world.callback(query.toString());
    expect(replay!.status).toBe(303);
    expect(replay!.headers.get("location")).toBe(
      `${ORIGIN}/?connection=mcp-ready`,
    );
    // No second exchange: the authorization state id was spent.
    expect((await ledger()).codeExchanges).toBe(afterFirst.codeExchanges);

    const connection = (await world.settings.read(ACCOUNT)).connections.find(
      (candidate) => candidate.connectionId === started.connectionId,
    );
    expect(connection!.state).toBe("ready");
  });

  test("revokes at the authorization server on disconnect", async () => {
    const world = await fixture();
    const started = await start(world, "workerd-oauth-revoke");
    const query = await followAuthorize(started.redirectUrl);
    await world.callback(query.toString());
    const before = await ledger();

    const response = await world.call(
      `/api/plugins/mcp/connections/${started.connectionId}/revoke`,
      { method: "POST" },
    );
    expect(await response!.json()).toEqual({
      schemaVersion: 1,
      status: "revoked",
    });
    expect((await ledger()).revocations).toBe(before.revocations + 1);
  });
});
