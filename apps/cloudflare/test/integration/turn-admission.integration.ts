// Turn admission end to end: the tool catalog a Turn is offered, the denial a
// call outside it produces, and what a user-facing send does to the Turn.
//
// The model is the outbound Ollama Cloud stub, driven by the `/call <tool>`
// trigger prompt in `test/harness/miniflare.ts`. Everything else is the
// deployed path: `SELF.fetch` enters `src/index.ts`, the gateway loads the real
// artifact, and the Bot Durable Object runs the Turn.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
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

interface TurnView {
  runId: string;
  text: string;
  events: Array<{
    type: string;
    call?: { id: string; name: string };
    content?: string;
    isError?: boolean;
    payload?: { type: string };
  }>;
}

interface RunView {
  schemaVersion: number;
  runId: string;
  status: string;
  events: TurnView["events"];
  outcome?: { type: string; text?: string };
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
        const stored = await state.storage.list<{
          runId: string;
          events: Array<{ type: string }>;
        }>();
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
});
