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
        accountStatus = "REVOKED";
        return Response.json({});
      }
      if (path === `/connected_accounts/${accountId}`)
        return Response.json({
          id: accountId,
          user_id: accountUser,
          status: accountStatus,
          toolkit: { slug: "gmail" },
          data: { access_token: "never-retain" },
        });
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
