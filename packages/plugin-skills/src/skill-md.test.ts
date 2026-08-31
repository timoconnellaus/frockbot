import { describe, expect, test } from "bun:test";
import {
  isSkillDocumentPathV1,
  isSkillSlugV1,
  parseSkillDocumentV1,
  renderSkillDocumentV1,
  skillDocumentPathV1,
  skillSlugFromNameV1,
  SKILL_MAX_FILE_BYTES,
} from "./skill-md.js";

describe("SKILL.md", () => {
  test("parses GrokBot's frontmatter-plus-body shape", () => {
    const outcome = parseSkillDocumentV1(
      "---\nname: Daily standup\ndescription: Use this when assembling the weekday standup.\n---\n# Steps\n1. Ask the team.\n",
    );
    expect(outcome).toEqual({
      status: "ok",
      document: {
        name: "Daily standup",
        description: "Use this when assembling the weekday standup.",
        body: "# Steps\n1. Ask the team.",
      },
    });
  });

  test("accepts CRLF, quoted values and extra frontmatter keys", () => {
    const outcome = parseSkillDocumentV1(
      "---\r\nname: \"quoted\"\r\nlicense: MIT\r\ndescription: 'Use this when quoting.'\r\n---\r\nBody.\r\n",
    );
    expect(outcome).toMatchObject({
      status: "ok",
      document: { name: "quoted", description: "Use this when quoting." },
    });
  });

  test("refuses rather than throws on every malformed shape", () => {
    const cases = [
      ["no frontmatter", "# Just a heading\n"],
      ["unclosed frontmatter", "---\nname: a\ndescription: b\n"],
      ["missing description", "---\nname: a\n---\nbody\n"],
      ["missing name", "---\ndescription: b\n---\nbody\n"],
      ["empty body", "---\nname: a\ndescription: b\n---\n\n"],
      [
        "nested yaml",
        "---\nname: a\nmeta:\n  nested: 1\ndescription: b\n---\nbody\n",
      ],
      ["duplicate key", "---\nname: a\nname: b\ndescription: c\n---\nbody\n"],
      [
        "oversized",
        `---\nname: a\ndescription: b\n---\n${"x".repeat(SKILL_MAX_FILE_BYTES)}`,
      ],
    ] as const;
    for (const [label, text] of cases) {
      const outcome = parseSkillDocumentV1(text);
      expect([label, outcome.status]).toEqual([label, "malformed"]);
    }
  });

  test("bounds the name and the description", () => {
    expect(
      parseSkillDocumentV1(
        `---\nname: ${"n".repeat(65)}\ndescription: b\n---\nbody\n`,
      ).status,
    ).toBe("malformed");
    expect(
      parseSkillDocumentV1(
        `---\nname: a\ndescription: ${"d".repeat(1025)}\n---\nbody\n`,
      ).status,
    ).toBe("malformed");
  });

  test("renders a document the parser reads back exactly", () => {
    const document = {
      name: "daily-standup",
      description: "Use this when assembling the weekday standup.",
      body: "# Steps\n1. Ask.",
    };
    expect(parseSkillDocumentV1(renderSkillDocumentV1(document))).toEqual({
      status: "ok",
      document,
    });
  });

  test("recognises and builds Skill paths", () => {
    expect(isSkillDocumentPathV1("skills/a/SKILL.md")).toBe(true);
    expect(isSkillDocumentPathV1("workflows/a/SKILL.md")).toBe(true);
    expect(isSkillDocumentPathV1("SKILL.md")).toBe(false);
    expect(isSkillDocumentPathV1("skills/a/notes.md")).toBe(false);
    expect(skillDocumentPathV1("daily-standup")).toBe(
      "skills/daily-standup/SKILL.md",
    );
    expect(() => skillDocumentPathV1("../escape")).toThrow();
    expect(isSkillSlugV1("Daily")).toBe(false);
    expect(skillSlugFromNameV1("Daily Standup!")).toBe("daily-standup");
    expect(skillSlugFromNameV1("///")).toBeUndefined();
  });
});
