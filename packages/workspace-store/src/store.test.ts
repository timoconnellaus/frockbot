import { describe, expect, test } from "bun:test";
import {
  isWorkspaceConflictV1,
  memoryShardPathV1,
  workspaceMemoryProjectionV1,
  type WorkspaceFilesV1,
  type WorkspaceRootV1,
  type WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import {
  createInMemoryObjectBucketV1,
  createInMemoryWorkspaceGenerationsV1,
  type InMemoryObjectBucketV1,
  type InMemoryWorkspaceGenerationsV1,
} from "./testing.js";
import { createObjectWorkspaceFilesV1 } from "./store.js";
import { workspaceConflictKeyV1, workspaceObjectKeyV1 } from "./keys.js";

const USER = "user-1";
const INSTRUCTIONS: WorkspaceRootV1 = {
  kind: "bot-instructions",
  userId: USER,
  botId: "bot-1",
};
const USER_MEMORY: WorkspaceRootV1 = { kind: "user-memory", userId: USER };
const PROJECT_MEMORY: WorkspaceRootV1 = {
  kind: "project-memory",
  userId: USER,
  projectId: "school-run",
};
const BOT_MEMORY: WorkspaceRootV1 = {
  kind: "bot-memory",
  userId: USER,
  botId: "bot-1",
};

function bot(botId: string): WorkspaceWriterV1 {
  return {
    kind: "bot",
    botId,
    sessionId: `${USER}:${botId}`,
    turnId: "turn-1",
    runId: "run-1",
  };
}

const user: WorkspaceWriterV1 = { kind: "user", userId: USER };
const firstParty: WorkspaceWriterV1 = {
  kind: "first-party",
  packageId: "skills",
};

interface Harness {
  files: WorkspaceFilesV1;
  memory: WorkspaceFilesV1;
  bucket: InMemoryObjectBucketV1;
  generations: InMemoryWorkspaceGenerationsV1;
}

function harness(): Harness {
  let ticks = 0;
  const clock = () => new Date(1_800_000_000_000 + ticks++ * 1000);
  const bucket = createInMemoryObjectBucketV1(clock);
  const generations = createInMemoryWorkspaceGenerationsV1(clock);
  return {
    bucket,
    generations,
    files: createObjectWorkspaceFilesV1({
      bucket,
      generations,
      clock,
      owner: { userId: USER },
    }),
    memory: createObjectWorkspaceFilesV1({
      bucket,
      generations,
      clock,
      owner: { userId: USER },
      surface: "memory",
    }),
  };
}

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

function text(value: Uint8Array): string {
  return new TextDecoder().decode(value);
}

describe("object keys and recorded generations", () => {
  test("a write lands under its root key and records its writer", async () => {
    const { files, bucket, generations } = harness();
    const written = await files.write({
      path: { root: INSTRUCTIONS, path: "skills/deploy/SKILL.md" },
      bytes: bytes("# Deploy"),
      writer: bot("bot-1"),
      expectedGenerationId: null,
    });

    expect(written.status).toBe("ok");
    expect(bucket.keys()).toEqual([
      "workspace/bot-instructions:user-1:bot-1/skills/deploy/SKILL.md",
    ]);
    expect(workspaceObjectKeyV1(INSTRUCTIONS, "skills/deploy/SKILL.md")).toBe(
      "workspace/bot-instructions:user-1:bot-1/skills/deploy/SKILL.md",
    );

    const read = await files.read({
      root: INSTRUCTIONS,
      path: "skills/deploy/SKILL.md",
    });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(text(read.file.bytes)).toBe("# Deploy");
    expect(read.file.generation.writer).toEqual(bot("bot-1"));

    const recorded = await generations.current(
      INSTRUCTIONS,
      "skills/deploy/SKILL.md",
    );
    expect(recorded?.generation.generationId).toBe(
      read.file.generation.generationId,
    );
    expect(recorded?.etag).toBeTruthy();
  });

  test("a file written straight into the bucket has no recorded writer", async () => {
    const { files, bucket } = harness();
    await bucket.put(
      workspaceObjectKeyV1(INSTRUCTIONS, "skills/rogue/SKILL.md"),
      bytes("# Rogue"),
    );

    const read = await files.read({
      root: INSTRUCTIONS,
      path: "skills/rogue/SKILL.md",
    });
    expect(read.status).toBe("ok");
    if (read.status !== "ok") return;
    expect(read.file.generation.writer).toEqual({ kind: "unattributed" });
  });

  test("stat and read agree, and a missing file is not-found", async () => {
    const { files } = harness();
    await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("hello"),
      writer: user,
      expectedGenerationId: null,
    });
    const stat = await files.stat({ root: INSTRUCTIONS, path: "notes.md" });
    expect(stat.status).toBe("ok");
    if (stat.status !== "ok") return;
    expect(stat.entry.generation.size).toBe(5);
    expect(
      await files.stat({ root: INSTRUCTIONS, path: "absent.md" }),
    ).toMatchObject({ status: "not-found" });
    expect(
      await files.read({ root: INSTRUCTIONS, path: "absent.md" }),
    ).toMatchObject({ status: "not-found" });
  });
});

describe("conditional writes preserve the loser", () => {
  test("a stale expected generation conflicts and both generations survive", async () => {
    const { files, bucket, generations } = harness();
    const first = await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("first"),
      writer: user,
      expectedGenerationId: null,
    });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    const second = await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("second"),
      writer: user,
      expectedGenerationId: first.generation.generationId,
    });
    expect(second.status).toBe("ok");

    const stale = await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("stale"),
      writer: bot("bot-1"),
      expectedGenerationId: first.generation.generationId,
    });

    expect(stale.status).toBe("conflict");
    if (!isWorkspaceConflictV1(stale)) return;
    expect(stale.current?.generationId).toBe(
      second.status === "ok" ? second.generation.generationId : "",
    );
    expect(stale.preserved?.conflictsWith).toBe(stale.current?.generationId);

    // The winner is untouched, and the loser is preserved beside it.
    const read = await files.read({ root: INSTRUCTIONS, path: "notes.md" });
    expect(read.status === "ok" && text(read.file.bytes)).toBe("second");
    const conflictKey = workspaceConflictKeyV1(
      INSTRUCTIONS,
      "notes.md",
      stale.preserved?.generationId ?? "",
    );
    expect(bucket.keys()).toContain(conflictKey);
    const preserved = await bucket.get(conflictKey);
    expect(text((await preserved?.bytes()) ?? new Uint8Array())).toBe("stale");

    const recorded = await generations.conflicts(INSTRUCTIONS, "notes.md");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.conflictKey).toBe(conflictKey);
    expect(recorded[0]?.generation.conflictsWith).toBe(
      stale.current?.generationId,
    );
  });

  test("asserting absence over an existing file conflicts, never overwrites", async () => {
    const { files } = harness();
    await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("first"),
      writer: user,
      expectedGenerationId: null,
    });

    const clash = await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("clash"),
      writer: user,
      expectedGenerationId: null,
    });

    expect(clash.status).toBe("conflict");
    const read = await files.read({ root: INSTRUCTIONS, path: "notes.md" });
    expect(read.status === "ok" && text(read.file.bytes)).toBe("first");
  });

  test("a preserved losing write is never listed as a file", async () => {
    const { files } = harness();
    await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("first"),
      writer: user,
      expectedGenerationId: null,
    });
    await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("loser"),
      writer: user,
      expectedGenerationId: null,
    });

    const listed = await files.list({ root: INSTRUCTIONS });
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") return;
    expect(listed.entries.map((entry) => entry.path.path)).toEqual([
      "notes.md",
    ]);
  });
});

describe("a delete leaves a durable tombstone", () => {
  test("the file is gone and the removal is recorded with its writer", async () => {
    const { files, bucket, generations } = harness();
    const written = await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("first"),
      writer: user,
      expectedGenerationId: null,
    });
    expect(written.status).toBe("ok");
    if (written.status !== "ok") return;

    const removed = await files.delete({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      writer: user,
      expectedGenerationId: written.generation.generationId,
    });

    expect(removed.status).toBe("ok");
    expect(bucket.keys()).toEqual([]);
    const tombstone = await generations.current(INSTRUCTIONS, "notes.md");
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.generation.writer).toEqual(user);
    expect(tombstone?.generation.size).toBe(0);
    expect(generations.tombstones()).toHaveLength(1);
  });

  test("a stale delete conflicts, and a missing file is not-found", async () => {
    const { files } = harness();
    const written = await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("first"),
      writer: user,
      expectedGenerationId: null,
    });
    expect(written.status).toBe("ok");

    expect(
      await files.delete({
        path: { root: INSTRUCTIONS, path: "notes.md" },
        writer: user,
        expectedGenerationId: "not-the-current-one",
      }),
    ).toMatchObject({ status: "conflict" });
    expect(
      await files.delete({
        path: { root: INSTRUCTIONS, path: "absent.md" },
        writer: user,
        expectedGenerationId: "whatever",
      }),
    ).toMatchObject({ status: "not-found" });
  });

  test("a tombstoned path is written again by asserting absence", async () => {
    const { files } = harness();
    const written = await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("first"),
      writer: user,
      expectedGenerationId: null,
    });
    if (written.status !== "ok") throw new Error("write failed");
    await files.delete({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      writer: user,
      expectedGenerationId: written.generation.generationId,
    });

    const again = await files.write({
      path: { root: INSTRUCTIONS, path: "notes.md" },
      bytes: bytes("again"),
      writer: user,
      expectedGenerationId: null,
    });
    expect(again.status).toBe("ok");
  });
});

describe("who may write", () => {
  test("an unattributed writer is refused, whatever the root", async () => {
    const { files, memory } = harness();
    expect(
      await files.write({
        path: { root: INSTRUCTIONS, path: "notes.md" },
        bytes: bytes("x"),
        writer: { kind: "unattributed" },
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await memory.write({
        path: memoryShardPathV1(USER_MEMORY, "bot-1", "profile.md"),
        bytes: bytes("x"),
        writer: { kind: "unattributed" },
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
  });

  test("a first-party Package writes neither an instruction nor a Memory root", async () => {
    const { files, memory } = harness();
    expect(
      await files.write({
        path: { root: INSTRUCTIONS, path: "skills/a/SKILL.md" },
        bytes: bytes("x"),
        writer: firstParty,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
    expect(
      await memory.write({
        path: { root: BOT_MEMORY, path: "profile.md" },
        bytes: bytes("x"),
        writer: firstParty,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
  });

  test("another Bot may not write this Bot's instruction root", async () => {
    const { files } = harness();
    expect(
      await files.write({
        path: { root: INSTRUCTIONS, path: "skills/a/SKILL.md" },
        bytes: bytes("x"),
        writer: bot("bot-2"),
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
  });

  test("the kernel surface refuses every Memory root and the Memory surface refuses every other", async () => {
    const { files, memory } = harness();
    for (const root of [BOT_MEMORY, USER_MEMORY, PROJECT_MEMORY]) {
      expect(
        await files.write({
          path: memoryShardPathV1(root, "bot-1", "profile.md"),
          bytes: bytes("x"),
          writer: bot("bot-1"),
          expectedGenerationId: null,
        }),
      ).toMatchObject({ status: "refused" });
    }
    expect(
      await memory.write({
        path: { root: INSTRUCTIONS, path: "skills/a/SKILL.md" },
        bytes: bytes("x"),
        writer: bot("bot-1"),
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
  });

  test("another User's root is refused outright", async () => {
    const { files } = harness();
    expect(
      await files.read({
        root: { kind: "bot-instructions", userId: "user-2", botId: "bot-1" },
        path: "notes.md",
      }),
    ).toMatchObject({ status: "refused" });
  });

  test("a file beyond the contract byte bound is refused", async () => {
    const { files } = harness();
    expect(
      await files.write({
        path: { root: INSTRUCTIONS, path: "big.md" },
        bytes: new Uint8Array(1_048_577),
        writer: user,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
  });
});

describe("shared Memory tiers are sharded per writing Bot", () => {
  test("a Bot writes its own shard and no other", async () => {
    const { memory } = harness();
    expect(
      await memory.write({
        path: memoryShardPathV1(USER_MEMORY, "bot-1", "profile.md"),
        bytes: bytes("- (2026-08-31) a fact"),
        writer: bot("bot-1"),
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "ok" });
    expect(
      await memory.write({
        path: memoryShardPathV1(USER_MEMORY, "bot-2", "profile.md"),
        bytes: bytes("- (2026-08-31) not mine to write"),
        writer: bot("bot-1"),
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
    // An unsharded path in a shared root belongs to no Bot.
    expect(
      await memory.write({
        path: { root: USER_MEMORY, path: "profile.md" },
        bytes: bytes("x"),
        writer: bot("bot-1"),
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "refused" });
  });

  test("the User may write any shard of their own Project Memory", async () => {
    const { memory } = harness();
    expect(
      await memory.write({
        path: memoryShardPathV1(PROJECT_MEMORY, "bot-9", "profile.md"),
        bytes: bytes("corrected"),
        writer: user,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "ok" });
  });

  test("a listing with no shard merges every Bot's shard", async () => {
    const { memory } = harness();
    for (const botId of ["bot-1", "bot-10", "bot-2"]) {
      const written = await memory.write({
        path: memoryShardPathV1(USER_MEMORY, botId, "profile.md"),
        bytes: bytes(`from ${botId}`),
        writer: bot(botId),
        expectedGenerationId: null,
      });
      expect(written.status).toBe("ok");
    }

    const merged = await memory.list({ root: USER_MEMORY });
    expect(merged.status).toBe("ok");
    if (merged.status !== "ok") return;
    expect(merged.entries.map((entry) => entry.path.path).sort()).toEqual([
      "by-agent/bot-1/profile.md",
      "by-agent/bot-10/profile.md",
      "by-agent/bot-2/profile.md",
    ]);
    // Every shared fact records which Bot learned it.
    expect(
      merged.entries.every((entry) => entry.generation.writer.kind === "bot"),
    ).toBe(true);
  });

  test("a listing of one shard returns that shard alone", async () => {
    const { memory } = harness();
    for (const botId of ["bot-1", "bot-10"]) {
      await memory.write({
        path: memoryShardPathV1(USER_MEMORY, botId, "profile.md"),
        bytes: bytes(`from ${botId}`),
        writer: bot(botId),
        expectedGenerationId: null,
      });
    }

    const shard = await memory.list({
      root: USER_MEMORY,
      prefix: "by-agent/bot-1",
    });
    expect(shard.status).toBe("ok");
    if (shard.status !== "ok") return;
    expect(shard.entries.map((entry) => entry.path.path)).toEqual([
      "by-agent/bot-1/profile.md",
    ]);
  });

  test("the Memory projection of the store exposes no write path", () => {
    const { memory } = harness();
    const projection: Record<string, unknown> = workspaceMemoryProjectionV1(
      memory,
    ) as unknown as Record<string, unknown>;
    expect(Object.keys(projection).sort()).toEqual(["list", "read", "stat"]);
    expect(projection.write).toBe(undefined);
    expect(projection.delete).toBe(undefined);
  });
});

describe("listing bounds", () => {
  test("pages through a root with a cursor", async () => {
    const { files } = harness();
    for (const name of ["a.md", "b.md", "c.md"]) {
      await files.write({
        path: { root: INSTRUCTIONS, path: name },
        bytes: bytes(name),
        writer: user,
        expectedGenerationId: null,
      });
    }

    const first = await files.list({ root: INSTRUCTIONS, limit: 2 });
    expect(first.status).toBe("ok");
    if (first.status !== "ok") return;
    expect(first.entries).toHaveLength(2);
    expect(first.cursor).toBeTruthy();

    const rest = await files.list({
      root: INSTRUCTIONS,
      limit: 2,
      cursor: first.cursor,
    });
    expect(rest.status).toBe("ok");
    if (rest.status !== "ok") return;
    expect(rest.entries.map((entry) => entry.path.path)).toEqual(["c.md"]);
    expect(rest.cursor).toBe(undefined);
  });

  test("a traversing path or prefix is refused, never normalized", async () => {
    const { files } = harness();
    expect(
      await files.list({ root: INSTRUCTIONS, prefix: "../elsewhere" }),
    ).toMatchObject({ status: "refused" });
    expect(
      await files.read({ root: INSTRUCTIONS, path: "../elsewhere.md" }),
    ).toMatchObject({ status: "refused" });
  });
});
