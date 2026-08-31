// What a Routine firing does to the conversation, end to end: nothing visible,
// and one durable thing.
//
// A firing runs as an automation Turn. It cannot speak to the user — that is
// `turn-admission.integration.ts`'s `send_to_user` denial, referenced here and
// not repeated — so its only way back is `wake_parent`, and what that produces
// is a completion-inbox entry and a pending input the Bot's next conversational
// Turn carries. The visible transcript never learns any of it happened.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  dueAtWithFiringHeadroomV1,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  settledRoutineFiringV1,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const HANDOFF = "Three overnight emails need you.";

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

/**
 * Wind the Routine's durable clock back to a moment already past — the record a
 * Routine whose occurrence has arrived actually holds. The integration Worker
 * has no fake clock.
 */
async function makeDue(userId: string, botId: string): Promise<void> {
  const dueAt = await dueAtWithFiringHeadroomV1();
  await runInDurableObject(botStub(userId, botId), async (_instance, state) => {
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
}

interface StoredRunProbe {
  runId: string;
  status: string;
  admission?: { turnType: string; origin?: { routineId: string } };
  events: Array<{ type: string; request?: { messages?: unknown } }>;
}

async function storedRuns(
  userId: string,
  botId: string,
): Promise<StoredRunProbe[]> {
  return runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => [
      ...(
        await state.storage.list<StoredRunProbe>({ prefix: "run:" })
      ).values(),
    ],
  );
}

/** The text one Turn was actually run on: its own `user/message` events. */
function inputTexts(run: StoredRunProbe): string[] {
  return run.events
    .filter((event) => event.type === "user/message")
    .map((event) => (event as { text?: string }).text ?? "");
}

async function chatTurn(
  userId: string,
  botId: string,
  text: string,
  commandId: string,
): Promise<string> {
  const turn = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text,
    }),
  )) as { runId: string };
  return turn.runId;
}

function requestTexts(run: StoredRunProbe): string[] {
  return run.events
    .filter((event) => event.type === "model/request")
    .flatMap((event) =>
      ((event.request?.messages ?? []) as Array<{ content?: unknown }>).map(
        (message) =>
          typeof message.content === "string" ? message.content : "",
      ),
    );
}

/**
 * Create the Routine, make it due, wake the object, and answer with the firing
 * once it has settled. The alarm returning is not the firing being over — a
 * second alarm delivery racing this one defers while the Turn executes — so the
 * durable run is read through the settled wait rather than straight after.
 */
async function fireRoutine(
  userId: string,
  botId: string,
): Promise<StoredRunProbe> {
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/routines`, {
      schemaVersion: 1,
      type: "routine/create",
      commandId: `create-${botId}`,
      botId,
      routineId: "brief",
      name: "Morning brief",
      // The Routine's own prompt is what the automation Turn is cued with, so
      // the scripted call travels in it.
      prompt: toolCallTriggerPrompt(["wake_parent", { message: HANDOFF }]),
      schedule: "* * * * *",
      timezone: "UTC",
    }),
  );
  await makeDue(userId, botId);
  expect(await runDurableObjectAlarm(botStub(userId, botId))).toBe(true);
  return settledRoutineFiringV1<StoredRunProbe>(userId, botId);
}

describe("a Routine firing, and what it leaves behind", () => {
  it("lands one inbox entry and leaves the visible transcript untouched", async () => {
    const userId = freshUserId("routines-firing");
    const botId = "routines-firing-bot";
    await provisionThroughGateway({ userId, botId });

    const before = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: Array<{ runId: string }> };

    const automation = await fireRoutine(userId, botId);

    // The firing ran, and it ran as an automation Turn.
    expect(automation.admission?.turnType).toBe("automation");
    expect(
      automation.events.some((event) => event.type === "wake/parent"),
    ).toBe(true);

    // THE TRANSCRIPT. `GET /turns` is the visible-conversation projection and
    // it does not move: an automation run is reachable only through the run log.
    const turns = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: Array<{ runId: string }> };
    expect(turns.runs.map((run) => run.runId)).toEqual(
      before.runs.map((run) => run.runId),
    );

    // THE INBOX. Exactly one entry, attributed to the Routine, unread.
    const inbox = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines/inbox`),
    )) as {
      unacknowledged: number;
      entries: Array<{
        entryId: string;
        runId: string;
        text: string;
        attribution: string;
        acknowledged: boolean;
      }>;
    };
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.unacknowledged).toBe(1);
    expect(inbox.entries[0]).toMatchObject({
      runId: automation.runId,
      text: HANDOFF,
      attribution: "Automation: Morning brief",
      acknowledged: false,
    });

    // Acknowledging is a command, and it is what clears the badge.
    const receipt = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/routines/inbox`, {
        schemaVersion: 1,
        commandId: `ack-${botId}`,
        botId,
        type: "routine/acknowledge-inbox",
        entryIds: [inbox.entries[0]!.entryId],
      }),
    )) as { status: string; inbox: { unacknowledged: number } };
    expect(receipt).toMatchObject({
      status: "applied",
      inbox: { unacknowledged: 0 },
    });

    // THE RUN LOG is the only door to the automation run, and it opens.
    const log = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines/brief/runs`),
    )) as { entries: Array<{ runId: string; status: string }> };
    expect(log.entries[0]).toMatchObject({
      runId: automation.runId,
      status: "ok",
    });
    const detail = (await expectOkJson(
      await asUser(
        userId,
        `/api/bots/${botId}/routines/brief/runs/${automation.runId}`,
      ),
    )) as { runId: string; events: Array<{ type: string; summary: string }> };
    expect(detail.runId).toBe(automation.runId);
    expect(detail.events.some((event) => event.type === "wake/parent")).toBe(
      true,
    );

    // A run the log does not name is not readable through it.
    expect(
      (await asUser(userId, `/api/bots/${botId}/routines/brief/runs/not-a-run`))
        .status,
    ).toBe(404);
  });

  it("hands the firing to the next chat Turn, without its transcript", async () => {
    const userId = freshUserId("routines-handoff");
    const botId = "routines-handoff-bot";
    await provisionThroughGateway({ userId, botId });

    // A conversational Turn first, so there is a parent transcript to not copy.
    const beforeRunId = await chatTurn(
      userId,
      botId,
      "remember the mango pickle",
      "chat-before-1",
    );
    const automation = await fireRoutine(userId, botId);
    // FRESH HISTORY. The firing's request carries a pointer and its own cue,
    // and not one word of the conversation it belongs to.
    const automationRequests = requestTexts(automation);
    expect(
      automationRequests.some((text) => text.includes("mango pickle")),
    ).toBe(false);
    expect(
      automationRequests.some((text) =>
        text.includes("running as an automation Turn"),
      ),
    ).toBe(true);

    // THE NEXT CHAT TURN carries the hand-off as durable input.
    const afterRunId = await chatTurn(
      userId,
      botId,
      "what happened overnight?",
      "chat-after-1",
    );
    const chat = (await storedRuns(userId, botId)).find(
      (run) => run.runId === afterRunId,
    )!;
    const chatRequests = requestTexts(chat);
    expect(chatRequests.some((text) => text.includes(HANDOFF))).toBe(true);
    // It arrived as this Turn's own input, recorded on the log, so the model
    // request is reconstructible from durable state.
    expect(inputTexts(chat).some((text) => text.includes(HANDOFF))).toBe(true);
    // …and not the automation Turn's transcript. The firing's cue never
    // reaches the conversation's prompt.
    expect(
      chatRequests.some((text) => text.includes('Morning brief" fired')),
    ).toBe(false);
    // The conversation's own history is still there.
    expect(chatRequests.some((text) => text.includes("mango pickle"))).toBe(
      true,
    );

    // The transcript shows the two chat Turns and neither the firing nor a
    // separate message for the hand-off.
    const turns = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: Array<{ runId: string; input: string }> };
    expect(turns.runs.map((run) => run.runId)).toEqual([
      beforeRunId,
      afterRunId,
    ]);
    // The visible input is what the person typed, not what the Bot was told.
    expect(turns.runs[1]!.input).toBe("what happened overnight?");

    // The hand-off is delivered once. A third Turn is not given it again — its
    // own input is only what the person typed, though the second Turn's input
    // is of course still in the history, as any Turn's is.
    const thirdRunId = await chatTurn(
      userId,
      botId,
      "anything else?",
      "chat-after-2",
    );
    const third = (await storedRuns(userId, botId)).find(
      (run) => run.runId === thirdRunId,
    )!;
    expect(inputTexts(third).some((text) => text.includes(HANDOFF))).toBe(
      false,
    );
  });
});
