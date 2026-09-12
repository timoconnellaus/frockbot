// The Skill catalog's live sources, assembled inside a real Bot Durable Object
// over real storage.
//
// The claim: a Bot's catalog draws from its own instruction root and from the
// managed set compiled into the Skills Package's artifact, and an install or
// uninstall of a Package moves neither — nothing about a Package's presence
// writes to, or removes from, an instruction root.
//
// It is read back through the production loader the Turn itself uses. The
// Turn-level claim — that the catalog is injected under the Composition the
// Turn pinned — belongs to `test/integration/skills-sources.integration.ts`,
// where a real Turn records `composition/pinned` and `skill/injected` together.
import { env } from "cloudflare:workers";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

const MANAGED_PATHS = [
  "managed/add-connector/SKILL.md",
  "managed/applets/SKILL.md",
  "managed/export-bot-template/SKILL.md",
  "managed/import-bot-template/SKILL.md",
  "managed/learn-from-demonstration/SKILL.md",
  "managed/plugins/SKILL.md",
];

function bot(name: string) {
  return env.BOT_STATES.getByName(name);
}

describe("the Skill catalog's sources in Workerd", () => {
  test("draws from the Bot's root and the managed set, and an uninstall moves neither", async () => {
    const suffix = crypto.randomUUID().slice(0, 8);
    const userId = `skills-user-${suffix}`;
    const identity = { userId, botId: `skills-bot-${suffix}` };
    await provisionBot(identity);

    const stub = bot(identity.botId);
    // The Bot's own Skill, written straight to its instruction root through the
    // production Workspace surface this object serves.
    await stub.writeWorkspaceFile({
      userId: identity.userId,
      root: {
        kind: "bot-instructions",
        userId: identity.userId,
        botId: identity.botId,
      },
      path: "skills/roster/SKILL.md",
      text: "---\nname: Own roster\ndescription: Use this when rostering.\n---\n\nOwn body.\n",
      writer: {
        kind: "bot",
        botId: identity.botId,
        sessionId: `${identity.userId}:${identity.botId}`,
        turnId: "turn-1",
        runId: "run-1",
      },
      expectedGenerationId: null,
    });

    const loaded = await stub.skillCatalogProbe(identity);

    expect(loaded.skills.map((skill) => skill.path)).toEqual([
      "skills/roster/SKILL.md",
      ...MANAGED_PATHS,
    ]);
    expect(loaded.refusals).toEqual([]);
    expect(loaded.compositionGenerationId.length).toBeGreaterThan(0);

    const again = await stub.skillCatalogProbe(identity);

    // The managed bodies are the artifact's, so they did not move: the same
    // Composition is mounted and the same content hashes come back.
    expect(again.compositionGenerationId).toBe(loaded.compositionGenerationId);
    expect(
      again.skills
        .filter((skill) => skill.path.startsWith("managed/"))
        .map((skill) => skill.generationId),
    ).toEqual(
      loaded.skills
        .filter((skill) => skill.path.startsWith("managed/"))
        .map((skill) => skill.generationId),
    );
    expect(again.refusals).toEqual([]);
  });
});
