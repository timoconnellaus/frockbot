// "Indexes, embeddings, and summaries are derived from Memory files and are
// always rebuildable from them." The check that makes that operational: an
// index built incrementally over a sequence of writes equals one rebuilt from
// the files in one pass.
import { describe, expect, test } from "bun:test";
import type { WorkspaceWriterV1 } from "@frockbot/kernel-contracts";
import {
  listAllMemoryDocumentsV1,
  readMemoryDocumentsV1,
} from "./documents.ts";
import {
  buildMemoryIndexV1,
  emptyMemoryIndexV1,
  updateMemoryIndexV1,
} from "./indexer.ts";
import { botMemoryRootV1, userMemoryRootV1 } from "./roots.ts";
import { MemoryStore } from "./store.ts";
import { createTestMemoryFilesV1 } from "./testing.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
const WRITER: WorkspaceWriterV1 = {
  kind: "bot",
  botId: "bot-1",
  sessionId: "user-1:bot-1",
  turnId: "turn-1",
  runId: "run-1",
};

describe("the derived Memory index", () => {
  test("a rebuilt index equals an incrementally updated one", async () => {
    const at = new Date("2026-08-31T10:00:00.000Z");
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const store = new MemoryStore({ files, owner: OWNER, clock: () => at });
    const roots = [botMemoryRootV1(OWNER), userMemoryRootV1(OWNER)];

    let incremental = emptyMemoryIndexV1();
    const facts: Array<{ root: (typeof roots)[number]; text: string }> = [
      {
        root: roots[0]!,
        text: "Tim lives in Wollongong and likes rubber floors.",
      },
      { root: roots[0]!, text: "Term ends on the twelfth of December." },
      { root: roots[1]!, text: "Shared: the gym build starts in spring." },
      { root: roots[0]!, text: "The shoot is on Friday at the beach." },
    ];
    for (const entry of facts) {
      await store.write({
        root: entry.root,
        tier: "log",
        fact: entry.text,
        writer: WRITER,
      });
      const documents = await listAllMemoryDocumentsV1(files, roots);
      incremental = (await updateMemoryIndexV1(incremental, documents)).index;
    }

    // A forget changes a document too, and the incremental path must follow.
    await store.forget({
      root: roots[0]!,
      fact: "Term ends on the twelfth of December.",
      writer: WRITER,
    });
    const documents = await listAllMemoryDocumentsV1(files, roots);
    const update = await updateMemoryIndexV1(incremental, documents);
    incremental = update.index;

    const rebuilt = await buildMemoryIndexV1(documents);

    expect(incremental.chunks.length).toBeGreaterThan(0);
    expect(incremental).toEqual(rebuilt);
    expect(update.documentsChanged).toBe(1);
  });

  test("drops the chunks of a document that is gone", async () => {
    const at = new Date("2026-08-31T10:00:00.000Z");
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const store = new MemoryStore({ files, owner: OWNER, clock: () => at });
    const root = botMemoryRootV1(OWNER);
    await store.write({
      root,
      tier: "profile",
      fact: "A fact worth chunking.",
      writer: WRITER,
    });
    const documents = await listAllMemoryDocumentsV1(files, [root]);
    const full = await buildMemoryIndexV1(documents);
    expect(full.chunks).toHaveLength(1);

    const emptied = await updateMemoryIndexV1(full, []);
    expect(emptied.index.chunks).toEqual([]);
    expect(emptied.documentsRemoved).toBe(1);
    expect(emptied.index).toEqual(await buildMemoryIndexV1([]));
  });
});

describe("a tier that could not be read whole says so", () => {
  test("a failed listing is partial, not empty", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const store = new MemoryStore({
      files,
      owner: OWNER,
      clock: () => new Date("2026-08-31T10:00:00.000Z"),
    });
    const root = botMemoryRootV1(OWNER);
    await store.write({
      root,
      tier: "profile",
      fact: "A fact worth chunking.",
      writer: WRITER,
    });
    expect((await readMemoryDocumentsV1(files, root)).complete).toBe(true);

    // Object storage blips on the listing exactly once.
    const list = files.list.bind(files);
    files.list = () =>
      Promise.resolve({ status: "unavailable" as const, reason: "R2 blip" });

    const listing = await readMemoryDocumentsV1(files, root);
    // The distinction that matters: nothing was read, and the caller is told,
    // so the indexer cannot mistake "unreadable" for "deleted".
    expect(listing.documents).toEqual([]);
    expect(listing.complete).toBe(false);

    files.list = list;
    expect((await readMemoryDocumentsV1(files, root)).complete).toBe(true);
  });

  test("a file that cannot be read leaves the tier partial", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const store = new MemoryStore({
      files,
      owner: OWNER,
      clock: () => new Date("2026-08-31T10:00:00.000Z"),
    });
    const root = botMemoryRootV1(OWNER);
    await store.write({
      root,
      tier: "profile",
      fact: "A fact worth chunking.",
      writer: WRITER,
    });
    files.read = () =>
      Promise.resolve({ status: "unavailable" as const, reason: "R2 blip" });

    const listing = await readMemoryDocumentsV1(files, root);
    expect(listing.documents).toEqual([]);
    expect(listing.complete).toBe(false);
  });
});
