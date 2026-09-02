// `needs-auth` in workerd: a server that stops accepting its token, and the
// User's way back.
//
// The interesting half is not the 401 — it is what the deployment does with
// one. A mount that meets `WWW-Authenticate: Bearer …` must leave the Bot with
// no tools rather than broken ones, must flip the durable record, and must put
// a URL-free connect card on the Connection projection the User's surface
// draws from. Then pressing *Reconnect* — the authenticated `connection/start`
// — must bring both the record and the tools back.
import { describe, expect, test } from "vitest";
import { Context } from "cordis";
import { ToolRegistry } from "@frockbot/plugin-tools";
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
  createConfiguredMcpRuntimeContribution,
  type McpMountOutcomeV1,
} from "@frockbot/plugin-mcp/agent";
import {
  createMcpBackendContribution,
  MCP_CALLBACK_ROUTE,
  MCP_CONNECTIONS_ROUTE,
} from "@frockbot/plugin-mcp/backend";
import {
  mcpOAuthAcceptEndpoint,
  mcpOAuthEndpoint,
  mcpOAuthRejectEndpoint,
  TEST_CREDENTIAL_KEYRING,
} from "./harness/miniflare.ts";

/** This file's own connector; see `mcp-oauth.workerd.ts` for why. */
const TENANT = "workerd-needs-auth";
const MCP_OAUTH_ENDPOINT = mcpOAuthEndpoint(TENANT);

const ACCOUNT = "mcp-needs-auth-user";
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

async function fixture() {
  // The stub is shared by every test in the run, so each one starts from a
  // server that is honouring its grants.
  await fetch(mcpOAuthAcceptEndpoint(TENANT), { method: "POST" });
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

  /** The whole User-pressed connect path: start, browser, callback. */
  const authorize = async (
    commandId: string,
    body: Record<string, unknown>,
  ): Promise<string> => {
    const startUrl = new URL(`${ORIGIN}${MCP_CONNECTIONS_ROUTE}`);
    const startResponse = await contribution.route(
      new Request(startUrl, {
        method: "POST",
        body: JSON.stringify({
          schemaVersion: 1,
          type: "connection/start",
          commandId,
          connectionTypeId: "mcp-remote-oauth",
          ...body,
        }),
      }),
      startUrl,
      { userId: ACCOUNT, client: "browser" },
    );
    expect(startResponse!.status).toBe(201);
    const started = (await startResponse!.json()) as {
      connectionId: string;
      redirectUrl: string;
    };
    const redirected = await fetch(started.redirectUrl, {
      redirect: "manual",
    });
    expect(redirected.status).toBe(303);
    const callback = new URL(redirected.headers.get("location")!);
    const completed = await contribution.publicRoute!(
      new Request(callback),
      callback,
      { client: "browser" },
    );
    expect(completed!.headers.get("location")).toBe(
      `${ORIGIN}/?connection=mcp-ready`,
    );
    return started.connectionId;
  };

  const connection = async (connectionId: string) => {
    const view = await settings.getConnection(ACCOUNT, connectionId);
    expect(view).toBeDefined();
    return view!;
  };

  /** One mount of the ready Connection, as an admitted Turn resolves it. */
  const mount = async (connectionId: string) => {
    const outcomes: McpMountOutcomeV1[] = [];
    const failures: string[] = [];
    const view = await connection(connectionId);
    const plugin = await createConfiguredMcpRuntimeContribution({
      binding: {
        packageId: "mcp",
        capabilityId: "mcp-tools",
        connectionId,
        state: "enabled",
      },
      userId: ACCOUNT,
      readSecret: (name) =>
        name === "CREDENTIAL_KEYRING" ? TEST_CREDENTIAL_KEYRING : undefined,
      authorizeConnection: () => Promise.resolve(view),
      leaseCredential: (effectId, expectedGeneration) =>
        mcp.leaseToolCredential({
          accountId: ACCOUNT,
          connectionId,
          effectId,
          connectionGeneration: expectedGeneration!,
        }),
      settleCredential: (effectId) =>
        mcp.settleToolCredential({
          accountId: ACCOUNT,
          connectionId,
          effectId,
        }),
      onFailure: (reason) => failures.push(reason),
      onOutcome: async (outcome) => {
        outcomes.push(outcome);
        await mcp.recordMountOutcome({ accountId: ACCOUNT, ...outcome });
      },
    });
    const root = new Context();
    await root.plugin(ToolRegistry);
    if (plugin) await root.plugin(plugin);
    const tools = root.tools
      .schemas({ turnType: "chat" })
      .map((tool) => tool.name);
    await root.fiber.dispose();
    return { outcomes, failures, tools, mounted: plugin !== undefined };
  };

  return { mcp, settings, contribution, authorize, connection, mount };
}

const SETTINGS = {
  label: "OAuth Example",
  settings: { url: MCP_OAUTH_ENDPOINT, transport: "streamable-http" },
};

describe("a server that stops accepting its token", () => {
  test("flips the record to needs-auth at the next Turn, and the Bot loses its tools", async () => {
    const world = await fixture();
    const connectionId = await world.authorize("needs-auth-1", SETTINGS);

    // Working: the ready Connection mounts and its server tool is offered.
    const before = await world.mount(connectionId);
    expect(before.mounted).toBe(true);
    expect(before.tools).toContain("mcp__oauth_example__echo");
    expect(before.outcomes.at(-1)).toMatchObject({ state: "ready" });
    expect(
      (await world.connection(connectionId)).pendingAuthorization,
    ).toBeUndefined();

    // The server stops honouring the grant at the resource: every bearer is
    // refused with the RFC 9728 challenge, however fresh. A refresh still
    // succeeds, so this is the mount-time 401 and nothing else.
    await fetch(mcpOAuthRejectEndpoint(TENANT), { method: "POST" });

    const after = await world.mount(connectionId);
    expect(after.mounted).toBe(false);
    expect(after.tools).not.toContain("mcp__oauth_example__echo");
    expect(after.outcomes.at(-1)).toMatchObject({
      state: "needs-auth",
      failure: { code: "unauthorized" },
    });

    // Durable on the record the User's own surface reads…
    const status = await world.mcp.readServerStatus(ACCOUNT);
    expect(status.servers[0]).toMatchObject({
      state: "needs-auth",
      toolCount: 0,
    });
    // …and projected onto the Connection as a URL-free connect card.
    const pending = (await world.connection(connectionId)).pendingAuthorization;
    expect(pending).toMatchObject({
      reason: "needs-auth",
      connectionId,
      label: "OAuth Example",
    });
    expect(JSON.stringify(pending)).not.toContain("http");
  });

  test("comes back to ready when the User reconnects, and the tools return", async () => {
    const world = await fixture();
    const connectionId = await world.authorize("needs-auth-2", SETTINGS);
    await world.mount(connectionId);
    await fetch(mcpOAuthRejectEndpoint(TENANT), { method: "POST" });
    await world.mount(connectionId);
    expect(
      (await world.connection(connectionId)).pendingAuthorization,
    ).toBeDefined();
    // The User signs in again at the server, which starts honouring grants.
    await fetch(mcpOAuthAcceptEndpoint(TENANT), { method: "POST" });

    // *Reconnect*: the same authenticated start, naming the Connection that is
    // already there rather than creating a second one.
    const reconnected = await world.authorize("needs-auth-2-again", {
      connectionId,
    });
    expect(reconnected).toBe(connectionId);

    const view = await world.connection(connectionId);
    expect(view.state).toBe("ready");
    expect(view.pendingAuthorization).toBeUndefined();
    const status = await world.mcp.readServerStatus(ACCOUNT);
    expect(status.servers).toHaveLength(1);
    expect(status.servers[0]).toMatchObject({ state: "ready" });

    const recovered = await world.mount(connectionId);
    expect(recovered.mounted).toBe(true);
    expect(recovered.tools).toContain("mcp__oauth_example__echo");
  });
});
