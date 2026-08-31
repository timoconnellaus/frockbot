// Slice F2 end to end: an approval card, entirely through `SELF.fetch`.
//
// The whole point of the card is that it crosses from a Turn to a person and
// back, so every step here is a request the browser makes. A Turn sends the
// card and ends; `GET /turns` renders it in the transcript; `POST` records the
// decision and answers a replay with the same body; and the Bot's next
// conversational Turn is run on a model request that carries the answer.
//
// A Bot with notifications off is checked too, because an approval is not an
// update: muting silences chatter, not a question that has stopped the Bot.
import {
  env,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectJson,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const ACTION = "Delete the staging database";

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

interface TurnView {
  runId: string;
  status: string;
  events: Array<{ type: string; payload?: { type?: string } }>;
}

interface ApprovalCard {
  approvalId: string;
  runId: string;
  action: string;
  risk: string;
  decision: string;
  expiresAt: string;
  rationale?: string;
}

interface StoredRunProbe {
  runId: string;
  events: Array<{
    type: string;
    text?: string;
    request?: { messages?: unknown };
  }>;
}

async function askForApproval(
  userId: string,
  botId: string,
  approvalId: string,
): Promise<TurnView> {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: `ask-${approvalId}`,
      text: toolCallTriggerPrompt([
        "send_to_user",
        {
          payload: {
            type: "approval",
            approvalId,
            action: ACTION,
            rationale: "Nothing has connected to it in a month.",
            risk: "high",
          },
        },
      ]),
    }),
  )) as TurnView;
}

async function listApprovals(
  userId: string,
  botId: string,
): Promise<{ approvals: ApprovalCard[]; pending: number }> {
  return (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/approvals`),
  )) as { approvals: ApprovalCard[]; pending: number };
}

/** The text one Turn was actually run on: its own `user/message` events. */
function inputTexts(run: StoredRunProbe): string[] {
  return run.events
    .filter((event) => event.type === "user/message")
    .map((event) => event.text ?? "");
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

async function storedRun(
  userId: string,
  botId: string,
  runId: string,
): Promise<StoredRunProbe> {
  const runs = await runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => [
      ...(
        await state.storage.list<StoredRunProbe>({ prefix: "run:" })
      ).values(),
    ],
  );
  const run = runs.find((candidate) => candidate.runId === runId);
  if (!run) throw new Error(`no stored run "${runId}"`);
  return run;
}

describe("approval cards through the gateway", () => {
  it("ends the Turn, renders the card, records one decision, and tells the Bot", async () => {
    const userId = freshUserId("approvals");
    const botId = "approvals-bot";
    await provisionThroughGateway({ userId, botId });

    const asked = await askForApproval(userId, botId, "ap-1");

    const transcript = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: TurnView[] };
    // Like a widget: the Turn is over the moment the card is sent, and it is
    // over in a terminal state rather than left running.
    const rendered = transcript.runs.find((run) => run.runId === asked.runId);
    expect(rendered?.status).toBe("completed");
    expect(
      rendered?.events
        .filter((event) => event.type === "send/to-user")
        .map((event) => event.payload?.type),
    ).toEqual(["approval"]);

    const pending = await listApprovals(userId, botId);
    expect(pending.pending).toBe(1);
    expect(pending.approvals[0]).toMatchObject({
      approvalId: "ap-1",
      runId: asked.runId,
      action: ACTION,
      risk: "high",
      decision: "pending",
      rationale: "Nothing has connected to it in a month.",
    });
    // Never an unbounded wait: the record carries its own deadline.
    expect(Date.parse(pending.approvals[0]!.expiresAt)).toBeGreaterThan(
      Date.now(),
    );

    const recorded = await postAsUser(
      userId,
      `/api/bots/${botId}/approvals/ap-1`,
      { schemaVersion: 1, decision: "approved" },
    );
    expect(recorded.status).toBe(200);
    const receipt = await recorded.json();
    expect(receipt).toMatchObject({
      status: "recorded",
      approval: { approvalId: "ap-1", decision: "approved" },
    });

    // A replay — a double click, a retried request — answers with the decision
    // that was recorded rather than recording a second one.
    const replay = await postAsUser(
      userId,
      `/api/bots/${botId}/approvals/ap-1`,
      { schemaVersion: 1, decision: "denied" },
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      status: "replayed",
      approval: {
        approvalId: "ap-1",
        decision: "approved",
        decidedAt: (receipt as { approval: { decidedAt: string } }).approval
          .decidedAt,
      },
    });

    const next = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "approvals-next",
        text: "so, did I say yes?",
      }),
    )) as TurnView;

    // The answer reaches the Bot as durable input on the next chat Turn, ahead
    // of the person's own words rather than merged into them.
    const texts = requestTexts(await storedRun(userId, botId, next.runId));
    expect(
      texts.some((text) =>
        text.includes('The decision on "ap-1" is approved.'),
      ),
    ).toBe(true);
    expect(texts.some((text) => text.includes("so, did I say yes?"))).toBe(
      true,
    );

    // Told once. A third Turn is not told again — its own input carries no
    // preamble, though the history it replays naturally still contains the
    // Turn that did.
    const later = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "approvals-later",
        text: "anything else?",
      }),
    )) as TurnView;
    expect(
      inputTexts(await storedRun(userId, botId, later.runId)).some((text) =>
        text.includes('The decision on "ap-1"'),
      ),
    ).toBe(false);
  });

  it("notifies a muted Bot's User anyway, and expires a card nobody answered", async () => {
    const userId = freshUserId("approvals-muted");
    const botId = "approvals-muted-bot";
    // A new Bot's notifications are off. That is the mute, and it gates
    // updates — not a question the Bot has stopped on.
    await provisionThroughGateway({ userId, botId });

    await askForApproval(userId, botId, "ap-muted");

    const notifications = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/notifications`),
    )) as {
      notifications: Array<{ notificationId: string; urgency?: string }>;
    };
    expect(
      notifications.notifications.find(
        (intent) => intent.notificationId === "approval:ap-muted",
      ),
    ).toMatchObject({ urgency: "critical" });

    // Nobody clicks. The deadline arrives, and the Bot's own alarm answers.
    await runInDurableObject(
      botStub(userId, botId),
      async (_instance, state) => {
        const key = "shell:approval:ap-muted";
        const stored = (await state.storage.get<{ expiresAt: string }>(key))!;
        await state.storage.put(key, {
          ...stored,
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
        });
        await state.storage.setAlarm(Date.now());
      },
    );
    await runDurableObjectAlarm(botStub(userId, botId));

    const expired = await listApprovals(userId, botId);
    expect(expired.pending).toBe(0);
    expect(expired.approvals[0]).toMatchObject({
      approvalId: "ap-muted",
      decision: "expired",
    });
  });

  it("refuses a decision that is neither answer, and an approval that does not exist", async () => {
    const userId = freshUserId("approvals-refuse");
    const botId = "approvals-refuse-bot";
    await provisionThroughGateway({ userId, botId });

    // Expiry is what the clock does, never what a person submits.
    const invalid = await postAsUser(
      userId,
      `/api/bots/${botId}/approvals/ap-none`,
      { schemaVersion: 1, decision: "expired" },
    );
    expect(invalid.status).toBe(400);

    const missing = await postAsUser(
      userId,
      `/api/bots/${botId}/approvals/ap-none`,
      { schemaVersion: 1, decision: "approved" },
    );
    expect({
      status: missing.status,
      body: await expectJson(missing),
    }).toMatchObject({ status: 404 });
  });
});
