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

const FACT = "Tim runs the gym build out of Wollongong.";

describe("Memory in Workerd", () => {
  test("a user-scope write records its generation in the User Durable Object, and another Bot of the same User is told who learned it", async () => {
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
    expect(request.request.system).toContain(`[via ${learner.botId}] ${FACT}`);

    const injected = events.find((event) => event.type === "memory/injected");
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    expect(injected.facts).toContainEqual({
      scope: "user",
      projectId: "",
      tier: "profile",
      via: learner.botId,
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

  test("a Bot may not write another Bot's shard of a shared Memory root", async () => {
    const suffix = crypto.randomUUID();
    const userId = `memory-user-${suffix}`;
    const identity = { userId, botId: `memory-bot-c-${suffix}` };
    await provisionBot(identity);
    const stub = bot(`memory-c-${suffix}`);

    const refused = await stub.writeWorkspaceFile({
      root: userMemoryRoot(userId),
      path: `by-agent/${identity.botId}-other/profile.md`,
      text: "- (2026-08-31) Forged.\n",
      writer: {
        kind: "bot",
        botId: identity.botId,
        sessionId: `${userId}:${identity.botId}`,
        turnId: "t",
        runId: "r",
      },
      expectedGenerationId: null,
    });

    // The kernel surface refuses every Memory root outright, which is the
    // stronger of the two refusals and the one the constitution names.
    expect(refused.status).toBe("refused");
  });
});
