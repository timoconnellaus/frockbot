import { describe, expect, test } from "bun:test";
import { createDebugRoute, type DebugGatewaySurface } from "./debug.js";

const TOKEN = "debug-token-value";

function surface(
  overrides: Partial<DebugGatewaySurface> = {},
): DebugGatewaySurface & {
  snapshots: Array<{ userId: string; botId: string; query: unknown }>;
} {
  const snapshots: Array<{ userId: string; botId: string; query: unknown }> =
    [];
  return {
    token: TOKEN,
    snapshots,
    listUsers: () =>
      Promise.resolve([
        {
          id: "user-1",
          email: "user@example.com",
          name: "User",
          createdAt: "2026-08-28T00:00:00.000Z",
        },
      ]),
    listBots: (userId) => Promise.resolve({ schemaVersion: 1, userId }),
    snapshot: (userId, botId, query) => {
      snapshots.push({ userId, botId, query });
      return Promise.resolve({ schemaVersion: 1, botId });
    },
    ...overrides,
  };
}

function get(path: string, headers: Record<string, string> = {}): Request {
  return new Request(`https://bot.frockbot.com${path}`, { headers });
}

const authorized = { authorization: `Bearer ${TOKEN}` };

describe("debug route", () => {
  test("passes on paths it does not own", async () => {
    const route = createDebugRoute(surface());

    expect(
      await route(get("/api/settings"), new URL("https://x/api/settings")),
    ).toBeUndefined();
  });

  test("404s when the deployment configured no token", async () => {
    const route = createDebugRoute(surface({ token: undefined }));
    const request = get("/api/debug/users", authorized);

    const response = await route(request, new URL(request.url));

    expect(response?.status).toBe(404);
  });

  test("401s without a token, and with a wrong one", async () => {
    const route = createDebugRoute(surface());

    const unauthorized: Array<Record<string, string>> = [
      {},
      { authorization: "Bearer wrong" },
    ];
    for (const headers of unauthorized) {
      const request = get("/api/debug/users", headers);
      expect((await route(request, new URL(request.url)))?.status).toBe(401);
    }
  });

  test("accepts the token in either header", async () => {
    const route = createDebugRoute(surface());

    for (const headers of [authorized, { "x-frockbot-debug-token": TOKEN }]) {
      const request = get("/api/debug/users", headers);
      expect((await route(request, new URL(request.url)))?.status).toBe(200);
    }
  });

  test("is read-only", async () => {
    const route = createDebugRoute(surface());
    const request = new Request("https://bot.frockbot.com/api/debug/users", {
      method: "POST",
      headers: authorized,
    });

    expect((await route(request, new URL(request.url)))?.status).toBe(405);
  });

  test("requires the user a Bot is read under", async () => {
    const route = createDebugRoute(surface());
    const request = get("/api/debug/bots/primary", authorized);

    expect((await route(request, new URL(request.url)))?.status).toBe(400);
  });

  test("reads a Bot snapshot with the query the URL carries", async () => {
    const target = surface();
    const route = createDebugRoute(target);
    const request = get(
      "/api/debug/bots/primary?userId=user-1&limit=3&events=true",
      authorized,
    );

    const response = await route(request, new URL(request.url));

    expect(response?.status).toBe(200);
    expect(target.snapshots).toEqual([
      {
        userId: "user-1",
        botId: "primary",
        query: { schemaVersion: 1, limit: 3, events: true },
      },
    ]);
  });

  test("reads one run by id", async () => {
    const target = surface();
    const route = createDebugRoute(target);
    const request = get(
      "/api/debug/bots/primary/runs/run-1?userId=user-1",
      authorized,
    );

    await route(request, new URL(request.url));

    expect(target.snapshots[0]?.query).toEqual({
      schemaVersion: 1,
      runId: "run-1",
    });
  });

  test("reports a failed read to the operator rather than swallowing it", async () => {
    const route = createDebugRoute(
      surface({
        snapshot: () => Promise.reject(new Error("bot storage is unreadable")),
      }),
    );
    const request = get("/api/debug/bots/primary?userId=user-1", authorized);

    const response = await route(request, new URL(request.url));

    expect(response?.status).toBe(500);
    expect(await response?.json()).toMatchObject({
      error: "bot storage is unreadable",
    });
  });
});
