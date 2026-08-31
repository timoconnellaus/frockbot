// The object-storage Workspace store, against real R2 and real Durable Object
// storage in workerd.
//
// Three claims are proven here that a Bun double cannot prove, because all
// three are claims about the deployed pieces:
//
//  1. The Skills seam is bound in production. A Skill written through the
//     store with Bot provenance is loaded on the next admitted Turn, with no
//     Computer anywhere on the path.
//  2. Conditional writes really are conditional on R2. A write whose
//     `expectedGenerationId` is stale loses, and both generations survive —
//     the winner in place, the loser under its conflict key and in the Bot
//     Durable Object's ledger.
//  3. A delete leaves durable evidence. Object storage forgets the key, so the
//     tombstone in the Durable Object is the only record that the file was
//     removed and by whom — and it is still there after eviction.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type {
  WorkspaceRootV1,
  WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import { provisionBot } from "./provision-bot.ts";

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

function identityFor(suffix: string) {
  return {
    schemaVersion: 1 as const,
    userId: `workspace-user-${suffix}`,
    botId: `workspace-bot-${suffix}`,
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

function botWriter(identity: {
  userId: string;
  botId: string;
}): WorkspaceWriterV1 {
  return {
    kind: "bot",
    botId: identity.botId,
    sessionId: `${identity.userId}:${identity.botId}`,
    turnId: "author-1",
    runId: "author-1",
  };
}

const SKILL_PATH = "skills/deploy/SKILL.md";
const SKILL_BODY = [
  "---",
  "name: deploy",
  "description: How this Bot deploys the thing",
  "---",
  "",
  "Run the deploy script, then check the logs.",
  "",
].join("\n");

describe("the object-storage Workspace store in Workerd", () => {
  test("a Skill written through the store is loaded on the next admitted Turn", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    await provisionBot(identity);
    const stub = bot(`skills-${suffix}`);

    const written = await stub.writeWorkspaceFile({
      userId: identity.userId,
      root: instructionRoot(identity),
      path: SKILL_PATH,
      text: SKILL_BODY,
      writer: botWriter(identity),
      expectedGenerationId: null,
    });
    expect(written.status).toBe("ok");

    // The Skill was written before this Turn was admitted, so this Turn sees
    // it: "An edit is visible to the Bot on its next admitted Turn."
    const result = await stub.run({
      ...identity,
      command: {
        runId: "run-1",
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: "2026-08-31T00:00:00.000Z",
        text: "hello",
      },
    });
    expect(result.text).toBe("Ollama reply");

    const events = await stub.durableSessionEvents();
    const injected = events.filter((event) => event.type === "skill/injected");
    expect(injected).toHaveLength(1);
    const payload = injected[0] as unknown as {
      skills: Array<{ path: string; name: string; generationId: string }>;
      refusals: unknown[];
    };
    // The Bot's own root first, then the managed set the Skills Package
    // compiles into its artifact — those are not Workspace files at all, and
    // this test is about the store.
    expect(payload.skills.map((skill) => skill.path)).toEqual([
      SKILL_PATH,
      "managed/add-connector/SKILL.md",
      "managed/export-bot-template/SKILL.md",
      "managed/import-bot-template/SKILL.md",
      "managed/learn-from-demonstration/SKILL.md",
    ]);
    expect(payload.skills[0]?.name).toBe("deploy");
    expect(payload.refusals).toEqual([]);
    // The exact generation the Turn used is reconstructable from durable state.
    expect(payload.skills[0]?.generationId).toBe(written.generationId);
  });

  test("a stale expected generation conflicts, and both generations survive", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    const root = instructionRoot(identity);
    const stub = bot(`conflict-${suffix}`);

    const first = await stub.writeWorkspaceFile({
      userId: identity.userId,
      root,
      path: "notes.md",
      text: "first",
      writer: botWriter(identity),
      expectedGenerationId: null,
    });
    expect(first.status).toBe("ok");
    const second = await stub.writeWorkspaceFile({
      userId: identity.userId,
      root,
      path: "notes.md",
      text: "second",
      writer: botWriter(identity),
      expectedGenerationId: first.generationId ?? null,
    });
    expect(second.status).toBe("ok");

    const stale = await stub.writeWorkspaceFile({
      userId: identity.userId,
      root,
      path: "notes.md",
      text: "stale",
      writer: botWriter(identity),
      expectedGenerationId: first.generationId ?? null,
    });

    expect(stale.status).toBe("conflict");
    expect(stale.currentGenerationId).toBe(second.generationId);
    expect(stale.preservedConflictsWith).toBe(stale.currentGenerationId);

    // The winner is untouched.
    expect(
      await stub.readWorkspaceFile({
        userId: identity.userId,
        root,
        path: "notes.md",
      }),
    ).toMatchObject({ status: "ok", text: "second" });

    // The loser survives in object storage and in the Durable Object ledger,
    // after the object has been evicted from memory.
    await evictDurableObject(stub);
    const conflicts = await stub.workspaceConflicts({ root, path: "notes.md" });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.generation.generationId).toBe(
      stale.preservedGenerationId,
    );
    expect(
      await stub.workspaceConflictBody(conflicts[0]?.conflictKey ?? ""),
    ).toBe("stale");
  });

  test("asserting absence over an existing object conflicts, never overwrites", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    const root = instructionRoot(identity);
    const stub = bot(`absence-${suffix}`);

    expect(
      (
        await stub.writeWorkspaceFile({
          userId: identity.userId,
          root,
          path: "notes.md",
          text: "first",
          writer: botWriter(identity),
          expectedGenerationId: null,
        })
      ).status,
    ).toBe("ok");

    const clash = await stub.writeWorkspaceFile({
      userId: identity.userId,
      root,
      path: "notes.md",
      text: "clash",
      writer: botWriter(identity),
      expectedGenerationId: null,
    });

    expect(clash.status).toBe("conflict");
    expect(
      await stub.readWorkspaceFile({
        userId: identity.userId,
        root,
        path: "notes.md",
      }),
    ).toMatchObject({ status: "ok", text: "first" });
  });

  test("a delete leaves a tombstone the Durable Object still holds after eviction", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    const root = instructionRoot(identity);
    const stub = bot(`tombstone-${suffix}`);

    const written = await stub.writeWorkspaceFile({
      userId: identity.userId,
      root,
      path: "notes.md",
      text: "first",
      writer: botWriter(identity),
      expectedGenerationId: null,
    });
    expect(written.status).toBe("ok");

    const removed = await stub.deleteWorkspaceFile({
      userId: identity.userId,
      root,
      path: "notes.md",
      writer: botWriter(identity),
      expectedGenerationId: written.generationId ?? "",
    });
    expect(removed.status).toBe("ok");
    expect(
      await stub.readWorkspaceFile({
        userId: identity.userId,
        root,
        path: "notes.md",
      }),
    ).toMatchObject({ status: "not-found" });

    await evictDurableObject(stub);

    const tombstone = await stub.workspaceGeneration({
      root,
      path: "notes.md",
    });
    expect(tombstone?.deleted).toBe(true);
    expect(tombstone?.generation.writer).toMatchObject({
      kind: "bot",
      botId: identity.botId,
    });
    expect(tombstone?.generation.size).toBe(0);
  });

  test("a store built for one User refuses another User's root", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    const stub = bot(`owner-${suffix}`);
    // The production surface is built with the `owner` the Durable Object
    // knows, so a root belonging to another User is refused here rather than
    // reaching R2 — whatever root the caller names.
    const other = {
      userId: `workspace-other-${suffix}`,
      botId: identity.botId,
    };

    const refused = await stub.writeWorkspaceFile({
      userId: identity.userId,
      root: instructionRoot(other),
      path: "notes.md",
      text: "elsewhere",
      writer: botWriter(other),
      expectedGenerationId: null,
    });

    expect(refused.status).toBe("refused");
    expect(refused.reason).toContain("different User");
    expect(
      await stub.readWorkspaceFile({
        userId: identity.userId,
        root: instructionRoot(other),
        path: "notes.md",
      }),
    ).toMatchObject({ status: "refused" });
  });

  test("a Skill another Bot wrote is refused at the store, not merely unloaded", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    const stub = bot(`authority-${suffix}`);

    const refused = await stub.writeWorkspaceFile({
      userId: identity.userId,
      root: instructionRoot(identity),
      path: SKILL_PATH,
      text: SKILL_BODY,
      writer: {
        kind: "bot",
        botId: `${identity.botId}-other`,
        sessionId: "other:session",
        turnId: "t",
        runId: "r",
      },
      expectedGenerationId: null,
    });

    expect(refused.status).toBe("refused");
  });
  // AGENTS.md § Authorities: the Bot's Durable Object is *the* authority for
  // everything Bot-scoped. An authority instantiated twice is not one — each
  // copy caches the minting cursor while resident — so two surfaces of one
  // object minting at the same moment must still produce two generations.
  test("two surfaces on one Bot object never mint the same generation", async () => {
    const suffix = crypto.randomUUID();
    const identity = identityFor(suffix);
    // A fresh object: nothing is cached, which is exactly when two ledgers
    // would each read the same stored cursor before either wrote it back.
    const stub = bot(`mint-${suffix}`);

    const minted = await stub.mintThroughBothSurfaces({
      userId: identity.userId,
      botId: identity.botId,
      instructions: instructionRoot(identity),
      memory: {
        kind: "bot-memory",
        userId: identity.userId,
        botId: identity.botId,
      },
      writer: botWriter(identity),
    });

    expect(minted.kernel).toBeTruthy();
    expect(minted.memory).toBeTruthy();
    expect(minted.kernel).not.toBe(minted.memory);
  });
});
