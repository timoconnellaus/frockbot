// Voice B0 end to end: Bot A asks Bot B, B runs an `agent` Turn, and B's
// send_to_user text returns as A's `bot_message` tool result.
import { describe, expect, it } from "vitest";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

describe("the agent lane through the gateway", () => {
  it("returns Bot B's send to Bot A and marks B's transcript origin", async () => {
    const userId = freshUserId("agent-lane");
    const askingBotId = "general";
    const targetBotId = "researcher";
    await provisionThroughGateway({ userId, botId: askingBotId });

    const created = await postAsUser(userId, "/api/bots", {
      schemaVersion: 1,
      type: "bot/create",
      commandId: "create-researcher",
      expectedRevision: 1,
      botId: targetBotId,
      name: "Researcher",
      description: "Finds primary sources.",
    });
    expect(created.status).toBe(201);

    const answer = "The specialist answer.";
    const targetQuestion = `${TOOL_CALL_TRIGGER}send_to_user:${JSON.stringify({
      payload: { type: "text", text: answer },
    })}`;
    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${askingBotId}/turns`, {
        schemaVersion: 1,
        commandId: "ask-researcher",
        text: `${TOOL_CALL_TRIGGER}bot_message:${JSON.stringify({
          target_id: targetBotId,
          message: targetQuestion,
        })}`,
      }),
    )) as {
      events: Array<
        | { type: "tool/call"; call: { id: string; name: string } }
        | {
            type: "tool/result";
            callId: string;
            content: string;
            isError: boolean;
          }
      >;
    };
    const call = turn.events.find(
      (event) =>
        event.type === "tool/call" && event.call.name === "bot_message",
    );
    expect(call).toBeDefined();
    const result = turn.events.find(
      (event) =>
        event.type === "tool/result" &&
        event.callId === (call as { call: { id: string } }).call.id,
    );
    const transcript = (await expectOkJson(
      await asUser(userId, `/api/bots/${targetBotId}/turns`),
    )) as {
      runs: Array<{
        input: string;
        via?: { kind: string; name: string; botId?: string };
      }>;
    };
    expect(result).toMatchObject({
      type: "tool/result",
      content: answer,
      isError: false,
    });
    expect(transcript.runs).toContainEqual(
      expect.objectContaining({
        input: targetQuestion,
        via: {
          kind: "bot",
          name: "Integration Bot",
          botId: askingBotId,
        },
      }),
    );
  });
});
