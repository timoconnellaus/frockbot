import { describe, expect, test } from "bun:test";
import type {
  ConnectionView,
  UserSettingsViewV1,
} from "@frockbot/core/configuration";
import {
  CredentialLeaseRuntime,
  createCredentialUserBackendContribution,
} from "@frockbot/app/credentials/user";
import type { UserSettingsBackendContribution } from "@frockbot/app/settings/user";
import {
  createFakeMcpAuthorizationServerV1,
  createFakeMcpServerV1,
  type FakeMcpAuthorizationServerV1,
  type FakeMcpToolV1,
} from "./testing.js";
import {
  MCP_CATALOG_JOB_PREFIX_V1,
  MCP_CATALOG_REFRESH_AFTER_MS_V1,
  readMcpCatalogV1,
} from "./catalog.js";
import { decodeMcpAccessSecretV1, MCP_SIGN_IN_TTL_MS_V1 } from "./oauth.js";
import { verifyMcpOAuthStateV1 } from "./oauth-state.js";
import {
  MCP_MAX_SERVERS_V1,
  MCP_SIGN_IN_AGAIN_LINE_V1,
  MCP_SIGN_IN_LINE_V1,
  McpUserBackendContribution,
  mcpNamespaceBaseV1,
  mcpSafeMetadataV1,
} from "./user.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarm: number | null = null;
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T);
  }
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put(keyOrEntries: string | Record<string, unknown>, value?: unknown) {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, structuredClone(value));
    } else {
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        this.values.set(key, structuredClone(entry));
      }
    }
    return Promise.resolve();
  }
  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }
  list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    const found = new Map<string, T>();
    for (const [key, value] of this.values) {
      if (key.startsWith(options.prefix)) found.set(key, value as T);
    }
    return Promise.resolve(found);
  }
  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>) {
    return callback(this);
  }
  getAlarm() {
    return Promise.resolve(this.alarm);
  }
  setAlarm(time: number | Date) {
    this.alarm = Number(time);
    return Promise.resolve();
  }
}

class FakeSettings {
  installed = new Set<string>(["mcp"]);
  state: UserSettingsViewV1 = {
    schemaVersion: 1,
    revision: 0,
    profile: { name: "User" },
    packages: [{ packageId: "mcp", version: "0.0.1", state: "installed" }],
    connections: [],
  };
  registerConfigurationReadBootstrap() {
    return () => undefined;
  }
  readSnapshot(): Promise<UserSettingsViewV1> {
    return Promise.resolve(structuredClone(this.state));
  }
  isPackageInstalled(_userId: string, packageId: string): Promise<boolean> {
    return Promise.resolve(this.installed.has(packageId));
  }
  createConnection(_userId: string, connection: ConnectionView) {
    this.state.connections = this.state.connections.filter(
      (candidate) => candidate.state !== "revoked",
    );
    this.state.connections.push(structuredClone(connection));
    this.state.revision += 1;
    return Promise.resolve(structuredClone(connection));
  }
  replaceConnection(
    _userId: string,
    connectionId: string,
    expectedGeneration: string | undefined,
    next: ConnectionView,
  ) {
    const index = this.state.connections.findIndex(
      (candidate) => candidate.connectionId === connectionId,
    );
    if (
      index < 0 ||
      this.state.connections[index]?.generation !== expectedGeneration
    ) {
      throw new Error("Connection generation changed");
    }
    this.state.connections[index] = structuredClone(next);
    this.state.revision += 1;
    return Promise.resolve(structuredClone(next));
  }
  getConnection(_userId: string, connectionId: string) {
    const found = this.state.connections.find(
      (candidate) => candidate.connectionId === connectionId,
    );
    return Promise.resolve(found ? structuredClone(found) : undefined);
  }
}

const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
const keyring = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "primary",
  keys: {
    primary: btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
  },
});

const echo: FakeMcpToolV1 = {
  name: "echo",
  description: "Say it back.",
  inputSchema: {
    type: "object",
    properties: { message: { type: "string" } },
  },
  run: (args) => ({
    content: [{ type: "text", text: `echo: ${String(args.message)}` }],
  }),
};

function setup(
  options: {
    token?: string;
    tools?: FakeMcpToolV1[];
    auth?: FakeMcpAuthorizationServerV1;
  } = {},
) {
  let now = Date.parse("2026-09-24T00:00:00.000Z");
  let ids = 0;
  const storage = new MemoryStorage();
  storage.values.set("user-id", "tim");
  const settings = new FakeSettings();
  const credentials = createCredentialUserBackendContribution({
    storage,
    keyring,
    now: () => now,
  });
  const server =
    options.auth?.server ??
    createFakeMcpServerV1({
      tools: options.tools ?? [echo],
      ...(options.token ? { token: options.token } : {}),
      instructions: "Echo repeats.",
    });
  const contribution = new McpUserBackendContribution({
    storage,
    settings: settings as unknown as UserSettingsBackendContribution,
    credentials,
    keyring,
    fetch: options.auth?.fetch ?? server.fetch,
    now: () => now,
    randomId: () => `id${++ids}`,
  });
  return {
    storage,
    settings,
    credentials,
    server,
    contribution,
    advance(ms: number) {
      now += ms;
    },
    now: () => now,
  };
}

function add(
  contribution: McpUserBackendContribution,
  commandId: string,
  options: { url?: string; token?: string; label?: string } = {},
) {
  return contribution.executeConnection("tim", {
    schemaVersion: 1,
    type: options.token ? "connection/create-api-key" : "connection/create",
    commandId,
    packageId: "mcp",
    connectionTypeId: "mcp-server",
    label: options.label ?? "Example",
    ...(options.token ? { apiKey: options.token } : {}),
    settings: { url: options.url ?? "https://mcp.example.test/mcp" },
  });
}

function only(settings: FakeSettings): ConnectionView {
  const live = settings.state.connections.filter(
    (connection) => connection.state !== "revoked",
  );
  expect(live).toHaveLength(1);
  return live[0]!;
}

describe("adding an MCP server", () => {
  test("holds a server that asks for nothing, with its tools listed", async () => {
    const { contribution, settings, storage } = setup();
    const receipt = await add(contribution, "add-1");
    expect(receipt).toMatchObject({ status: "applied" });
    const connection = only(settings);
    expect(connection).toMatchObject({
      packageId: "mcp",
      connectionTypeId: "mcp-server",
      displayName: "Example",
      state: "ready",
      settings: { url: "https://mcp.example.test/mcp" },
      authorization: { kind: "none" },
    });
    expect(mcpSafeMetadataV1(connection)).toEqual({
      namespace: "mcp-example",
      host: "mcp.example.test",
      startedAt: "2026-09-24T00:00:00.000Z",
      transport: "streamable-http",
      serverName: "fake-mcp",
      instructions: "Echo repeats.",
    });
    expect(
      (await readMcpCatalogV1(storage, connection.connectionId))?.tools,
    ).toEqual([
      {
        name: "echo",
        description: "Say it back.",
        inputSchema: echo.inputSchema!,
      },
    ]);
    // A replay answers what the first delivery did, and adds nothing.
    expect(await add(contribution, "add-1")).toEqual(receipt);
    expect(settings.state.connections).toHaveLength(1);
    await expect(
      add(contribution, "add-1", { url: "https://other.example.test/mcp" }),
    ).rejects.toThrow("idempotency key was reused");
  });

  test("keeps a token as a credential and never in the command record", async () => {
    const { contribution, settings, storage, credentials } = setup({
      token: "sk-secret",
    });
    expect(
      await add(contribution, "add-1", { token: "sk-secret" }),
    ).toMatchObject({ status: "applied" });
    const connection = only(settings);
    expect(connection.authorization?.kind).toBe("api-key");
    expect(JSON.stringify([...storage.values])).not.toContain("sk-secret");
    const lease = await contribution.leaseToolCredential({
      accountId: "tim",
      connectionId: connection.connectionId,
      effectId: "tool:1:1:0",
      connectionGeneration: connection.generation!,
    });
    const opened = await new CredentialLeaseRuntime({
      readSecret: () => keyring,
    }).open({
      accountId: "tim",
      connectionId: connection.connectionId,
      packageId: "mcp",
      lease,
    });
    expect(opened).toBe("sk-secret");
    await contribution.settleToolCredential({
      accountId: "tim",
      connectionId: connection.connectionId,
      effectId: "tool:1:1:0",
    });
    // A stale generation is never leased.
    await expect(
      contribution.leaseToolCredential({
        accountId: "tim",
        connectionId: connection.connectionId,
        effectId: "tool:1:1:1",
        connectionGeneration: "old",
      }),
    ).rejects.toThrow("changed");
    void credentials;
  });

  test("fails a server that wants a token it was not given", async () => {
    const { contribution, settings, storage } = setup({ token: "sk-secret" });
    expect(await add(contribution, "add-1")).toMatchObject({
      status: "failed",
    });
    const connection = only(settings);
    expect(connection.state).toBe("failed");
    expect(connection.failure).toContain("token");
    expect(
      await readMcpCatalogV1(storage, connection.connectionId),
    ).toBeUndefined();
  });

  test("fails an address that is not a public https one, and a retry replaces it", async () => {
    const { contribution, settings } = setup();
    expect(
      await add(contribution, "add-1", { url: "http://mcp.example.test/mcp" }),
    ).toMatchObject({ status: "failed" });
    expect(only(settings)).toMatchObject({
      state: "failed",
      failure: "Enter the server's full https address.",
    });
    expect(
      await add(contribution, "add-2", { url: "https://10.1.2.3/mcp" }),
    ).toMatchObject({ status: "failed" });
    expect(only(settings).failure).toBe(
      "That address is not on the public internet.",
    );
    expect(await add(contribution, "add-3")).toMatchObject({
      status: "applied",
    });
    expect(only(settings).state).toBe("ready");
  });

  test("names a second server on the same host apart", async () => {
    const { contribution, settings } = setup();
    await add(contribution, "add-1");
    await add(contribution, "add-2", { label: "Again" });
    expect(
      settings.state.connections.map(
        (connection) => mcpSafeMetadataV1(connection)?.namespace,
      ),
    ).toEqual(["mcp-example", "mcp-example-2"]);
  });

  test("holds a bounded number of servers", async () => {
    const { contribution } = setup();
    for (let index = 0; index < MCP_MAX_SERVERS_V1; index += 1) {
      await add(contribution, `add-${index}`);
    }
    await expect(add(contribution, "add-over")).rejects.toThrow(
      `up to ${MCP_MAX_SERVERS_V1}`,
    );
  });

  test("calls an add that never answered failed on the next read", async () => {
    const { contribution, settings, advance } = setup();
    settings.state.connections.push({
      connectionId: "connection-stuck",
      packageId: "mcp",
      connectionTypeId: "mcp-server",
      displayName: "Stuck",
      state: "authorizing",
      generation: "g",
      settings: { url: "https://mcp.example.test/mcp" },
      safeMetadata: {
        namespace: "mcp-example",
        host: "mcp.example.test",
        startedAt: "2026-09-24T00:00:00.000Z",
      },
    });
    await contribution.bootstrap("tim");
    expect(only(settings).state).toBe("authorizing");
    advance(3 * 60_000);
    await contribution.bootstrap("tim");
    expect(only(settings).state).toBe("failed");
  });
});

describe("namespaces", () => {
  test("read what the server is", () => {
    expect(mcpNamespaceBaseV1("mcp.linear.app")).toBe("mcp-linear");
    expect(mcpNamespaceBaseV1("api.githubcopilot.com")).toBe(
      "mcp-githubcopilot",
    );
    expect(mcpNamespaceBaseV1("my-server.acme.workers.dev")).toBe(
      "mcp-my-server",
    );
    expect(mcpNamespaceBaseV1("huggingface.co")).toBe("mcp-huggingface");
    expect(mcpNamespaceBaseV1("mcp.example.test:8443")).toBe("mcp-example");
    expect(mcpNamespaceBaseV1("x".repeat(60) + ".com")).toBe(
      `mcp-${"x".repeat(24)}`,
    );
  });
});

describe("a server's directory", () => {
  test("answers a Turn its tools and one tool's schema", async () => {
    const { contribution, settings } = setup();
    await add(contribution, "add-1");
    const connection = only(settings);
    const read = (toolName?: string, generation = connection.generation!) =>
      contribution.readToolCatalog({
        userId: "tim",
        connectionId: connection.connectionId,
        generation,
        ...(toolName === undefined ? {} : { toolName }),
      });
    expect(await read()).toEqual({
      kind: "directory",
      tools: [{ name: "echo", description: "Say it back." }],
    });
    expect(await read("echo")).toEqual({
      kind: "tool",
      tool: {
        name: "echo",
        description: "Say it back.",
        inputSchema: echo.inputSchema!,
      },
    });
    expect(await read("nope")).toMatchObject({ kind: "unavailable" });
    expect(await read(undefined, "old")).toMatchObject({
      kind: "stale-contract",
    });
  });

  test("refreshes on the alarm, and keeps the old tools while a server is down", async () => {
    const { contribution, settings, storage, server, advance, now } = setup();
    await add(contribution, "add-1");
    const connection = only(settings);
    expect(storage.alarm).toBe(now() + MCP_CATALOG_REFRESH_AFTER_MS_V1);
    server.tools = [
      echo,
      { ...echo, name: "shout", description: "Say it loudly." },
    ];
    advance(MCP_CATALOG_REFRESH_AFTER_MS_V1);
    await contribution.alarm();
    expect(
      (await readMcpCatalogV1(storage, connection.connectionId))?.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["echo", "shout"]);
    server.status = 503;
    advance(MCP_CATALOG_REFRESH_AFTER_MS_V1);
    await contribution.alarm();
    const kept = await readMcpCatalogV1(storage, connection.connectionId);
    expect(kept?.tools.map((tool) => tool.name)).toEqual(["echo", "shout"]);
    expect(kept?.refreshError).toContain("HTTP 503");
    const [job] = [
      ...(
        await storage.list<{ attempts: number; dueAt: number }>({
          prefix: MCP_CATALOG_JOB_PREFIX_V1,
        })
      ).values(),
    ];
    expect(job?.attempts).toBe(1);
    expect(storage.alarm).toBe(job?.dueAt ?? null);
    expect(only(settings).state).toBe("ready");
  });

  test("a refresh the person asks for fails a server that refuses its token", async () => {
    const { contribution, settings, server } = setup({ token: "sk-secret" });
    await add(contribution, "add-1", { token: "sk-secret" });
    const connection = only(settings);
    const refresh = (commandId: string) =>
      contribution.executeConnection("tim", {
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId,
        connectionId: connection.connectionId,
      });
    expect(await refresh("refresh-1")).toMatchObject({ status: "applied" });
    server.token = "rotated";
    expect(await refresh("refresh-2")).toMatchObject({ status: "failed" });
    expect(only(settings)).toMatchObject({ state: "failed" });
  });
});

describe("managing a server", () => {
  test("renames, turns off and removes it, token and directory with it", async () => {
    const { contribution, settings, storage } = setup({ token: "sk-secret" });
    await add(contribution, "add-1", { token: "sk-secret" });
    const connection = only(settings);
    const command = (commandId: string, rest: Record<string, unknown>) =>
      contribution.executeConnection("tim", {
        schemaVersion: 1,
        commandId,
        connectionId: connection.connectionId,
        ...rest,
      });
    await command("rename", {
      type: "connection/update-label",
      label: "Work server",
    });
    expect(only(settings).displayName).toBe("Work server");
    await command("off", { type: "connection/set-enabled", enabled: false });
    expect(only(settings).state).toBe("disabled");
    await command("on", { type: "connection/set-enabled", enabled: true });
    expect(only(settings).state).toBe("ready");
    expect(
      await command("remove", {
        type: "connection/disconnect",
        revokeUpstream: false,
      }),
    ).toMatchObject({ status: "applied" });
    expect(settings.state.connections[0]?.state).toBe("revoked");
    expect(
      await readMcpCatalogV1(storage, connection.connectionId),
    ).toBeUndefined();
    expect(
      [...storage.values.keys()].some((key) =>
        key.startsWith(`credential-active:${connection.connectionId}`),
      ),
    ).toBe(false);
    expect(await contribution.readHosts()).toEqual(
      new Map([["mcp-example", "mcp.example.test"]]),
    );
  });

  test("changes a server's token in place, and keeps the old one when the new one is refused", async () => {
    const { contribution, settings, server } = setup({ token: "sk-1" });
    await add(contribution, "add-1", { token: "sk-1" });
    const before = only(settings);
    const rotate = (commandId: string, apiKey: string) =>
      contribution.executeConnection("tim", {
        schemaVersion: 1,
        type: "connection/rotate-api-key",
        commandId,
        connectionId: before.connectionId,
        apiKey,
      });
    server.token = "sk-2";
    expect(await rotate("rotate-1", "sk-2")).toMatchObject({
      status: "applied",
    });
    const after = only(settings);
    expect(after).toMatchObject({
      state: "ready",
      authorization: { kind: "api-key" },
    });
    expect(after.generation).not.toBe(before.generation);
    expect(await leaseSecret(contribution, after, "tool:1")).toBe("sk-2");
    expect(await rotate("rotate-2", "wrong")).toMatchObject({
      status: "failed",
    });
    expect(only(settings)).toMatchObject({
      state: "ready",
      generation: after.generation,
    });
    expect(await leaseSecret(contribution, after, "tool:2")).toBe("sk-2");
  });

  test("reconnects a server that could not be reached", async () => {
    const { contribution, settings, server, storage } = setup();
    server.status = 503;
    await add(contribution, "add-1");
    const failed = only(settings);
    expect(failed.state).toBe("failed");
    const retry = (commandId: string) =>
      contribution.executeConnection("tim", {
        schemaVersion: 1,
        type: "connection/refresh-models",
        commandId,
        connectionId: failed.connectionId,
      });
    expect(await retry("retry-1")).toMatchObject({ status: "failed" });
    server.status = undefined;
    expect(await retry("retry-2")).toMatchObject({ status: "applied" });
    const ready = only(settings);
    expect(ready.state).toBe("ready");
    expect(ready.failure).toBeUndefined();
    expect(
      (await readMcpCatalogV1(storage, ready.connectionId))?.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["echo"]);
  });
});

async function leaseSecret(
  contribution: McpUserBackendContribution,
  connection: ConnectionView,
  effectId: string,
): Promise<string> {
  const lease = await contribution.leaseToolCredential({
    accountId: "tim",
    connectionId: connection.connectionId,
    effectId,
    connectionGeneration: connection.generation!,
  });
  const secret = await new CredentialLeaseRuntime({
    readSecret: () => keyring,
  }).open({
    accountId: "tim",
    connectionId: connection.connectionId,
    packageId: "mcp",
    lease,
  });
  await contribution.settleToolCredential({
    accountId: "tim",
    connectionId: connection.connectionId,
    effectId,
  });
  return secret;
}

const CALLBACK = "https://bot.frockbot.test/api/mcp/oauth/callback/android";

function signIn(
  contribution: McpUserBackendContribution,
  connectionId: string,
  attemptId: string,
) {
  return contribution.executeConnection("tim", {
    schemaVersion: 1,
    type: "connection/oauth",
    commandId: attemptId,
    attemptId,
    packageId: "mcp",
    action: "start",
    connectionId,
    callbackUrl: CALLBACK,
  });
}

function comeBack(
  contribution: McpUserBackendContribution,
  connectionId: string,
  attemptId: string,
  callback: string,
  commandId = `return-${attemptId}`,
) {
  return contribution.executeConnection("tim", {
    schemaVersion: 1,
    type: "connection/oauth",
    commandId,
    attemptId,
    packageId: "mcp",
    action: "complete",
    connectionId,
    code: callback,
  });
}

/** Adds a server that asks for a sign-in, and signs in to it. */
async function signedIn(options: { expiresIn?: number } = {}) {
  const auth = createFakeMcpAuthorizationServerV1({ tools: [echo] });
  if ("expiresIn" in options) auth.expiresIn = options.expiresIn;
  const harness = setup({ auth });
  await add(harness.contribution, "add-1", { url: auth.server.url });
  const pending = only(harness.settings);
  const started = await signIn(
    harness.contribution,
    pending.connectionId,
    "sign-in-1",
  );
  await comeBack(
    harness.contribution,
    pending.connectionId,
    "sign-in-1",
    auth.approve(started.oauth!.authorizationUrl!),
  );
  return { ...harness, auth, connection: only(harness.settings) };
}

describe("signing in to a server", () => {
  test("offers a sign-in, signs in, and leases only the access token", async () => {
    const auth = createFakeMcpAuthorizationServerV1({ tools: [echo] });
    const { contribution, settings, storage, now } = setup({ auth });
    expect(
      await add(contribution, "add-1", { url: auth.server.url }),
    ).toMatchObject({ status: "failed" });
    const pending = only(settings);
    expect(pending).toMatchObject({
      state: "failed",
      failure: MCP_SIGN_IN_LINE_V1,
      authorization: { kind: "grant", credential: { configured: false } },
    });

    const started = await signIn(
      contribution,
      pending.connectionId,
      "sign-in-1",
    );
    expect(started).toMatchObject({
      status: "applied",
      oauth: {
        attemptId: "sign-in-1",
        status: "waiting",
        expiresAt: now() + MCP_SIGN_IN_TTL_MS_V1,
      },
    });
    const authorize = new URL(started.oauth!.authorizationUrl!);
    expect(authorize.searchParams.get("redirect_uri")).toBe(CALLBACK);
    // The state names this User, this server and this attempt, signed.
    expect(
      await verifyMcpOAuthStateV1(
        keyring,
        authorize.searchParams.get("state"),
        now(),
      ),
    ).toEqual({
      userId: "tim",
      connectionId: pending.connectionId,
      attemptId: "sign-in-1",
      expiresAt: now() + MCP_SIGN_IN_TTL_MS_V1,
    });

    const back = auth.approve(authorize.href);
    expect(
      await comeBack(contribution, pending.connectionId, "sign-in-1", back),
    ).toMatchObject({ status: "applied", oauth: { status: "ready" } });
    const ready = only(settings);
    expect(ready).toMatchObject({
      state: "ready",
      authorization: { kind: "grant", credential: { configured: true } },
    });
    expect(ready.failure).toBeUndefined();
    expect(ready.generation).not.toBe(pending.generation);
    expect(
      (await readMcpCatalogV1(storage, ready.connectionId))?.tools.map(
        (tool) => tool.name,
      ),
    ).toEqual(["echo"]);

    // The same callback again, however it arrives, trades nothing.
    expect(
      await comeBack(
        contribution,
        pending.connectionId,
        "sign-in-1",
        back,
        "return-again",
      ),
    ).toMatchObject({ status: "failed" });
    expect(auth.tokenRequests).toHaveLength(1);

    // Nothing is kept in the clear, and a lease is the access token alone.
    const stored = JSON.stringify([...storage.values]);
    expect(stored).not.toContain("access-");
    expect(stored).not.toContain("refresh-");
    const secret = await leaseSecret(contribution, ready, "tool:1:1:0");
    expect(secret).not.toContain("refresh");
    expect(
      auth.accessTokens.has(decodeMcpAccessSecretV1(secret).accessToken),
    ).toBe(true);
  });

  test("refreshes an access token that would expire inside a lease", async () => {
    const { contribution, connection, auth, advance } = await signedIn({
      expiresIn: 3600,
    });
    advance(3600_000 - 60_000);
    const secret = await leaseSecret(contribution, connection, "tool:1");
    expect(auth.tokenRequests.at(-1)?.get("grant_type")).toBe("refresh_token");
    const refreshed = decodeMcpAccessSecretV1(secret);
    expect(refreshed.accessToken).not.toBe("access-2");
    expect(auth.accessTokens.has(refreshed.accessToken)).toBe(true);
    // Refreshed once; the next lease finds a fresh token.
    await leaseSecret(contribution, connection, "tool:2");
    expect(
      auth.tokenRequests.filter(
        (form) => form.get("grant_type") === "refresh_token",
      ),
    ).toHaveLength(1);
  });

  test("asks for a sign-in again when a refresh is refused, and never retries it", async () => {
    const { contribution, connection, auth, settings, advance } =
      await signedIn({ expiresIn: 60 });
    await auth.fetch(`${auth.issuer}/revoke`, {
      method: "POST",
      body: new URLSearchParams({ token: "refresh-2" }),
    });
    advance(60_000);
    await expect(
      leaseSecret(contribution, connection, "tool:1"),
    ).rejects.toThrow();
    expect(only(settings)).toMatchObject({
      state: "failed",
      failure: MCP_SIGN_IN_AGAIN_LINE_V1,
    });
    await expect(
      leaseSecret(contribution, connection, "tool:2"),
    ).rejects.toThrow();
    expect(
      auth.tokenRequests.filter(
        (form) => form.get("grant_type") === "refresh_token",
      ),
    ).toHaveLength(1);

    // Signing in again reuses FrockBot's registration and makes it ready.
    const again = await signIn(contribution, connection.connectionId, "again");
    await comeBack(
      contribution,
      connection.connectionId,
      "again",
      auth.approve(again.oauth!.authorizationUrl!),
    );
    expect(only(settings).state).toBe("ready");
    expect(auth.registrations).toHaveLength(1);
  });

  test("changes nothing for a cancelled, stale or forged return", async () => {
    const auth = createFakeMcpAuthorizationServerV1({ tools: [echo] });
    const { contribution, settings, advance } = setup({ auth });
    await add(contribution, "add-1", { url: auth.server.url });
    const pending = only(settings);

    const denied = await signIn(contribution, pending.connectionId, "one");
    expect(
      await comeBack(
        contribution,
        pending.connectionId,
        "one",
        auth.deny(denied.oauth!.authorizationUrl!),
      ),
    ).toMatchObject({ status: "failed" });
    expect(only(settings)).toMatchObject({
      state: "failed",
      failure: "The sign-in was cancelled.",
    });

    const forged = await signIn(contribution, pending.connectionId, "two");
    const back = new URL(auth.approve(forged.oauth!.authorizationUrl!));
    back.searchParams.set("state", "not-the-state");
    expect(
      await comeBack(contribution, pending.connectionId, "two", back.href),
    ).toMatchObject({ status: "failed" });

    const late = await signIn(contribution, pending.connectionId, "three");
    advance(MCP_SIGN_IN_TTL_MS_V1);
    expect(
      await comeBack(
        contribution,
        pending.connectionId,
        "three",
        auth.approve(late.oauth!.authorizationUrl!),
      ),
    ).toMatchObject({ status: "failed" });
    expect(only(settings).failure).toContain("took too long");
    expect(auth.tokenRequests).toHaveLength(0);
  });

  test("revokes the grant when the server is removed, or given a token instead", async () => {
    const first = await signedIn();
    await first.contribution.executeConnection("tim", {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "remove",
      connectionId: first.connection.connectionId,
      revokeUpstream: false,
    });
    expect(first.auth.revoked).toEqual(["refresh-2"]);
    expect(
      [...first.storage.values.keys()].some((key) =>
        key.startsWith("mcp:grant"),
      ),
    ).toBe(false);

    const second = await signedIn();
    second.auth.server.accepts = (header) => header === "Bearer sk-own";
    expect(
      await second.contribution.executeConnection("tim", {
        schemaVersion: 1,
        type: "connection/rotate-api-key",
        commandId: "use-token",
        connectionId: second.connection.connectionId,
        apiKey: "sk-own",
      }),
    ).toMatchObject({ status: "applied" });
    expect(only(second.settings).authorization?.kind).toBe("api-key");
    expect(second.auth.revoked).toEqual(["refresh-2"]);
  });
});
