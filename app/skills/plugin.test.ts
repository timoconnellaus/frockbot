import { describe, expect, test } from "bun:test";
import { loadPluginSkillsV1 } from "./plugin.js";
import { skillMarkdown } from "./testing.js";
import { SKILL_MAX_FILE_BYTES, SKILL_MAX_REFERENCES } from "./skill-md.js";

const DOCUMENT = skillMarkdown(
  "Draft an email",
  "Use this when the User wants an email drafted.",
  "Body.",
);

describe("the Skills a Plugin contributes", () => {
  test("loads one under its Plugin's ref, attributed to the Plugin", async () => {
    const loaded = await loadPluginSkillsV1([
      {
        pluginId: "email-card",
        displayName: "Email",
        skills: [
          {
            slug: "drafting",
            text: DOCUMENT,
            references: [{ path: "forms.md", text: "# Forms" }],
          },
        ],
      },
    ]);

    expect(loaded.refusals).toEqual([]);
    expect(loaded.skills[0]).toMatchObject({
      path: "plugin/email-card/drafting/SKILL.md",
      source: "plugin",
      ref: {
        schemaVersion: 1,
        source: "plugin",
        pluginId: "email-card",
        slug: "drafting",
      },
      by: 'Plugin "Email"',
      name: "Draft an email",
      references: [
        {
          path: "plugin/email-card/drafting/references/forms.md",
          text: "# Forms",
        },
      ],
    });
  });

  test("a malformed document is a refusal, not a throw that takes the Turn with it", async () => {
    const loaded = await loadPluginSkillsV1([
      {
        pluginId: "email-card",
        skills: [
          { slug: "drafting", text: "no frontmatter here" },
          { slug: "Drafting", text: DOCUMENT },
        ],
      },
    ]);

    expect(loaded.skills).toEqual([]);
    expect(loaded.refusals.map((refusal) => refusal.kind)).toEqual([
      "malformed",
      "malformed",
    ]);
  });

  test("refuses a Skill whose references are past a bound", async () => {
    const overCount = await loadPluginSkillsV1([
      {
        pluginId: "email-card",
        skills: [
          {
            slug: "drafting",
            text: DOCUMENT,
            references: Array.from(
              { length: SKILL_MAX_REFERENCES + 1 },
              (_, index) => ({ path: `r${index}.md`, text: "#" }),
            ),
          },
        ],
      },
    ]);
    expect(overCount.skills).toEqual([]);
    expect(overCount.refusals[0]).toMatchObject({ kind: "oversized" });

    const overSize = await loadPluginSkillsV1([
      {
        pluginId: "email-card",
        skills: [
          {
            slug: "drafting",
            text: DOCUMENT,
            references: [
              { path: "big.md", text: "x".repeat(SKILL_MAX_FILE_BYTES + 1) },
            ],
          },
        ],
      },
    ]);
    expect(overSize.skills).toEqual([]);
    expect(overSize.refusals[0]?.reason).toContain("big.md");
  });
});
