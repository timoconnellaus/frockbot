import { describe, expect, test } from "bun:test";
import { createDebugRoute, type DebugGatewaySurface } from "./debug.js";

const TOKEN = "debug-token-value";

function surface(
  overrides: Partial<DebugGatewaySurface> = {},
): DebugGatewaySurface & {
  snapshots: Array<{ userId: string; botId: string; query: unknown }>;
  submissions: Array<{ userId: string; botId: string; text: string }>;
} {
  const snapshots: Array<{ userId: string; botId: string; query: unknown }> =
    [];
  const submissions: Array<{ userId: string; botId: string; text: string }> =
    [];
  return {
    token: TOKEN,
    snapshots,
    submissions,
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
    readUsage: (userId) =>
      Promise.resolve({ schemaVersion: 1, userId, costMicros: 42 }),
    snapshot: (userId, botId, query) => {
      snapshots.push({ userId, botId, query });
      return Promise.resolve({ schemaVersion: 1, botId });
    },
    isAdminUser: () => Promise.resolve(true),
    ...overrides,
  };
}

function submitter(target: ReturnType<typeof surface>) {
  return (userId: string, botId: string, text: string) => {
    target.submissions.push({ userId, botId, text });
    return Promise.resolve(
      Response.json(
        { schemaVersion: 1, runId: "run-1", status: "running" },
        { status: 202 },
      ),
    );
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

  test("keeps every route except the owner Turn send read-only", async () => {
    const route = createDebugRoute(surface());
    const request = new Request("https://bot.frockbot.com/api/debug/users", {
      method: "POST",
      headers: authorized,
    });

    expect((await route(request, new URL(request.url)))?.status).toBe(405);
  });

  test("submits the one write as an ordinary Turn and preserves its response", async () => {
    const target = surface();
    const request = new Request(
      "https://bot.frockbot.com/api/debug/users/user-1/bots/primary/turns",
      {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        body: JSON.stringify({ text: "hello from the terminal" }),
      },
    );

    const response = await createDebugRoute(target, submitter(target))(
      request,
      new URL(request.url),
    );

    expect(response?.status).toBe(202);
    expect(await response?.json()).toMatchObject({ runId: "run-1" });
    expect(target.submissions).toEqual([
      { userId: "user-1", botId: "primary", text: "hello from the terminal" },
    ]);
  });

  test("403s a non-admin with a plain sentence before submitting", async () => {
    const target = surface({ isAdminUser: () => Promise.resolve(false) });
    const request = new Request(
      "https://bot.frockbot.com/api/debug/users/user-2/bots/primary/turns",
      {
        method: "POST",
        headers: { ...authorized, "content-type": "application/json" },
        body: JSON.stringify({ text: "not allowed" }),
      },
    );

    const response = await createDebugRoute(target, submitter(target))(
      request,
      new URL(request.url),
    );

    expect(response?.status).toBe(403);
    expect(response?.headers.get("content-type")).toContain("text/plain");
    expect(await response?.text()).toBe(
      "Debug Turn submission is only allowed for an administrator account.",
    );
    expect(target.submissions).toEqual([]);
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

  test("reads the User spend ledger", async () => {
    const route = createDebugRoute(surface());
    const request = get("/api/debug/usage?userId=user-1", authorized);

    const response = await route(request, new URL(request.url));

    expect(response?.status).toBe(200);
    expect(await response?.json()).toMatchObject({
      schemaVersion: 1,
      userId: "user-1",
      costMicros: 42,
    });
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

  // `--limit 100` used to answer 500 and log an uncaught error in the isolate:
  // the cap was enforced inside the Bot, past the point that could answer for
  // it. A bad query is the caller's, and the answer says what would be right.
  test("400s on a limit outside the allowed range, and never reaches the Bot", async () => {
    const target = surface();
    const route = createDebugRoute(target);
    const request = get(
      "/api/debug/bots/primary?userId=user-1&limit=100&events=true",
      authorized,
    );

    const response = await route(request, new URL(request.url));

    expect(response?.status).toBe(400);
    const body = (await response?.json()) as Record<string, unknown>;
    expect(body).toMatchObject({
      error: "debug query limit must be a whole number from 1 to 20",
    });
    // No stack: the 500 path carries one for the operator, but a caller's own
    // mistake must not hand back the build's file layout and line numbers.
    expect(body.stack).toBeUndefined();
    expect(target.snapshots).toEqual([]);
  });

  test("400s on a limit that is not a whole number at all", async () => {
    const target = surface();
    const route = createDebugRoute(target);
    const request = get(
      "/api/debug/bots/primary?userId=user-1&limit=nonsense",
      authorized,
    );

    const response = await route(request, new URL(request.url));

    expect(response?.status).toBe(400);
    expect(target.snapshots).toEqual([]);
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
