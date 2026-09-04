// Compaction against a real Bot Durable Object (ADR 0030).
//
// The claims a Bun double cannot make, because all three are claims about the
// deployed object:
//
//  1. A conversation that grows past the trigger compacts **itself**, at Turn
//     end, on the Bot's own model binding — no test seam, no injected
//     summariser, the ordinary `agent/turn-stopping` path in the shipped
//     Composition.
//  2. The summary is a **durable event**, not a per-request recomputation:
//     `conversation/compacted` sits on the log with the range it covers, and
//     the next Turn's `model/request` carries it as its first message with the
//     covered Turns gone. That is the whole difference from the design this
//     replaces, which recomputed the same summary on every Turn and stored
//     none of them.
//  3. It is **idempotent by range**: the Turns after it do not write a second
//     summary of the same prefix.
//
// Tool-output pruning is exercised where it can be asserted exactly — through
// the same `turnScopedMessagesV1` this object calls, in
// `packages/plugin-shell/src/compaction.test.ts`. Nothing this Worker can
// reach produces a tool result large enough for the prune floor.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

/** Roughly a tenth of the 150k budget per Turn, so a dozen Turns overflow it. */
const TURN_CHARS = 13_000;

function say(index: number): string {
  return `Turn ${index} says: ${"detail ".repeat(TURN_CHARS / 7)}`;
}

describe("conversation compaction in Workerd", () => {
  test("a long conversation summarises its own beginning, once, and carries the summary into the next request", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      schemaVersion: 1 as const,
      userId: `compaction-user-${suffix}`,
      botId: `compaction-bot-${suffix}`,
    };
    await provisionBot(identity);
    const name = `${identity.userId}:${identity.botId}`;
    const stub = bot(name);

    async function turn(index: number): Promise<void> {
      const result = await stub.run({
        ...identity,
        command: {
          runId: `run-${index}`,
          sessionId: name,
          acceptedAt: new Date(1_800_000_000_000 + index * 1_000).toISOString(),
          text: say(index),
        },
      });
      expect(result.text).toBe("Ollama reply");
    }

    // Eleven Turns is comfortably past 70% of the 150k character budget, and
    // leaves more than the four Turns compaction always keeps verbatim.
    for (let index = 1; index <= 11; index += 1) await turn(index);

    const events = await stub.durableSessionEvents();
    const intents = events.filter(
      (event) => event.type === "conversation/compaction-intent",
    );
    const compactions = events.filter(
      (event) => event.type === "conversation/compacted",
    );
    expect(events).not.toContainEqual(
      expect.objectContaining({ type: "conversation/compaction-failed" }),
    );
    // Intent before the effect, and exactly one of each: the range is the
    // idempotency key, so the Turns after the first compaction write nothing.
    expect(intents).toHaveLength(1);
    expect(compactions).toHaveLength(1);
    const compacted = compactions[0];
    if (compacted?.type !== "conversation/compacted") {
      throw new Error("unreachable");
    }
    expect(compacted.fromTurn).toBe(1);
    // The newest four Turns are never covered.
    expect(compacted.throughTurn).toBeLessThanOrEqual(7);
    expect(compacted.throughTurn).toBeGreaterThan(0);
    expect(compacted.summary.length).toBeGreaterThan(0);
    expect(compacted.provider).toBe("ollama-cloud");
    expect(
      intents[0]!.type === "conversation/compaction-intent" &&
        intents[0]!.effectId,
    ).toBe(compacted.effectId);
    expect(intents[0]!.seq).toBeLessThan(compacted.seq);

    // THE NEXT REQUEST. The summary is the first message, and every Turn it
    // covers is gone from the window — replayed from the log, not recomputed.
    const before = events.length;
    await turn(12);
    const after = await stub.durableSessionEvents();
    const request = after
      .slice(before)
      .findLast((event) => event.type === "model/request");
    if (request?.type !== "model/request") throw new Error("unreachable");
    const [first, ...rest] = request.request.messages;
    expect(first?.role).toBe("user");
    expect(first?.content).toContain(
      `Turns 1 to ${compacted.throughTurn} of this conversation`,
    );
    expect(first?.content).toContain(compacted.summary);
    for (let index = 1; index <= compacted.throughTurn; index += 1) {
      expect(first?.content).not.toContain(`Turn ${index} says:`);
      for (const message of rest) {
        expect(message.content).not.toContain(`Turn ${index} says:`);
      }
    }
    // …and the Turns after it are still there, verbatim.
    expect(
      rest.some((message) =>
        message.content.startsWith(`Turn ${compacted.throughTurn + 1} says:`),
      ),
    ).toBe(true);
    expect(rest.at(-1)?.content).toContain("Turn 12 says:");

    // Still exactly one summary of that prefix after another Turn.
    expect(
      after.filter((event) => event.type === "conversation/compacted"),
    ).toHaveLength(1);

    // And the transcript says so, once, without putting the summary on the wire.
    const page = await stub.listRuns({
      ...identity,
      query: { schemaVersion: 1 },
    });
    const announcements = (page as { announcements?: unknown[] }).announcements;
    expect(announcements).toContainEqual(
      expect.objectContaining({
        type: "conversation/compacted",
        throughTurn: compacted.throughTurn,
      }),
    );
    expect(JSON.stringify(announcements)).not.toContain(compacted.summary);
  });
});
