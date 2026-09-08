import { describe, expect, test } from "bun:test";
import type { WebChatMessage } from "../shared.js";
import {
  TRANSCRIPT_CACHE_LIMIT,
  TranscriptCache,
  TRANSCRIPT_FRESH_MS,
} from "./transcript-cache.js";

function message(runId: string, text = "hello"): WebChatMessage {
  return {
    id: `${runId}:user`,
    runId,
    role: "user",
    text,
    status: "completed",
    tools: [],
    sends: [],
  };
}

function snapshot(runId = "run-1") {
  return { messages: [message(runId)] };
}

describe("TranscriptCache", () => {
  test("gives a saved conversation back without a read", () => {
    const cache = new TranscriptCache();
    cache.save("alpha", snapshot());
    const restored = cache.take("alpha");
    expect(restored?.messages.map((entry) => entry.runId)).toEqual(["run-1"]);
    expect(restored?.stale).toBe(false);
  });

  test("hands back copies, so the caller's edits never reach the cache", () => {
    const cache = new TranscriptCache();
    cache.save("alpha", snapshot());
    const restored = cache.take("alpha");
    restored?.messages.push(message("run-2"));
    const [first] = restored?.messages ?? [];
    if (first) first.text = "rewritten";
    expect(cache.take("alpha")?.messages).toEqual([message("run-1")]);
  });

  test("another Bot cannot restore this Bot's transcript", () => {
    const cache = new TranscriptCache();
    cache.save("alpha", snapshot());
    expect(cache.take("beta")).toBeUndefined();
    expect(cache.take("alpha")?.messages).toEqual([message("run-1")]);
  });

  test("keeps the last N Bots and evicts the least recently used", () => {
    const cache = new TranscriptCache();
    for (let index = 0; index < TRANSCRIPT_CACHE_LIMIT + 2; index += 1) {
      cache.save(`bot-${index}`, snapshot(`run-${index}`));
    }
    expect(cache.size).toBe(TRANSCRIPT_CACHE_LIMIT);
    expect(cache.take("bot-0")).toBeUndefined();
    expect(cache.take("bot-1")).toBeUndefined();
    expect(cache.take("bot-2")).toBeDefined();
  });

  test("reading a transcript makes it the last one evicted", () => {
    const cache = new TranscriptCache({ limit: 2 });
    cache.save("alpha", snapshot("a"));
    cache.save("beta", snapshot("b"));
    // Alpha is the oldest write but the newest use.
    expect(cache.take("alpha")).toBeDefined();
    cache.save("gamma", snapshot("c"));
    expect(cache.take("beta")).toBeUndefined();
    expect(cache.take("alpha")).toBeDefined();
  });

  test("an empty transcript is not held", () => {
    const cache = new TranscriptCache();
    cache.save("alpha", snapshot());
    cache.save("alpha", { messages: [] });
    expect(cache.size).toBe(0);
  });

  test("a channel notice leaves the transcript drawable but owes a read", () => {
    const cache = new TranscriptCache();
    cache.save("alpha", snapshot());
    cache.markStale("alpha");
    const restored = cache.take("alpha");
    expect(restored?.messages).toHaveLength(1);
    expect(restored?.stale).toBe(true);
  });

  test("a transcript past its freshness window owes a read", () => {
    let clock = 1_000;
    const cache = new TranscriptCache({ now: () => clock });
    cache.save("alpha", snapshot());
    clock += TRANSCRIPT_FRESH_MS + 1;
    expect(cache.take("alpha")?.stale).toBe(true);
  });

  test("forget drops one Bot, or every Bot", () => {
    const cache = new TranscriptCache();
    cache.save("alpha", snapshot("a"));
    cache.save("beta", snapshot("b"));
    cache.forget("alpha");
    expect(cache.take("alpha")).toBeUndefined();
    expect(cache.take("beta")).toBeDefined();
    // Signing out is not "some conversations are stale", it is "none of these
    // are this User's".
    cache.forget();
    expect(cache.size).toBe(0);
  });

  test("remembers where the reader had the thread", () => {
    const cache = new TranscriptCache();
    cache.save("alpha", snapshot());
    cache.rememberViewport("alpha", { scrollTop: 420, pinnedToLatest: false });
    expect(cache.take("alpha")?.viewport).toEqual({
      scrollTop: 420,
      pinnedToLatest: false,
    });
    // A viewport for a Bot that is not held is dropped rather than resurrecting it.
    cache.rememberViewport("ghost", { scrollTop: 1, pinnedToLatest: true });
    expect(cache.take("ghost")).toBeUndefined();
  });
});
