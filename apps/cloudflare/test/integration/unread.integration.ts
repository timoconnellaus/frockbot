// Slice F1 end to end: unread badges and the notification fan-out, entirely
// through `SELF.fetch`.
//
// Nothing here reaches past the gateway. Every step is a request the sidebar
// makes: create two Bots, talk to one of them, read the bounded fan-out, send
// the read receipt, and check that another User's Bot is simply not there.
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

interface UnreadView {
  botId: string;
  count: number;
  capped: boolean;
  unread: boolean;
  manuallyUnread: boolean;
  lastActivityCursor?: string;
}

async function unreadDirectory(userId: string): Promise<UnreadView[]> {
  const value = (await expectOkJson(
    await asUser(userId, "/api/bots/unread"),
  )) as { unread: UnreadView[] };
  return value.unread;
}

function forBot(views: UnreadView[], botId: string): UnreadView {
  const view = views.find((candidate) => candidate.botId === botId);
  if (!view) throw new Error(`no unread view for "${botId}"`);
  return view;
}

describe("unread and notifications through the gateway", () => {
  it("marks the Bot that spoke, leaves the one being viewed alone, and clears on read", async () => {
    const userId = freshUserId("unread");
    const botA = "unread-alpha";
    const botB = "unread-beta";
    await provisionThroughGateway({ userId, botId: botA });
    // The second Bot rides the same installed Package, Connection and default
    // model; only the Flock revision moves.
    const createdB = await postAsUser(userId, "/api/bots", {
      schemaVersion: 1,
      type: "bot/create",
      commandId: `create-${botB}`,
      expectedRevision: 1,
      botId: botB,
      name: "Beta",
    });
    expect(createdB.status).toBe(201);

    const initial = await unreadDirectory(userId);
    expect(initial.map((view) => view.unread)).toEqual([false, false]);

    // A Turn on A while the User is "viewing" B — the client sends no read
    // receipt for A, so A is the one that goes unread.
    const turn = await postAsUser(userId, `/api/bots/${botA}/turns`, {
      schemaVersion: 1,
      commandId: "unread-turn-1",
      text: "hello",
    });
    expect(turn.status).toBe(200);

    const settled = await unreadDirectory(userId);
    expect(forBot(settled, botA)).toMatchObject({ count: 1, unread: true });
    expect(forBot(settled, botB)).toMatchObject({ count: 0, unread: false });

    // Selecting A while the page is visible is what sends this.
    const receipt = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botA}/unread`, {
        schemaVersion: 1,
        type: "bot/mark-read",
        commandId: "unread-mark-1",
        botId: botA,
        upToCursor: forBot(settled, botA).lastActivityCursor,
      }),
    )) as { status: string; unread: UnreadView };
    expect(receipt).toMatchObject({
      status: "applied",
      unread: { count: 0, unread: false },
    });
    expect(forBot(await unreadDirectory(userId), botA)).toMatchObject({
      count: 0,
      unread: false,
    });

    // Manual unread is a command too, and the directory shows it.
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botA}/unread`, {
        schemaVersion: 1,
        type: "bot/mark-unread",
        commandId: "unread-unmark-1",
        botId: botA,
      }),
    );
    expect(forBot(await unreadDirectory(userId), botA)).toMatchObject({
      count: 0,
      unread: true,
      manuallyUnread: true,
    });
  });

  it("answers 404 for another User's Bot and never leaks it into the fan-out", async () => {
    const owner = freshUserId("unread-owner");
    const stranger = freshUserId("unread-stranger");
    const botId = "unread-private";
    await provisionThroughGateway({ userId: owner, botId });

    expect(await unreadDirectory(stranger)).toEqual([]);
    const refused = await postAsUser(stranger, `/api/bots/${botId}/unread`, {
      schemaVersion: 1,
      type: "bot/mark-unread",
      commandId: "unread-stranger-1",
      botId,
    });
    expect({
      status: refused.status,
      body: await refused.json(),
    }).toMatchObject({ status: 404, body: { code: "bot-not-found" } });
  });

  it("lists a background Bot's pending notification intent", async () => {
    const userId = freshUserId("unread-notify");
    const botId = "unread-notify-bot";
    await provisionThroughGateway({ userId, botId });

    // Notifications are off on a new Bot: the mute gates the intent, never the
    // cursor, so this turns them on before the Turn that should raise one.
    const settings = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/settings`),
    )) as { revision: number };
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/settings`, {
        schemaVersion: 1,
        type: "bot/update-notifications",
        commandId: "unread-notify-1",
        expectedRevision: settings.revision,
        botId,
        notifications: { enabled: true },
      }),
    );

    expect(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "unread-notify-turn-1",
        text: "hello",
      }),
    ).toMatchObject({ status: 200 });

    const directory = (await expectOkJson(
      await asUser(userId, "/api/bots/notifications"),
    )) as {
      notifications: Array<{ botId: string; runId: string; title: string }>;
    };
    expect(directory.notifications).toContainEqual(
      expect.objectContaining({ botId, runId: "unread-notify-turn-1" }),
    );
  });
});
