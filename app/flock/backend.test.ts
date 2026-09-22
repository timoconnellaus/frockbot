import { describe, expect, test } from "bun:test";
import { createFlockBackendContribution } from "./backend.js";
import { randomAvatarAppearanceV1 } from "./shared.js";

const avatar = randomAvatarAppearanceV1(() => 0);
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
      readVoice: () => Promise.reject(new Error("voice is not wired here")),
      updateVoice: () => Promise.reject(new Error("voice is not wired here")),
      readLook: () => Promise.reject(new Error("look is not wired here")),
      updateLook: () => Promise.reject(new Error("look is not wired here")),
      createBot: () =>
        Promise.reject({ name: "FlockDecodeError", message: "collision" }),
      listBotLifecycles: () =>
        Promise.resolve({ schemaVersion: 1, lifecycles: [] }),
      readFlockBootstrap: () =>
        Promise.resolve({ schemaVersion: 1, generalBotId: null }),
      executeBotLifecycle: () => Promise.reject(new Error("not used")),
      readAvatar: () => Promise.reject(new Error("not used")),
      updateAvatar: () => Promise.reject(new Error("not used")),
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
        avatar,
      }),
      new URL("https://bot.example/api/bots"),
      { userId: "user-1", client: "browser" },
    );
    expect(response?.status).toBe(400);
    expect(await response?.json<unknown>()).toEqual({
      error: "Flock request is invalid",
      code: "invalid-request",
      definitive: true,
    });
  });

  test("routes exact authenticated create/read/update DTOs", async () => {
    const contribution = createFlockBackendContribution({
      listBots: () =>
        Promise.resolve({ schemaVersion: 1, revision: 0, bots: [] }),
      readVoice: () => Promise.reject(new Error("voice is not wired here")),
      updateVoice: () => Promise.reject(new Error("voice is not wired here")),
      readLook: () => Promise.reject(new Error("look is not wired here")),
      updateLook: () => Promise.reject(new Error("look is not wired here")),
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
      readFlockBootstrap: () =>
        Promise.resolve({ schemaVersion: 1, generalBotId: "alpha" }),
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
      readAvatar: (_user, botId) =>
        Promise.resolve({ schemaVersion: 1, botId, revision: 0, avatar }),
      updateAvatar: (_user, _bot, command) =>
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
            notificationsEnabled: true,
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
    const bootstrap = await contribution.route(
      request("/api/bots/bootstrap"),
      new URL("https://bot.example/api/bots/bootstrap"),
      context,
    );
    expect(await bootstrap?.json<unknown>()).toEqual({
      schemaVersion: 1,
      generalBotId: "alpha",
    });
    const create = {
      schemaVersion: 1,
      type: "bot/create",
      commandId: "create-1",
      expectedRevision: 0,
      botId: "alpha",
      name: "Alpha",
      avatar,
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

  test("a person's Bot deletion is issued to the lifecycle", async () => {
    const issued: unknown[] = [];
    let stale = false;
    const contribution = createFlockBackendContribution({
      listBots: () =>
        Promise.resolve({ schemaVersion: 1, revision: 0, bots: [] }),
      readVoice: () => Promise.reject(new Error("voice is not wired here")),
      updateVoice: () => Promise.reject(new Error("voice is not wired here")),
      readLook: () => Promise.reject(new Error("look is not wired here")),
      updateLook: () => Promise.reject(new Error("look is not wired here")),
      createBot: () => Promise.reject(new Error("not used")),
      listBotLifecycles: () =>
        Promise.resolve({ schemaVersion: 1, lifecycles: [] }),
      readFlockBootstrap: () =>
        Promise.resolve({ schemaVersion: 1, generalBotId: null }),
      executeBotLifecycle: (_user, command) => {
        issued.push(command);
        // The User Durable Object's refusal, as RPC serializes it: a name.
        if (stale)
          return Promise.reject({
            name: "AppletImpactConflictError",
            message: "the Applets this Bot owns changed",
          });
        return Promise.resolve({
          schemaVersion: 1,
          commandId: command.commandId,
          botId: command.botId,
          status: "applied",
          lifecycle: {
            schemaVersion: 1,
            botId: command.botId,
            status: "deleted",
            revision: 1,
          },
        });
      },
      readAvatar: () => Promise.reject(new Error("not used")),
      updateAvatar: () => Promise.reject(new Error("not used")),
      listBotIdentities: () =>
        Promise.resolve({ schemaVersion: 1 as const, identities: [] }),
      listBotUnread: () =>
        Promise.resolve({ schemaVersion: 1 as const, unread: [] }),
      listBotNotifications: () =>
        Promise.resolve({ schemaVersion: 1 as const, notifications: [] }),
      executeBotUnreadCommand: () => Promise.reject(new Error("not used")),
    });
    const context = { userId: "user-1", client: "browser" as const };
    const url = new URL("https://bot.example/api/bots/alpha/lifecycle");
    const remove = {
      schemaVersion: 1,
      type: "bot/delete",
      commandId: "delete-1",
      botId: "alpha",
    };
    const confirmed = await contribution.route(
      request("/api/bots/alpha/lifecycle", remove),
      url,
      context,
    );
    expect(confirmed?.status).toBe(200);
    expect(issued).toEqual([remove]);
  });
});
