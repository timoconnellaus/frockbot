/// <reference types="bun" />
/*
 * A Skill is a directory (ADR 0030), so the generator copies one where it used
 * to copy a file. Nothing else proves that a reference authored beside a
 * managed `SKILL.md` reaches the bundle: `--check` is what the typecheck gate
 * runs, so a generator that silently ignored `references/` would keep passing.
 *
 * Every Skill directory here is a temporary one of this test's own making, and
 * the generated module is imported as the Worker imports it — the module is
 * the generator's output contract, so it is executed rather than scanned.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  managedSkillModule,
  PLUGIN_SKILL_SOURCE,
  PLUGIN_TYPES_REFERENCE,
  pluginTypesReference,
  skillDirectory,
} from "./build-applets-assets";
import { SDK_PLUGIN_TYPES } from "../applets/sdk/src/build/paths";
import {
  PLUGINS_SKILL_DOCUMENT_V1,
  PLUGINS_SKILL_REFERENCES_V1,
} from "../app/skills/managed-plugins.generated";
import {
  parseSkillDocumentV1,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_REFERENCES,
} from "../app/skills/skill-md";

const made: string[] = [];

/** A working directory outside the checkout, so nothing here survives as source. */
function scratch(files: Record<string, string>): string {
  const directory = mkdtempSync(join(tmpdir(), "skill-directory-"));
  made.push(directory);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true });
    writeFileSync(join(directory, path), text);
  }
  return directory;
}

const authored = (files: Record<string, string>): URL =>
  pathToFileURL(`${scratch(files)}/`);

afterEach(() => {
  while (made.length > 0) {
    rmSync(made.pop() as string, { recursive: true, force: true });
  }
});

const DOCUMENT =
  "---\nname: A\ndescription: Use this when testing.\n---\nBody.\n";

describe("the managed Skill generator", () => {
  test("reads a Skill's SKILL.md and the Markdown under references/, and nothing else", async () => {
    const skill = await skillDirectory(
      authored({
        "SKILL.md": DOCUMENT,
        "references/forms.md": "# Forms\n",
        "references/a-layout.md": "# Layout\n",
        // Not Markdown, and not under `references/`: neither is a reference.
        "references/notes.txt": "not markdown\n",
        "scratch.md": "beside the Skill\n",
      }),
    );

    expect(skill.text).toBe(DOCUMENT);
    expect(skill.references).toEqual([
      { path: "a-layout.md", text: "# Layout\n" },
      { path: "forms.md", text: "# Forms\n" },
    ]);
  });

  test("a Skill with nothing beside it carries no references", async () => {
    const skill = await skillDirectory(authored({ "SKILL.md": DOCUMENT }));
    expect(skill.references).toEqual([]);
  });

  test("fails the build on more references than the loader would admit", async () => {
    const files: Record<string, string> = { "SKILL.md": DOCUMENT };
    for (let index = 0; index <= SKILL_MAX_REFERENCES; index += 1) {
      files[`references/r${index}.md`] = `# ${index}\n`;
    }
    await expect(skillDirectory(authored(files))).rejects.toThrow(
      `the bound is ${SKILL_MAX_REFERENCES}`,
    );
  });

  test("fails the build on a SKILL.md the loader would refuse as oversized", async () => {
    const oversized = `${DOCUMENT}${"x".repeat(SKILL_MAX_FILE_BYTES)}`;
    expect(parseSkillDocumentV1(oversized).status).toBe("malformed");
    await expect(
      skillDirectory(authored({ "SKILL.md": oversized })),
    ).rejects.toThrow(`larger than ${SKILL_MAX_FILE_BYTES} bytes`);
  });

  test("a reference authored beside a SKILL.md reaches the generated module", async () => {
    const source = await managedSkillModule({
      prefix: "PLUGINS",
      slug: "plugins",
      authoredAt: "a temporary directory",
      directory: authored({
        "SKILL.md": DOCUMENT,
        "references/forms.md": "# Forms\nOne per person.\n",
      }),
    });
    const module = join(scratch({}), "managed.generated.ts");
    writeFileSync(module, source);

    // Imported the way the Worker bundle imports it: the module is the
    // contract, so what it exports is what the assertion reads.
    const generated = (await import(pathToFileURL(module).href)) as {
      PLUGINS_SKILL_SLUG_V1: string;
      PLUGINS_SKILL_DOCUMENT_V1: string;
      PLUGINS_SKILL_REFERENCES_V1: ReadonlyArray<{
        path: string;
        text: string;
      }>;
    };
    expect(generated.PLUGINS_SKILL_SLUG_V1).toBe("plugins");
    expect(generated.PLUGINS_SKILL_DOCUMENT_V1).toBe(DOCUMENT);
    expect(generated.PLUGINS_SKILL_REFERENCES_V1).toEqual([
      { path: "forms.md", text: "# Forms\nOne per person.\n" },
    ]);
  });

  test("the Plugins Skill's types.md is the exact file plugin_check resolves", async () => {
    const declarations = await Bun.file(SDK_PLUGIN_TYPES).text();
    const reference = await pluginTypesReference();
    // Byte for byte inside one fence: nothing summarised, nothing dropped.
    const fenced = /^(`{3,})ts\n([\s\S]*)\n\1$/m.exec(reference)?.[2];
    expect(fenced).toBe(declarations.trimEnd());
    // What ships is what the generator makes from that file.
    const shipped = PLUGINS_SKILL_REFERENCES_V1.find(
      (entry) => entry.path === "types.md",
    );
    expect(shipped?.text).toBe(reference);
    expect(
      await Bun.file(
        new URL(`../${PLUGIN_TYPES_REFERENCE}`, import.meta.url),
      ).text(),
    ).toBe(reference);
  });

  test("the committed Plugins Skill carries what its directory holds", async () => {
    const plugins = await skillDirectory(PLUGIN_SKILL_SOURCE);
    expect(PLUGINS_SKILL_DOCUMENT_V1).toBe(plugins.text);
    expect(PLUGINS_SKILL_REFERENCES_V1).toEqual(plugins.references);
  });
});
