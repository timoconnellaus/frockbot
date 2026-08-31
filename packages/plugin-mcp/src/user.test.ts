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

const ACCOUNT = "account-1";
const URL_TEXT = "https://mcp.example.test/mcp";

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
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 3);
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

const INITIALIZE_RESULT = {
  protocolVersion: "2025-06-18",
  capabilities: { tools: {} },
  serverInfo: { name: "Example" },
};

/** A server that accepts exactly one key, when a key is required at all. */
function mcpServer(options: {
  goodKey?: string;
  seen?: string[];
  tools?: { name: string; inputSchema: Record<string, unknown> }[];
}): typeof fetch {
  const tools = options.tools ?? [
    { name: "echo", inputSchema: { type: "object" } },
    { name: "search", inputSchema: { type: "object" } },
  ];
  return (async (input: string | URL | Request, init?: RequestInit) => {
    options.seen?.push(String(input));
    const headers = new Headers(init?.headers);
    if (
      options.goodKey !== undefined &&
      headers.get("authorization") !== `Bearer ${options.goodKey}`
    ) {
      return new Response("Unauthorized", { status: 401 });
    }
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    if (body.id === undefined) return new Response("", { status: 202 });
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: body.method === "initialize" ? INITIALIZE_RESULT : { tools },
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
  const read = async (connectionId: string): Promise<ConnectionView> => {
    const connection = await settings.getConnection(ACCOUNT, connectionId);
    expect(connection).toBeDefined();
    return connection!;
  };
  return { storage, settings, credentials, mcp, read };
}

describe("creating a public MCP server Connection", () => {
  test("reaches ready and records what the handshake learned", async () => {
    const { mcp, read } = await fixture(mcpServer({}));

    const receipt = await mcp.executeConnection(ACCOUNT, {
      schemaVersion: 1,
      type: "connection/create",
      commandId: "add-1",
      packageId: "mcp",
      connectionTypeId: "mcp-remote",
      label: "Example",
      settings: { url: URL_TEXT, transport: "streamable-http" },
    });

    expect(receipt.status).toBe("applied");
    const connection = await read(receipt.connectionId);
    expect(connection.state).toBe("ready");
    expect(connection.settings).toEqual({
      url: URL_TEXT,
      transport: "streamable-http",
    });
    expect(connection.safeMetadata).toMatchObject({
      protocolVersion: "2025-06-18",
      toolCount: 2,
      serverName: "Example",
    });
    expect(typeof connection.safeMetadata.toolsHash).toBe("string");
  });

  test("refuses a URL the outbound rules reject before recording anything", async () => {
    const { mcp, settings } = await fixture(mcpServer({}));

    await expect(
      mcp.executeConnection(ACCOUNT, {
        schemaVersion: 1,
        type: "connection/create",
        commandId: "add-private",
        packageId: "mcp",
        connectionTypeId: "mcp-remote",
        label: "Internal",
        settings: { url: "https://10.0.0.1/mcp" },
      }),
    ).rejects.toThrow(/private address/);
    expect((await settings.read(ACCOUNT)).connections).toEqual([]);
  });

  test("refuses the keyed Connection Type on the keyless command", async () => {
    const { mcp } = await fixture(mcpServer({}));

    await expect(
      mcp.executeConnection(ACCOUNT, {
        schemaVersion: 1,
        type: "connection/create",
        commandId: "add-wrong-type",
        packageId: "mcp",
        connectionTypeId: "mcp-remote-key",
        label: "Example",
        settings: { url: URL_TEXT },
      }),
    ).rejects.toThrow(/does not accept this command/);
  });
});

describe("creating a keyed MCP server Connection", () => {
  const create = (commandId: string, apiKey: string) => ({
    schemaVersion: 1 as const,
    type: "connection/create-api-key" as const,
    commandId,
    packageId: "mcp",
    connectionTypeId: "mcp-remote-key",
    label: "Example",
    apiKey,
    settings: { url: URL_TEXT },
  });

  test("proves the key with the handshake and reaches ready", async () => {
    const { mcp, read } = await fixture(mcpServer({ goodKey: "good-key" }));

    const receipt = await mcp.executeConnection(
      ACCOUNT,
      create("add-key", "good-key"),
    );

    expect(receipt.status).toBe("applied");
    expect((await read(receipt.connectionId)).state).toBe("ready");
  });

  test("leaves a rejected key failed, with the server's reason", async () => {
    const { mcp, read } = await fixture(mcpServer({ goodKey: "good-key" }));

    const receipt = await mcp.executeConnection(
      ACCOUNT,
      create("add-bad-key", "wrong-key"),
    );

    expect(receipt.status).toBe("failed");
    const connection = await read(receipt.connectionId);
    expect(connection.state).toBe("failed");
    expect(connection.failure).toContain("401");
  });

  test("leases the credential for a mount only while the Connection is ready", async () => {
    const { mcp, read } = await fixture(mcpServer({ goodKey: "good-key" }));
    const receipt = await mcp.executeConnection(
      ACCOUNT,
      create("add-lease", "good-key"),
    );
    const connection = await read(receipt.connectionId);

    const lease = await mcp.leaseToolCredential({
      accountId: ACCOUNT,
      connectionId: connection.connectionId,
      effectId: "mount-1",
      connectionGeneration: connection.generation!,
    });

    expect(lease.connectionId).toBe(connection.connectionId);
    expect(lease.effectId).toBe("mount-1");
    await mcp.settleToolCredential({
      accountId: ACCOUNT,
      connectionId: connection.connectionId,
      effectId: "mount-1",
    });

    // A generation the caller no longer holds is refused, so a rotated key
    // cannot be opened by a Composition pinned to the old one.
    await expect(
      mcp.leaseToolCredential({
        accountId: ACCOUNT,
        connectionId: connection.connectionId,
        effectId: "mount-2",
        connectionGeneration: "stale-generation",
      }),
    ).rejects.toThrow(/generation changed/);
  });

  test("refuses a lease on a keyless Connection", async () => {
    const { mcp } = await fixture(mcpServer({}));
    const receipt = await mcp.executeConnection(ACCOUNT, {
      schemaVersion: 1,
      type: "connection/create",
      commandId: "add-keyless",
      packageId: "mcp",
      connectionTypeId: "mcp-remote",
      label: "Example",
      settings: { url: URL_TEXT },
    });

    await expect(
      mcp.leaseToolCredential({
        accountId: ACCOUNT,
        connectionId: receipt.connectionId,
        effectId: "mount-1",
        connectionGeneration: "id-2",
      }),
    ).rejects.toThrow(/carries no credential/);
  });
});

describe("the Connection command path", () => {
  const add = {
    schemaVersion: 1 as const,
    type: "connection/create" as const,
    commandId: "add-1",
    packageId: "mcp",
    connectionTypeId: "mcp-remote",
    label: "Example",
    settings: { url: URL_TEXT },
  };

  test("replays one receipt for a repeated command and refuses a reused id", async () => {
    const seen: string[] = [];
    const { mcp, settings } = await fixture(mcpServer({ seen }));

    const first = await mcp.executeConnection(ACCOUNT, add);
    const replay = await mcp.executeConnection(ACCOUNT, add);

    expect(replay).toEqual(first);
    expect((await settings.read(ACCOUNT)).connections).toHaveLength(1);
    expect(await mcp.lookupConnectionCommand(ACCOUNT, "add-1")).toEqual(first);
    await expect(
      mcp.executeConnection(ACCOUNT, { ...add, label: "Different" }),
    ).rejects.toThrow(/reused for a different command/);
  });

  test("renames, disables and disconnects through the shared commands", async () => {
    const { mcp, read } = await fixture(mcpServer({}));
    const { connectionId } = await mcp.executeConnection(ACCOUNT, add);

    await mcp.executeConnection(ACCOUNT, {
      schemaVersion: 1,
      type: "connection/update-label",
      commandId: "rename-1",
      connectionId,
      label: "Renamed",
    });
    expect((await read(connectionId)).displayName).toBe("Renamed");

    await mcp.executeConnection(ACCOUNT, {
      schemaVersion: 1,
      type: "connection/set-enabled",
      commandId: "disable-1",
      connectionId,
      enabled: false,
    });
    expect((await read(connectionId)).state).toBe("disabled");

    await mcp.executeConnection(ACCOUNT, {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "remove-1",
      connectionId,
      revokeUpstream: false,
    });
    expect((await read(connectionId)).state).toBe("revoked");
  });

  test("offers no model catalog", async () => {
    const { mcp } = await fixture(mcpServer({}));
    const { connectionId } = await mcp.executeConnection(ACCOUNT, add);

    await expect(
      mcp.executeConnection(ACCOUNT, {
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId: "refresh-1",
        connectionId,
      }),
    ).rejects.toThrow(/no model catalog/);
    await expect(mcp.leaseModelCredential()).rejects.toThrow(/no model/);
  });
});
