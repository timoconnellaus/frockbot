// The Memory Package's writer and reader, against the production
// object-storage store over an in-memory bucket and generation ledger.
import { describe, expect, test } from "bun:test";
import type { WorkspaceWriterV1 } from "@frockbot/kernel-contracts";
import {
  botMemoryRootV1,
  projectMemoryRootV1,
  userMemoryRootV1,
} from "./roots.ts";
import { MemoryStore } from "./store.ts";
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
