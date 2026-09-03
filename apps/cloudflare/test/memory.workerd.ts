// The Memory Package against real R2 and two real Durable Objects.
//
// One claim, and it is the whole point of Step 3 of `docs/plans/slice-2.md`:
//
//   A Bot writes a fact to the *User* Memory scope. Its generation is recorded
//   in the **User** Durable Object — "The User's Durable Object is the
//   authority for ... the generation records of User Memory roots" — and not
//   in the writing Bot's. A *different* Bot of the same User then runs an
//   ordinary admitted Turn, and the fact reaches its model request tagged
//   `[via <the Bot that learned it>]`, with the exact generations recorded in
//   `memory/injected`.
//
// Nothing here touches a Computer. There is no Computer bound in this test
// worker at all, which is the strongest form the hibernation rule can take:
// the whole cycle runs where no Computer exists.
import { env } from "cloudflare:workers";
import { evictDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import type { WorkspaceRootV1 } from "@frockbot/kernel-contracts";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

function userMemoryRoot(userId: string): WorkspaceRootV1 {
  return { kind: "user-memory", userId };
}

function botMemoryRoot(identity: {
  userId: string;
  botId: string;
}): WorkspaceRootV1 {
  return { kind: "bot-memory", ...identity };
}

/** `YYYY-MM-DD`, `offset` days from now, in UTC — the Memory date grammar. */
function day(offset: number): string {
  return new Date(Date.now() + offset * 24 * 60 * 60 * 1_000)
    .toISOString()
    .slice(0, 10);
}

const FACT = "Tim runs the gym build out of Wollongong.";

describe("Memory in Workerd", () => {
  test("a user-scope write records its generation in the User Durable Object, and another Bot of the same User reads the fact without being given a sibling's id", async () => {
    const suffix = crypto.randomUUID();
    const userId = `memory-user-${suffix}`;
    const learner = { userId, botId: `memory-bot-a-${suffix}` };
    const reader = { userId, botId: `memory-bot-b-${suffix}` };
    await provisionBot(learner);
    await provisionSiblingBot(reader, 1);

    const learnerStub = bot(`memory-a-${suffix}`);
    const written = await learnerStub.memoryWrite({
      ...learner,
      scope: "user",
      tier: "profile",
      fact: FACT,
    });

    expect(written.isError).toBe(false);
    const intent = written.events.find(
      (event) => event.type === "memory/write-intent",
    );
    const record = written.events.find(
      (event) => event.type === "memory/written",
    );
    // Intent before the effect, both durable, sharing one effect identifier.
    expect(intent).toBeDefined();
    expect(record).toBeDefined();
    expect(intent!.seq).toBeLessThan(record!.seq);
    if (record?.type !== "memory/written") throw new Error("unreachable");
    expect(record.path).toBe(`by-agent/${learner.botId}/profile.md`);

    const root = userMemoryRoot(userId);
    const shardPath = `by-agent/${learner.botId}/profile.md`;

    // THE LEDGER. The User Durable Object holds the generation…
    const userStub = env.USER_CONFIGURATIONS.getByName(userId);
    await evictDurableObject(userStub);
    const recorded = await userStub.currentWorkspaceGeneration({
      schemaVersion: 1,
      userId,
      root,
      path: shardPath,
    });
    expect(recorded).toBeDefined();
    expect(recorded?.generation.generationId).toBe(record.generationId);
    expect(recorded?.generation.writer).toMatchObject({
      kind: "bot",
      botId: learner.botId,
    });

    // …and the writing Bot's own object does not.
    expect(
      await learnerStub.botLedgerGeneration({ root, path: shardPath }),
    ).toBeUndefined();

    // THE INJECTION. A different Bot of the same User runs an ordinary Turn.
    const readerStub = bot(`memory-b-${suffix}`);
    const result = await readerStub.run({
      schemaVersion: 1,
      ...reader,
      command: {
        runId: "run-1",
        sessionId: `${userId}:${reader.botId}`,
        acceptedAt: "2026-08-31T00:00:00.000Z",
        text: "What do you know about me?",
      },
    });
    expect(result.text).toBe("Ollama reply");

    const events = await readerStub.durableSessionEvents();
    const request = events.find((event) => event.type === "model/request");
    if (request?.type !== "model/request") throw new Error("unreachable");
    expect(request.request.system).toContain("User memory:");
    expect(request.request.system).toContain("About the user (shared):");
    expect(request.request.system).toContain(FACT);
    // A shared fact is credited by name or not at all. This deployment gives
    // the memory store no Bot names, so the fact is uncredited rather than
    // tagged with a sibling's id — which the model reads as a name and says
    // out loud to the User.
    expect(request.request.system).not.toContain(`[via ${learner.botId}]`);
    expect(request.request.system).not.toContain(learner.botId);

    const injected = events.find((event) => event.type === "memory/injected");
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    expect(injected.facts).toContainEqual({
      scope: "user",
      projectId: "",
      tier: "profile",
      // Empty, not the learner's id: the durable record credits a name or
      // nobody, exactly as the prompt does.
      via: "",
      learnedAt: expect.any(String),
      text: FACT,
    });
    expect(injected.sources).toContainEqual({
      scope: "user",
      projectId: "",
      path: shardPath,
      generationId: record.generationId,
      contentHash: expect.any(String),
    });
  });

  test("a Bot writes its own shard of a shared Memory root on real R2, and another Bot's is refused", async () => {
    const suffix = crypto.randomUUID();
    const userId = `memory-user-${suffix}`;
    const identity = { userId, botId: `memory-bot-c-${suffix}` };
    await provisionBot(identity);
    const stub = bot(`memory-c-${suffix}`);
    const root = userMemoryRoot(userId);
    const writer = {
      kind: "bot" as const,
      botId: identity.botId,
      sessionId: `${userId}:${identity.botId}`,
      turnId: "t",
      runId: "r",
    };

    // Through the *Memory* surface — the Memory Package's own seam, and the
    // only one that writes a Memory root at all. Writing through the kernel
    // surface would prove nothing about shard ownership, because that surface
    // refuses every Memory root before ownership is ever consulted.
    const forged = await stub.memoryWriteWorkspaceFile({
      ...identity,
      root,
      path: `by-agent/${identity.botId}-other/profile.md`,
      text: "- (2026-08-31) Forged.\n",
      writer,
      expectedGenerationId: null,
    });
    expect(forged.status).toBe("refused");
    expect(forged.reason).toContain("Memory shard");

    // And the Bot's own shard is written, on real R2, through the same seam.
    const own = await stub.memoryWriteWorkspaceFile({
      ...identity,
      root,
      path: `by-agent/${identity.botId}/profile.md`,
      text: "- (2026-08-31) Mine.\n",
      writer,
      expectedGenerationId: null,
    });
    expect(own.status).toBe("ok");

    // The forged shard does not exist; the Bot's own does.
    expect(
      await stub.memoryReadWorkspaceFile({
        ...identity,
        root,
        path: `by-agent/${identity.botId}-other/profile.md`,
      }),
    ).toMatchObject({ status: "not-found" });
    expect(
      await stub.memoryReadWorkspaceFile({
        ...identity,
        root,
        path: `by-agent/${identity.botId}/profile.md`,
      }),
    ).toMatchObject({ status: "ok", text: "- (2026-08-31) Mine.\n" });

    // The generation is in the User Durable Object, which is the authority for
    // a shared Memory root, and it survives eviction.
    const userStub = env.USER_CONFIGURATIONS.getByName(userId);
    await evictDurableObject(userStub);
    const recorded = await userStub.currentWorkspaceGeneration({
      schemaVersion: 1,
      userId,
      root,
      path: `by-agent/${identity.botId}/profile.md`,
    });
    expect(recorded?.generation.generationId).toBe(own.generationId);
  });

  test("a User Durable Object refuses an RPC naming another User's root", async () => {
    const suffix = crypto.randomUUID();
    const mine = `memory-user-${suffix}`;
    const theirs = `memory-other-${suffix}`;
    const identity = { userId: mine, botId: `memory-bot-d-${suffix}` };
    await provisionBot(identity);

    // Addressed as *this* User's object, and asked about another User. The
    // request agrees with itself — `userId` and `root.userId` both name the
    // other User — which is exactly why comparing the two proves nothing.
    const stub = env.USER_CONFIGURATIONS.getByName(mine);
    let refusal = "";
    try {
      await stub.currentWorkspaceGeneration({
        schemaVersion: 1,
        userId: theirs,
        root: userMemoryRoot(theirs),
        path: "by-agent/whoever/profile.md",
      });
    } catch (error) {
      refusal = error instanceof Error ? error.message : String(error);
    }
    expect(refusal).toContain("different User");

    // And its own root still answers.
    await expect(
      stub.currentWorkspaceGeneration({
        schemaVersion: 1,
        userId: mine,
        root: userMemoryRoot(mine),
        path: "by-agent/whoever/profile.md",
      }),
    ).resolves.toBeUndefined();
  });

  // Row 9's other half: the note tier "fades fast". The fade is a read-time
  // filter and nothing else, so the strongest statement of that claim is that
  // the note stops reaching the model while the file it lives in does not
  // move — no sweep, no alarm, no generation minted behind the Turn's back.
  test("a note past the 14-day fade leaves the prompt while its file stays exactly where it was", async () => {
    const suffix = crypto.randomUUID();
    const userId = `memory-user-${suffix}`;
    const identity = { userId, botId: `memory-bot-e-${suffix}` };
    await provisionBot(identity);
    const stub = bot(`memory-e-${suffix}`);
    const root = botMemoryRoot(identity);

    const LIVE = "The standup moved to nine.";
    const STALE = "The standup moved to eight.";
    const DURABLE = "Tim teaches on Tuesdays.";
    // Two notes either side of the cutoff and one ordinary log fact, in the
    // Bot's own shard, written as the bytes a Bot would have left there.
    const path = `log/${day(0).slice(0, 7)}.md`;
    const written = await stub.memoryWriteWorkspaceFile({
      ...identity,
      root,
      path,
      text: [
        `- (${day(0)}) [note] ${LIVE}`,
        `- (${day(-30)}) [note] ${STALE}`,
        `- (${day(-30)}) ${DURABLE}`,
        "",
      ].join("\n"),
      writer: {
        kind: "bot" as const,
        botId: identity.botId,
        sessionId: `${userId}:${identity.botId}`,
        turnId: "t",
        runId: "r",
      },
      expectedGenerationId: null,
    });
    expect(written.status).toBe("ok");

    const result = await stub.run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: "run-1",
        sessionId: `${userId}:${identity.botId}`,
        acceptedAt: "2026-08-31T00:00:00.000Z",
        text: "What do you know about me?",
      },
    });
    expect(result.text).toBe("Ollama reply");

    const events = await stub.durableSessionEvents();
    const request = events.find((event) => event.type === "model/request");
    if (request?.type !== "model/request") throw new Error("unreachable");
    expect(request.request.system).toContain(LIVE);
    expect(request.request.system).not.toContain(STALE);
    // An unmarked log fact of the same age is untouched: only markers fade.
    expect(request.request.system).toContain(DURABLE);

    const injected = events.find((event) => event.type === "memory/injected");
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    // The cutoff is on the durable log, so this request reconstructs exactly.
    expect(injected.noteTtlDays).toBe(14);
    expect(injected.noteCutoff).toBe(day(-14));
    expect(injected.faded).toContainEqual({
      scope: "bot",
      projectId: "",
      count: 1,
    });
    // A fade is policy working, never an omission.
    expect(injected.omissions).toEqual([]);

    // AND THE FILE DID NOT MOVE. Same generation, same bytes, note included.
    const after = await stub.memoryReadWorkspaceFile({
      ...identity,
      root,
      path,
    });
    expect(after.status).toBe("ok");
    expect(after.generationId).toBe(written.generationId);
    expect(after.text).toContain(STALE);
  });
});
