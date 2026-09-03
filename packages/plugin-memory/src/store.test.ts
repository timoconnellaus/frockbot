// The Memory Package's writer and reader, against the production
// object-storage store over an in-memory bucket and generation ledger.
import { describe, expect, test } from "bun:test";
import type {
  WorkspaceFilesV1,
  WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import { renderInjectedFactLineV1 } from "./facts.ts";
import {
  botMemoryRootV1,
  projectMemoryRootV1,
  userMemoryRootV1,
} from "./roots.ts";
import { MemoryStore, MEMORY_MAX_FILES_PER_TIER } from "./store.ts";
import { createTestMemoryFilesV1 } from "./testing.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
const AT = new Date("2026-08-31T10:00:00.000Z");

function writerFor(botId: string): WorkspaceWriterV1 {
  return {
    kind: "bot",
    botId,
    sessionId: `user-1:${botId}`,
    turnId: "turn-1",
    runId: "run-1",
  };
}

function storeFor(
  botId: string,
  files = createTestMemoryFilesV1({ userId: "user-1" }),
) {
  return {
    files,
    store: new MemoryStore({
      files,
      owner: { userId: "user-1", botId },
      botNames: { "bot-1": "General", "bot-2": "School" },
      clock: () => AT,
    }),
  };
}

describe("the Memory writer", () => {
  test("writes a Bot fact to profile.md and a log fact to log/YYYY-MM.md", async () => {
    const { store } = storeFor("bot-1");
    const root = botMemoryRootV1(OWNER);

    const profile = await store.write({
      root,
      tier: "profile",
      fact: "Tim lives in Wollongong.",
      writer: writerFor("bot-1"),
    });
    const log = await store.write({
      root,
      tier: "log",
      fact: "Term ends on the 12th.",
      writer: writerFor("bot-1"),
    });

    expect(profile).toMatchObject({ status: "ok", path: "profile.md" });
    expect(log).toMatchObject({ status: "ok", path: "log/2026-08.md" });

    const tier = await store.read(root);
    expect(tier.profile.map((fact) => fact.text)).toEqual([
      "Tim lives in Wollongong.",
    ]);
    expect(tier.recent.map((fact) => fact.text)).toEqual([
      "Term ends on the 12th.",
    ]);
    expect(tier.profile[0]?.date).toBe("2026-08-31");
  });

  test("writes a shared fact into the writing Bot's own shard only", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const { store } = storeFor("bot-1", files);
    const root = userMemoryRootV1(OWNER);

    const written = await store.write({
      root,
      tier: "profile",
      fact: "Tim prefers blunt answers.",
      writer: writerFor("bot-1"),
    });
    expect(written).toMatchObject({
      status: "ok",
      path: "by-agent/bot-1/profile.md",
    });

    // Another Bot's shard is refused, whatever this Bot asks for.
    const foreign = await new MemoryStore({
      files,
      owner: { userId: "user-1", botId: "bot-1" },
      clock: () => AT,
    }).writeFile({
      path: { root, path: "by-agent/bot-2/profile.md" },
      text: "- (2026-08-31) Forged.\n",
      writer: writerFor("bot-1"),
    });
    expect(foreign.status).toBe("refused");
  });

  test("merges shards and tags every shared fact with the Bot that learned it", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const root = userMemoryRootV1(OWNER);
    const one = storeFor("bot-1", files);
    const two = storeFor("bot-2", files);
    await one.store.write({
      root,
      tier: "profile",
      fact: "Tim lives in Wollongong.",
      writer: writerFor("bot-1"),
    });
    await two.store.write({
      root,
      tier: "profile",
      fact: "Tim teaches on Tuesdays.",
      writer: writerFor("bot-2"),
    });

    const tier = await one.store.read(root);
    expect(
      tier.profile.map((fact) => `${fact.via}: ${fact.text}`).sort(),
    ).toEqual([
      "General: Tim lives in Wollongong.",
      "School: Tim teaches on Tuesdays.",
    ]);
  });

  // A Bot id is a handle, not a name. Rendered as `[via remy-9d15e086]` the
  // model reads it as a name and tells the User a sibling's id.
  test("credits nobody rather than a Bot id when no name is known", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const nameless = new MemoryStore({
      files,
      owner: { userId: "user-1", botId: "bot-9" },
      clock: () => AT,
    });
    const root = userMemoryRootV1(OWNER);
    await nameless.write({
      root,
      tier: "profile",
      fact: "Tim stops drinking coffee at 2pm.",
      writer: writerFor("bot-9"),
    });

    const tier = await nameless.read(root);

    expect(tier.profile).toHaveLength(1);
    expect(tier.profile[0]?.via).toBeUndefined();
    expect(tier.profile[0]?.botId).toBe("bot-9");
    expect(renderInjectedFactLineV1(tier.profile[0]!, 200)).not.toContain(
      "bot-9",
    );
  });

  test("dedupes a fact that is already recorded, without writing", async () => {
    const { store } = storeFor("bot-1");
    const root = botMemoryRootV1(OWNER);
    const first = await store.write({
      root,
      tier: "profile",
      fact: "Tim lives in Wollongong.",
      writer: writerFor("bot-1"),
    });
    const again = await store.write({
      root,
      tier: "profile",
      fact: "tim lives in wollongong.",
      writer: writerFor("bot-1"),
    });
    expect(first).toMatchObject({ status: "ok", duplicate: false });
    expect(again).toMatchObject({ status: "ok", duplicate: true });
    expect((await store.read(root)).profile).toHaveLength(1);
  });

  test("refuses a fact that looks like a credential", async () => {
    const { store } = storeFor("bot-1");
    for (const fact of [
      "The API key is sk-abcdefghijklmnopqrstuvwx.",
      "Use Bearer eyJhbGciOiJIUzI1NiJ9.aaaaaaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbbbbbb",
      "-----BEGIN RSA PRIVATE KEY-----",
      "password = hunter2hunter2hunter2",
    ]) {
      const outcome = await store.write({
        root: botMemoryRootV1(OWNER),
        tier: "log",
        fact,
        writer: writerFor("bot-1"),
      });
      expect(outcome.status).toBe("refused");
      expect(outcome.status === "refused" ? outcome.reason : "").toContain(
        "no secrets",
      );
    }
    expect((await store.read(botMemoryRootV1(OWNER))).recent).toHaveLength(0);
  });
});

describe("forgetting", () => {
  test("removes a fact this Bot recorded from its own shard", async () => {
    const { store } = storeFor("bot-1");
    const root = botMemoryRootV1(OWNER);
    await store.write({
      root,
      tier: "profile",
      fact: "Tim lives in Wollongong.",
      writer: writerFor("bot-1"),
    });

    const forgotten = await store.forget({
      root,
      fact: "Tim lives in Wollongong.",
      writer: writerFor("bot-1"),
    });

    expect(forgotten.status).toBe("ok");
    expect(forgotten.retracted).toBeUndefined();
    expect((await store.read(root)).profile).toEqual([]);
  });

  test("retracts another Bot's shared fact in this Bot's own shard, never editing theirs", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const root = userMemoryRootV1(OWNER);
    const two = storeFor("bot-2", files);
    await two.store.write({
      root,
      tier: "profile",
      fact: "Tim teaches on Tuesdays.",
      writer: writerFor("bot-2"),
    });
    const one = storeFor("bot-1", files);

    const forgotten = await one.store.forget({
      root,
      fact: "Tim teaches on Tuesdays.",
      writer: writerFor("bot-1"),
    });

    expect(forgotten).toMatchObject({ status: "ok", retracted: true });
    // The other Bot's file is untouched: its bytes still hold the fact.
    const theirs = await files.read({
      root,
      path: "by-agent/bot-2/profile.md",
    });
    expect(
      theirs.status === "ok" ? new TextDecoder().decode(theirs.file.bytes) : "",
    ).toContain("Tim teaches on Tuesdays.");
    // But the merged tier no longer carries it: newest wins.
    expect((await one.store.read(root)).profile).toEqual([]);
    expect((await two.store.read(root)).profile).toEqual([]);
  });

  test("removes every marker variant of a fact, given the body or the marker", async () => {
    const { store } = storeFor("bot-1");
    const root = botMemoryRootV1(OWNER);
    const writer = writerFor("bot-1");
    // A note and a durable log fact making the same claim are two records:
    // dedupe is on the full text, so the second write is not a duplicate.
    await store.write({ root, tier: "log", fact: "we ship on Friday", writer });
    const second = await store.write({
      root,
      tier: "note",
      fact: "[note] we ship on Friday",
      writer,
    });
    expect(second).toMatchObject({ status: "ok", duplicate: false });
    expect((await store.read(root)).recent.map((f) => f.text).sort()).toEqual([
      "[note] we ship on Friday",
      "we ship on Friday",
    ]);

    // Forgetting the body removes both — a User can forget a note whose
    // `[note] ` prefix they were never shown.
    const forgotten = await store.forget({
      root,
      fact: "we ship on Friday",
      writer,
    });
    expect(forgotten.status).toBe("ok");
    expect((await store.read(root)).recent).toEqual([]);
  });

  test("a forget that does pass the marker matches too", async () => {
    const { store } = storeFor("bot-1");
    const root = botMemoryRootV1(OWNER);
    const writer = writerFor("bot-1");
    await store.write({
      root,
      tier: "note",
      fact: "[note] we ship on Friday",
      writer,
    });
    const forgotten = await store.forget({
      root,
      fact: "[note] we ship on Friday",
      writer,
    });
    expect(forgotten.status).toBe("ok");
    expect((await store.read(root)).recent).toEqual([]);
  });

  test("retracts another Bot's note by its body, naming the recorded text", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const root = userMemoryRootV1(OWNER);
    const two = storeFor("bot-2", files);
    await two.store.write({
      root,
      tier: "note",
      fact: "[note] Tim teaches on Tuesdays.",
      writer: writerFor("bot-2"),
    });
    const one = storeFor("bot-1", files);

    const forgotten = await one.store.forget({
      root,
      fact: "Tim teaches on Tuesdays.",
      writer: writerFor("bot-1"),
    });
    expect(forgotten).toMatchObject({ status: "ok", retracted: true });

    // The retraction names the *recorded* text, marker and all, because that
    // is the text newest-wins resolves against.
    const mine = await files.read({
      root,
      path: "by-agent/bot-1/log/2026-08.md",
    });
    expect(
      mine.status === "ok" ? new TextDecoder().decode(mine.file.bytes) : "",
    ).toContain("[forgotten] [note] Tim teaches on Tuesdays.");
    expect((await one.store.read(root)).recent).toEqual([]);
  });

  test("refuses a forget of a fact nobody recorded", async () => {
    const { store } = storeFor("bot-1");
    const outcome = await store.forget({
      root: botMemoryRootV1(OWNER),
      fact: "Never said.",
      writer: writerFor("bot-1"),
    });
    expect(outcome.status).toBe("refused");
  });
});

describe("project memory", () => {
  test("shards a Project tier per writing Bot exactly as the User tier does", async () => {
    const { store } = storeFor("bot-1");
    const root = projectMemoryRootV1(OWNER, "ghetto-movement");
    const written = await store.write({
      root,
      tier: "log",
      fact: "The shoot is on Friday.",
      writer: writerFor("bot-1"),
    });
    expect(written).toMatchObject({
      status: "ok",
      path: "by-agent/bot-1/log/2026-08.md",
    });
    expect((await store.read(root)).recent.map((fact) => fact.via)).toEqual([
      "General",
    ]);
  });
});

describe("a tier read that a declared bound cut short", () => {
  /** One profile shard per Bot, past the per-tier file bound. */
  async function crowdedUserTier(shards: number) {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    for (let index = 0; index < shards; index += 1) {
      const botId = `bot-${String(index).padStart(3, "0")}`;
      const store = new MemoryStore({
        files,
        owner: { userId: "user-1", botId },
        clock: () => AT,
      });
      const written = await store.write({
        root: userMemoryRootV1(OWNER),
        tier: "profile",
        fact: `Shard ${String(index).padStart(3, "0")} learned something.`,
        writer: writerFor(botId),
      });
      expect(written.status).toBe("ok");
    }
    return files;
  }

  test("keeps the newest files, because injection is about recent facts", async () => {
    const shards = MEMORY_MAX_FILES_PER_TIER + 2;
    const files = await crowdedUserTier(shards);
    const store = new MemoryStore({
      files,
      owner: { userId: "user-1", botId: "bot-000" },
      clock: () => AT,
    });

    const tier = await store.read(userMemoryRootV1(OWNER));

    expect(tier.sources).toHaveLength(MEMORY_MAX_FILES_PER_TIER);
    expect(tier.omitted).toContain("the newest");
    const shardIds = tier.sources.map((source) => source.botId).sort();
    // The two oldest shards were dropped; the newest write is still read.
    expect(shardIds).not.toContain("bot-000");
    expect(shardIds).not.toContain("bot-001");
    expect(shardIds).toContain(`bot-${String(shards - 1).padStart(3, "0")}`);
  });

  test("a forget refuses rather than reporting a fact it could not have removed", async () => {
    const files = await crowdedUserTier(MEMORY_MAX_FILES_PER_TIER + 1);
    const store = new MemoryStore({
      files,
      owner: { userId: "user-1", botId: "bot-000" },
      clock: () => AT,
    });

    const forgotten = await store.forget({
      root: userMemoryRootV1(OWNER),
      fact: "Shard 000 learned something.",
      writer: writerFor("bot-000"),
    });

    expect(forgotten.status).toBe("unavailable");
    if (forgotten.status !== "unavailable") throw new Error("unreachable");
    expect(forgotten.reason).toContain("read bound");
    // And the fact is still on disk, which is what the refusal is about.
    const own = await files.read({
      root: userMemoryRootV1(OWNER),
      path: "by-agent/bot-000/profile.md",
    });
    expect(own.status).toBe("ok");
    if (own.status !== "ok") return;
    expect(new TextDecoder().decode(own.file.bytes)).toContain(
      "Shard 000 learned something.",
    );
  });

  test("keeps every omission when two bounds bite at once", async () => {
    // A listing that never ends, of more files than the tier bound reads:
    // both the page bound and the file bound cut this read, and a caller that
    // must refuse on an incomplete read needs to be told both.
    const entries = (page: number) =>
      Array.from({ length: 100 }, (_, index) => {
        const botId = `bot-${String(page * 100 + index).padStart(4, "0")}`;
        return {
          path: {
            root: userMemoryRootV1(OWNER),
            path: `by-agent/${botId}/profile.md`,
          },
          generation: {
            schemaVersion: 1 as const,
            generationId: `${String(page * 100 + index).padStart(9, "0")}`,
            contentHash: "0".repeat(64),
            size: 12,
            writer: writerFor(botId),
            writtenAt: AT.toISOString(),
          },
        };
      });
    const endless: WorkspaceFilesV1 = {
      list: (request) => {
        const page = Number(request.cursor ?? "0");
        return Promise.resolve({
          status: "ok",
          entries: entries(page),
          cursor: String(page + 1),
        });
      },
      read: (path) =>
        Promise.resolve({
          status: "ok",
          file: {
            path,
            generation: {
              schemaVersion: 1,
              generationId: "000000001",
              contentHash: "0".repeat(64),
              size: 12,
              writer: writerFor("bot-0000"),
              writtenAt: AT.toISOString(),
            },
            bytes: new TextEncoder().encode("- 2026-08-31 A fact.\n"),
          },
        }),
      stat: () =>
        Promise.resolve({ status: "not-found", reason: "unused in this test" }),
      write: () =>
        Promise.resolve({ status: "refused", reason: "unused in this test" }),
      delete: () =>
        Promise.resolve({ status: "refused", reason: "unused in this test" }),
    };
    const store = new MemoryStore({
      files: endless,
      owner: { userId: "user-1", botId: "bot-0000" },
      clock: () => AT,
    });

    const tier = await store.read(userMemoryRootV1(OWNER));

    expect(tier.omitted).toContain("did not finish listing");
    expect(tier.omitted).toContain("read bound were not read");
  });
});
