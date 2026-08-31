// Slice B end to end: a title, a hidden flag, an uploaded avatar, and the
// rename announcement, all through `SELF.fetch` — the gateway, the Flock
// routes, the Bot Durable Object, and the object store that holds the bytes.
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
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

/** A one-pixel PNG, small enough to compare byte for byte. */
const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function pngBytes(): Uint8Array {
  const binary = atob(PNG_BASE64);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

interface BotSettings {
  revision: number;
  profile: {
    name: string;
    title?: string;
    namedBy?: string;
    hiddenFromSidebar?: boolean;
    avatar?: { kind: string; digest: string; contentType: string };
  };
}

async function settings(userId: string, botId: string): Promise<BotSettings> {
  return (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/settings`),
  )) as BotSettings;
}

describe("Bot identity through the gateway", () => {
  it("carries a title, a hidden flag and an uploaded avatar to the directory and the avatar route", async () => {
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

    // The upload writes content-addressed bytes and hands back the reference.
    const upload = await postAsUser(userId, `/api/bots/${botId}/avatar`, {
      schemaVersion: 1,
      type: "bot/upload-avatar",
      botId,
      contentType: "image/png",
      bytes: PNG_BASE64,
    });
    expect(upload.status).toBe(201);
    const receipt = (await upload.json()) as {
      avatar: { kind: string; digest: string; contentType: string };
    };
    expect(receipt.avatar).toMatchObject({
      kind: "image",
      contentType: "image/png",
    });

    // Recording it on the Bot is a separate durable write with its own
    // revision, exactly like every other settings change.
    const withAvatar = await settings(userId, botId);
    const recorded = await postAsUser(userId, `/api/bots/${botId}/settings`, {
      schemaVersion: 1,
      type: "bot/set-profile",
      commandId: "identity-avatar-1",
      expectedRevision: withAvatar.revision,
      botId,
      profile: { avatar: receipt.avatar },
    });
    expect(recorded.status).toBe(200);

    const directory = (await expectOkJson(
      await asUser(userId, "/api/bots/identities"),
    )) as {
      identities: Array<{
        botId: string;
        name: string;
        title?: string;
        hiddenFromSidebar: boolean;
        avatar?: { digest: string };
      }>;
    };
    expect(directory.identities).toContainEqual(
      expect.objectContaining({
        botId,
        title: "Chief of staff",
        hiddenFromSidebar: true,
        avatar: expect.objectContaining({ digest: receipt.avatar.digest }),
      }),
    );

    const served = await asUser(userId, `/api/bots/${botId}/avatar`);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await served.arrayBuffer())).toEqual(pngBytes());

    // Clearing the avatar restores the sheep and stops the route serving it.
    const cleared = await settings(userId, botId);
    expect(
      (
        await postAsUser(userId, `/api/bots/${botId}/settings`, {
          schemaVersion: 1,
          type: "bot/set-profile",
          commandId: "identity-clear-1",
          expectedRevision: cleared.revision,
          botId,
          profile: { avatar: { kind: "sheep" } },
        })
      ).status,
    ).toBe(200);
    expect((await asUser(userId, `/api/bots/${botId}/avatar`)).status).toBe(
      404,
    );
  });

  it("refuses an avatar the durable contract would not accept", async () => {
    const userId = freshUserId("bot-identity-refusal");
    const botId = "refusal-bot";
    await provisionThroughGateway({ userId, botId });

    for (const body of [
      { contentType: "text/html", bytes: PNG_BASE64 },
      { contentType: "image/png", bytes: "A".repeat(8_000_000) },
    ]) {
      const response = await postAsUser(userId, `/api/bots/${botId}/avatar`, {
        schemaVersion: 1,
        type: "bot/upload-avatar",
        botId,
        ...body,
      });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({ definitive: true });
    }
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
