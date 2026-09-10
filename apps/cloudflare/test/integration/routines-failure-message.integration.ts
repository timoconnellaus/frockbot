// A Routine that breaks is an ordinary message, end to end.
//
// The claim under test is the read contract, not the storage: a firing that
// fails raises a badge, and the conversation it badges must be able to clear
// it. So every assertion here is a request a client makes — the transcript
// projection, the unread directory, the mark-read command — and the identity
// they agree on is the one the device renders (`<runId>:send:<ordinal>`) and
// the one the cloud counts unread by. Asserting the durable message record
// instead would prove nothing about whether anybody can see it.
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import {
  asUser,
  botStateStubV1,
  dueAtWithFiringHeadroomV1,
  expectOkJson,
  freshUserId,
  listStoredRunsWithEventsV1,
  OLLAMA_REVOKED_API_KEY,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface RunProbe {
  runId: string;
  status: string;
  admission?: { turnType: string; origin?: { routineId: string } };
}

interface ClientRun {
  runId: string;
  status: string;
  events: Array<{
    type: string;
    ordinal?: number;
    payload?: { type: string; text?: string };
  }>;
  outcome?: { type: string; message?: string };
}

interface UnreadView {
  botId: string;
  count: number;
  unread: boolean;
  lastMessageId?: string;
  unreadFromMessageId?: string;
  lastActivityCursor?: string;
  lastSeenCursor?: string;
}

async function transcript(userId: string, botId: string): Promise<ClientRun[]> {
  const page = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/turns`),
  )) as { runs: ClientRun[] };
  return page.runs;
}

async function unreadView(userId: string, botId: string): Promise<UnreadView> {
  const directory = (await expectOkJson(
    await asUser(userId, "/api/bots/unread"),
  )) as { unread: UnreadView[] };
  const view = directory.unread.find((candidate) => candidate.botId === botId);
  if (!view) throw new Error(`no unread view for "${botId}"`);
  return view;
}

async function notificationIds(userId: string): Promise<string[]> {
  const directory = (await expectOkJson(
    await asUser(userId, "/api/bots/notifications"),
  )) as { notifications: Array<{ notificationId: string }> };
  return directory.notifications.map((intent) => intent.notificationId);
}

async function setNotifications(
  userId: string,
  botId: string,
  enabled: boolean,
): Promise<void> {
  const settings = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/settings`),
  )) as { revision: number };
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/settings`, {
      schemaVersion: 1,
      type: "bot/update-notifications",
      commandId: `notify-${botId}-${enabled}`,
      expectedRevision: settings.revision,
      botId,
      notifications: { enabled },
    }),
  );
}

/**
 * Create a Routine, wind its clock back, and drive the alarm until the firing
 * has settled `failed` and released its lock. The provider rejects every model
 * call for this account, so the automation Turn cannot finish.
 */
async function failedFiring(
  userId: string,
  botId: string,
  // Refuses the firing's Turn before admission, so the firing settles with no
  // durable run at all — the pre-admission failure, which used to reach nobody.
  options: { fenceAdmission?: boolean } = {},
): Promise<string> {
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/routines`, {
      schemaVersion: 1,
      type: "routine/create",
      commandId: `create-${botId}`,
      botId,
      routineId: "brief",
      name: "Morning brief",
      prompt: "summarise the overnight mail",
      schedule: "* * * * *",
      timezone: "UTC",
    }),
  );
  const dueAt = await dueAtWithFiringHeadroomV1();
  const stub = botStateStubV1(userId, botId);
  await runInDurableObject(stub, async (_instance, state) => {
    const record = await state.storage.get<{ updatedAt: string }>(
      "routine:brief",
    );
    await state.storage.put("routine-schedule:brief", {
      schemaVersion: 1,
      routineId: "brief",
      anchor: record!.updatedAt,
      dueAt,
    });
  });
  if (options.fenceAdmission) {
    await expectOkJson(
      await postAsUser(
        userId,
        `/api/bots/${botId}/turns/rf-brief-${dueAt}/fence`,
        { schemaVersion: 1, action: "fence-admission" },
      ),
    );
  }
  let fireId: string | undefined;
  await vi.waitFor(
    async () => {
      await runDurableObjectAlarm(stub);
      const runs = await listStoredRunsWithEventsV1<RunProbe>(userId, botId);
      const fired = runs.filter(
        (run) => run.admission?.origin?.routineId === "brief",
      );
      expect(fired).toHaveLength(1);
      expect(fired[0]!.status).toBe("failed");
      const unsettled = await runInDurableObject(stub, (_i, state) =>
        state.storage.get<unknown>("routine-fire:brief"),
      );
      expect(unsettled).toBeUndefined();
      fireId = fired[0]!.runId;
    },
    { timeout: 30_000, interval: 250 },
  );
  return fireId!;
}

/** The newest message the transcript draws, named the way the device names it. */
function renderedMessages(runs: ClientRun[]): Array<{
  messageId: string;
  text: string | undefined;
}> {
  return runs.flatMap((run) =>
    run.events
      .filter(
        (event) => event.type === "send/to-user" && event.ordinal !== undefined,
      )
      .map((event) => ({
        messageId: `${run.runId}:send:${event.ordinal}`,
        text: event.payload?.text,
      })),
  );
}

describe("a Routine firing that fails", () => {
  it("is a message the conversation shows, and reading the conversation clears it", async () => {
    const userId = freshUserId("routine-failed-message");
    const botId = "routine-failed-bot";
    await provisionThroughGateway({
      userId,
      botId,
      apiKey: OLLAMA_REVOKED_API_KEY,
    });
    await setNotifications(userId, botId, true);

    const fireId = await failedFiring(userId, botId);

    // THE CONVERSATION. The firing is drawn, and what it says is the sentence
    // written for a person — never the provider's diagnostic.
    const runs = await transcript(userId, botId);
    const failed = runs.find((run) => run.runId === fireId);
    expect(failed).toBeDefined();
    const messages = renderedMessages(runs);
    expect(messages).toHaveLength(1);
    expect(messages[0]!.messageId).toBe(`${fireId}:send:0`);
    expect(messages[0]!.text).toBeTruthy();
    expect(messages[0]!.text).not.toContain("401");
    expect(messages[0]!.text).not.toContain("model-error");
    // It says which automation broke: a message arrives among ordinary
    // replies, where an unattributed sentence reads as the Bot speaking up.
    expect(messages[0]!.text).toContain('"Morning brief"');
    expect(messages[0]!.text).toContain("did not run");
    // And the Turn's own notice is that same message, word for word, which is
    // what lets the thread draw the failure once instead of drawing the
    // message with a second generic line underneath it.
    expect(failed!.outcome).toEqual({
      type: "failed",
      message: messages[0]!.text,
    });

    // THE BADGE names exactly the message the transcript drew. This is the
    // whole contract: the device only claims a read when the id the cloud
    // calls latest is the id it is rendering.
    const badged = await unreadView(userId, botId);
    expect(badged.count).toBe(1);
    expect(badged.unread).toBe(true);
    expect(badged.lastMessageId).toBe(messages[0]!.messageId);

    // One alert, not two: the firing's message is the only intent raised.
    expect(await notificationIds(userId)).toHaveLength(1);

    // READING IT. The ordinary mark-read a focused conversation sends.
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/unread`, {
        schemaVersion: 1,
        type: "bot/mark-read",
        commandId: `read-${botId}`,
        botId,
        upToCursor: badged.lastActivityCursor,
      }),
    );
    const cleared = await unreadView(userId, botId);
    expect(cleared.count).toBe(0);
    expect(cleared.unread).toBe(false);
    // The read cursor other devices clear their notifications by.
    expect(cleared.lastSeenCursor).toBe(badged.lastActivityCursor);

    // And the message stays in the conversation after it has been read.
    expect(renderedMessages(await transcript(userId, botId))).toEqual(messages);

    // UNREADING IT. The conversation offers "mark unread from here" on this
    // message, so the boundary the device posts back is the id it rendered —
    // and the cloud has to recognise it, or the action is one that can only
    // ever fail on exactly the message this change added.
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/unread`, {
        schemaVersion: 1,
        type: "bot/mark-unread",
        commandId: `unread-${botId}`,
        botId,
        fromMessageId: messages[0]!.messageId,
      }),
    );
    const reraised = await unreadView(userId, botId);
    expect(reraised.unread).toBe(true);
    expect(reraised.unreadFromMessageId).toBe(messages[0]!.messageId);
    // Manual unread wakes nobody: it raises no alert of its own, and the one
    // the message raised was cleared by the read before it.
    expect(await notificationIds(userId)).toEqual([]);
  });

  it("is the same message when the firing never reached a run", async () => {
    const userId = freshUserId("routine-unadmitted-message");
    const botId = "routine-unadmitted-bot";
    await provisionThroughGateway({
      userId,
      botId,
      apiKey: OLLAMA_REVOKED_API_KEY,
    });
    await setNotifications(userId, botId, true);

    const fireId = await failedFiring(userId, botId, { fenceAdmission: true });

    // The Turn was refused before admission, so nothing ran: the record the
    // conversation draws is the firing's own failure and no journal at all.
    const stored = await listStoredRunsWithEventsV1<
      RunProbe & { events: unknown[] }
    >(userId, botId);
    const refused = stored.find((run) => run.runId === fireId);
    expect(refused?.events).toEqual([]);

    // It is an ordinary message all the same: drawn in the conversation,
    // counted unread, and alerted for exactly once.
    const messages = renderedMessages(await transcript(userId, botId));
    expect(messages.map((message) => message.messageId)).toEqual([
      `${fireId}:send:0`,
    ]);
    expect(messages[0]!.text).toBeTruthy();
    const badged = await unreadView(userId, botId);
    expect(badged.count).toBe(1);
    expect(badged.lastMessageId).toBe(`${fireId}:send:0`);
    expect(await notificationIds(userId)).toHaveLength(1);

    // Reading the conversation clears the badge it raised.
    await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/unread`, {
        schemaVersion: 1,
        type: "bot/mark-read",
        commandId: `read-${botId}`,
        botId,
        upToCursor: badged.lastActivityCursor,
      }),
    );
    expect((await unreadView(userId, botId)).count).toBe(0);
  });

  it("stays readable when the Bot is muted, and wakes nobody", async () => {
    const userId = freshUserId("routine-failed-muted");
    const botId = "routine-muted-bot";
    await provisionThroughGateway({
      userId,
      botId,
      apiKey: OLLAMA_REVOKED_API_KEY,
    });
    await setNotifications(userId, botId, false);

    const fireId = await failedFiring(userId, botId);

    const messages = renderedMessages(await transcript(userId, botId));
    expect(messages.map((message) => message.messageId)).toEqual([
      `${fireId}:send:0`,
    ]);
    const badged = await unreadView(userId, botId);
    expect(badged.count).toBe(1);
    expect(badged.lastMessageId).toBe(`${fireId}:send:0`);
    // Mute is the mute on alerting alone.
    expect(await notificationIds(userId)).toEqual([]);
  });
});
