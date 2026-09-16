// The `batch` meta-tool against a real Bot Durable Object.
//
// What a person sees when a model batches its replies: several bubbles from
// one inference, in the order the model wrote them, each its own durable
// message. The claims here are the ones no unit test of the loop can make on
// its own, because they are about what the Bot's durable state and the
// client's transcript say afterwards:
//
//  * three sends in one `batch` are one model request and three bubbles, in
//    declared order, with the message identities `<runId>:send:<N>` that
//    unread and delivery name;
//  * two identical sends in one batch stay two bubbles — the sub-occurrence
//    ids are what keeps `send_to_user`'s own dedupe from collapsing them;
//  * one malformed call inside a batch costs only that call;
//  * a batch past the declared cap is refused whole, and the Turn survives it.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";

interface BatchRpc {
  run(command: unknown): Promise<{ runId: string }>;
  readUnread(input: unknown): Promise<{
    count: number;
    unread: boolean;
    lastMessageId?: string;
  }>;
  listNotifications(
    input: unknown,
  ): Promise<Array<{ notificationId: string; body: string }>>;
  lookupRun(input: unknown): Promise<{
    state: string;
    run: {
      status: string;
      events: Array<{
        type: string;
        ordinal?: number;
        payload?: { type: string; text?: string };
        call?: { id: string; name: string };
        content?: string;
        isError?: boolean;
        callId?: string;
      }>;
    };
  }>;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  events: Array<{
    type: string;
    name?: string;
    occurrenceId?: string;
    content?: string;
    isError?: boolean;
    payload?: { type: string; text?: string };
  }>;
}

function bot(identity: { userId: string; botId: string }): BatchRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as BatchRpc;
}

function storedRun(
  identity: { userId: string; botId: string },
  runId: string,
): Promise<StoredRunProbe | undefined> {
  return runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    async (_instance, state) =>
      (await hydratedStoredRunsV1<StoredRunProbe>(state.storage)).find(
        (run) => run.runId === runId,
      ),
  );
}

function send(text: string, disposition: "continue" | "finish"): unknown {
  return {
    tool: "send_to_user",
    arguments: { disposition, payload: { type: "text", text } },
  };
}

async function freshBot(label: string): Promise<{
  userId: string;
  botId: string;
}> {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `batch-${label}-${suffix}`,
    botId: `batch-bot-${label}-${suffix}`,
  };
  await provisionBot(identity);
  return identity;
}

/** One chat Turn whose scripted model step is a single `batch` call. */
async function batchTurn(
  identity: { userId: string; botId: string },
  runId: string,
  calls: unknown[],
): Promise<void> {
  await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt(["batch", { calls }]),
    },
  });
}

function bubbles(run: StoredRunProbe | undefined): string[] {
  return (run?.events ?? [])
    .filter((event) => event.type === "send/to-user")
    .map((event) => event.payload?.text ?? "");
}

describe("a batched reply through a real Bot Durable Object", () => {
  test("three sends in one batch are one inference and three ordered bubbles", async () => {
    const identity = await freshBot("ordered");
    const runId = "batch-ordered-1";
    await batchTurn(identity, runId, [
      send("first", "continue"),
      send("second", "continue"),
      send("third", "finish"),
    ]);

    const stored = await storedRun(identity, runId);
    expect(stored?.status).toBe("completed");
    // One inference bought all three: the Turn made a single model request and
    // wrote a single assistant message.
    expect(
      stored?.events.filter((event) => event.type === "model/request"),
    ).toHaveLength(1);
    expect(
      stored?.events.filter((event) => event.type === "assistant/message"),
    ).toHaveLength(1);
    expect(bubbles(stored)).toEqual(["first", "second", "third"]);
    // Each call is its own occurrence, keyed under the batch's id with a dot.
    const dispatched = (stored?.events ?? []).filter(
      (event) => event.type === "tool/call" && event.name === "send_to_user",
    );
    expect(dispatched.map((event) => event.occurrenceId)).toEqual([
      "tool:1:1:0.0",
      "tool:1:1:0.1",
      "tool:1:1:0.2",
    ]);

    // What the client draws: the three calls rather than the envelope, and
    // three bubbles whose ordinals are their declared positions.
    const lookup = await bot(identity).lookupRun({
      schemaVersion: 1,
      ...identity,
      query: { schemaVersion: 1, runId },
    });
    expect(lookup.state).toBe("terminal");
    const sends = lookup.run.events.filter(
      (event) => event.type === "send/to-user",
    );
    expect(sends.map((event) => [event.ordinal, event.payload?.text])).toEqual([
      [0, "first"],
      [1, "second"],
      [2, "third"],
    ]);
    expect(
      lookup.run.events
        .filter((event) => event.type === "tool/call")
        .map((event) => event.call?.name),
    ).toEqual(["send_to_user", "send_to_user", "send_to_user"]);

    // The durable identity of the last message is its declared position, which
    // is what the unread boundary and delivery name.
    expect(
      await bot(identity).readUnread({ schemaVersion: 1, ...identity }),
    ).toMatchObject({
      unread: true,
      count: 3,
      lastMessageId: `${runId}:send:2`,
    });
    expect(
      (
        await bot(identity).listNotifications({ schemaVersion: 1, ...identity })
      ).map((notice) => notice.body),
    ).toEqual(["first", "second", "third"]);
  });

  test("two identical sends in one batch stay two bubbles", async () => {
    const identity = await freshBot("dedupe");
    const runId = "batch-identical-1";
    await batchTurn(identity, runId, [
      send("same", "continue"),
      send("same", "finish"),
    ]);

    const stored = await storedRun(identity, runId);
    expect(bubbles(stored)).toEqual(["same", "same"]);
    expect(
      await bot(identity).readUnread({ schemaVersion: 1, ...identity }),
    ).toMatchObject({ count: 2, lastMessageId: `${runId}:send:1` });
  });

  test("one malformed call inside a batch costs only that call", async () => {
    const identity = await freshBot("invalid");
    const runId = "batch-invalid-1";
    await batchTurn(identity, runId, [
      send("before", "continue"),
      { tool: "batch", arguments: { calls: [send("nested", "finish")] } },
      send("after", "finish"),
    ]);

    const stored = await storedRun(identity, runId);
    expect(stored?.status).toBe("completed");
    // The other two calls still ran, in declared order.
    expect(bubbles(stored)).toEqual(["before", "after"]);
    const refusals = (stored?.events ?? []).filter(
      (event) => event.type === "tool/result" && event.isError === true,
    );
    expect(refusals).toHaveLength(1);
    expect(refusals[0]?.content).toContain("batch cannot call itself");
    expect(refusals[0]?.occurrenceId).toBe("tool:1:1:0.1");
    // The refused slot keeps a row of its own, so the transcript still shows
    // that the model asked for something that did not run.
    const lookup = await bot(identity).lookupRun({
      schemaVersion: 1,
      ...identity,
      query: { schemaVersion: 1, runId },
    });
    expect(
      lookup.run.events
        .filter((event) => event.type === "tool/call")
        .map((event) => event.call?.name),
    ).toEqual(["send_to_user", "invalid_tool_call", "send_to_user"]);
    expect(
      lookup.run.events
        .filter((event) => event.type === "send/to-user")
        .map((event) => [event.ordinal, event.payload?.text]),
    ).toEqual([
      [0, "before"],
      [1, "after"],
    ]);
  });

  test("a batch past the cap is refused whole and the Turn survives", async () => {
    const identity = await freshBot("cap");
    const runId = "batch-cap-1";
    await batchTurn(
      identity,
      runId,
      Array.from({ length: 26 }, (_index, index) =>
        send(`over-${index}`, "continue"),
      ),
    );

    const stored = await storedRun(identity, runId);
    // The Turn completed rather than failing, and not one of the 26 declared
    // calls ran: the batch is refused whole, never truncated to the cap.
    expect(stored?.status).toBe("completed");
    expect(bubbles(stored).filter((text) => text.startsWith("over-"))).toEqual(
      [],
    );
    // One `batch` occurrence and no sub-occurrence: a batch refused before any
    // call was declared dispatches nothing.
    const calls = (stored?.events ?? []).filter(
      (event) => event.type === "tool/call",
    );
    expect(calls.filter((event) => event.name === "batch")).toHaveLength(1);
    expect(
      calls.filter((event) => event.occurrenceId?.includes(".")),
    ).toHaveLength(0);
    const refusal = (stored?.events ?? []).find(
      (event) => event.type === "tool/result",
    );
    expect(refusal?.isError).toBe(true);
    expect(refusal?.content).toContain("batch carries at most 25 calls");
    expect(refusal?.content).toContain("this one carried 26");
    // And the model could act on the refusal: the Turn still reached the
    // person, rather than dying on the cap.
    expect(bubbles(stored)).not.toEqual([]);
  });
});
