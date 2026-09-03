// The dev Worker died twice in one evening on a `BotNotFoundError` thrown out
// of the Bot Durable Object's own `fetch` during a state-channel upgrade —
// wrangler reported "ProxyController: Network connection lost" straight after.
// A Durable Object's `fetch` is an entry point: nothing inside the object is
// left to catch a throw there.
//
// So every one of these asserts two things: the answer a client gets, and that
// the Worker is still there to answer the next request.
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectJson,
  freshUserId,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const ABSENT = "no-such-bot";

describe("a Bot that is not there", () => {
  it("refuses a state-channel upgrade with 404 JSON, and the Worker survives", async () => {
    const userId = freshUserId("absent-channel");

    const refused = await asUser(userId, `/api/bots/${ABSENT}/state-channel`, {
      headers: { upgrade: "websocket" },
    });

    expect(refused.status).toBe(404);
    expect(await expectJson(refused)).toMatchObject({
      error: expect.any(String),
    });

    const next = await asUser(userId, "/");
    expect(next.status).toBe(200);
  });

  it("refuses a Turn with 404 JSON, and the Worker survives", async () => {
    const userId = freshUserId("absent-turn");

    const refused = await asUser(userId, `/api/bots/${ABSENT}/turns`, {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        text: "hello",
      }),
    });

    expect(refused.status).toBe(404);
    expect(await expectJson(refused)).toMatchObject({
      error: expect.any(String),
    });

    const next = await asUser(userId, "/");
    expect(next.status).toBe(200);
  });

  it("still answers after both refusals in the same isolate", async () => {
    const userId = freshUserId("absent-both");

    await asUser(userId, `/api/bots/${ABSENT}/state-channel`, {
      headers: { upgrade: "websocket" },
    });
    await asUser(userId, `/api/bots/${ABSENT}/turns`, {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        text: "hello",
      }),
    });

    const runs = await asUser(userId, "/api/bots");
    expect(runs.headers.get("content-type")).toContain("application/json");
    expect(runs.status).toBeLessThan(500);
  });
});
