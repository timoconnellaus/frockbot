import { describe, expect, test } from "bun:test";
import { createFlockBackendContribution } from "./backend.js";
import { randomSheepRecipeV1 } from "./shared.js";

const sheep = randomSheepRecipeV1(() => 0);
function request(path: string, body?: unknown) {
  return new Request(`https://bot.example${path}`, {
    method: body ? "POST" : "GET",
    headers: body ? { "content-type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe("Flock gateway Contribution", () => {
  test("maps RPC-serialized decode failures to definitive requests", async () => {
    const contribution = createFlockBackendContribution({
      listBots: () =>
        Promise.resolve({ schemaVersion: 1, revision: 0, bots: [] }),
      createBot: () =>
        Promise.reject({ name: "FlockDecodeError", message: "collision" }),
      listBotLifecycles: () =>
        Promise.resolve({ schemaVersion: 1, lifecycles: [] }),
      executeBotLifecycle: () => Promise.reject(new Error("not used")),
      readSheep: () => Promise.reject(new Error("not used")),
      updateSheep: () => Promise.reject(new Error("not used")),
      listBotIdentities: () =>
        Promise.resolve({ schemaVersion: 1 as const, identities: [] }),
      listBotUnread: () =>
        Promise.resolve({ schemaVersion: 1 as const, unread: [] }),
      listBotNotifications: () =>
        Promise.resolve({ schemaVersion: 1 as const, notifications: [] }),
      executeBotUnreadCommand: () => Promise.reject(new Error("not used")),
    });
    const response = await contribution.route(
      request("/api/bots", {
        schemaVersion: 1,
        type: "bot/create",
        commandId: "create-1",
        expectedRevision: 0,
        botId: "alpha",
        name: "Alpha",
        sheep,
      }),
      new URL("https://bot.example/api/bots"),
      { userId: "user-1", client: "browser" },
    );
    expect(response?.status).toBe(400);
    expect(await response?.json()).toEqual({
      error: "Flock request is invalid",
      code: "invalid-request",
      definitive: true,
    });
  });

  test("routes exact authenticated create/read/update DTOs", async () => {
    const contribution = createFlockBackendContribution({
      listBots: () =>
        Promise.resolve({ schemaVersion: 1, revision: 0, bots: [] }),
      createBot: (_user, command) =>
        Promise.resolve({
          schemaVersion: 1,
          commandId: command.commandId,
          status: "applied",
          revision: 1,
        }),
      listBotLifecycles: () =>
        Promise.resolve({
          schemaVersion: 1,
          lifecycles: [
            { schemaVersion: 1, botId: "alpha", status: "active", revision: 0 },
          ],
        }),
      executeBotLifecycle: (_user, command) =>
        Promise.resolve({
          schemaVersion: 1,
          commandId: command.commandId,
          botId: command.botId,
          status: "applied",
          lifecycle: {
            schemaVersion: 1,
            botId: command.botId,
            status: command.type === "bot/archive" ? "archived" : "active",
            revision: 1,
          },
        }),
      readSheep: (_user, botId) =>
        Promise.resolve({ schemaVersion: 1, botId, revision: 0, sheep }),
      updateSheep: (_user, _bot, command) =>
        Promise.resolve({
          schemaVersion: 1,
          commandId: command.commandId,
          status: "applied",
          revision: 1,
        }),
      listBotIdentities: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          identities: [
            {
              schemaVersion: 1 as const,
              botId: "alpha",
              name: "Alpha",
              namedBy: "user" as const,
              hiddenFromSidebar: false,
            },
          ],
        }),
      listBotUnread: () =>
        Promise.resolve({ schemaVersion: 1 as const, unread: [] }),
      listBotNotifications: () =>
        Promise.resolve({ schemaVersion: 1 as const, notifications: [] }),
      executeBotUnreadCommand: (_user, botId, command) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          commandId: command.commandId,
          status: "applied" as const,
          unread: {
            schemaVersion: 1 as const,
            botId,
            count: 0,
            capped: false,
            unread: command.type === "bot/mark-unread",
            manuallyUnread: command.type === "bot/mark-unread",
          },
        }),
    });
    const context = { userId: "user-1", client: "browser" as const };
    expect(
      (
        await contribution.route(
          request("/api/bots"),
          new URL("https://bot.example/api/bots"),
          context,
        )
      )?.status,
    ).toBe(200);
    const create = {
      schemaVersion: 1,
      type: "bot/create",
      commandId: "create-1",
      expectedRevision: 0,
      botId: "alpha",
      name: "Alpha",
      sheep,
    };
    expect(
      (
        await contribution.route(
          request("/api/bots", create),
          new URL("https://bot.example/api/bots"),
          context,
        )
      )?.status,
    ).toBe(201);
    const archive = await contribution.route(
      request("/api/bots/alpha/lifecycle", {
        schemaVersion: 1,
        type: "bot/archive",
        commandId: "archive-1",
        botId: "alpha",
      }),
      new URL("https://bot.example/api/bots/alpha/lifecycle"),
      context,
    );
    expect(archive?.status).toBe(200);
    expect(await archive?.json()).toMatchObject({
      status: "applied",
      lifecycle: { status: "archived" },
    });
    const invalid = await contribution.route(
      request("/api/bots", { ...create, extra: true }),
      new URL("https://bot.example/api/bots"),
      context,
    );
    expect(invalid?.status).toBe(400);
    expect(await invalid?.json()).toMatchObject({ definitive: true });
    const invalidBotId = await contribution.route(
      request("/api/bots", { ...create, botId: "bad@bot" }),
      new URL("https://bot.example/api/bots"),
      context,
    );
    expect(invalidBotId?.status).toBe(400);
    expect(await invalidBotId?.json()).toMatchObject({
      code: "invalid-request",
      definitive: true,
    });
    expect(
      await contribution.route(
        request("/api/bots"),
        new URL("https://bot.example/api/bots"),
        { client: "browser" },
      ),
    ).toBeUndefined();

    const identities = await contribution.route(
      request("/api/bots/identities"),
      new URL("https://bot.example/api/bots/identities"),
      context,
    );
    expect(identities?.status).toBe(200);
    expect(await identities?.json()).toMatchObject({
      identities: [{ botId: "alpha", name: "Alpha", namedBy: "user" }],
    });
  });
});
