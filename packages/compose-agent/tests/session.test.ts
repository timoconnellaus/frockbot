import { describe, expect, it } from "bun:test";
import { deriveMessages, sessionAppendedEvent, sessionKey } from "../src";
import { buildAgent, kindsOf } from "./helpers/agent";
import { lookupTool } from "./helpers/other-package";
import type { SessionEntry } from "../src";

const script = [
  {
    chunks: ["Look", "ing"],
    toolCalls: [{ name: "lookup", args: { query: "cats" } }],
  },
  { chunks: ["Found 4."] },
];

const conversation = async () => {
  const built = await buildAgent({ script, tools: [lookupTool] });
  built.agent.send("find cats");
  await built.agent.idle();
  return built;
};

describe("B. Session is the source of truth", () => {
  it("every model-visible fact is appended to the log as it happens", async () => {
    const { client, session } = await conversation();

    expect(kindsOf(session.snapshot())).toEqual([
      "turn-opened",
      "input",
      "step-opened",
      "chunk",
      "chunk",
      "assistant",
      "tool-call",
      "tool-result",
      "step-closed",
      "step-opened",
      "chunk",
      "assistant",
      "step-closed",
      "turn-closed",
    ]);

    // The streamed chunks are in the log, and so is the complete message.
    const chunks = session
      .snapshot()
      .filter((entry) => entry.kind === "chunk")
      .map((entry) => entry.text);
    expect(chunks).toEqual(["Look", "ing", "Found 4."]);

    const assistant = session
      .snapshot()
      .filter((entry) => entry.kind === "assistant");
    expect(assistant[0]).toMatchObject({
      text: "Looking",
      toolCalls: [{ id: "call-1", name: "lookup", args: { query: "cats" } }],
    });

    // Every entry has its own identity and belongs to a turn.
    const ids = session.snapshot().map((entry) => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(session.snapshot().every((entry) => entry.turn === 1)).toBe(true);

    await client.destroy();
  });

  it("messages are derived from the log and deriving twice gives the same messages", async () => {
    const { client, session } = await conversation();

    const first = session.messages();
    const second = session.messages();
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(deriveMessages(session.snapshot())).toEqual(first);

    expect(first).toEqual([
      { role: "user", content: "find cats" },
      {
        role: "assistant",
        content: "Looking",
        toolCalls: [{ id: "call-1", name: "lookup", args: { query: "cats" } }],
      },
      {
        role: "tool",
        callId: "call-1",
        name: "lookup",
        content: '{"found":4}',
        isError: false,
      },
      { role: "assistant", content: "Found 4.", toolCalls: [] },
    ]);

    await client.destroy();
  });

  it("a log replayed into a fresh client derives the same messages, and forks at a step boundary", async () => {
    const original = await conversation();
    const entries = original.session.snapshot();
    const messages = original.session.messages();
    await original.client.destroy();

    const replayed = await buildAgent({ entries });
    expect(replayed.session.messages()).toEqual(messages);
    expect(replayed.session.snapshot()).toEqual(entries);
    await replayed.client.destroy();

    // Forking at the first step boundary drops everything after it.
    const boundary = entries.find((entry) => entry.kind === "step-closed")!;
    const forked = original.session.fork(boundary.id);
    expect(kindsOf(forked)).toEqual([
      "turn-opened",
      "input",
      "step-opened",
      "chunk",
      "chunk",
      "assistant",
      "tool-call",
      "tool-result",
      "step-closed",
    ]);

    const branch = await buildAgent({
      entries: forked,
      script: [{ chunks: ["A different ending."] }],
    });
    expect(branch.session.messages()).toEqual(messages.slice(0, 3));
    branch.agent.send("carry on");
    await branch.agent.idle();
    // The fork continues the turn numbering rather than restarting it.
    expect(branch.session.snapshot().at(-1)).toMatchObject({
      kind: "turn-closed",
      turn: 2,
    });
    await branch.client.destroy();

    // Anything that is not a step or turn boundary is refused.
    const midStep = entries.find((entry) => entry.kind === "assistant")!;
    expect(() => original.session.fork(midStep.id)).toThrow(
      /not a step or turn boundary/,
    );
    expect(() => original.session.fork("nope")).toThrow(/no session entry/);
  });

  it("appends are observable as events and through the entries store", async () => {
    const { client, agent, session } = await buildAgent({
      script,
      tools: [lookupTool],
    });

    // A follower subscribes to the event and never imports the loop.
    const observed: Array<string> = [];
    const stop = client.on(sessionAppendedEvent, (entry: SessionEntry) => {
      // The payload is a discriminated union; listeners narrow on `kind`.
      if (entry.kind === "input") observed.push(`input:${entry.text}`);
      else if (entry.kind === "assistant") observed.push(`say:${entry.text}`);
      else if (entry.kind === "tool-result") observed.push(`ran:${entry.name}`);
    });

    let published = 0;
    const subscription = session.entries.subscribe(() => {
      published += 1;
    });

    agent.send("find cats");
    await agent.idle();
    stop();
    subscription.unsubscribe();

    expect(observed).toEqual([
      "input:find cats",
      "say:Looking",
      "ran:lookup",
      "say:Found 4.",
    ]);
    // Every append is published to the store as well as the event.
    expect(published).toBe(session.snapshot().length);

    // A follower reads the session through its key alone.
    expect(client.getContext(sessionKey)).toBe(session);

    await client.destroy();
  });
});
