// Bot identity end to end: a title, a hidden flag, and the rename announcement,
// all through `SELF.fetch` — the gateway, the Flock routes, and the Bot Durable
// Object.
//
// The point of doing it here rather than in unit tests is that nothing in this
// file reaches past the gateway: every step is a request a browser makes.
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
} from "./fixtures.ts";

interface BotSettings {
  revision: number;
  profile: {
    name: string;
    title?: string;
    namedBy?: string;
    hiddenFromSidebar?: boolean;
  };
}

async function settings(userId: string, botId: string): Promise<BotSettings> {
  return (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/settings`),
  )) as BotSettings;
}

describe("Bot identity through the gateway", () => {
  it("carries a title and hidden flag to the directory", async () => {
    const userId = freshUserId("bot-identity");
    const botId = "identity-bot";
    await provisionThroughGateway({ userId, botId });

    const before = await settings(userId, botId);
    const applied = await postAsUser(userId, `/api/bots/${botId}/settings`, {
      schemaVersion: 1,
      type: "bot/set-profile",
      commandId: "identity-1",
      expectedRevision: before.revision,
      botId,
      profile: { title: "Chief of staff", hiddenFromSidebar: true },
    });
    expect({
      status: applied.status,
      body: await applied.json(),
    }).toMatchObject({ status: 200, body: { status: "applied" } });

    const directory = (await expectOkJson(
      await asUser(userId, "/api/bots/identities"),
    )) as {
      identities: Array<{
        botId: string;
        name: string;
        title?: string;
        hiddenFromSidebar: boolean;
      }>;
    };
    expect(directory.identities).toContainEqual(
      expect.objectContaining({
        botId,
        title: "Chief of staff",
        hiddenFromSidebar: true,
      }),
    );
  });

  it("announces a rename in the Session the run list projects", async () => {
    const userId = freshUserId("bot-identity-rename");
    const botId = "rename-bot";
    await provisionThroughGateway({ userId, botId });

    const before = await settings(userId, botId);
    expect(
      (
        await postAsUser(userId, `/api/bots/${botId}/settings`, {
          schemaVersion: 1,
          type: "bot/set-profile",
          commandId: "rename-1",
          expectedRevision: before.revision,
          botId,
          profile: { name: "Atlas" },
        })
      ).status,
    ).toBe(200);

    const after = await settings(userId, botId);
    expect(after.profile).toMatchObject({ name: "Atlas", namedBy: "user" });

    const runs = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as {
      announcements?: Array<{
        type: string;
        from: string;
        to: string;
        namedBy: string;
      }>;
    };
    expect(runs.announcements).toEqual([
      expect.objectContaining({
        type: "bot/renamed",
        from: before.profile.name,
        to: "Atlas",
        namedBy: "user",
      }),
    ]);
  });
});
