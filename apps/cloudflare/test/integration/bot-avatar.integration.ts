// Choosing a character for a Bot, through the same two routes the client uses:
// `POST /api/bots/:botId/avatar` to save it and `GET /api/bots` to draw every
// Bot afterwards. Tim's report was that the character changed straight back —
// the Bot had taken the change, the directory every list reads had not — so the
// claim under test is about what the *second* request answers, not the first.
import { evictDurableObject, env } from "cloudflare:test";
import { expect, test } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface AvatarV1 {
  schemaVersion: 1;
  characterId: string;
  primary: string;
}

interface DirectoryV1 {
  revision: number;
  bots: Array<{ botId: string; initialName: string; avatar: AvatarV1 }>;
}

const FOX: AvatarV1 = {
  schemaVersion: 1,
  characterId: "fox",
  primary: "#ff8800",
};
const CAT: AvatarV1 = {
  schemaVersion: 1,
  characterId: "cat",
  primary: "#8b72d9",
};

async function directory(userId: string): Promise<DirectoryV1> {
  return (await expectOkJson(await asUser(userId, "/api/bots"))) as DirectoryV1;
}

async function listedAvatar(userId: string, botId: string): Promise<AvatarV1> {
  const found = (await directory(userId)).bots.find(
    (bot) => bot.botId === botId,
  );
  expect(found, `Bot ${botId} is listed`).toBeDefined();
  return found!.avatar;
}

async function bootstrapGeneral(userId: string): Promise<string> {
  const { generalBotId } = (await expectOkJson(
    await asUser(userId, "/api/bots/bootstrap"),
  )) as { generalBotId: string };
  return generalBotId;
}

function saveAvatar(
  userId: string,
  botId: string,
  commandId: string,
  expectedRevision: number,
  avatar: AvatarV1,
): Promise<Response> {
  return postAsUser(userId, `/api/bots/${botId}/avatar`, {
    schemaVersion: 1,
    type: "bot/update-avatar",
    commandId,
    expectedRevision,
    botId,
    avatar,
  });
}

test("a character saved for a Bot is the one every later list of Bots shows", async () => {
  const userId = freshUserId("avatar-http");
  const botId = await bootstrapGeneral(userId);
  expect(await listedAvatar(userId, botId)).not.toEqual(FOX);

  const receipt = await expectOkJson(
    await saveAvatar(userId, botId, crypto.randomUUID(), 0, FOX),
  );
  expect(receipt).toMatchObject({ status: "applied", revision: 1 });

  // What the picker reads back, and what the shell redraws its list from.
  expect(
    await expectOkJson(await asUser(userId, `/api/bots/${botId}/avatar`)),
  ).toMatchObject({ avatar: FOX });
  expect(await listedAvatar(userId, botId)).toEqual(FOX);

  // And from durable state alone, once the objects have gone cold.
  await evictDurableObject(env.USER_CONFIGURATIONS.getByName(userId));
  expect(await listedAvatar(userId, botId)).toEqual(FOX);
});

test("a retried save does not drag the list back to the older character", async () => {
  const userId = freshUserId("avatar-http-replay");
  const botId = await bootstrapGeneral(userId);
  const firstCommandId = crypto.randomUUID();

  expect(
    await expectOkJson(await saveAvatar(userId, botId, firstCommandId, 0, FOX)),
  ).toMatchObject({ status: "applied" });
  expect(
    await expectOkJson(
      await saveAvatar(userId, botId, crypto.randomUUID(), 1, CAT),
    ),
  ).toMatchObject({ status: "applied" });
  expect(await listedAvatar(userId, botId)).toEqual(CAT);

  // The first save arrives a second time — a client retry after a lost
  // response. The Bot answers from its stored receipt without changing what it
  // wears, so the list must still show the later choice.
  expect(
    await expectOkJson(await saveAvatar(userId, botId, firstCommandId, 0, FOX)),
  ).toMatchObject({ status: "applied" });
  expect(await listedAvatar(userId, botId)).toEqual(CAT);
  expect(
    await expectOkJson(await asUser(userId, `/api/bots/${botId}/avatar`)),
  ).toMatchObject({ avatar: CAT });
});

test("a save the Bot refuses leaves the list on the character it showed", async () => {
  const userId = freshUserId("avatar-http-conflict");
  const botId = await bootstrapGeneral(userId);
  expect(
    await expectOkJson(
      await saveAvatar(userId, botId, crypto.randomUUID(), 0, FOX),
    ),
  ).toMatchObject({ status: "applied" });

  // A stale revision: the Bot rejects it, so nothing may be mirrored.
  const stale = await saveAvatar(userId, botId, crypto.randomUUID(), 0, CAT);
  expect(stale.ok).toBe(false);
  expect(await listedAvatar(userId, botId)).toEqual(FOX);
});
