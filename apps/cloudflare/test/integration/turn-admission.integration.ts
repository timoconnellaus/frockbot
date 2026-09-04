// Turn admission end to end: the tool catalog a Turn is offered, the denial a
// call outside it produces, and what a user-facing send does to the Turn.
//
// The model is the outbound Ollama Cloud stub, driven by the `/call <tool>`
// trigger prompt in `test/harness/miniflare.ts`. Everything else is the
// deployed path: `SELF.fetch` enters `src/index.ts`, the gateway loads the real
// artifact, and the Bot Durable Object runs the Turn.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import type { FakeExecScript } from "../computer-host-fake.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

/** `plugin-fly-sprite` reads the inner command's exit code off this marker. */
const EXEC_EXIT_MARKER = "__FROCKBOT_EXIT__";

interface TurnView {
  runId: string;
  text: string;
  events: Array<{
    type: string;
    call?: { id: string; name: string };
    content?: string;
    isError?: boolean;
    callId?: string;
    payload?: { type: string; text?: string };
  }>;
}

interface RunView {
  schemaVersion: number;
  runId: string;
  status: string;
  events: TurnView["events"];
  outcome?: { type: string; text?: string };
}

/** Teaches the shared fake Computer host how to answer one exec. */
async function scriptExec(rule: FakeExecScript): Promise<void> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request("http://computer-host.internal/__fake/exec", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(rule),
    }),
  );
  expect(response.status).toBe(200);
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

async function chatTurn(
  userId: string,
  botId: string,
  text: string,
  commandId: string,
): Promise<TurnView> {
  return (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text,
    }),
  )) as TurnView;
}

async function listRuns(userId: string, botId: string): Promise<RunView[]> {
  const list = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/turns`),
  )) as { runs: RunView[] };
  return list.runs;
}

describe("turn admission through the gateway and the Bot", () => {
  it("denies wake_parent on a chat Turn and still completes it", async () => {
    const userId = freshUserId("admission-chat");
    const botId = "admission-chat-bot";
    await provisionThroughGateway({ userId, botId });

    const turn = await chatTurn(
      userId,
      botId,
      toolCallTriggerPrompt(["wake_parent", { message: "done" }]),
      "admission-wake-1",
    );

    const denial = turn.events.find((event) => event.type === "tool/result");
    expect(denial).toMatchObject({
      isError: true,
      content: "Tool is not available on a chat turn: wake_parent",
    });
    // The denial is a tool result, not a failure: the Turn asks the model
    // again and finishes on the reply.
    expect(turn.text).toContain("Ollama reply");
    const runs = await listRuns(userId, botId);
    expect(runs[0]).toMatchObject({
      runId: "admission-wake-1",
      status: "completed",
    });
    expect(runs[0]?.events.some((event) => event.type === "wake/parent")).toBe(
      false,
    );
  });

  it("denies send_to_user on an automation Turn admitted inside the Bot", async () => {
    const userId = freshUserId("admission-automation");
    const botId = "admission-automation-bot";
    await provisionThroughGateway({ userId, botId });

    // Only an in-Durable-Object producer may admit a Turn as anything but
    // chat: the HTTP path and the Bot's run RPC both refuse a client-named
    // turn type, so this goes straight to the Shell's own run entry.
    const turn = await runInDurableObject(
      botStub(userId, botId),
      (instance: unknown) =>
        (
          instance as {
            materialized(identity: { userId: string; botId: string }): Promise<{
              shell: { run(command: unknown): Promise<TurnView> };
            }>;
          }
        )
          .materialized({ userId, botId })
          .then(({ shell }) =>
            shell.run({
              userId,
              botId,
              runId: "admission-automation-1",
              sessionId: `${userId}:${botId}`,
              acceptedAt: new Date().toISOString(),
              text: toolCallTriggerPrompt([
                "send_to_user",
                { payload: { type: "text", text: "hello" } },
              ]),
              turnType: "automation",
            }),
          ),
    );

    const denial = turn.events.find((event) => event.type === "tool/result");
    expect(denial).toMatchObject({
      isError: true,
      content: "Tool is not available on a automation turn: send_to_user",
    });
    // The automation Turn is not in the visible transcript at all — that is
    // the transcript seam — and the Turn's own events carry no send.
    const runs = await listRuns(userId, botId);
    expect(
      runs.find((run) => run.runId === "admission-automation-1"),
    ).toBeUndefined();
    expect(turn.events.some((event) => event.type === "send/to-user")).toBe(
      false,
    );
  });

  it("carries a widget send into the run projection and ends the Turn on it", async () => {
    const userId = freshUserId("admission-widget");
    const botId = "admission-widget-bot";
    await provisionThroughGateway({ userId, botId });

    const turn = await chatTurn(
      userId,
      botId,
      toolCallTriggerPrompt([
        "send_to_user",
        {
          payload: {
            type: "widget",
            widget: { prompt: "Which day?", options: ["Tuesday", "Thursday"] },
          },
        },
      ]),
      "admission-widget-1",
    );

    expect(
      turn.events.filter((event) => event.type === "send/to-user"),
    ).toEqual([
      {
        type: "send/to-user",
        payload: {
          type: "widget",
          widget: { prompt: "Which day?", options: ["Tuesday", "Thursday"] },
        },
      },
    ]);
    // A widget-ended Turn writes no assistant message, so the derived text is
    // empty and the payload reaches the client through the event alone.
    expect(turn.text).toBe("");

    const run = (await listRuns(userId, botId)).find(
      (candidate) => candidate.runId === "admission-widget-1",
    );
    expect(run).toMatchObject({ schemaVersion: 2, status: "completed" });
    expect(
      run?.events.filter((event) => event.type === "send/to-user"),
    ).toHaveLength(1);

    // Exactly one model request: the widget closed the Turn, so the loop never
    // asked the model again.
    const requests = await runInDurableObject(
      botStub(userId, botId),
      async (_instance: unknown, state: DurableObjectState) => {
        // `run:` and nothing else: other durable records name the same run
        // (the admission idempotency record among them) and carry no events,
        // so an unprefixed scan can answer with the wrong one.
        const stored = await state.storage.list<{
          runId: string;
          events: Array<{ type: string }>;
        }>({ prefix: "run:" });
        const record = [...stored.values()].find(
          (value) =>
            typeof value === "object" &&
            value !== null &&
            (value as { runId?: string }).runId === "admission-widget-1",
        );
        return (record?.events ?? []).filter(
          (event) => event.type === "model/request",
        ).length;
      },
    );
    expect(requests).toBe(1);
  });

  it("keeps every send of one Turn, in order, in the durable transcript", async () => {
    const userId = freshUserId("admission-stack");
    const botId = "admission-stack-bot";
    await provisionThroughGateway({ userId, botId });

    // The shape a person actually sees: an acknowledgement, then a beat, then
    // the result — three messages from the Bot inside one Turn, with the
    // model's own reply written after them.
    await chatTurn(
      userId,
      botId,
      toolCallTriggerPrompt(
        ["send_to_user", { payload: { type: "text", text: "On it." } }],
        ["send_to_user", { payload: { type: "text", text: "Looking now." } }],
        ["send_to_user", { payload: { type: "text", text: "Booked." } }],
      ),
      "admission-stack-1",
    );

    // Read back the way the thread reads it, not out of the reply this test
    // is holding: a refresh has to draw the same three messages in the same
    // order, because durable order is display order.
    const run = (await listRuns(userId, botId)).find(
      (candidate) => candidate.runId === "admission-stack-1",
    );
    expect(run).toMatchObject({ status: "completed" });
    expect(
      run?.events
        .filter((event) => event.type === "send/to-user")
        .map((event) => event.payload?.text),
    ).toEqual(["On it.", "Looking now.", "Booked."]);
    // The Turn's own line is the model's reply, kept whole beside the sends
    // rather than replacing them — the last send does not become the Turn's
    // text, and no send is dropped for the one after it.
    expect(run?.outcome?.text).toContain("Ollama reply");
  });

  it("falls back to the last text send when the Turn wrote no assistant message", async () => {
    const userId = freshUserId("admission-text");
    const botId = "admission-text-bot";
    await provisionThroughGateway({ userId, botId });

    // Both sends land in one model response, so the widget ends the Turn on
    // the same step the text was sent — a Turn that spoke and then stopped,
    // with no assistant message anywhere in it.
    const turn = await chatTurn(
      userId,
      botId,
      toolCallTriggerPrompt(
        ["send_message", { payload: { type: "text", text: "Booked." } }],
        [
          "send_to_user",
          {
            payload: {
              type: "widget",
              widget: { prompt: "Anything else?", options: ["No"] },
            },
          },
        ],
      ),
      "admission-text-1",
    );

    expect(
      turn.events
        .filter((event) => event.type === "send/to-user")
        .map((event) => event.payload?.type),
    ).toEqual(["text", "widget"]);
    expect(turn.text).toBe("Booked.");
  });

  // The conversational contract, proved where it is observable: the short
  // "On it." reaches the durable log before the slow work does, so the person
  // is not left watching a spinner while the Bot runs a command.
  it("records the acknowledgement before the work it acknowledges", async () => {
    const userId = freshUserId("admission-ack");
    const botId = "admission-ack-bot";
    const marker = `frockbot-ack-${crypto.randomUUID()}`;
    await scriptExec({ match: marker, stdout: `done\n${EXEC_EXIT_MARKER}0\n` });
    await provisionThroughGateway({ userId, botId });

    const turn = await chatTurn(
      userId,
      botId,
      toolCallTriggerPrompt(
        ["send_to_user", { payload: { type: "text", text: "On it." } }],
        ["computer_exec", { command: `echo ${marker}` }],
      ),
      "admission-ack-1",
    );

    const acknowledgement = turn.events.findIndex(
      (event) => event.type === "send/to-user",
    );
    expect(acknowledgement).toBeGreaterThanOrEqual(0);
    expect(turn.events[acknowledgement]?.payload).toMatchObject({
      type: "text",
      text: "On it.",
    });

    // The work itself: its result is matched back to the call by id, the way
    // the transcript draws it.
    const exec = turn.events.find(
      (event) =>
        event.type === "tool/call" && event.call?.name === "computer_exec",
    );
    expect(exec?.call?.id).toBeDefined();
    const execResult = turn.events.findIndex(
      (event) =>
        event.type === "tool/result" && event.callId === exec?.call?.id,
    );
    // Recorded before the work, so it is delivered before it: a send is
    // flushed to the durable log as its own event the moment the tool
    // returns, not held back until the Turn settles.
    expect(execResult).toBeGreaterThan(acknowledgement);
    expect(turn.events[execResult]?.isError).toBe(false);
  });
});
