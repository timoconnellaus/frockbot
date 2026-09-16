// A batched reply across the whole gateway: the door a browser knocks on
// (`POST /api/bots/:bot/turns`), the loaded application artifact, the Bot
// Durable Object, and the transcript the client reads back
// (`GET /api/bots/:bot/turns/:run`).
//
// The claim is the one the feature exists for: a model that already knows
// every part of its reply spends one inference on all of them, and the person
// still reads them as separate messages, in the order the model wrote them.
import { describe, expect, it } from "vitest";
import {
  expectOkJson,
  freshUserId,
  asUser,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface RunLookup {
  state: string;
  run: {
    status: string;
    events: Array<{
      type: string;
      ordinal?: number;
      payload?: { text?: string };
      call?: { name: string };
    }>;
  };
}

function send(text: string, disposition: "continue" | "finish"): unknown {
  return {
    tool: "send_to_user",
    arguments: { disposition, payload: { type: "text", text } },
  };
}

describe("a batched reply through the gateway", () => {
  it("delivers one bubble per call, in declared order, from one inference", async () => {
    const userId = freshUserId("batch");
    const botId = "batch-bot";
    await provisionThroughGateway({ userId, botId });

    const response = await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "batch-turn-1",
      text: toolCallTriggerPrompt([
        "batch",
        {
          calls: [
            send("On it.", "continue"),
            send("Here is the middle part.", "continue"),
            send("And that is the last of it.", "finish"),
          ],
        },
      ]),
    });
    expect(response.status).toBe(200);

    const stored = await readStoredRunWithEventsV1<{
      events: Array<{ type: string }>;
    }>(userId, botId, "batch-turn-1");
    // One model request bought all three sends.
    expect(
      (stored?.events ?? []).filter((event) => event.type === "model/request"),
    ).toHaveLength(1);

    const lookup = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns/batch-turn-1`),
    )) as RunLookup;
    expect(lookup.run.status).toBe("completed");
    expect(
      lookup.run.events
        .filter((event) => event.type === "send/to-user")
        .map((event) => [event.ordinal, event.payload?.text]),
    ).toEqual([
      [0, "On it."],
      [1, "Here is the middle part."],
      [2, "And that is the last of it."],
    ]);
    // The transcript draws the calls the model made, not the envelope.
    expect(
      lookup.run.events
        .filter((event) => event.type === "tool/call")
        .map((event) => event.call?.name),
    ).toEqual(["send_to_user", "send_to_user", "send_to_user"]);
  });
});
