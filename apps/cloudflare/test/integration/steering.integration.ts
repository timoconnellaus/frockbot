// Steering end to end: a message the person sends while the Bot is working
// waits, the running Turn ends at its next step boundary once its tools have
// settled, and the message runs next with that work — and a note that it was
// unfinished — in its context.
import { describe, expect, it } from "vitest";
import { frockbotToolCallPrompt } from "../harness/miniflare.ts";
import {
  asUser,
  expectJson,
  freshUserId,
  provisionThroughGateway,
  readStoredRunEventsV1,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

async function send(
  userId: string,
  botId: string,
  commandId: string,
  text: string,
): Promise<{ runId: string }> {
  const response = await asUser(userId, `/api/bots/${botId}/turns`, {
    method: "POST",
    body: JSON.stringify({ schemaVersion: 1, commandId, text }),
  });
  expect(response.status).toBe(202);
  return (await expectJson(response)) as { runId: string };
}

async function lookup(
  userId: string,
  botId: string,
  runId: string,
): Promise<{ state?: string; run?: { status: string; queued?: boolean } }> {
  return (await expectJson(
    await asUser(userId, `/api/bots/${botId}/turns/${runId}`),
  )) as { state?: string; run?: { status: string; queued?: boolean } };
}

async function terminal(
  userId: string,
  botId: string,
  runId: string,
): Promise<{ status: string }> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const body = await lookup(userId, botId, runId);
    if (body.state === "terminal" && body.run) return body.run;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`turn ${runId} did not settle`);
}

describe("a message sent while the Bot is working", () => {
  it("steers: the running Turn yields after its tool, and the message runs with its work", async () => {
    const userId = freshUserId("steering");
    const botId = "steered";
    await provisionThroughGateway({ userId, botId });

    const first = await send(
      userId,
      botId,
      "look-it-up",
      frockbotToolCallPrompt("web_fetch", {
        url: "https://example.test/slow?ms=2500",
      }),
    );
    // Inside the fetch, the person says something else.
    await new Promise((resolve) => setTimeout(resolve, 600));
    const second = await send(userId, botId, "change-of-plan", "also check B");
    expect((await lookup(userId, botId, second.runId)).run).toMatchObject({
      status: "running",
      queued: true,
    });

    expect(await terminal(userId, botId, first.runId)).toMatchObject({
      status: "completed",
    });
    expect(await terminal(userId, botId, second.runId)).toMatchObject({
      status: "completed",
    });

    // The fetch finished and its result is durable; the Turn did not go back
    // to the model, because the person had spoken.
    const firstEvents = await readStoredRunEventsV1(userId, botId, first.runId);
    expect(
      firstEvents.filter((event) => event.type === "tool/result"),
    ).toHaveLength(1);
    expect(
      firstEvents.filter((event) => event.type === "model/request"),
    ).toHaveLength(1);

    // The next Turn reads the message, told the earlier work is unfinished,
    // with that work — the fetched page — in the request it sends.
    const secondEvents = await readStoredRunEventsV1(
      userId,
      botId,
      second.runId,
    );
    const input = secondEvents.find((event) => event.type === "user/message");
    expect(String(input?.text)).toContain("[Steering]");
    expect(String(input?.text)).toContain("also check B");
    const request = secondEvents.find(
      (event) => event.type === "model/request",
    ) as { request: { messages: unknown[] } } | undefined;
    expect(JSON.stringify(request?.request.messages)).toContain("slow body");
  });
});
