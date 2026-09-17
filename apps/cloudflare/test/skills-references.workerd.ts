// The bound on a Skill's references, over real storage (ADR 0030 step 2).
//
// "A Skill past either bound … is refused whole with a recorded refusal and
// never partially loaded." Driven inside a real Bot Durable Object, against
// the real Workspace bucket and its generation ledger, and read back through
// the production loader the Turn itself uses: a Skill carrying one reference
// too many is not in the catalog at all, and the refusal names it.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

/** The loader's bound; a Skill holding more than this is refused whole. */
const SKILL_MAX_REFERENCES = 32;

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

describe("a Skill's references in Workerd", () => {
  test("one reference too many refuses the whole Skill, and the sibling Skill still loads", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userId = `skill-bound-${suffix}`;
    const identity = { userId, botId: `skill-bound-bot-${suffix}` };
    await provisionBot(identity);

    const stub = bot(identity.botId);
    const root = {
      kind: "bot-instructions" as const,
      userId: identity.userId,
      botId: identity.botId,
    };
    const writer = {
      kind: "bot" as const,
      botId: identity.botId,
      sessionId: `${identity.userId}:${identity.botId}`,
      turnId: "turn-1",
      runId: "run-1",
    };
    const write = async (path: string, text: string) => {
      const outcome = await stub.writeWorkspaceFile({
        userId: identity.userId,
        root,
        path,
        text,
        writer,
        expectedGenerationId: null,
      });
      expect(outcome.status).toBe("ok");
    };

    // A well-formed neighbour, so the refusal is shown to be about the one
    // Skill rather than about the root.
    await write(
      "skills/roster/SKILL.md",
      "---\nname: Roster\ndescription: Use this when rostering.\n---\n\nBody.\n",
    );
    await write("skills/roster/references/shifts.md", "The shift table.\n");

    await write(
      "skills/standup/SKILL.md",
      "---\nname: Standup\ndescription: Use this when standing up.\n---\n\nBody.\n",
    );
    for (let index = 0; index <= SKILL_MAX_REFERENCES; index += 1) {
      await write(
        `skills/standup/references/note-${index}.md`,
        `Note ${index}.\n`,
      );
    }

    const loaded = await stub.skillCatalogProbe(identity);

    // The over-full Skill is absent from the catalog entirely — not listed
    // with its references trimmed to the bound.
    expect(
      loaded.skills
        .map((skill) => skill.path)
        .filter((path) => path.startsWith("skills/")),
    ).toEqual(["skills/roster/SKILL.md"]);
    // And the refusal is recorded against it, naming the bound.
    const refusal = loaded.refusals.find((entry) =>
      entry.path.startsWith("skills/standup/"),
    );
    expect(refusal, JSON.stringify(loaded.refusals)).toBeDefined();
    expect(refusal?.reason).toContain(String(SKILL_MAX_REFERENCES));

    // The neighbour still carries its own reference, so the bound refused one
    // Skill and left the root working.
    expect(
      loaded.refusals.filter((entry) =>
        entry.path.startsWith("skills/roster/"),
      ),
    ).toEqual([]);
  });
});
