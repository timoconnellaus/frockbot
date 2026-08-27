import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "cordis";
import { SessionStore } from "./session.js";
import type { NormalizedModelRequest } from "./types.js";

const roots: Context[] = [];

async function createStore(): Promise<Context> {
  const root = new Context();
  roots.push(root);
  await root.plugin(SessionStore);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("SessionStore", () => {
  test("records exact requests and derives model messages", async () => {
    const root = await createStore();
    const session = root.sessions.create("session-1");
    const request: NormalizedModelRequest = {
      requestId: "request-1",
      provider: "scripted",
      model: "test",
      system: "Be concise.",
      messages: [{ role: "user", content: "Hello" }],
      tools: [],
    };

    session.appendBatch([
      { type: "turn/start", turn: 1 },
      { type: "input/admitted", messageId: "message-1", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "user/message",
        turn: 1,
        step: 1,
        messageId: "message-1",
        text: "Hello",
      },
      { type: "model/request", turn: 1, step: 1, request },
      {
        type: "assistant/message",
        turn: 1,
        step: 1,
        requestId: "request-1",
        text: "Hi",
        toolCalls: [],
      },
      { type: "step/end", turn: 1, step: 1, outcome: "completed" },
      { type: "turn/end", turn: 1, outcome: "completed" },
    ]);

    const recorded = session.events.find(
      (event) => event.type === "model/request",
    );
    expect(
      recorded?.type === "model/request" ? recorded.request : undefined,
    ).toEqual(request);
    expect(session.deriveMessages()).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Hi", toolCalls: [] },
    ]);
    expect(session.events.map((event) => event.seq)).toEqual(
      session.events.map((_, index) => index),
    );
  });

  test("reconciles unmatched tools, steps, and turns in order", async () => {
    const root = await createStore();
    const session = root.sessions.create("session-2");
    session.appendBatch([
      { type: "turn/start", turn: 1 },
      { type: "input/admitted", messageId: "message-1", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      {
        type: "tool/call",
        turn: 1,
        step: 1,
        call: { id: "call-1", name: "write", input: { value: "x" } },
      },
    ]);

    const repaired = session.reconcileInterrupted();
    expect(repaired.map((event) => event.type)).toEqual([
      "tool/result",
      "step/end",
      "turn/end",
    ]);
    expect(
      repaired.find((event) => event.type === "tool/result"),
    ).toMatchObject({ status: "interrupted", isError: true });
    expect(session.reconcileInterrupted()).toEqual([]);
  });

  test("disposes all live sessions with its Cordis fiber", async () => {
    const root = await createStore();
    const session = root.sessions.create("session-3");
    await root.fiber.dispose();
    roots.splice(roots.indexOf(root), 1);

    expect(session.disposed).toBe(true);
    expect(session.events.at(-1)?.type).toBe("session/disposed");
  });
});
