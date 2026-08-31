/**
 * The MCP lifecycle against the User Contribution that owns it: the durable
 * record's states, the epoch a restart bumps, the instructions a Turn will
 * carry, and the two refusals this build records rather than performs.
 */
import { describe, expect, test } from "bun:test";
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
import { MAX_MCP_SERVERS_PER_USER_V1 } from "./agent.js";
import { createMcpUserBackendContribution } from "./user.js";

const ACCOUNT = "account-1";
const URL_TEXT = "https://mcp.example.test/mcp";
const GOOD_KEY = "good-key";

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
    return Promise.resolve(null);
  }

  setAlarm(): Promise<void> {
    return Promise.resolve();
  }
}

function keyring(): string {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 7);
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

interface ServerOptions {
  goodKey?: string;
  handshakes?: { count: number };
  /** Flip to make a server that was reachable stop answering. */
  down?: { value: boolean };
}

function mcpServer(options: ServerOptions = {}): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    if (options.down?.value) {
      return new Response("gone", { status: 503 });
    }
    const headers = new Headers(init?.headers);
    if (
      options.goodKey !== undefined &&
      headers.get("authorization") !== `Bearer ${options.goodKey}`
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.id === undefined) return new Response("", { status: 202 });
    if (body.method === "initialize" && options.handshakes) {
      options.handshakes.count += 1;
    }
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
}

async function fixture(fetchImpl: typeof fetch) {
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
  const mcp = createMcpUserBackendContribution({
    storage,
    settings,
    credentials,
    fetch: fetchImpl,
    randomId: () => `id-${++id}`,
  });
  const addServer = (overrides: Record<string, unknown> = {}) =>
    mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/add-server",
      commandId: "add-1",
      label: "Example",
      url: URL_TEXT,
      transport: "streamable-http",
      ...overrides,
    });
  return { storage, settings, credentials, mcp, addServer };
}

describe("mcp/add-server", () => {
  test("creates a ready server whose record carries what the handshake learned", async () => {
    const { mcp, addServer } = await fixture(mcpServer());

    const receipt = await addServer();
    expect(receipt.status).toBe("applied");

    const status = await mcp.readServerStatus(ACCOUNT);
    expect(status.servers).toHaveLength(1);
    expect(status.servers[0]).toMatchObject({
      serverId: receipt.serverId,
      label: "Example",
      url: URL_TEXT,
      transport: "streamable-http",
      serverEpoch: 1,
      state: "ready",
      protocolVersion: "2025-06-18",
      toolCount: 1,
    });
    expect(status.quotas).toEqual({
      maxServers: MAX_MCP_SERVERS_PER_USER_V1,
      maxToolsPerServer: 64,
      maxResponseBytes: 262_144,
    });
  });

  test("carries a key, and a key the server refuses leaves the record needs-auth", async () => {
    const { mcp, addServer } = await fixture(mcpServer({ goodKey: GOOD_KEY }));

    const good = await addServer({ apiKey: GOOD_KEY });
    expect(good.status).toBe("applied");

    const bad = await mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/add-server",
      commandId: "add-2",
      label: "Wrong key",
      url: URL_TEXT,
      transport: "streamable-http",
      apiKey: "not-the-key",
    });
    expect(bad.status).toBe("failed");

    const status = await mcp.readServerStatus(ACCOUNT);
    const failed = status.servers.find(
      (server) => server.serverId === bad.serverId,
    );
    expect(failed).toMatchObject({ state: "needs-auth" });
    expect(failed?.failure?.code).toBe("unauthorized");
  });

  test("a server that is not there leaves the record in error, durably", async () => {
    const down = { value: true };
    const { mcp, addServer } = await fixture(mcpServer({ down }));

    const receipt = await addServer();
    expect(receipt.status).toBe("failed");

    const [server] = (await mcp.readServerStatus(ACCOUNT)).servers;
    expect(server).toMatchObject({ state: "error" });
    expect(server?.failure?.code).toBe("unreachable");
    expect(server?.failure?.message).toContain("503");
  });

  test("refuses stdio durably rather than creating a Connection", async () => {
    const { mcp, settings } = await fixture(mcpServer());

    const receipt = await mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/add-server",
      commandId: "add-stdio",
      label: "Beeper",
      url: "stdio://beeper",
      transport: "stdio",
    });

    expect(receipt).toMatchObject({
      status: "refused",
      code: "unsupported-transport",
    });
    const status = await mcp.readServerStatus(ACCOUNT);
    expect(status.servers).toHaveLength(0);
    // The refusal is the durable trace: the request left one, the Connection
    // list did not gain a server that could never connect.
    expect(status.refusals[0]).toMatchObject({
      code: "unsupported-transport",
      commandId: "add-stdio",
      transport: "stdio",
      label: "Beeper",
    });
    expect((await settings.read(ACCOUNT)).connections).toHaveLength(0);
  });

  test("refuses the server past the per-User quota, visibly", async () => {
    const { mcp } = await fixture(mcpServer());
    for (let index = 0; index < MAX_MCP_SERVERS_PER_USER_V1; index += 1) {
      const receipt = await mcp.executeLifecycle(ACCOUNT, {
        schemaVersion: 1,
        type: "mcp/add-server",
        commandId: `add-${index}`,
        label: `Server ${index}`,
        url: URL_TEXT,
        transport: "streamable-http",
      });
      expect(receipt.status).toBe("applied");
    }

    const refused = await mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/add-server",
      commandId: "add-too-many",
      label: "One too many",
      url: URL_TEXT,
      transport: "streamable-http",
    });

    expect(refused).toMatchObject({
      status: "refused",
      code: "server-quota",
    });
    const status = await mcp.readServerStatus(ACCOUNT);
    expect(status.servers).toHaveLength(MAX_MCP_SERVERS_PER_USER_V1);
    expect(status.refusals[0]?.code).toBe("server-quota");
  });

  test("is idempotent on its command id", async () => {
    const { mcp, addServer } = await fixture(mcpServer());
    const first = await addServer();
    const second = await addServer();
    expect(second).toEqual(first);
    expect((await mcp.readServerStatus(ACCOUNT)).servers).toHaveLength(1);
  });

  test("refuses a reused command id carrying a different command", async () => {
    const { mcp, addServer } = await fixture(mcpServer());
    await addServer();
    await expect(addServer({ label: "Different" })).rejects.toThrow(
      "was reused for a different command",
    );
  });
});

describe("mcp/set-instructions", () => {
  test("records the instructions and mirrors them onto the Connection", async () => {
    const { mcp, settings, addServer } = await fixture(mcpServer());
    const added = await addServer();

    await mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/set-instructions",
      commandId: "set-1",
      serverId: added.serverId!,
      instructions: "Search before you answer.",
    });

    const [server] = (await mcp.readServerStatus(ACCOUNT)).servers;
    expect(server?.instructions).toBe("Search before you answer.");
    // The mirror is how a Turn reads them without a second cross-object call.
    const connection = await settings.getConnection(ACCOUNT, added.serverId!);
    expect(connection?.safeMetadata.instructions).toBe(
      "Search before you answer.",
    );
  });

  test("clears them with an empty string, and the mirror clears too", async () => {
    const { mcp, settings, addServer } = await fixture(mcpServer());
    const added = await addServer({ instructions: "Be brief." });
    expect((await mcp.readServerStatus(ACCOUNT)).servers[0]?.instructions).toBe(
      "Be brief.",
    );

    await mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/set-instructions",
      commandId: "clear-1",
      serverId: added.serverId!,
      instructions: "",
    });

    expect(
      (await mcp.readServerStatus(ACCOUNT)).servers[0]?.instructions,
    ).toBeUndefined();
    const connection = await settings.getConnection(ACCOUNT, added.serverId!);
    expect(connection?.safeMetadata.instructions).toBeUndefined();
  });
});

describe("mcp/restart", () => {
  test("bumps the epoch, re-handshakes, and keeps the instructions", async () => {
    const handshakes = { count: 0 };
    const { mcp, settings, addServer } = await fixture(
      mcpServer({ handshakes }),
    );
    const added = await addServer({ instructions: "Be brief." });
    expect(handshakes.count).toBe(1);

    const receipt = await mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/restart",
      commandId: "restart-1",
      serverId: added.serverId!,
    });

    expect(receipt.status).toBe("applied");
    expect(handshakes.count).toBe(2);
    const [server] = (await mcp.readServerStatus(ACCOUNT)).servers;
    expect(server).toMatchObject({
      serverEpoch: 2,
      state: "ready",
      instructions: "Be brief.",
    });
    // The epoch reaches the Bot through the Connection it already reads.
    const connection = await settings.getConnection(ACCOUNT, added.serverId!);
    expect(connection?.safeMetadata.serverEpoch).toBe(2);
  });

  test("restarts a keyed server without the key ever leaving the User object", async () => {
    const handshakes = { count: 0 };
    const { mcp, addServer } = await fixture(
      mcpServer({ goodKey: GOOD_KEY, handshakes }),
    );
    const added = await addServer({ apiKey: GOOD_KEY });

    const receipt = await mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/restart",
      commandId: "restart-keyed",
      serverId: added.serverId!,
    });

    expect(receipt.status).toBe("applied");
    expect(handshakes.count).toBe(2);
    expect((await mcp.readServerStatus(ACCOUNT)).servers[0]).toMatchObject({
      serverEpoch: 2,
      state: "ready",
    });
  });

  test("a restart that cannot reach the server leaves error, with the epoch bumped", async () => {
    const down = { value: false };
    const { mcp, addServer } = await fixture(mcpServer({ down }));
    const added = await addServer();
    down.value = true;

    const receipt = await mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/restart",
      commandId: "restart-down",
      serverId: added.serverId!,
    });

    expect(receipt).toMatchObject({ status: "failed", code: "unreachable" });
    expect((await mcp.readServerStatus(ACCOUNT)).servers[0]).toMatchObject({
      serverEpoch: 2,
      state: "error",
    });
  });
});

describe("rename, remove and the mount outcome", () => {
  test("connection/update-label renames the record too", async () => {
    const { mcp, addServer } = await fixture(mcpServer());
    const added = await addServer();

    await mcp.executeConnection(ACCOUNT, {
      schemaVersion: 1,
      type: "connection/update-label",
      commandId: "rename-1",
      connectionId: added.serverId!,
      label: "Renamed",
    });

    expect((await mcp.readServerStatus(ACCOUNT)).servers[0]?.label).toBe(
      "Renamed",
    );
  });

  test("connection/disconnect takes the record with it", async () => {
    const { mcp, addServer } = await fixture(mcpServer());
    const added = await addServer();

    await mcp.executeConnection(ACCOUNT, {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "remove-1",
      connectionId: added.serverId!,
      revokeUpstream: false,
    });

    expect((await mcp.readServerStatus(ACCOUNT)).servers).toHaveLength(0);
  });

  test("a Bot's failed mount writes error onto the record", async () => {
    const { mcp, addServer } = await fixture(mcpServer());
    const added = await addServer();

    await mcp.recordMountOutcome({
      accountId: ACCOUNT,
      connectionId: added.serverId!,
      serverEpoch: 1,
      state: "error",
      failure: { code: "unreachable", message: "MCP server answered 503" },
    });

    const [server] = (await mcp.readServerStatus(ACCOUNT)).servers;
    expect(server).toMatchObject({ state: "error", toolCount: 0 });
    expect(server?.failure?.message).toContain("503");
  });

  test("ignores an outcome for a server generation the User has restarted away from", async () => {
    const { mcp, addServer } = await fixture(mcpServer());
    const added = await addServer();
    await mcp.executeLifecycle(ACCOUNT, {
      schemaVersion: 1,
      type: "mcp/restart",
      commandId: "restart-1",
      serverId: added.serverId!,
    });

    await mcp.recordMountOutcome({
      accountId: ACCOUNT,
      connectionId: added.serverId!,
      serverEpoch: 1,
      state: "error",
      failure: { code: "unreachable", message: "stale" },
    });

    expect((await mcp.readServerStatus(ACCOUNT)).servers[0]).toMatchObject({
      serverEpoch: 2,
      state: "ready",
    });
  });
});
