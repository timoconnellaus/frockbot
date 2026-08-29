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
      readSheep: (_user, botId) =>
        Promise.resolve({ schemaVersion: 1, botId, revision: 0, sheep }),
      updateSheep: (_user, _bot, command) =>
        Promise.resolve({
          schemaVersion: 1,
          commandId: command.commandId,
          status: "applied",
          revision: 1,
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
  });
});
