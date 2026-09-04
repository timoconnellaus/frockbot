// The durable-root sync's effect records, against real Durable Object storage
// and real eviction in workerd.
//
// Constitution — Computer and Workspace: "Computer effects are reconcilable. A
// mutation or process launch records intent and an effect identifier in the
// Bot's Durable Object and in the Workspace before it runs, so recovery can
// read its outcome or classify it as unknown without repeating it."
//
// Two claims a Bun double cannot make, because both are claims about the
// deployed Bot Durable Object:
//
//  1. The intent is in *this object's* storage before the push reaches object
//     storage, and it is still there after the object has been evicted from
//     memory.
//  2. A push interrupted after the store took it is adopted on the next run,
//     not repeated: the file keeps the generation the first run produced.
//
// The store, the effect records, the generation ledger and the writer are all
// production; only the Computer side is a probe, and it keeps its files in
// Durable Object storage so a Sprite's durable disk is modelled across the
// same eviction.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { WorkspaceRootV1 } from "@frockbot/kernel-contracts";

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

function identityFor(suffix: string) {
  return {
    userId: `sync-user-${suffix}`,
    botId: `sync-bot-${suffix}`,
  };
}

function instructionRoot(identity: {
  userId: string;
  botId: string;
}): WorkspaceRootV1 {
  return {
    kind: "bot-instructions",
    userId: identity.userId,
    botId: identity.botId,
  };
}

describe("the durable-root sync's records in the Bot Durable Object", () => {
  test("a push records its intent in the Bot Durable Object, and it survives eviction", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    const root = instructionRoot(identity);
    const stub = bot(`sync-intent-${suffix}`);

    // A shell wrote a file on the Computer: bytes, and nothing recording who.
    await stub.computerShellWrite({
      root,
      path: "notes.md",
      text: "written by a shell",
    });

    // The connection drops after the store has taken the write, which is the
    // ordinary shape of a Computer pause rather than an exceptional one.
    const interrupted = await stub.computerSyncRun({
      ...identity,
      interrupt: true,
    });
    expect(interrupted.pushed).toEqual([]);

    await evictDurableObject(stub);

    const pending = await stub.pendingSyncEffects();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "push", path: "notes.md" });

    // The bytes did land: the intent is what makes that knowable without
    // repeating the write.
    const stored = await stub.readWorkspaceFile({
      userId: identity.userId,
      root,
      path: "notes.md",
    });
    expect(stored).toMatchObject({ status: "ok", text: "written by a shell" });
  });

  test("an interrupted push is adopted after eviction, never written twice", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    const root = instructionRoot(identity);
    const stub = bot(`sync-adopt-${suffix}`);

    await stub.computerShellWrite({
      root,
      path: "notes.md",
      text: "written by a shell",
    });
    await stub.computerSyncRun({ ...identity, interrupt: true });
    const first = await stub.readWorkspaceFile({
      userId: identity.userId,
      root,
      path: "notes.md",
    });
    expect(first.status).toBe("ok");

    await evictDurableObject(stub);

    const resumed = await stub.computerSyncRun(identity);

    expect(resumed.status).toBe("ok");
    // Adopted, not pushed: the generation the interrupted run produced is the
    // one that stands.
    expect(resumed.adopted).toEqual(["notes.md"]);
    expect(resumed.pushed).toEqual([]);
    const after = await stub.readWorkspaceFile({
      userId: identity.userId,
      root,
      path: "notes.md",
    });
    expect(after.generationId).toBe(first.generationId);
    // The intent is settled once its outcome is known.
    expect(await stub.pendingSyncEffects()).toEqual([]);
    // And the Computer now records the generation its file is, so the next run
    // sees a clean file rather than pushing it again.
    expect(await stub.computerFile({ root, path: "notes.md" })).toBe(
      "written by a shell",
    );
    const settled = await stub.computerSyncRun(identity);
    expect(settled.pushed).toEqual([]);
    expect(settled.adopted).toEqual([]);
  });

  test("a Turn's push writes the Bot's own instruction root, unattributed", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    const root = instructionRoot(identity);
    const stub = bot(`sync-writer-${suffix}`);

    await stub.computerShellWrite({ root, path: "notes.md", text: "shell" });
    const report = await stub.computerSyncRun(identity);

    expect(report.status).toBe("ok");
    expect(report.pushed).toEqual(["notes.md"]);
    const generation = await stub.workspaceGeneration({
      root,
      path: "notes.md",
    });
    // "A file that reaches a durable root without passing through the
    // Workspace file surface (a shell write on the Computer) is mirrored to
    // object storage by the sync with an unattributed writer." A Turn was
    // open, and it is still not evidence: one Computer serves all of a User's
    // Bots, so nothing on this path knows which process wrote the file.
    expect(generation?.generation.writer).toEqual({ kind: "unattributed" });
  });

  test("a fresh Computer restores source without restoring a legacy dependency tree", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    const root = instructionRoot(identity);
    const stub = bot(`sync-restore-${suffix}`);
    const writer = { kind: "user" as const, userId: identity.userId };

    expect(
      await stub.writeWorkspaceFile({
        userId: identity.userId,
        root,
        path: "todo/src/index.ts",
        text: "export const todo = true;",
        writer,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "ok" });
    // This represents a generation written before dependency trees became
    // reproducible scratch. It remains durable, but is no longer materialized.
    expect(
      await stub.writeWorkspaceFile({
        userId: identity.userId,
        root,
        path: "todo/node_modules/dependency/package.json",
        text: '{"name":"dependency"}',
        writer,
        expectedGenerationId: null,
      }),
    ).toMatchObject({ status: "ok" });

    const restored = await stub.computerSyncRun(identity);

    expect(restored).toMatchObject({
      status: "ok",
      pulled: ["todo/src/index.ts"],
      ignored: 1,
      omitted: 0,
    });
    expect(await stub.computerFile({ root, path: "todo/src/index.ts" })).toBe(
      "export const todo = true;",
    );
    expect(
      await stub.computerFile({
        root,
        path: "todo/node_modules/dependency/package.json",
      }),
    ).toBeUndefined();
  });
});
