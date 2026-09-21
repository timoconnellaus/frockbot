import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { findingsForSkillV1, type SkillFilesV1 } from "./check-managed-skills";

function skill(
  partial: Partial<SkillFilesV1> & { text: string },
): SkillFilesV1 {
  return {
    slug: partial.slug ?? "sample",
    directory: partial.directory ?? "/tmp/sample",
    text: partial.text,
    references: partial.references ?? [],
  };
}

const FRONT = `---
name: Sample
description: Use this when testing the gate.
---
`;

describe("the managed-Skill gate", () => {
  test("accepts a Skill whose description, references and tools line up", () => {
    expect(
      findingsForSkillV1(
        skill({
          text: `${FRONT}# Sample\n\nCall \`skill_write\`.\n\n- \`forms.md\`\n`,
          references: [{ path: "forms.md", text: "# Forms\n" }],
        }),
        ["skill_write"],
      ),
    ).toEqual([]);
  });

  test("refuses a body that names a GrokBot-only tool", () => {
    expect(
      findingsForSkillV1(
        skill({
          text: `${FRONT}Call SearchPlugins then stop.\n`,
        }),
      ),
    ).toEqual([
      "sample: names SearchPlugins, which this product does not offer",
    ]);
  });

  test("refuses a reference the SKILL.md index omitted", () => {
    expect(
      findingsForSkillV1(
        skill({
          text: `${FRONT}No index.\n`,
          references: [{ path: "forms.md", text: "# Forms\n" }],
        }),
      ),
    ).toEqual(["sample: SKILL.md does not list reference `forms.md`"]);
  });

  test("refuses a description that is not a when-clause", () => {
    expect(
      findingsForSkillV1(
        skill({
          text: `---\nname: Sample\ndescription: How this works.\n---\nBody.\n`,
        }),
      ),
    ).toEqual([
      'sample: description must start with "Use this when" or "Use this whenever"',
    ]);
  });

  test("uses a real directory only as an authored fixture, not the checkout", () => {
    const directory = mkdtempSync(join(tmpdir(), "managed-skill-"));
    mkdirSync(join(directory, "references"));
    writeFileSync(join(directory, "SKILL.md"), `${FRONT}- \`note.md\`\n`);
    writeFileSync(join(directory, "references", "note.md"), "# Note\n");
    expect(
      findingsForSkillV1({
        slug: "sample",
        directory,
        text: `${FRONT}- \`note.md\`\n`,
        references: [{ path: "note.md", text: "# Note\n" }],
      }),
    ).toEqual([]);
  });
});
