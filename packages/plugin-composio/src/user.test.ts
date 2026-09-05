import { expect, test } from "bun:test";
import {
  createUserSettingsBackendContribution,
  type UserSettingsTransaction,
} from "@frockbot/plugin-settings/user";
import { ComposioClient } from "./composio-client.js";
import { ComposioUserService } from "./user.js";

class Storage {
  values = new Map<string, unknown>();
  alarm: number | null = null;
  async get<T>(key: string): Promise<T | undefined> {
    return structuredClone(this.values.get(key)) as T | undefined;
  }
  async put<T>(key: string | Record<string, unknown>, value?: T) {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else
      for (const [name, item] of Object.entries(key))
        this.values.set(name, structuredClone(item));
  }
  async getAlarm() {
    return this.alarm;
  }
  async setAlarm(time: number | Date) {
    this.alarm = Number(time);
  }
  async transaction<T>(fn: (tx: Storage) => Promise<T>) {
    return fn(this);
  }
}
function fixture() {
  const storage = new Storage();
  const settings = createUserSettingsBackendContribution({
    storage,
    availablePackages: [
      { packageId: "composio", version: "0.0.1", installByDefault: true },
    ],
  });
  const calls: string[] = [];
  let configCreated = false,
    accountStatus = "ACTIVE",
    accountUser = "owner",
    linkCount = 0,
    accountId = "ca_one";
  let configFailure = 0,
    revokeFailure = 0,
    accountFailure = 0,
    accountDeleted = false;
  let beforeAccountRead: (() => Promise<void>) | undefined;
  const client = new ComposioClient({
    apiKey: "private-api-key",
    fetch: async (input, init) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
      expect(new Headers(init?.headers).get("x-api-key")).toBe(
        "private-api-key",
      );
      const path = url.pathname.replace("/api/v3.1", "");
      if (path === "/toolkits")
        return Response.json({
          items: [
            {
              slug: "gmail",
              name: "Gmail",
              meta: {
                description: "Read and send email",
                logo: "https://example.com/gmail.svg",
              },
              composio_managed_auth_schemes: ["oauth2"],
            },
            {
              slug: "manual",
              name: "Manual app",
              meta: { description: "Needs setup" },
              composio_managed_auth_schemes: [],
            },
          ],
        });
      if (path === "/auth_configs" && init?.method !== "POST")
        return Response.json({
          items: configCreated
            ? [{ id: "ac_one", toolkit: { slug: "gmail" }, status: "ENABLED" }]
            : [],
        });
      if (path === "/auth_configs") {
        expect(await storage.get("composio:auth-config:gmail")).toMatchObject({
          status: "creating",
        });
        if (configFailure) return Response.json({}, { status: configFailure });
        configCreated = true;
        return Response.json({
          auth_config: { id: "ac_one" },
          toolkit: { slug: "gmail" },
        });
      }
      if (path === "/connected_accounts/link") {
        linkCount++;
        const body = JSON.parse(String(init?.body));
        accountId = `ca_${linkCount}`;
        expect(body.user_id).toBe("owner");
        const snapshot = await settings.readSnapshot();
        expect(
          snapshot.connections.find((row) => row.connectionId === body.alias)
            ?.state,
        ).toBe("authorizing");
        return Response.json({
          connected_account_id: accountId,
          redirect_url:
            "https://connect.example.test/authorize?token=private-link",
          expires_at: new Date(Date.now() + 600_000).toISOString(),
        });
      }
      if (path === `/connected_accounts/${accountId}/revoke`) {
        if (revokeFailure) return Response.json({}, { status: revokeFailure });
        accountStatus = "REVOKED";
        return Response.json({});
      }
      if (path === `/connected_accounts/${accountId}`) {
        if (init?.method === "DELETE") {
          const connection = await settings.getConnection(
            "owner",
            "connection-one",
          );
          expect(
            connection?.safeMetadata.providerAccountDeletionRequested,
          ).toBe(true);
          accountDeleted = true;
          return Response.json({});
        }
        if (accountDeleted || accountFailure)
          return Response.json(
            {},
            { status: accountDeleted ? 404 : accountFailure },
          );
        const observed = accountStatus;
        if (beforeAccountRead) {
          const wait = beforeAccountRead;
          beforeAccountRead = undefined;
          await wait();
        }
        return Response.json({
          id: accountId,
          user_id: accountUser,
          status: observed,
          toolkit: { slug: "gmail" },
          data: { access_token: "never-retain" },
        });
      }
      throw new Error(`Unexpected fake request: ${path}`);
    },
  });
  const make = () =>
    new ComposioUserService({
      storage,
      settings,
      client,
      callbackBaseUrl: "https://bot.test",
    });
  return {
    storage,
    settings,
    calls,
    make,
    setStatus: (value: string) => {
      accountStatus = value;
    },
    setUser: (value: string) => {
      accountUser = value;
    },
    getLinkCount: () => linkCount,
    setConfigFailure: (status: number) => {
      configFailure = status;
    },
    setRevokeFailure: (status: number) => {
      revokeFailure = status;
    },
    setAccountFailure: (status: number) => {
      accountFailure = status;
    },
    pauseAccountRead: (wait: () => Promise<void>) => {
      beforeAccountRead = wait;
    },
  };
}
function start(commandId = "connection-one") {
  return {
    schemaVersion: 1,
    operation: "start",
    command: {
      schemaVersion: 1,
      type: "connection/start",
      commandId,
      connectionTypeId: "app",
      connectorId: "gmail",
    },
    start: {
      returnTarget: "browser",
      callbackState: "signed-state",
      authorizationStateId: "state-one",
      authorizationStateExpiresAt: Date.now() + 600_000,
    },
  };
}
const completion = {
  schemaVersion: 1,
  operation: "complete",
  connectionId: "connection-one",
  connectedAccountId: "ca_1",
  authorizationStateId: "state-one",
};

test("catalog is cached, direct named, and excludes unusable toolkits", async () => {
  const f = fixture();
  expect((await f.make().catalog("owner")).items.map((x) => x.name)).toEqual([
    "Gmail",
  ]);
  await f.make().catalog("owner");
  expect(f.calls.filter((x) => x.endsWith("/toolkits"))).toHaveLength(1);
});
test("durable first-use Connect Link survives eviction; replay consumes no second effect; provider status reconciles", async () => {
  const f = fixture();
  const service = f.make();
  expect(await service.request("owner", start())).toMatchObject({
    status: "authorization-required",
  });
  expect(await f.make().request("owner", completion)).toMatchObject({
    status: "ready",
  });
  expect(await f.make().request("owner", completion)).toMatchObject({
    status: "ready",
  });
  expect(await f.make().request("owner", start())).toMatchObject({
    status: "ready",
  });
  expect(f.getLinkCount()).toBe(1);
  const connection = await f.settings.getConnection("owner", "connection-one");
  if (!connection) throw new Error("expected connection");
  const projected = service.projectConnection(connection);
  expect(JSON.stringify(projected)).not.toMatch(
    /private-link|private-api-key|never-retain|authorizationState|connectedAccountId/,
  );
  f.setStatus("EXPIRED");
  await f.make().reconcile("owner");
  expect(
    (await f.settings.getConnection("owner", "connection-one"))?.state,
  ).toBe("failed");
});
test("provider account ownership is verified and revocation fences access durably", async () => {
  const f = fixture();
  await f.make().request("owner", start());
  f.setUser("another-user");
  await expect(f.make().request("owner", completion)).rejects.toThrow(
    "not active",
  );
  f.setUser("owner");
  await f.make().request("owner", completion);
  expect(
    await f.make().request("owner", {
      schemaVersion: 1,
      operation: "revoke",
      connectionId: "connection-one",
    }),
  ).toMatchObject({ status: "revoked" });
  expect(
    (await f.settings.getConnection("owner", "connection-one"))?.state,
  ).toBe("revoked");
});

test("a definite setup refusal can retry, while a crashed create is reconciled without repetition", async () => {
  const f = fixture();
  f.setConfigFailure(400);
  await expect(f.make().request("owner", start())).rejects.toThrow(
    "Try connecting again",
  );
  expect(await f.storage.get("composio:auth-config:gmail")).toMatchObject({
    status: "failed",
  });
  f.setConfigFailure(0);
  await f.make().request("owner", start());
  expect(
    f.calls.filter((call) => call === "POST /api/v3.1/auth_configs"),
  ).toHaveLength(2);
  await f.storage.put("composio:auth-config:gmail", {
    schemaVersion: 1,
    status: "creating",
    startedAt: Date.now() - 120_000,
  });
  await f.make().alarm();
  expect(await f.storage.get("composio:auth-config:gmail")).toMatchObject({
    status: "ready",
  });
  expect(
    f.calls.filter((call) => call === "POST /api/v3.1/auth_configs"),
  ).toHaveLength(2);
});
test("an unknown auth config create survives eviction and becomes an explicit setup failure", async () => {
  const f = fixture();
  await f.storage.put("composio:auth-config:gmail", {
    schemaVersion: 1,
    status: "creating",
    startedAt: Date.now() - 120_000,
  });
  await f.storage.put("composio:auth-config-pending:v1", ["gmail"]);
  await f.make().alarm();
  expect(await f.storage.get("composio:auth-config:gmail")).toMatchObject({
    status: "uncertain",
  });
  await expect(f.make().request("owner", start())).rejects.toThrow(
    "administrator setup",
  );
  expect(f.calls.filter((call) => call.startsWith("POST"))).toHaveLength(0);
});
test("expired accounts can disconnect through a separately admitted account deletion", async () => {
  const f = fixture();
  await f.make().request("owner", start());
  await f.make().request("owner", completion);
  f.setRevokeFailure(409);
  await f.make().request("owner", {
    schemaVersion: 1,
    operation: "revoke",
    connectionId: "connection-one",
  });
  expect(
    (await f.settings.getConnection("owner", "connection-one"))?.state,
  ).toBe("revoked");
  expect(f.calls.filter((call) => call.startsWith("DELETE"))).toHaveLength(1);
});
test("a delayed provider observation cannot restore a disconnected account", async () => {
  const f = fixture();
  await f.make().request("owner", start());
  await f.make().request("owner", completion);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reading = new Promise<void>((resolve) => {
    started = resolve;
  });
  f.pauseAccountRead(async () => {
    started();
    await held;
  });
  const reconciliation = f.make().reconcile("owner");
  await reading;
  await f.make().request("owner", {
    schemaVersion: 1,
    operation: "revoke",
    connectionId: "connection-one",
  });
  release();
  await reconciliation;
  expect(
    (await f.settings.getConnection("owner", "connection-one"))?.state,
  ).toBe("revoked");
});
test("an unavailable provider leaves a visible Connection failure and settings readable", async () => {
  const f = fixture();
  await f.make().request("owner", start());
  await f.make().request("owner", completion);
  f.setAccountFailure(503);
  await f.make().reconcile("owner");
  expect((await f.settings.read("owner")).connections[0]?.state).toBe(
    "reconciliation-required",
  );
  f.setAccountFailure(0);
  await f.make().reconcile("owner");
  expect((await f.settings.read("owner")).connections[0]?.state).toBe("ready");
});
test("revoke and alarm never change another Package connection", async () => {
  const f = fixture();
  await f.make().request("owner", start());
  const snapshot = await f.settings.readSnapshot();
  const own = snapshot.connections[0]!;
  await f.settings.replaceConnection(
    "owner",
    own.connectionId,
    own.generation,
    { ...own, packageId: "mcp" },
  );
  const before = await f.settings.readSnapshot();
  await expect(
    f.make().request("owner", {
      schemaVersion: 1,
      operation: "revoke",
      connectionId: own.connectionId,
    }),
  ).rejects.toThrow("not admitted");
  await f.make().alarm();
  expect((await f.settings.readSnapshot()).connections).toEqual(
    before.connections,
  );
});

test("an early shared alarm preserves another contribution deadline", async () => {
  const f = fixture();
  const deadline = Date.now() + 10_000;
  await f.storage.put("composio:auth-config:gmail", {
    schemaVersion: 1,
    status: "creating",
    startedAt: Date.now(),
  });
  await f.storage.put("composio:auth-config-pending:v1", ["gmail"]);
  await f.storage.setAlarm(deadline);
  await f.make().alarm();
  expect(f.storage.alarm).toBe(deadline);
  expect(
    await f.storage.get<string[]>("composio:auth-config-pending:v1"),
  ).toEqual(["gmail"]);
});

test("removing the optional key retains accounts and makes tools unavailable without errors", async () => {
  const f = fixture();
  await f.make().request("owner", start());
  await f.make().request("owner", completion);
  const before = f.calls.length;
  const service = new ComposioUserService({
    storage: f.storage,
    settings: f.settings,
    callbackBaseUrl: "https://bot.test",
  });
  expect(
    await service.request("owner", {
      schemaVersion: 1,
      operation: "tool-availability",
    }),
  ).toEqual({ schemaVersion: 1, available: false });
  expect(
    await service.request("owner", {
      schemaVersion: 1,
      operation: "execute-tool",
      connectionId: "connection-one",
    }),
  ).toMatchObject({
    isError: true,
    content: expect.stringContaining("not started"),
  });
  expect(f.calls).toHaveLength(before);
  expect(
    (await f.settings.getConnection("owner", "connection-one"))?.state,
  ).toBe("ready");
});
