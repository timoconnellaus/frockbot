// The agent lane end to end: Bot A asks Bot B, B runs an `agent` Turn, and B's
// reply_to_request answer returns as A's `bot_message` tool result.
import { describe, expect, it } from "vitest";
import {
  frockbotToolCallPrompt,
  toolCallTriggerPrompt,
} from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
  flockRevision,
} from "./fixtures.ts";

useApplicationArtifact();

describe("the agent lane through the gateway", () => {
  it("returns Bot B's answer to Bot A and marks both transcripts", async () => {
    const userId = freshUserId("agent-lane");
    const askingBotId = "general";
    const targetBotId = "researcher";
    await provisionThroughGateway({ userId, botId: askingBotId });

    const created = await postAsUser(userId, "/api/bots", {
      schemaVersion: 1,
      type: "bot/create",
      commandId: "create-researcher",
      expectedRevision: await flockRevision(userId),
      botId: targetBotId,
      name: "Researcher",
      description: "Finds primary sources.",
    });
    expect(created.status).toBe(201);

    const answer = "The specialist answer.";
    const targetQuestion = toolCallTriggerPrompt([
      "reply_to_request",
      { answer },
    ]);
    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${askingBotId}/turns`, {
        schemaVersion: 1,
        commandId: "ask-researcher",
        text: frockbotToolCallPrompt("bot_message", {
          target_id: targetBotId,
          message: targetQuestion,
        }),
      }),
    )) as {
      events: Array<
        | {
            type: "message/to-bot";
            callId: string;
            botId: string;
            text: string;
          }
        | {
            type: "tool/result";
            callId: string;
            content: string;
            isError: boolean;
          }
      >;
    };
    // The asking side carries the question as an exchange, not a tool call.
    const call = turn.events.find(
      (event) => event.type === "message/to-bot" && event.botId === targetBotId,
    );
    expect(call).toMatchObject({
      type: "message/to-bot",
      text: targetQuestion,
    });
    const result = turn.events.find(
      (event) =>
        event.type === "tool/result" &&
        event.callId === (call as { callId: string }).callId,
    );
    const transcript = (await expectOkJson(
      await asUser(userId, `/api/bots/${targetBotId}/turns`),
    )) as {
      runs: Array<{
        input: string;
        via?: { kind: string; name: string; botId?: string };
        events: Array<{ type: string; caller?: string; text?: string }>;
      }>;
    };
    expect(result).toMatchObject({
      type: "tool/result",
      content: answer,
      isError: false,
    });
    const answered = transcript.runs.find(
      (run) => run.input === targetQuestion,
    );
    expect(answered).toMatchObject({
      via: { kind: "bot", name: "Integration Bot", botId: askingBotId },
    });
    // B's answer is a caller reply, not a send: it never minted a message.
    expect(answered?.events).toContainEqual({
      type: "reply/to-caller",
      caller: "bot",
      text: answer,
    });
    expect(
      answered?.events.some((event) => event.type === "send/to-user"),
    ).toBe(false);

    // The exchange view's read: only the Turns that crossed to this Bot.
    const pair = (await expectOkJson(
      await asUser(
        userId,
        `/api/bots/${askingBotId}/turns?with=bot:${targetBotId}`,
      ),
    )) as { runs: Array<{ runId: string }> };
    expect(pair.runs.map((run) => run.runId)).toEqual([
      (turn as unknown as { runId: string }).runId,
    ]);
    const spoken = (await expectOkJson(
      await asUser(userId, `/api/bots/${askingBotId}/turns?with=voice`),
    )) as { runs: unknown[] };
    expect(spoken.runs).toEqual([]);
    const mirrored = (await expectOkJson(
      await asUser(
        userId,
        `/api/bots/${targetBotId}/turns?with=bot:${askingBotId}`,
      ),
    )) as { runs: Array<{ input: string }> };
    expect(mirrored.runs.map((run) => run.input)).toEqual([targetQuestion]);
  });
});
