import { describe, expect, test } from "bun:test";
import { createRoutinesBackendContribution } from "./backend.js";
import { RoutineStore, RoutineNotFoundError } from "./store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import { decodeRoutineCommandV1 } from "./shared.js";

const CONTEXT = { userId: "tim", client: "browser" as const };

function contribution(options: { ownedBots?: string[] } = {}) {
  const owned = new Set(options.ownedBots ?? ["scout"]);
  const stores = new Map<string, RoutineStore>();
  const store = (botId: string): RoutineStore => {
    if (!owned.has(botId)) {
      const error = new Error(`Bot "${botId}" not found`);
      error.name = "BotNotFoundError";
      throw error;
    }
    const existing = stores.get(botId);
    if (existing) return existing;
    const created = new RoutineStore(createMemoryRoutineStorageV1());
    stores.set(botId, created);
    return created;
  };
  return createRoutinesBackendContribution({
    listRoutines: (_userId, botId) => store(botId).list(botId),
    executeRoutineCommand: (_userId, botId, command) =>
      store(botId).execute(command, { kind: "user" }),
    listRoutineRuns: (_userId, botId, routineId) =>
      store(botId).listRuns(botId, routineId),
  });
}

function call(
  route: ReturnType<typeof contribution>,
  path: string,
  init?: RequestInit,
): Promise<Response | undefined> {
  const url = new URL(`https://bot.frockbot.com${path}`);
  return route.route(new Request(url, init), url, CONTEXT);
}

const CREATE = {
  schemaVersion: 1,
  type: "routine/create",
  commandId: "cmd-1",
  botId: "scout",
  name: "Morning brief",
  prompt: "Summarize overnight email.",
  schedule: "0 7 * * *",
};

describe("Routines gateway routes", () => {
  test("posts a command and lists the Routine back", async () => {
    const route = contribution();
    const posted = await call(route, "/api/bots/scout/routines", {
      method: "POST",
      body: JSON.stringify(CREATE),
    });
    expect(posted?.status).toBe(200);
    const listed = await call(route, "/api/bots/scout/routines");
    expect(await listed!.json()).toMatchObject({
      schemaVersion: 1,
      botId: "scout",
      routines: [{ name: "Morning brief", enabled: true }],
    });
  });

  test("answers an invalid cron with 400 and the reason", async () => {
    const route = contribution();
    const response = await call(route, "/api/bots/scout/routines", {
      method: "POST",
      body: JSON.stringify({ ...CREATE, schedule: "not a cron" }),
    });
    expect(response?.status).toBe(400);
    expect((await response!.json()) as { error: string }).toMatchObject({
      error: expect.stringContaining("five fields") as unknown as string,
    });
  });

  test("refuses a command whose botId does not match the path", async () => {
    const route = contribution({ ownedBots: ["scout", "other"] });
    const response = await call(route, "/api/bots/other/routines", {
      method: "POST",
      body: JSON.stringify(CREATE),
    });
    expect(response?.status).toBe(400);
  });

  test("a Bot the caller does not hold is 404", async () => {
    const route = contribution({ ownedBots: ["scout"] });
    const response = await call(route, "/api/bots/someone-else/routines");
    expect(response?.status).toBe(404);
  });

  test("an unknown Routine's run log is 404 and a known one starts empty", async () => {
    const route = contribution();
    await call(route, "/api/bots/scout/routines", {
      method: "POST",
      body: JSON.stringify({ ...CREATE, routineId: "brief" }),
    });
    expect(
      (await call(route, "/api/bots/scout/routines/missing/runs"))?.status,
    ).toBe(404);
    const runs = await call(route, "/api/bots/scout/routines/brief/runs");
    expect(await runs!.json()).toMatchObject({ entries: [] });
  });

  test("declines every path it does not own and every method it does not serve", async () => {
    const route = contribution();
    expect(await call(route, "/api/bots/scout/settings")).toBeUndefined();
    expect(
      (await call(route, "/api/bots/scout/routines", { method: "DELETE" }))
        ?.status,
    ).toBe(405);
    expect(
      (await call(route, "/api/bots/scout/routines?limit=5"))?.status,
    ).toBe(400);
  });

  test("answers nothing without an authenticated User", async () => {
    const route = contribution();
    const url = new URL("https://bot.frockbot.com/api/bots/scout/routines");
    expect(
      await route.route(new Request(url), url, { client: "browser" }),
    ).toBeUndefined();
  });
});

describe("RoutineNotFoundError", () => {
  test("is the shape the routes map to 404", () => {
    expect(new RoutineNotFoundError("brief").name).toBe("RoutineNotFoundError");
    expect(decodeRoutineCommandV1(CREATE).botId).toBe("scout");
  });
});
