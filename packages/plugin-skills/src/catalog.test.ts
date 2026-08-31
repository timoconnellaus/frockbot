import { describe, expect, test } from "bun:test";
import type { WorkspaceRootV1 } from "@frockbot/kernel-contracts";
import {
  botInstructionRootV1,
  loadSkillCatalogV1,
  renderSkillCatalogPromptV1,
  SKILL_MAX_CATALOG_ENTRIES,
} from "./catalog.js";
import { FakeWorkspace, skillMarkdown } from "./testing.js";

const OWNER = { userId: "user-1", botId: "bot-1" };
const OWN_ROOT = botInstructionRootV1(OWNER);
const OTHER_BOT_ROOT: WorkspaceRootV1 = {
  kind: "bot-instructions",
  userId: "user-1",
  botId: "bot-2",
};
const MEMORY_ROOT: WorkspaceRootV1 = {
  kind: "bot-memory",
  userId: "user-1",
  botId: "bot-1",
};

const BOT_WRITER = {
  kind: "bot" as const,
  botId: "bot-1",
  sessionId: "session-1",
  turnId: "turn-1",
  runId: "run-1",
};
const USER_WRITER = { kind: "user" as const, userId: "user-1" };

describe("the Skills loader", () => {
  test("loads only Skills the Bot or its User wrote under its own root", async () => {
    const workspace = await FakeWorkspace.seeded([
      {
        root: OWN_ROOT,
        path: "skills/bot-authored/SKILL.md",
        text: skillMarkdown(
          "bot-authored",
          "Use this when the Bot wrote it.",
          "Body.",
        ),
        writer: BOT_WRITER,
      },
      {
        root: OWN_ROOT,
        path: "skills/user-authored/SKILL.md",
        text: skillMarkdown(
          "user-authored",
          "Use this when the User wrote it.",
          "Body.",
        ),
        writer: USER_WRITER,
      },
      {
        root: OWN_ROOT,
        path: "skills/package-authored/SKILL.md",
        text: skillMarkdown("package-authored", "Use this never.", "Body."),
        writer: { kind: "first-party", packageId: "memory" },
      },
      {
        root: OWN_ROOT,
        path: "skills/other-bot-authored/SKILL.md",
        text: skillMarkdown("other-bot", "Use this never.", "Body."),
        writer: { ...BOT_WRITER, botId: "bot-2" },
      },
      {
        root: OWN_ROOT,
        path: "skills/other-user-authored/SKILL.md",
        text: skillMarkdown("other-user", "Use this never.", "Body."),
        writer: { kind: "user", userId: "user-2" },
      },
    ]);

    const catalog = await loadSkillCatalogV1(workspace, OWNER);

    expect(catalog.skills.map((skill) => skill.name)).toEqual([
      "bot-authored",
      "user-authored",
    ]);
    expect(
      catalog.refusals.map((refusal) => [refusal.path, refusal.kind]),
    ).toEqual([
      ["skills/other-bot-authored/SKILL.md", "authority"],
      ["skills/other-user-authored/SKILL.md", "authority"],
      ["skills/package-authored/SKILL.md", "authority"],
    ]);
    // Every refused candidate was refused before its body was ever read.
    expect(workspace.calls).not.toContain(
      "read:skills/package-authored/SKILL.md",
    );
  });

  test("never loads a file outside the instruction root, however it is named", async () => {
    const workspace = await FakeWorkspace.seeded([
      {
        root: MEMORY_ROOT,
        path: "skills/memory-shaped/SKILL.md",
        text: skillMarkdown("memory-shaped", "Use this never.", "Body."),
        writer: BOT_WRITER,
      },
      {
        root: OTHER_BOT_ROOT,
        path: "skills/other-root/SKILL.md",
        text: skillMarkdown("other-root", "Use this never.", "Body."),
        writer: BOT_WRITER,
      },
    ]);

    // A Workspace that answered a listing of the Bot's root with foreign
    // entries would still get nowhere: the predicate decides, not the caller.
    const leaky = {
      read: (path: Parameters<typeof workspace.read>[0]) =>
        workspace.read(path),
      stat: (path: Parameters<typeof workspace.stat>[0]) =>
        workspace.stat(path),
      list: () =>
        workspace.list({ root: MEMORY_ROOT }).then((memory) =>
          workspace.list({ root: OTHER_BOT_ROOT }).then((other) =>
            memory.status === "ok" && other.status === "ok"
              ? {
                  status: "ok" as const,
                  entries: [...memory.entries, ...other.entries],
                }
              : memory,
          ),
        ),
    };

    const catalog = await loadSkillCatalogV1(leaky, OWNER);
    expect(catalog.skills).toEqual([]);
    expect(catalog.refusals).toHaveLength(2);
    expect(
      catalog.refusals.every((refusal) => refusal.kind === "authority"),
    ).toBe(true);
  });

  test("refuses a malformed Skill without failing the load", async () => {
    const workspace = await FakeWorkspace.seeded([
      {
        root: OWN_ROOT,
        path: "skills/broken/SKILL.md",
        text: "# no frontmatter\n",
        writer: BOT_WRITER,
      },
      {
        root: OWN_ROOT,
        path: "skills/good/SKILL.md",
        text: skillMarkdown("good", "Use this when it parses.", "Body."),
        writer: BOT_WRITER,
      },
      {
        root: OWN_ROOT,
        path: "notes.md",
        text: "not a Skill",
        writer: BOT_WRITER,
      },
    ]);

    const catalog = await loadSkillCatalogV1(workspace, OWNER);
    expect(catalog.skills.map((skill) => skill.name)).toEqual(["good"]);
    expect(catalog.refusals).toEqual([
      {
        path: "skills/broken/SKILL.md",
        kind: "malformed",
        reason: "SKILL.md must open with a --- frontmatter fence",
      },
    ]);
  });

  test("an unreadable instruction root yields no instructions and says so", async () => {
    const workspace = await FakeWorkspace.seeded([]);
    workspace.listFailure = {
      status: "unavailable",
      reason: "the durable root is not synchronized",
    };
    const catalog = await loadSkillCatalogV1(workspace, OWNER);
    expect(catalog.skills).toEqual([]);
    expect(catalog.refusals[0]?.kind).toBe("unreadable");
  });

  test("bounds the catalog", async () => {
    const workspace = new FakeWorkspace();
    for (let index = 0; index < 4; index += 1) {
      await workspace.seed({
        root: OWN_ROOT,
        path: `skills/s${index}/SKILL.md`,
        text: skillMarkdown(`s${index}`, "Use this when counting.", "Body."),
        writer: BOT_WRITER,
      });
    }
    const catalog = await loadSkillCatalogV1(workspace, OWNER, {
      maxSkills: 2,
    });
    expect(catalog.skills).toHaveLength(2);
    expect(catalog.refusals.map((refusal) => refusal.kind)).toEqual([
      "over-catalog",
      "over-catalog",
    ]);
    expect(SKILL_MAX_CATALOG_ENTRIES).toBe(200);
  });

  test("renders the catalog as a progressive-disclosure prompt block", async () => {
    const workspace = await FakeWorkspace.seeded([
      {
        root: OWN_ROOT,
        path: "skills/standup/SKILL.md",
        text: skillMarkdown(
          "Daily standup",
          "Use this when assembling the <weekday> standup.",
          "Secret body text.",
        ),
        writer: USER_WRITER,
      },
    ]);
    const rendered = renderSkillCatalogPromptV1(
      await loadSkillCatalogV1(workspace, OWNER),
    );
    expect(rendered).toContain("<agent_skills>");
    expect(rendered).toContain(
      '<skill name="Daily standup" path="skills/standup/SKILL.md">Use this when assembling the &lt;weekday&gt; standup.</skill>',
    );
    expect(rendered).toContain("Mentioning a Skill is not running it.");
    // Progressive disclosure: the body is never in the prompt.
    expect(rendered).not.toContain("Secret body text.");
    expect(
      renderSkillCatalogPromptV1({ owner: OWNER, skills: [], refusals: [] }),
    ).toBe("");
  });
});
