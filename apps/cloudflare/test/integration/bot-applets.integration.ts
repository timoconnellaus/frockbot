// Bot-scoped Applet routes and the fenced Bot deletion (ADR 0027), through the
// gateway a client talks to.
//
// The User Durable Object's own RPCs are covered in `applets-access.workerd.ts`;
// what only `SELF.fetch` can show is what a client is answered:
//
//  1. `/api/bots/:bot/applets` lists what that Bot owns or is shared, and a
//     shared Bot's delete is a 403 the client can name while an Applet the Bot
//     cannot reach is a 404.
//  2. A person's `bot/delete` must carry the Applet impact its confirmation
//     read. Without one it is a 400; with one the directory no longer matches
//     it is a 409 `applet-impact-changed`, and the Bot survives; with the
//     fresh fingerprint it deletes the Bot and the Applets it owned.
import { env } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface UserAppletRpc {
  createApplet(input: unknown): Promise<{ appletId: string }>;
  shareApplet(input: unknown): Promise<unknown>;
}

function userRpc(userId: string): UserAppletRpc {
  // SAFETY: the generated stub type is too deep to instantiate here; this
  // names only the methods the test calls. There is no client route that
  // creates or shares an Applet — a Bot's tools do — so the test stands in for
  // the Bot at the User Durable Object.
  return env.USER_CONFIGURATIONS.getByName(userId) as unknown as UserAppletRpc;
}

/** What an admin does before an account's Bots see the Applets surfaces. */
async function setApplets(userId: string): Promise<void> {
  await expectOkJson(
    await postAsUser("development", `/api/admin/users/${userId}/features`, {
      schemaVersion: 1,
      type: "user/set-features",
      applets: true,
    }),
  );
}

async function twoBots(prefix: string) {
  const userId = freshUserId(prefix);
  const owner = "applets-owner";
  const other = "applets-other";
  await provisionThroughGateway({ userId, botId: owner });
  const created = await postAsUser(userId, "/api/bots", {
    schemaVersion: 1,
    type: "bot/create",
    commandId: `create-${other}`,
    expectedRevision: 1,
    botId: other,
    name: "Other Bot",
  });
  expect(created.status).toBe(201);
  await setApplets(userId);
  return { userId, owner, other };
}

async function impactOf(
  userId: string,
  botId: string,
): Promise<{ botId: string; fingerprint: string; applets: unknown[] }> {
  return (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/applets/impact`),
  )) as { botId: string; fingerprint: string; applets: unknown[] };
}

describe("Bot-scoped Applet routes", () => {
  test("a Bot lists what it owns or is shared, and only the owner may delete", async () => {
    const { userId, owner, other } = await twoBots("bot-applets-routes");
    const { appletId } = await userRpc(userId).createApplet({
      schemaVersion: 1,
      userId,
      botId: owner,
      displayName: "Expenses",
      provenance: { kind: "user" },
    });

    expect(
      await expectOkJson(await asUser(userId, `/api/bots/${owner}/applets`)),
    ).toEqual({
      schemaVersion: 1,
      applets: [
        expect.objectContaining({
          appletId,
          ownerBotId: owner,
          access: "owner",
          sharedWithBotIds: [],
        }),
      ],
    });
    expect(
      await expectOkJson(await asUser(userId, `/api/bots/${other}/applets`)),
    ).toEqual({ schemaVersion: 1, applets: [] });

    // Not shared: the other Bot cannot reach it, which answers as missing.
    expect(
      (
        await postAsUser(
          userId,
          `/api/bots/${other}/applets/${appletId}/delete`,
          {},
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await postAsUser(userId, `/api/bots/${other}/applets/focus`, {
          appletId,
        })
      ).status,
    ).toBe(404);

    await userRpc(userId).shareApplet({
      schemaVersion: 1,
      userId,
      botId: owner,
      appletId,
      targetBotId: other,
    });
    expect(
      await expectOkJson(await asUser(userId, `/api/bots/${other}/applets`)),
    ).toEqual({
      schemaVersion: 1,
      applets: [
        expect.objectContaining({
          appletId,
          ownerBotId: owner,
          access: "shared",
          sharedWithBotIds: [],
        }),
      ],
    });

    // Shared: use, not authorship. The delete and the source read are the
    // owner's, and the refusal is one the client can name.
    for (const response of [
      await postAsUser(
        userId,
        `/api/bots/${other}/applets/${appletId}/delete`,
        {},
      ),
      await asUser(userId, `/api/bots/${other}/applets/${appletId}/source`),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "applet-not-owner" });
    }
    expect(
      await expectOkJson(await asUser(userId, `/api/bots/${owner}/applets`)),
    ).toMatchObject({ applets: [expect.objectContaining({ appletId })] });

    // The owner's delete settles, and a repeat is the settled 404.
    expect(
      await expectOkJson(
        await postAsUser(
          userId,
          `/api/bots/${owner}/applets/${appletId}/delete`,
          {},
        ),
      ),
    ).toEqual({ schemaVersion: 1, status: "deleted" });
    expect(
      (
        await postAsUser(
          userId,
          `/api/bots/${owner}/applets/${appletId}/delete`,
          {},
        )
      ).status,
    ).toBe(404);
    for (const botId of [owner, other]) {
      expect(
        await expectOkJson(await asUser(userId, `/api/bots/${botId}/applets`)),
      ).toEqual({ schemaVersion: 1, applets: [] });
    }
  });
});

describe("a person's Bot deletion is fenced on the Applet impact it confirmed", () => {
  test("a stale impact is a 409 and the Bot survives; the fresh one deletes it and its Applets", async () => {
    const { userId, owner, other } = await twoBots("bot-applets-delete");
    const path = `/api/bots/${owner}/lifecycle`;
    const deletion = {
      schemaVersion: 1,
      type: "bot/delete",
      commandId: "delete-owner",
      botId: owner,
    };

    // The confirmation reads the impact: nothing yet.
    const confirmed = await impactOf(userId, owner);
    expect(confirmed).toMatchObject({ botId: owner, applets: [] });
    expect(confirmed.fingerprint).toMatch(/^[0-9a-f]{16}$/);

    // A deletion that does not say what it confirmed is refused outright.
    expect((await postAsUser(userId, path, deletion)).status).toBe(400);

    // While the dialog is open, the Bot makes an Applet and shares it.
    const { appletId } = await userRpc(userId).createApplet({
      schemaVersion: 1,
      userId,
      botId: owner,
      displayName: "Journal",
      provenance: { kind: "user" },
    });
    await userRpc(userId).shareApplet({
      schemaVersion: 1,
      userId,
      botId: owner,
      appletId,
      targetBotId: other,
    });

    // The deletion carries what the person saw, which is no longer true.
    const stale = await postAsUser(userId, path, {
      ...deletion,
      appletImpact: confirmed.fingerprint,
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({
      code: "applet-impact-changed",
    });
    // Nothing was destroyed: the Bot and its Applet are both still there.
    const bots = (await expectOkJson(await asUser(userId, "/api/bots"))) as {
      bots: Array<{ botId: string }>;
    };
    expect(bots.bots.map((bot) => bot.botId)).toContain(owner);
    expect(
      await expectOkJson(await asUser(userId, `/api/bots/${other}/applets`)),
    ).toMatchObject({ applets: [expect.objectContaining({ appletId })] });

    // Reading the impact again names the Applet and who loses it.
    const reread = await impactOf(userId, owner);
    expect(reread.fingerprint).not.toBe(confirmed.fingerprint);
    expect(reread.applets).toEqual([
      expect.objectContaining({ appletId, sharedWithBotIds: [other] }),
    ]);

    // Confirmed again, with what is now true, it deletes.
    const deleted = (await expectOkJson(
      await postAsUser(userId, path, {
        ...deletion,
        commandId: "delete-owner-reconfirmed",
        appletImpact: reread.fingerprint,
      }),
    )) as { status: string; lifecycle: { status: string } };
    expect(deleted).toMatchObject({
      status: "applied",
      lifecycle: { status: "deleted" },
    });
    const after = (await expectOkJson(await asUser(userId, "/api/bots"))) as {
      bots: Array<{ botId: string }>;
    };
    expect(after.bots.map((bot) => bot.botId)).toEqual([other]);
    // The Applet it owned went with it, shared or not.
    expect(
      await expectOkJson(await asUser(userId, `/api/bots/${other}/applets`)),
    ).toEqual({ schemaVersion: 1, applets: [] });
  });
});
