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
      readBotAvatar: () => Promise.resolve(undefined),
      uploadBotAvatar: () => Promise.reject(new Error("not used")),
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
      readBotAvatar: () =>
        Promise.resolve({
          bytes: new Uint8Array([1, 2, 3]),
          contentType: "image/png",
        }),
      uploadBotAvatar: (_user, botId, command) =>
        Promise.resolve({
          schemaVersion: 1 as const,
          botId,
          avatar: {
            kind: "image" as const,
            digest: "a".repeat(64),
            contentType: command.contentType,
            size: 3,
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

    // The served avatar is bytes with their own content type, never JSON.
    const served = await contribution.route(
      request("/api/bots/alpha/avatar"),
      new URL("https://bot.example/api/bots/alpha/avatar"),
      context,
    );
    expect(served?.status).toBe(200);
    expect(served?.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served!.arrayBuffer())).toEqual(
      new Uint8Array([1, 2, 3]),
    );

    const uploaded = await contribution.route(
      request("/api/bots/alpha/avatar", {
        schemaVersion: 1,
        type: "bot/upload-avatar",
        botId: "alpha",
        contentType: "image/png",
        bytes: "AAEC",
      }),
      new URL("https://bot.example/api/bots/alpha/avatar"),
      context,
    );
    expect(uploaded?.status).toBe(201);
    expect(await uploaded?.json()).toMatchObject({
      botId: "alpha",
      avatar: { kind: "image", contentType: "image/png" },
    });

    const mismatched = await contribution.route(
      request("/api/bots/alpha/avatar", {
        schemaVersion: 1,
        type: "bot/upload-avatar",
        botId: "beta",
        contentType: "image/png",
        bytes: "AAEC",
      }),
      new URL("https://bot.example/api/bots/alpha/avatar"),
      context,
    );
    expect(mismatched?.status).toBe(400);

    // A Configuration decode failure is as definitive as a Flock one.
    const badType = await contribution.route(
      request("/api/bots/alpha/avatar", {
        schemaVersion: 1,
        type: "bot/upload-avatar",
        botId: "alpha",
        contentType: "text/html",
        bytes: "AAEC",
      }),
      new URL("https://bot.example/api/bots/alpha/avatar"),
      context,
    );
    expect(badType?.status).toBe(400);
    expect(await badType?.json()).toMatchObject({
      code: "invalid-request",
      definitive: true,
    });
  });
});
