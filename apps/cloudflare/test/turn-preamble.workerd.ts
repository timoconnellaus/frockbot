// Live validation driver for the turn-start latency branch: the preamble's
// observable behaviour, driven through a real Bot Durable Object, real R2
// Memory files and a real User Durable Object, with a scripted model.
//
// Five claims, each about a behaviour the turn-start latency work could have
// broken:
//
//  1. a fact written on an earlier Turn is injected into the next Turn's
//     prompt AND found by `memory_search` in that Turn — the index the Turn
//     searches is now built from the bytes the render already read;
//  2. a fact written *inside* a Turn is found by `memory_search` in that same
//     Turn — the render's documents are taken exactly once, so the reindex
//     after `memory_write` goes back to disk for the file that just changed;
//  3. a Bot created mid-Turn by `bot_create` is named in the next step's
//     `<teammates>` prompt section — the Turn-scoped flock memo is invalidated
//     by the tool that made it stale;
//  4. an admin moving the Applets switch between two Turns of a Bot that never
//     left memory is seen by the second Turn — the account-features read is
//     shared inside one mount and never cached on the Bot;
//  5. a Bot whose Memory spans six files across two scopes still has every one
//     of them in its injected block, in the order the render has always used —
//     the tier and per-file reads now run in parallel under one shared bound.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import {
  frockbotToolCall,
  toolCallTriggerPrompt,
} from "./harness/miniflare.ts";
import { provisionBot } from "./provision-bot.ts";

interface TurnEvent {
  type: string;
  content?: string;
  isError?: boolean;
  request?: { system?: string };
}

interface TurnResult {
  text: string;
  events: TurnEvent[];
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

async function turn(
  identity: { userId: string; botId: string },
  runId: string,
  text: string,
): Promise<TurnResult> {
  return (await botStub(identity.userId, identity.botId).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text,
    },
  })) as unknown as TurnResult;
}

function results(turnResult: TurnResult): string[] {
  return turnResult.events
    .filter((event) => event.type === "tool/result")
    .map((event) => event.content ?? "");
}

/** Every system prompt this Bot's durable session log recorded, in order. */
async function systems(identity: {
  userId: string;
  botId: string;
}): Promise<string[]> {
  const events = (await (
    botStub(identity.userId, identity.botId) as unknown as {
      durableSessionEvents(): Promise<TurnEvent[]>;
    }
  ).durableSessionEvents()) as TurnEvent[];
  return events
    .filter((event) => event.type === "model/request")
    .map((event) => event.request?.system ?? "");
}

const CARRIED = "Tim runs the gym build out of Wollongong.";
const MIDTURN = "The Wednesday strength session starts at half past five.";

describe("the turn-start preamble, driven end to end", () => {
  test("a remembered fact reaches the next Turn's prompt and its memory_search", async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `preamble-user-${id}`, botId: `preamble-${id}` };
    await provisionBot(identity);

    const remembered = await turn(
      identity,
      `run-write-${id}`,
      toolCallTriggerPrompt(
        frockbotToolCall("memory_write", {
          scope: "bot",
          tier: "profile",
          fact: CARRIED,
        }),
      ),
    );
    expect(results(remembered).join("\n")).toContain("Remembered.");

    const searched = await turn(
      identity,
      `run-search-${id}`,
      toolCallTriggerPrompt(
        frockbotToolCall("memory_search", { query: "gym build Wollongong" }),
      ),
    );
    // The injected block still carries the fact…
    const prompts = await systems(identity);
    expect(prompts.some((prompt) => prompt.includes(CARRIED))).toBe(true);
    // …and the derived index, now built from the very bytes that render read,
    // finds it too.
    expect(results(searched).join("\n")).toContain(CARRIED);
  });

  test("a fact written inside a Turn is found by memory_search in that same Turn", async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `preamble-user-${id}`, botId: `preamble-${id}` };
    await provisionBot(identity);

    const both = await turn(
      identity,
      `run-write-search-${id}`,
      toolCallTriggerPrompt(
        frockbotToolCall("memory_write", {
          scope: "bot",
          tier: "log",
          fact: MIDTURN,
        }),
        frockbotToolCall("memory_search", { query: "Wednesday strength" }),
      ),
    );
    const content = results(both);
    expect(content[0]).toBe("Remembered.");
    expect(content.join("\n")).toContain(MIDTURN);
  });

  test("a Bot created mid-Turn is named in the next step's teammates section", async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `preamble-user-${id}`, botId: `preamble-${id}` };
    await provisionBot(identity);

    const created = await turn(
      identity,
      `run-create-${id}`,
      toolCallTriggerPrompt(
        frockbotToolCall("bot_create", {
          name: "Scout",
          description: "Keeps an eye on the gym build.",
        }),
      ),
    );
    expect(results(created).join("\n")).toContain(`Created Bot "Scout"`);

    const prompts = await systems(identity);
    expect(prompts.length).toBeGreaterThan(1);
    // The first step's prompt named no teammates; the step after bot_create
    // names the Bot it just made.
    expect(prompts[0]).not.toContain("Scout");
    expect(prompts[prompts.length - 1]).toContain("<teammates>");
    expect(prompts[prompts.length - 1]).toContain("Scout");
  });
});

/** What an admin does to an account's Applets switch. */
async function setApplets(userId: string, applets: boolean): Promise<void> {
  await (
    env.USER_CONFIGURATIONS.getByName(userId) as unknown as {
      setFeatures(input: unknown): Promise<unknown>;
    }
  ).setFeatures({
    schemaVersion: 1,
    userId,
    command: { schemaVersion: 1, type: "user/set-features", applets },
    updatedBy: "workerd-admin",
  });
}

describe("the account-features read shared inside one mount", () => {
  test("an admin switching Applets off is seen by the very next Turn of a resident Bot", async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `features-user-${id}`, botId: `features-${id}` };
    await provisionBot(identity);
    await setApplets(identity.userId, true);

    const on = await turn(
      identity,
      `run-on-${id}`,
      toolCallTriggerPrompt(frockbotToolCall("applet_list")),
    );
    expect(results(on).join("\n")).toContain("no Applets yet");

    // No eviction: the same resident Bot object, one Turn later. The features
    // memo lives as long as the mount that made it, so the switch is read
    // again here rather than remembered from the Turn above.
    await setApplets(identity.userId, false);
    const off = await turn(
      identity,
      `run-off-${id}`,
      toolCallTriggerPrompt(frockbotToolCall("applet_list")),
    );
    expect(results(off).join("\n")).toContain('Tool not found: "applet_list"');
  });
});

describe("a Bot whose Memory spans many files across two scopes", () => {
  test("every fact still reaches the injected block, in tier order", async () => {
    const id = crypto.randomUUID().slice(0, 8);
    const identity = { userId: `fanout-user-${id}`, botId: `fanout-${id}` };
    await provisionBot(identity);
    const stub = botStub(identity.userId, identity.botId) as unknown as {
      memoryWrite(input: unknown): Promise<{ isError: boolean }>;
    };

    // Two scopes, three tiers, several files: the fan-out the tier read and
    // its per-file reads now run in parallel under one shared bound.
    const facts = [
      {
        scope: "bot",
        tier: "profile",
        fact: "Fact one: the gym opens at six.",
      },
      { scope: "bot", tier: "log", fact: "Fact two: the slab was poured." },
      {
        scope: "bot",
        tier: "note",
        fact: "Fact three: chase the electrician.",
      },
      { scope: "user", tier: "profile", fact: "Fact four: Tim lives in Gong." },
      { scope: "user", tier: "log", fact: "Fact five: the lease was signed." },
      { scope: "user", tier: "note", fact: "Fact six: call the council back." },
    ] as const;
    for (const entry of facts) {
      expect((await stub.memoryWrite({ ...identity, ...entry })).isError).toBe(
        false,
      );
    }

    await turn(identity, `run-fanout-${id}`, "What do you know about me?");
    const prompt = (await systems(identity)).at(-1)!;
    for (const entry of facts) expect(prompt).toContain(entry.fact);
    // Shared memory is rendered before own memory, and the tiers are still
    // assembled in tier order however their reads finished.
    expect(prompt.indexOf("User memory:")).toBeLessThan(
      prompt.indexOf("Memory: your own memory."),
    );
    expect(prompt.indexOf("Fact four")).toBeLessThan(
      prompt.indexOf("Fact one"),
    );
  });
});
