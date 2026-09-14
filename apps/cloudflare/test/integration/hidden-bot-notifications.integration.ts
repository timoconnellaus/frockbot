// Hiding a Bot from the sidebar mutes it, enforced in the Bot's configuration
// transaction rather than in any one client. Everything here goes through the
// gateway the browser and the native client use, and the Bot's own
// `bot_update` arrives the way production delivers it — a model answering with
// a tool call inside the Agent loop.
import { describe, expect, it } from "vitest";
import { evictDurableObject } from "cloudflare:test";
import {
  callsFrockbotTool,
  frockbotToolCallPrompt,
} from "../harness/miniflare.ts";
import {
  asUser,
  botStateStubV1,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface BotSettings {
  revision: number;
  profile: { name: string; hiddenFromSidebar?: boolean };
  notifications: { enabled: boolean };
}

interface Receipt {
  status: string;
  revision: number;
  failure?: string;
}

async function settings(userId: string, botId: string): Promise<BotSettings> {
  return (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/settings`),
  )) as BotSettings;
}

function command(
  userId: string,
  botId: string,
  body: Record<string, unknown>,
): Promise<Response> {
  return postAsUser(userId, `/api/bots/${botId}/settings`, {
    schemaVersion: 1,
    botId,
    ...body,
  });
}

/** Notifications are off on a new Bot; this is the User turning them on. */
async function notify(userId: string, botId: string): Promise<BotSettings> {
  const before = await settings(userId, botId);
  await expectOkJson(
    await command(userId, botId, {
      type: "bot/update-notifications",
      commandId: `notify-on-${botId}`,
      expectedRevision: before.revision,
      notifications: { enabled: true },
    }),
  );
  const after = await settings(userId, botId);
  expect(after.notifications.enabled).toBe(true);
  return after;
}

describe("a Bot hidden from the sidebar is muted, whoever hides it", () => {
  it("turns notifications off in the same write the hide lands in", async () => {
    const userId = freshUserId("hidden-mutes");
    const botId = "hidden-mutes-bot";
    await provisionThroughGateway({ userId, botId });
    const notifying = await notify(userId, botId);

    // One command carrying both values, the way the native surface sends it
    // after the confirmation.
    const receipt = (await expectOkJson(
      await command(userId, botId, {
        type: "bot/set-profile",
        commandId: "hide-1",
        expectedRevision: notifying.revision,
        profile: { hiddenFromSidebar: true },
      }),
    )) as Receipt;
    expect(receipt.status).toBe("applied");

    const after = await settings(userId, botId);
    expect(after.profile.hiddenFromSidebar).toBe(true);
    expect(after.notifications.enabled).toBe(false);
    // Both values moved, and the revision moved exactly once: no second write.
    expect(after.revision).toBe(notifying.revision + 1);
  });

  it("refuses to turn notifications on while the Bot is hidden, moving no revision", async () => {
    const userId = freshUserId("hidden-refuses");
    const botId = "hidden-refuses-bot";
    await provisionThroughGateway({ userId, botId });
    const notifying = await notify(userId, botId);
    await expectOkJson(
      await command(userId, botId, {
        type: "bot/set-profile",
        commandId: "hide-2",
        expectedRevision: notifying.revision,
        profile: { hiddenFromSidebar: true },
      }),
    );
    const hidden = await settings(userId, botId);

    const refused = (await expectOkJson(
      await command(userId, botId, {
        type: "bot/update-notifications",
        commandId: "unmute-while-hidden",
        expectedRevision: hidden.revision,
        notifications: { enabled: true },
      }),
    )) as Receipt;
    expect(refused).toMatchObject({
      status: "rejected",
      revision: hidden.revision,
    });
    expect(refused.failure).toMatch(/hidden from the sidebar/iu);
    expect(await settings(userId, botId)).toEqual(hidden);

    // The same command id again — and again after the object is evicted — is
    // the same stored receipt, not a second decision.
    expect(
      await (
        await command(userId, botId, {
          type: "bot/update-notifications",
          commandId: "unmute-while-hidden",
          expectedRevision: hidden.revision,
          notifications: { enabled: true },
        })
      ).json(),
    ).toEqual(refused);
    await evictDurableObject(botStateStubV1(userId, botId));
    expect(
      await (
        await command(userId, botId, {
          type: "bot/update-notifications",
          commandId: "unmute-while-hidden",
          expectedRevision: hidden.revision,
          notifications: { enabled: true },
        })
      ).json(),
    ).toEqual(refused);
    expect(await settings(userId, botId)).toEqual(hidden);

    // A writer that never saw the hide is still fenced by the revision.
    const stale = await command(userId, botId, {
      type: "bot/update-notifications",
      commandId: "unmute-stale",
      expectedRevision: notifying.revision,
      notifications: { enabled: true },
    });
    expect(stale.status).toBe(409);
    expect(await settings(userId, botId)).toEqual(hidden);
  });

  it("leaves notifications off when the Bot is shown again, until they are turned on", async () => {
    const userId = freshUserId("hidden-unhide");
    const botId = "hidden-unhide-bot";
    await provisionThroughGateway({ userId, botId });
    const notifying = await notify(userId, botId);
    await expectOkJson(
      await command(userId, botId, {
        type: "bot/set-profile",
        commandId: "hide-3",
        expectedRevision: notifying.revision,
        profile: { hiddenFromSidebar: true },
      }),
    );
    const hidden = await settings(userId, botId);
    expect(hidden.notifications.enabled).toBe(false);

    await expectOkJson(
      await command(userId, botId, {
        type: "bot/set-profile",
        commandId: "show-3",
        expectedRevision: hidden.revision,
        profile: { hiddenFromSidebar: false },
      }),
    );
    const shown = await settings(userId, botId);
    expect(shown.profile.hiddenFromSidebar ?? false).toBe(false);
    expect(shown.notifications.enabled).toBe(false);

    await expectOkJson(
      await command(userId, botId, {
        type: "bot/update-notifications",
        commandId: "notify-again",
        expectedRevision: shown.revision,
        notifications: { enabled: true },
      }),
    );
    expect((await settings(userId, botId)).notifications.enabled).toBe(true);
  });

  it("keeps a hidden Bot's messages unread while no alert is raised", async () => {
    const userId = freshUserId("hidden-unread");
    const botId = "hidden-unread-bot";
    await provisionThroughGateway({ userId, botId });
    const notifying = await notify(userId, botId);
    await expectOkJson(
      await command(userId, botId, {
        type: "bot/set-profile",
        commandId: "hide-4",
        expectedRevision: notifying.revision,
        profile: { hiddenFromSidebar: true },
      }),
    );

    expect(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "hidden-turn-1",
        text: "hello",
      }),
    ).toMatchObject({ status: 200 });

    const unread = (await expectOkJson(
      await asUser(userId, "/api/bots/unread"),
    )) as { unread: Array<{ botId: string; count: number; unread: boolean }> };
    expect(unread.unread).toContainEqual(
      expect.objectContaining({ botId, count: 1, unread: true }),
    );

    const raised = (await expectOkJson(
      await asUser(userId, "/api/bots/notifications"),
    )) as { notifications: Array<{ botId: string }> };
    expect(
      raised.notifications.filter((entry) => entry.botId === botId),
    ).toEqual([]);
  });

  it("mutes a Bot that hides itself, and refuses a Bot that asks to be hidden and notifying", async () => {
    const userId = freshUserId("hidden-agent");
    const botId = "hidden-agent-bot";
    await provisionThroughGateway({ userId, botId });
    const notifying = await notify(userId, botId);

    const hide = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "agent-hide-1",
        text: frockbotToolCallPrompt("bot_update", {
          hidden_from_sidebar: true,
        }),
      }),
    )) as {
      events: Array<{
        type: string;
        callId?: string;
        content?: string;
        isError?: boolean;
      }>;
    };
    const call = hide.events.find((event) =>
      callsFrockbotTool(event, "bot_update"),
    ) as { call: { id: string } } | undefined;
    expect(call, "the Turn made no bot_update call").toBeDefined();
    const result = hide.events.find(
      (event) => event.type === "tool/result" && event.callId === call!.call.id,
    )!;
    expect(result.isError).toBe(false);
    // The report says the mute happened rather than leaving it to be found.
    expect(result.content).toMatch(/notify_on_updates/u);

    const hidden = await settings(userId, botId);
    expect(hidden.profile.hiddenFromSidebar).toBe(true);
    expect(hidden.notifications.enabled).toBe(false);
    expect(hidden.revision).toBe(notifying.revision + 1);

    // And the pair no writer may hold is refused before anything is written.
    const refused = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "agent-hide-2",
        text: frockbotToolCallPrompt("bot_update", {
          hidden_from_sidebar: true,
          notify_on_updates: true,
        }),
      }),
    )) as { events: Array<{ type: string; content?: string }> };
    const refusal = refused.events.find(
      (event) => event.type === "tool/result",
    )!;
    expect(refusal.content).toMatch(/hidden from the sidebar/iu);
    expect(await settings(userId, botId)).toEqual(hidden);
  });
});
