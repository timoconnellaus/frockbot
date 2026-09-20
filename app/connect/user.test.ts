import { describe, expect, test } from "bun:test";
import type {
  ConnectionView,
  UserSettingsViewV1,
} from "@frockbot/core/configuration";
import {
  ComposioRequestError,
  type ConnectedAccountStatusV1,
  type ConnectedAccountSummaryV1,
} from "./composio.js";
import {
  ConnectUserBackendContribution,
  connectSafeMetadataV1,
} from "./user.js";

interface Transaction {
  get<T>(key: string): Promise<T | undefined>;
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
}

class MemoryStorage implements Transaction {
  readonly values = new Map<string, unknown>();
  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }
  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(keyOrEntries: string | Record<string, unknown>, value?: T) {
    if (typeof keyOrEntries === "string") this.values.set(keyOrEntries, value);
    else
      for (const [k, v] of Object.entries(keyOrEntries)) this.values.set(k, v);
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
  async transaction<T>(callback: (storage: Transaction) => Promise<T>) {
    return callback(this);
  }
}

class FakeSettings {
  installed = new Set<string>(["connect"]);
  state: UserSettingsViewV1 = {
    schemaVersion: 1,
    revision: 0,
    profile: { name: "User" },
    packages: [{ packageId: "connect", version: "0.0.1", state: "installed" }],
    connections: [],
  };
  bootstrap?: { packageId: string; bootstrap(userId: string): Promise<void> };
  registerConfigurationReadBootstrap(bootstrap: FakeSettings["bootstrap"]) {
    this.bootstrap = bootstrap;
    return () => undefined;
  }
  readSnapshot(): Promise<UserSettingsViewV1> {
    return Promise.resolve(structuredClone(this.state));
  }
  isPackageInstalled(_userId: string, packageId: string): Promise<boolean> {
    return Promise.resolve(this.installed.has(packageId));
  }
  createConnection(_userId: string, connection: ConnectionView) {
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

class FakeClient {
  authConfigs: { id: string; toolkitSlug: string }[] = [];
  accounts = new Map<string, ConnectedAccountSummaryV1>();
  created: string[] = [];
  links: string[] = [];
  deleted: string[] = [];
  private counter = 0;
  listAuthConfigs() {
    return Promise.resolve([...this.authConfigs]);
  }
  createManagedAuthConfig(toolkitSlug: string) {
    this.created.push(toolkitSlug);
    const config = { id: `ac_${toolkitSlug}`, toolkitSlug };
    this.authConfigs.push(config);
    return Promise.resolve(config);
  }
  callbacks: string[] = [];
  createConnectLink(input: { authConfigId: string; callbackUrl: string }) {
    this.links.push(input.authConfigId);
    this.callbacks.push(input.callbackUrl);
    const id = `ca_${++this.counter}`;
    this.accounts.set(id, {
      id,
      status: "INITIATED",
      toolkitSlug: input.authConfigId.slice(3),
      disabled: false,
    });
    return Promise.resolve({
      connectedAccountId: id,
      redirectUrl: `https://connect.example/${id}`,
      expiresAt: "2026-09-11T00:10:00.000Z",
    });
  }
  getConnectedAccount(id: string) {
    const account = this.accounts.get(id);
    if (!account) return Promise.reject(new ComposioRequestError(404));
    return Promise.resolve({ ...account });
  }
  deleteConnectedAccount(id: string) {
    this.deleted.push(id);
    this.accounts.delete(id);
    return Promise.resolve();
  }
  triggerTypes = new Map<
    string,
    Array<{ slug: string; name: string; description: string; toolkitSlug: string }>
  >([
    [
      "gmail",
      [
        {
          slug: "GMAIL_NEW_GMAIL_MESSAGE",
          name: "New Gmail message received",
          description: "When a new message arrives.",
          toolkitSlug: "gmail",
        },
        {
          slug: "GMAIL_EMAIL_SENT",
          name: "Email sent",
          description: "When a message is sent.",
          toolkitSlug: "gmail",
        },
      ],
    ],
  ]);
  instances = new Map<
    string,
    { slug: string; userId: string; connectedAccountId: string }
  >();
  deletedTriggers: string[] = [];
  private triggerCounter = 0;
  listTriggerTypes(toolkitSlug: string) {
    return Promise.resolve(this.triggerTypes.get(toolkitSlug) ?? []);
  }
  upsertTriggerInstance(input: {
    slug: string;
    userId: string;
    connectedAccountId: string;
  }) {
    const id = `ti_${++this.triggerCounter}`;
    this.instances.set(id, input);
    return Promise.resolve({
      id,
      slug: input.slug,
      connectedAccountId: input.connectedAccountId,
    });
  }
  deleteTriggerInstance(id: string) {
    this.deletedTriggers.push(id);
    this.instances.delete(id);
    return Promise.resolve();
  }
  set(id: string, status: ConnectedAccountStatusV1) {
    this.accounts.set(id, { ...this.accounts.get(id)!, status });
  }
}

function fixture(
  options: {
    apiKey?: string;
    clock?: { now: number };
    bootstrapDeadlineMs?: number;
  } = {},
) {
  const storage = new MemoryStorage();
  const settings = new FakeSettings();
  const client = new FakeClient();
  const clock = options.clock ?? { now: Date.UTC(2026, 8, 11) };
  let ids = 0;
  const contribution = new ConnectUserBackendContribution({
    storage,
    settings: settings as never,
    apiKey: options.apiKey ?? "project-key",
    callbackBaseUrl: "https://bot.frockbot.com",
    // No key means no client at all, as the deployment would have it.
    ...(options.apiKey === "" ? {} : { client: client as never }),
    now: () => clock.now,
    randomId: () => `id-${++ids}`,
    ...(options.bootstrapDeadlineMs === undefined
      ? {}
      : { bootstrapDeadlineMs: options.bootstrapDeadlineMs }),
  });
  settings.registerConfigurationReadBootstrap(contribution);
  return { storage, settings, client, contribution, clock };
}

function start(
  commandId: string,
  connectionTypeId = "connect-gmail",
  callbackUrl?: string,
) {
  return {
    schemaVersion: 1 as const,
    type: "connection/oauth" as const,
    commandId,
    attemptId: commandId,
    packageId: "connect",
    action: "start" as const,
    connectionTypeId,
    ...(callbackUrl === undefined ? {} : { callbackUrl }),
  };
}

describe("starting a connected app", () => {
  test("mints a sign-in, writes an authorizing Connection and answers the link", async () => {
    const { contribution, settings, client } = fixture();
    const receipt = await contribution.executeConnection("tim", start("s1"));
    expect(receipt.status).toBe("applied");
    expect(receipt.oauth?.authorizationUrl).toBe(
      "https://connect.example/ca_1",
    );
    // The provider had no app registered for Gmail, so one was created once.
    expect(client.created).toEqual(["gmail"]);
    const connection = settings.state.connections[0]!;
    expect(connection).toMatchObject({
      connectionId: "connection-id-1",
      packageId: "connect",
      connectionTypeId: "connect-gmail",
      displayName: "Gmail",
      state: "authorizing",
    });
    expect(connectSafeMetadataV1(connection)).toEqual({
      toolkitSlug: "gmail",
      toolkitName: "Gmail",
      connectedAccountId: "ca_1",
      namespace: "gmail",
      startedAt: "2026-09-11T00:00:00.000Z",
    });
    // The same command replays its receipt without a second sign-in.
    const again = await contribution.executeConnection("tim", start("s1"));
    expect(again).toEqual(receipt);
    expect(client.links).toHaveLength(1);
  });

  test("the return page is the client's, on the deployment's own origin", async () => {
    const { contribution, client } = fixture();
    await contribution.executeConnection("tim", start("s1"));
    await contribution.executeConnection(
      "tim",
      start(
        "s2",
        "connect-gmail",
        "https://gateway.example/api/connect/callback/android",
      ),
    );
    await contribution.executeConnection(
      "tim",
      start(
        "s3",
        "connect-gmail",
        "https://gateway.example/api/connect/callback/macos",
      ),
    );
    // A path that names no return page of ours falls back to the plain one.
    await contribution.executeConnection(
      "tim",
      start(
        "s4",
        "connect-gmail",
        "https://gateway.example/api/model-oauth/callback",
      ),
    );
    expect(client.callbacks).toEqual([
      "https://bot.frockbot.com/api/connect/callback",
      "https://bot.frockbot.com/api/connect/callback/android",
      "https://bot.frockbot.com/api/connect/callback/macos",
      "https://bot.frockbot.com/api/connect/callback",
    ]);
  });

  test("a second account of the same app gets its own namespace and label", async () => {
    const { contribution, settings } = fixture();
    await contribution.executeConnection("tim", start("s1"));
    await contribution.executeConnection("tim", start("s2"));
    const second = settings.state.connections[1]!;
    expect(second.displayName).toBe("Gmail 2");
    expect(connectSafeMetadataV1(second)?.namespace).toBe("gmail-2");
  });

  test("a disconnected account's suffix is not handed to the next one", async () => {
    const { contribution, settings, client, clock } = fixture();
    await contribution.executeConnection("tim", start("s1"));
    await contribution.executeConnection("tim", start("s2"));
    client.set("ca_1", "ACTIVE");
    client.set("ca_2", "ACTIVE");
    clock.now += 5_000;
    await contribution.bootstrap("tim");
    await contribution.executeConnection("tim", {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "gone",
      connectionId: settings.state.connections[0]!.connectionId,
      revokeUpstream: false,
    });
    await contribution.executeConnection("tim", start("s3"));
    const third = settings.state.connections[2]!;
    // `gmail-2` is still live, so the newcomer takes the first free name.
    expect(connectSafeMetadataV1(third)?.namespace).toBe("gmail");
    expect(third.displayName).toBe("Gmail");
  });

  test("a failed sign-in gives the app's own name back to the next one", async () => {
    const { contribution, settings, client, clock } = fixture();
    await contribution.executeConnection("tim", start("s1"));
    client.set("ca_1", "FAILED");
    clock.now += 5_000;
    await contribution.bootstrap("tim");
    expect(settings.state.connections[0]?.state).toBe("failed");

    await contribution.executeConnection("tim", start("s2"));
    const second = settings.state.connections[1]!;
    expect(second.displayName).toBe("Gmail");
    expect(connectSafeMetadataV1(second)?.namespace).toBe("gmail");
    // The dead sign-in is retired here and upstream.
    expect(settings.state.connections[0]?.state).toBe("revoked");
    expect(client.deleted).toEqual(["ca_1"]);
  });

  test("reuses the provider's existing auth config for an app", async () => {
    const { contribution, client } = fixture();
    client.authConfigs.push({ id: "ac_gmail", toolkitSlug: "gmail" });
    await contribution.executeConnection("tim", start("s1"));
    expect(client.created).toEqual([]);
    expect(client.links).toEqual(["ac_gmail"]);
  });

  test("fails plainly when there is no provider key or the app is unknown", async () => {
    const { contribution } = fixture({ apiKey: "" });
    expect(
      (await contribution.executeConnection("tim", start("s1"))).status,
    ).toBe("failed");
    const other = fixture();
    expect(
      (
        await other.contribution.executeConnection(
          "tim",
          start("s2", "connect-fax"),
        )
      ).status,
    ).toBe("failed");
  });
});

describe("settling a sign-in on the next read", () => {
  test("moves an active account to ready with a fresh generation", async () => {
    const { contribution, settings, client, clock } = fixture();
    await contribution.executeConnection("tim", start("s1"));
    await contribution.bootstrap("tim");
    expect(settings.state.connections[0]?.state).toBe("authorizing");
    client.set("ca_1", "ACTIVE");
    // Still inside the poll interval: not asked again.
    await contribution.bootstrap("tim");
    expect(settings.state.connections[0]?.state).toBe("authorizing");
    clock.now += 5_000;
    await contribution.bootstrap("tim");
    expect(settings.state.connections[0]).toMatchObject({
      state: "ready",
      generation: "id-2",
    });
  });

  test("marks a failed, expired or vanished sign-in as failed with a line for the person", async () => {
    const { contribution, settings, client, clock } = fixture();
    await contribution.executeConnection("tim", start("s1"));
    await contribution.executeConnection("tim", start("s2"));
    await contribution.executeConnection("tim", start("s3", "connect-slack"));
    client.set("ca_1", "FAILED");
    client.set("ca_2", "EXPIRED");
    client.accounts.delete("ca_3");
    clock.now += 5_000;
    await contribution.bootstrap("tim");
    expect(settings.state.connections.map((c) => c.state)).toEqual([
      "failed",
      "failed",
      "failed",
    ]);
    expect(settings.state.connections[0]?.failure).toContain("didn't finish");
    expect(settings.state.connections[1]?.failure).toContain("expired");
  });

  test("a disconnect that lands during the provider round trip is not undone", async () => {
    const { contribution, settings, client, clock } = fixture();
    await contribution.executeConnection("tim", start("s1"));
    client.set("ca_1", "ACTIVE");
    clock.now += 5_000;
    const connectionId = settings.state.connections[0]!.connectionId;
    // The disconnect wins the race: the account read comes back to a
    // Connection that is no longer waiting.
    const read = client.getConnectedAccount.bind(client);
    client.getConnectedAccount = async (id: string) => {
      const account = await read(id);
      await contribution.executeConnection("tim", {
        schemaVersion: 1,
        type: "connection/disconnect",
        commandId: "gone",
        connectionId,
        revokeUpstream: false,
      });
      return account;
    };
    await contribution.bootstrap("tim");
    expect(settings.state.connections[0]?.state).toBe("revoked");
  });

  test("a hanging provider neither stalls the read nor holds up a sibling", async () => {
    const { contribution, settings, client, clock } = fixture({
      bootstrapDeadlineMs: 100,
    });
    await contribution.executeConnection("tim", start("s1"));
    await contribution.executeConnection("tim", start("s2"));
    client.set("ca_2", "ACTIVE");
    clock.now += 5_000;
    // The first account's read never comes back at all.
    const read = client.getConnectedAccount.bind(client);
    client.getConnectedAccount = (id: string) =>
      id === "ca_1" ? new Promise(() => undefined) : read(id);
    const started = Date.now();
    await contribution.bootstrap("tim");
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(settings.state.connections.map((c) => c.state)).toEqual([
      "authorizing",
      "ready",
    ]);
  });

  test("gives up on a sign-in nobody finished", async () => {
    const { contribution, settings, clock } = fixture();
    await contribution.executeConnection("tim", start("s1"));
    clock.now += 31 * 60_000;
    await contribution.bootstrap("tim");
    expect(settings.state.connections[0]).toMatchObject({
      state: "failed",
      failure: "Sign-in timed out. Connect it again.",
    });
  });
});

describe("changing a connected app", () => {
  async function ready(f: ReturnType<typeof fixture>) {
    await f.contribution.executeConnection("tim", start("s1"));
    f.client.set("ca_1", "ACTIVE");
    f.clock.now += 5_000;
    await f.contribution.bootstrap("tim");
    return f.settings.state.connections[0]!;
  }

  test("turns an account off and on without touching the provider", async () => {
    const f = fixture();
    const connection = await ready(f);
    const off = await f.contribution.executeConnection("tim", {
      schemaVersion: 1,
      type: "connection/set-enabled",
      commandId: "off",
      connectionId: connection.connectionId,
      enabled: false,
    });
    expect(off.status).toBe("applied");
    expect(f.settings.state.connections[0]?.state).toBe("disabled");
    await f.contribution.executeConnection("tim", {
      schemaVersion: 1,
      type: "connection/set-enabled",
      commandId: "on",
      connectionId: connection.connectionId,
      enabled: true,
    });
    expect(f.settings.state.connections[0]?.state).toBe("ready");
    expect(f.client.deleted).toEqual([]);
  });

  test("disconnecting removes the account upstream and retires the Connection", async () => {
    const f = fixture();
    const connection = await ready(f);
    const receipt = await f.contribution.executeConnection("tim", {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "gone",
      connectionId: connection.connectionId,
      revokeUpstream: false,
    });
    expect(receipt.status).toBe("applied");
    expect(f.client.deleted).toEqual(["ca_1"]);
    expect(f.settings.state.connections[0]?.state).toBe("revoked");
  });

  test("refuses a command for a Connection that is not this Package's", async () => {
    const f = fixture();
    f.settings.state.connections.push({
      connectionId: "other",
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      displayName: "Ollama",
      state: "ready",
      safeMetadata: {},
    });
    const receipt = await f.contribution.executeConnection("tim", {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "x",
      connectionId: "other",
      revokeUpstream: false,
    });
    expect(receipt.status).toBe("failed");
    expect(f.settings.state.connections[0]?.state).toBe("ready");
  });
});

describe("Connected-app Routine triggers", () => {
  async function ready(f: ReturnType<typeof fixture>) {
    await f.contribution.executeConnection("tim", start("s1"));
    f.client.set("ca_1", "ACTIVE");
    f.clock.now += 5_000;
    await f.contribution.bootstrap("tim");
    return f.settings.state.connections[0]!;
  }

  test("lists Gmail's new-message and email-sent events for a ready account", async () => {
    const f = fixture();
    await ready(f);
    const offers = await f.contribution.listTriggers("tim");
    expect(offers.map((offer) => offer.slug)).toEqual([
      "GMAIL_NEW_GMAIL_MESSAGE",
      "GMAIL_EMAIL_SENT",
    ]);
    expect(offers[0]).toMatchObject({
      connectionLabel: "Gmail",
      toolkitName: "Gmail",
      name: "New Gmail message received",
    });
  });

  test("upserts an instance once per command and replays the same id", async () => {
    const f = fixture();
    const connection = await ready(f);
    const first = await f.contribution.upsertTrigger({
      userId: "tim",
      commandId: "cmd-1",
      botId: "scout",
      routineId: "inbox",
      connectionId: connection.connectionId,
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
    });
    const again = await f.contribution.upsertTrigger({
      userId: "tim",
      commandId: "cmd-1",
      botId: "scout",
      routineId: "inbox",
      connectionId: connection.connectionId,
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
    });
    expect(again.instanceId).toBe(first.instanceId);
    expect(f.client.instances.size).toBe(1);
    expect(await f.contribution.resolveTrigger(first.instanceId)).toMatchObject({
      botId: "scout",
      routineId: "inbox",
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
    });
  });

  test("deletes the instance with the Routine and on disconnect", async () => {
    const f = fixture();
    const connection = await ready(f);
    const held = await f.contribution.upsertTrigger({
      userId: "tim",
      commandId: "cmd-1",
      botId: "scout",
      routineId: "inbox",
      connectionId: connection.connectionId,
      triggerType: "GMAIL_EMAIL_SENT",
    });
    await f.contribution.deleteTrigger({
      commandId: "cmd-2",
      botId: "scout",
      routineId: "inbox",
    });
    expect(f.client.deletedTriggers).toEqual([held.instanceId]);
    expect(await f.contribution.resolveTrigger(held.instanceId)).toBeUndefined();

    const again = await f.contribution.upsertTrigger({
      userId: "tim",
      commandId: "cmd-3",
      botId: "scout",
      routineId: "inbox",
      connectionId: connection.connectionId,
      triggerType: "GMAIL_EMAIL_SENT",
    });
    await f.contribution.executeConnection("tim", {
      schemaVersion: 1,
      type: "connection/disconnect",
      commandId: "gone",
      connectionId: connection.connectionId,
      revokeUpstream: false,
    });
    expect(f.client.deletedTriggers).toContain(again.instanceId);
  });

  test("marks an expired account failed and names the Routines that fired on it", async () => {
    const f = fixture();
    const connection = await ready(f);
    await f.contribution.upsertTrigger({
      userId: "tim",
      commandId: "cmd-1",
      botId: "scout",
      routineId: "inbox",
      connectionId: connection.connectionId,
      triggerType: "GMAIL_NEW_GMAIL_MESSAGE",
    });
    const failed = await f.contribution.failExpiredAccount("tim", "ca_1");
    expect(failed).toMatchObject({
      connectionId: connection.connectionId,
      routines: [{ botId: "scout", routineId: "inbox" }],
    });
    expect(f.settings.state.connections[0]?.state).toBe("failed");
  });
});
