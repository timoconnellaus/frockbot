// Incident: a ~111 KB message answered 400 without the body ever being read.
// workerd threw "Can't read from request stream after response has been sent"
// and took the whole process down — twice in one evening. The size refusal is
// the one path guaranteed never to read the body, so it is the one path that
// must drain it.
//
// What this suite pins is therefore two things at once: the answer a person
// sees, and that the Worker is still there to answer the next request.
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectJson,
  freshUserId,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

/** Comfortably past the wire limit, and the size of the message that broke it. */
const OVERSIZED_TEXT = "a".repeat(111_000);

describe("an oversized send is refused without taking the Worker down", () => {
  it("answers 413 with a message the composer can show, and still serves the next request", async () => {
    const userId = freshUserId("oversized");

    const refused = await asUser(userId, "/api/bots/oversized-bot/turns", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        text: OVERSIZED_TEXT,
      }),
    });

    expect(refused.status).toBe(413);
    expect(await expectJson(refused)).toMatchObject({
      error: expect.stringContaining("Your message is too long"),
    });

    // The point of the whole suite: the isolate survived. Before the drain,
    // workerd exited here and this request never got an answer at all.
    const next = await asUser(userId, "/");
    expect(next.status).toBe(200);
  });

  // The size refusal is the loudest early return, not the only one. Any POST
  // answered before its body is read is the same hazard, so the drain sits on
  // the outermost wrapper of both Workers rather than on the one route that
  // reported the incident.
  it("survives a large POST that is refused for some other reason entirely", async () => {
    const userId = freshUserId("early-return");

    const refused = await asUser(
      userId,
      "/api/bots/absent-bot/does-not-exist",
      {
        method: "POST",
        body: JSON.stringify({ text: "c".repeat(50_000) }),
      },
    );

    expect(refused.status).toBe(404);
    expect(await expectJson(refused)).toMatchObject({
      error: expect.any(String),
    });

    const next = await asUser(userId, "/");
    expect(next.status).toBe(200);
  });

  it("still admits a message inside the limit", async () => {
    const userId = freshUserId("sized");

    // No Bot is registered, so this stops at the registration check rather
    // than starting a Turn. What matters is that it got past the size guard.
    const answered = await asUser(userId, "/api/bots/sized-bot/turns", {
      method: "POST",
      body: JSON.stringify({
        schemaVersion: 1,
        commandId: crypto.randomUUID(),
        text: "hello",
      }),
    });

    expect(answered.status).not.toBe(413);
    expect(answered.headers.get("content-type")).toContain("application/json");
  });
});
