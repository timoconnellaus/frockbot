// The User-global instruction root, written by two Bot Durable Objects over
// real R2 and real Durable Object storage.
//
// ADR 0016 gives one User one `user-instructions` root at `users/<id>/skills/`,
// shared by every Bot that User owns and written only through object storage.
// Three claims a Bun double cannot make, because all three are about the
// deployed pieces:
//
//  1. Two Bots of one User write the same root and both Skills survive. Bot B
//     loads Bot A's Skill and is told Bot A wrote it.
//  2. The conditional write is still conditional across Durable Objects. A
//     stale `expectedGenerationId` from the other Bot loses, and the loser is
//     preserved under its conflict key rather than dropped.
//  3. Authority does not widen. A first-party writer is refused, and a Bot of
//     one User cannot reach another User's root through its own store.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import type {
  WorkspaceRootV1,
  WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

function userSkillsRoot(userId: string): WorkspaceRootV1 {
  return { kind: "user-instructions", userId };
}

function writerFor(userId: string, botId: string): WorkspaceWriterV1 {
  return {
    kind: "bot",
    botId,
    sessionId: `${userId}:${botId}`,
    turnId: "turn-1",
    runId: "run-1",
  };
}

function skill(name: string, description: string, body: string): string {
  return `---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
}

describe("the User-global instruction root in Workerd", () => {
  test("two Bots of one User share the root, and each is told who wrote what", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userId = `user-skills-${suffix}`;
    const alice = { userId, botId: `alice-${suffix}` };
    const bob = { userId, botId: `bob-${suffix}` };
    await provisionBot(alice);
    // The Flock's revision has moved on by one Bot.
    await provisionSiblingBot(bob, 1);
    const root = userSkillsRoot(userId);

    const written = await bot(alice.botId).writeWorkspaceFile({
      userId,
      root,
      path: "standup/SKILL.md",
      text: skill(
        "Daily standup",
        "Use this when assembling the standup.",
        "Ask each Bot for its blockers.",
      ),
      writer: writerFor(userId, alice.botId),
      expectedGenerationId: null,
    });
    expect(written.status).toBe("ok");

    // The second Bot writes the same root, through its own Durable Object and
    // its own generation ledger.
    const sibling = await bot(bob.botId).writeWorkspaceFile({
      userId,
      root,
      path: "house-style/SKILL.md",
      text: skill(
        "House style",
        "Use this when writing for this User.",
        "Short sentences.",
      ),
      writer: writerFor(userId, bob.botId),
      expectedGenerationId: null,
    });
    expect(sibling.status).toBe("ok");

    // Bob reads Alice's Skill, and his own, out of the shared root.
    const bobsCatalog = await bot(bob.botId).skillCatalogProbe(bob);
    const shared = bobsCatalog.skills.filter(
      (entry) => entry.ref?.startsWith("user/") ?? false,
    );
    expect(shared.map((entry) => [entry.ref, entry.by])).toEqual([
      // Written by his sibling, and attributed to it: a Bot is told whose
      // instruction it is about to follow.
      [`user/house-style`, undefined],
      [`user/standup`, `Bot "${alice.botId}"`],
    ]);
    expect(shared.at(-1)?.generationId).toBe(written.generationId);
    expect(bobsCatalog.refusals).toEqual([]);

    // And Alice sees Bob's, attributed to Bob.
    const alicesCatalog = await bot(alice.botId).skillCatalogProbe(alice);
    expect(
      alicesCatalog.skills
        .filter((entry) => entry.ref === "user/house-style")
        .map((entry) => entry.by),
    ).toEqual([`Bot "${bob.botId}"`]);
  });

  test("a stale expected generation from the other Bot conflicts, and the loser is preserved", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userId = `user-fence-${suffix}`;
    const alice = { userId, botId: `alice-${suffix}` };
    const bob = { userId, botId: `bob-${suffix}` };
    await provisionBot(alice);
    await provisionSiblingBot(bob, 1);
    const root = userSkillsRoot(userId);
    const path = "standup/SKILL.md";

    const first = await bot(alice.botId).writeWorkspaceFile({
      userId,
      root,
      path,
      text: skill("Daily standup", "Use this when standing.", "Alice's."),
      writer: writerFor(userId, alice.botId),
      expectedGenerationId: null,
    });
    expect(first.status).toBe("ok");

    // Bob supersedes it on the generation he read: a same-slug write is a
    // legitimate supersede in a shared, slug-addressed root.
    const second = await bot(bob.botId).writeWorkspaceFile({
      userId,
      root,
      path,
      text: skill("Daily standup", "Use this when standing.", "Bob's."),
      writer: writerFor(userId, bob.botId),
      expectedGenerationId: first.generationId ?? null,
    });
    expect(second.status).toBe("ok");

    // Alice writes on the generation she last saw, which Bob has replaced.
    const stale = await bot(alice.botId).writeWorkspaceFile({
      userId,
      root,
      path,
      text: skill("Daily standup", "Use this when standing.", "Stale."),
      writer: writerFor(userId, alice.botId),
      expectedGenerationId: first.generationId ?? null,
    });

    expect(stale.status).toBe("conflict");
    expect(stale.currentGenerationId).toBe(second.generationId);
    // The winner is untouched and the loser is durable, not dropped.
    expect(
      await bot(bob.botId).readWorkspaceFile({ userId, root, path }),
    ).toMatchObject({ status: "ok" });
    const winner = await bot(bob.botId).readWorkspaceFile({
      userId,
      root,
      path,
    });
    expect(winner.text).toContain("Bob's.");
    const conflicts = await bot(alice.botId).workspaceConflicts({ root, path });
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.generation.generationId).toBe(
      stale.preservedGenerationId,
    );
    expect(
      await bot(alice.botId).workspaceConflictBody(
        conflicts[0]?.conflictKey ?? "",
      ),
    ).toContain("Stale.");
  });

  test("the shared root refuses a first-party writer and another User's root", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userId = `user-authority-${suffix}`;
    const alice = { userId, botId: `alice-${suffix}` };
    await provisionBot(alice);

    const firstParty = await bot(alice.botId).writeWorkspaceFile({
      userId,
      root: userSkillsRoot(userId),
      path: "shipped/SKILL.md",
      text: skill("Shipped", "Use this never.", "Body."),
      writer: { kind: "first-party", packageId: "skills" },
      expectedGenerationId: null,
    });
    expect(firstParty.status).toBe("refused");

    // A store serves one User's roots. Another User's shared root is not
    // reachable through this Bot's Workspace surface at all.
    const foreign = await bot(alice.botId).writeWorkspaceFile({
      userId,
      root: userSkillsRoot(`${userId}-other`),
      path: "foreign/SKILL.md",
      text: skill("Foreign", "Use this never.", "Body."),
      writer: writerFor(userId, alice.botId),
      expectedGenerationId: null,
    });
    expect(foreign.status).toBe("refused");
  });
});
