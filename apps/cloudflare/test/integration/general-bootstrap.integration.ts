import { env, evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { randomAvatarAppearanceV1 } from "@frockbot/app/flock/shared";
import {
  asUser,
  botStateStubV1,
  expectOkJson,
  freshUserId,
  postAsUser,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

test("legacy empty account is backfilled once without reviving an old general tombstone", async () => {
  const userId = freshUserId("legacy-empty-general");
  const user = env.USER_CONFIGURATIONS.getByName(userId);
  const tombstone = {
    schemaVersion: 1,
    botId: "general",
    status: "deleted",
    revision: 2,
  };
  await runInDurableObject(user, async (_, state) => {
    await state.storage.put("flock:directory:v1", {
      schemaVersion: 1,
      revision: 4,
      bots: [],
    });
    await state.storage.put("flock:lifecycle:general", tombstone);
    expect(await state.storage.get("flock:bootstrap:v1")).toBeUndefined();
  });
  await runInDurableObject(botStateStubV1(userId, "general"), (_, state) =>
    state.storage.put("flock:lifecycle:v1", tombstone),
  );

  const [directory, bootstrap] = (await Promise.all([
    asUser(userId, "/api/bots").then(expectOkJson),
    asUser(userId, "/api/bots/bootstrap").then(expectOkJson),
  ])) as [
    { revision: number; bots: Array<{ botId: string; initialName: string }> },
    { generalBotId: string },
  ];
  const generalId = bootstrap.generalBotId;
  expect(generalId).toMatch(/^general-[0-9a-f]{16}$/);
  expect(directory.revision).toBe(5);
  expect(directory.bots).toHaveLength(1);
  expect(directory.bots[0]).toMatchObject({
    botId: generalId,
    initialName: "General",
  });
  await evictDurableObject(user);
  expect(await expectOkJson(await asUser(userId, "/api/bots"))).toEqual(
    directory,
  );
  expect(
    await expectOkJson(await asUser(userId, "/api/bots/bootstrap")),
  ).toEqual(bootstrap);

  expect(
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${generalId}/lifecycle`, {
        schemaVersion: 1,
        type: "bot/delete",
        botId: generalId,
        commandId: crypto.randomUUID(),
      }),
    ),
  ).toMatchObject({ status: "applied" });
  await runInDurableObject(user, (instance) => {
    // Delete keeps live RPC references; clear only the eviction-lost memo.
    (instance as unknown as { bootstrapped: boolean }).bootstrapped = false;
  });
  expect(await expectOkJson(await asUser(userId, "/api/bots"))).toMatchObject({
    bots: [],
  });
  expect(
    await expectOkJson(await asUser(userId, "/api/bots/bootstrap")),
  ).toEqual({ schemaVersion: 1, generalBotId: null });
  expect((await asUser(userId, "/api/bots/general/turns")).status).toBe(404);
  expect(
    await runInDurableObject(botStateStubV1(userId, "general"), (_, state) =>
      state.storage.get("flock:lifecycle:v1"),
    ),
  ).toEqual(tombstone);
  expect(
    await runInDurableObject(user, (_, state) =>
      state.storage.get("flock:lifecycle:general"),
    ),
  ).toEqual(tombstone);
});

test("legacy nonempty account keeps its registrations and never gains General", async () => {
  const userId = freshUserId("legacy-existing-general");
  const user = env.USER_CONFIGURATIONS.getByName(userId);
  const directory = {
    schemaVersion: 1,
    revision: 3,
    bots: [
      {
        schemaVersion: 1,
        botId: "existing-bot",
        registeredAt: "2026-09-01T00:00:00.000Z",
        initialName: "General",
        avatar: randomAvatarAppearanceV1(() => 0),
      },
    ],
  };
  await runInDurableObject(user, async (_, state) => {
    await state.storage.put("flock:directory:v1", directory);
    await state.storage.put("flock:lifecycle:existing-bot", {
      schemaVersion: 1,
      botId: "existing-bot",
      status: "active",
      revision: 0,
    });
  });
  for (let entry = 0; entry < 2; entry++) {
    expect(await expectOkJson(await asUser(userId, "/api/bots"))).toEqual(
      directory,
    );
    expect(
      await expectOkJson(await asUser(userId, "/api/bots/bootstrap")),
    ).toEqual({ schemaVersion: 1, generalBotId: null });
    await evictDurableObject(user);
  }
});
