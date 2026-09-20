import { describe, expect, test } from "bun:test";
import { createRoutinesBackendContribution } from "./backend.js";
import { RoutineStore, RoutineNotFoundError } from "./store.js";
import { RoutineInboxStore } from "./inbox-store.js";
import { createMemoryRoutineStorageV1 } from "./testing.js";
import { decodeRoutineCommandV1 } from "./shared.js";
import { routineInboxEntryViewV1 } from "./bot.js";

const CONTEXT = { userId: "tim", client: "browser" as const };

function contribution(options: { ownedBots?: string[] } = {}) {
  const owned = new Set(options.ownedBots ?? ["scout"]);
  const stores = new Map<string, RoutineStore>();
  const inboxes = new Map<string, RoutineInboxStore>();
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
  const inbox = (botId: string): RoutineInboxStore => {
    store(botId);
    const existing = inboxes.get(botId);
    if (existing) return existing;
    const created = new RoutineInboxStore(createMemoryRoutineStorageV1());
    inboxes.set(botId, created);
    return created;
  };
  const inboxView = async (botId: string) => {
    const entries = await inbox(botId).list();
    return {
      schemaVersion: 1 as const,
      botId,
      entries: entries.map(routineInboxEntryViewV1),
      unacknowledged: entries.filter((entry) => !entry.acknowledged).length,
    };
  };
  return createRoutinesBackendContribution({
    deliverRoutineHook: () =>
      Promise.reject(new Error("no webhook in this fixture")),
    listRoutines: (_userId, botId) =>
      store(botId).list(botId, undefined, "UTC"),
    executeRoutineCommand: (_userId, botId, command) =>
      store(botId).execute(command, { kind: "user" }, "UTC"),
    listRoutineRuns: (_userId, botId, routineId) =>
      store(botId).listRuns(botId, routineId),
    readRoutineRun: (_userId, botId, routineId, runId) => {
      store(botId);
      const error = new Error(`run "${runId}" is unknown`);
      error.name = "RoutineNotFoundError";
      void routineId;
      return Promise.reject(error);
    },
    listRoutineInbox: (_userId, botId) => inboxView(botId),
    executeRoutineInboxCommand: async (_userId, botId, command) => {
      await inbox(botId).acknowledge(command.entryIds);
      return {
        schemaVersion: 1 as const,
        commandId: command.commandId,
        status: "applied" as const,
        inbox: await inboxView(botId),
      };
    },
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

  test("`as=document` answers the Routines and the inbox as one document", async () => {
    const route = contribution();
    await call(route, "/api/bots/scout/routines", {
      method: "POST",
      body: JSON.stringify(CREATE),
    });
    const response = await call(route, "/api/bots/scout/routines?as=document");
    expect(response?.status).toBe(200);
    const document = (await response!.json()) as {
      surfaceId: string;
      actions: { id: string }[];
    };
    expect(document.surfaceId).toBe("routines");
    expect(document.actions.map((action) => action.id)).toContain("open-run");
    // The list read is unchanged for a client that wants a list.
    expect(
      await (await call(route, "/api/bots/scout/routines"))!.json(),
    ).toMatchObject({ botId: "scout" });
  });

  test("`as=document` still answers when a completion failed", async () => {
    const route = createRoutinesBackendContribution({
      deliverRoutineHook: () =>
        Promise.reject(new Error("no webhook in this fixture")),
      listRoutines: () =>
        Promise.resolve({ schemaVersion: 1, botId: "scout", routines: [] }),
      executeRoutineCommand: () =>
        Promise.reject(new Error("no command in this fixture")),
      listRoutineRuns: () =>
        Promise.reject(new Error("no runs in this fixture")),
      readRoutineRun: () => Promise.reject(new Error("no run in this fixture")),
      listRoutineInbox: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          botId: "scout",
          entries: [
            routineInboxEntryViewV1({
              schemaVersion: 1,
              entryId: "ri-run-1",
              runId: "run-1",
              routineId: "brief",
              text: "It stopped without saying why.",
              attribution: "Automation: Morning brief",
              createdAt: "2026-09-02T23:00:10.000Z",
              acknowledged: false,
              failure: true,
              repeatCount: 2,
            }),
          ],
          unacknowledged: 1,
        }),
      executeRoutineInboxCommand: () =>
        Promise.reject(new Error("no inbox command in this fixture")),
    });
    const response = await call(route, "/api/bots/scout/routines?as=document");
    expect(response?.status).toBe(200);
    const document = (await response!.json()) as {
      surfaceId: string;
      root: { children: unknown[] };
    };
    expect(document.surfaceId).toBe("routines");
    expect(JSON.stringify(document)).toContain("failed");
    expect(JSON.stringify(document)).toContain("open-run");
  });

  test("`as=document` takes `routine`, and nothing else", async () => {
    const route = contribution();
    expect(
      (await call(route, "/api/bots/scout/routines?as=frame"))?.status,
    ).toBe(400);
    expect(
      (await call(route, "/api/bots/scout/routines?as=document&limit=5"))
        ?.status,
    ).toBe(400);
    expect(
      (await call(route, "/api/bots/scout/routines/inbox?as=document"))?.status,
    ).toBe(400);
    expect(
      (await call(route, "/api/bots/scout/routines?as=document&new=1"))?.status,
    ).toBe(400);
    expect(
      (
        await call(
          route,
          "/api/bots/scout/routines?as=document&routine=missing",
        )
      )?.status,
    ).toBe(200);
  });

  test("`routine` is the detail, not the list with a form on it", async () => {
    const route = contribution();
    await call(route, "/api/bots/scout/routines", {
      method: "POST",
      body: JSON.stringify(CREATE),
    });
    const listed = (await (await call(
      route,
      "/api/bots/scout/routines?as=document",
    ))!.json()) as { root: { children: { title?: string }[] } };
    expect(listed.root.children.map((child) => child.title)).not.toContain(
      "New Routine",
    );
    const created = (await (await call(
      route,
      "/api/bots/scout/routines",
    ))!.json()) as { routines: { routineId: string }[] };
    const opened = (await (await call(
      route,
      `/api/bots/scout/routines?as=document&routine=${created.routines[0]!.routineId}`,
    ))!.json()) as { root: { children: { title?: string }[] } };
    expect(JSON.stringify(opened).includes('"id":"routine.name"')).toBe(true);
    expect(opened.root.children.some((child) => child.title)).toBe(false);
    expect(JSON.stringify(opened)).toContain("Run now");
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
