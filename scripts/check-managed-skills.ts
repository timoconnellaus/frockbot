// First-party Skills are recipes a Bot loads. This gate holds them to the
// product they describe: every managed Skill is a directory with `SKILL.md`
// and optional `references/`, the catalog matches that set, GrokBot-only
// tools are absent, and the tools a Skill teaches actually exist.
//
// `bun run typecheck` runs `--check`. Findings are printed and the process
// exits 1; the functions are also the unit tests' public surface, so a
// fixture Skill is checked the same way the checkout is.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BOT_ISOLATE_HOOK_EVENTS_V1 } from "../core/contracts/loop-events.ts";
import { PLUGIN_GRANTS_V1 } from "../core/contracts/plugin-descriptor.ts";
import { parseSkillDocumentV1 } from "../app/skills/skill-md.ts";
import {
  APPLET_TOOL_NAMES_V1,
  FORBIDDEN_MANAGED_SKILL_SLUGS_V1,
  FORBIDDEN_SKILL_TOKENS_V1,
  MANAGED_SKILL_AUTHORSHIPS_V1,
  PLUGIN_AUTHORING_TOOL_NAMES_V1,
} from "../app/skills/inventory.ts";
import { MANAGED_SKILL_DOCUMENTS_V1 } from "../app/skills/managed.ts";
import { seededPluginWordsV1 } from "../app/plugins/catalog.ts";

const DESCRIPTION_PREFIX = /^Use this when(?:ever)? /;

export interface SkillFilesV1 {
  slug: string;
  directory: string;
  text: string;
  references: { path: string; text: string }[];
}

function corpusOf(skill: SkillFilesV1): string {
  return [
    skill.text,
    ...skill.references.map((reference) => reference.text),
  ].join("\n");
}

function backtickFiles(text: string): Set<string> {
  const names = new Set<string>();
  for (const match of text.matchAll(/`([A-Za-z0-9._-]+\.md)`/g)) {
    const name = match[1];
    if (name) names.add(name);
  }
  return names;
}

export function findingsForSkillV1(
  skill: SkillFilesV1,
  required: readonly string[] = [],
): string[] {
  const findings: string[] = [];
  const parsed = parseSkillDocumentV1(skill.text);
  if (parsed.status !== "ok") {
    findings.push(`${skill.slug}: SKILL.md is malformed (${parsed.reason})`);
    return findings;
  }
  if (!DESCRIPTION_PREFIX.test(parsed.document.description)) {
    findings.push(
      `${skill.slug}: description must start with "Use this when" or "Use this whenever"`,
    );
  }
  const listed = backtickFiles(skill.text);
  const offered = new Set(skill.references.map((reference) => reference.path));
  for (const path of offered) {
    if (!listed.has(path)) {
      findings.push(
        `${skill.slug}: SKILL.md does not list reference \`${path}\``,
      );
    }
  }
  const corpus = corpusOf(skill);
  for (const token of FORBIDDEN_SKILL_TOKENS_V1) {
    if (corpus.includes(token)) {
      findings.push(
        `${skill.slug}: names ${token}, which this product does not offer`,
      );
    }
  }
  for (const token of required) {
    if (!corpus.includes(token)) {
      findings.push(`${skill.slug}: does not teach ${token}`);
    }
  }
  return findings;
}

function requiredTokensFor(slug: string): readonly string[] {
  switch (slug) {
    case "add-connector":
      return ["send_to_user", "Marketplace", "Connectors"];
    case "export-bot-template":
      return ["bot_export_template"];
    case "import-bot-template":
      return ["cannot import"];
    case "write-skill":
      return ["skill_write", "skill_load", "reference"];
    case "applets":
      return APPLET_TOOL_NAMES_V1;
    case "plugins":
      return [
        ...PLUGIN_AUTHORING_TOOL_NAMES_V1,
        ...BOT_ISOLATE_HOOK_EVENTS_V1.map((event) => `\`${event}\``),
        ...PLUGIN_GRANTS_V1.map((grant) => `\`${grant}\``),
      ];
    case "a2ui":
      return ["send_to_user", "skill_load"];
    default:
      return [];
  }
}

function readSkillDirectoryV1(directory: string, slug: string): SkillFilesV1 {
  const text = readFileSync(resolve(directory, "SKILL.md"), "utf8");
  const referencesDirectory = resolve(directory, "references");
  const references = existsSync(referencesDirectory)
    ? readdirSync(referencesDirectory)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((path) => ({
          path,
          text: readFileSync(resolve(referencesDirectory, path), "utf8"),
        }))
    : [];
  return { slug, directory, text, references };
}

export function findingsForCheckoutV1(root: string): string[] {
  const findings: string[] = [];
  for (const slug of FORBIDDEN_MANAGED_SKILL_SLUGS_V1) {
    const path = resolve(root, "app/skills/managed-skills", slug);
    if (existsSync(path)) {
      findings.push(
        `${slug} must not ship: this product cannot run that procedure`,
      );
    }
  }
  const authored = new Set(
    MANAGED_SKILL_AUTHORSHIPS_V1.map((entry) => entry.slug),
  );
  const bundled = MANAGED_SKILL_DOCUMENTS_V1.map((document) => document.slug);
  for (const slug of authored) {
    if (!bundled.includes(slug)) {
      findings.push(
        `${slug} is authored but not in MANAGED_SKILL_DOCUMENTS_V1`,
      );
    }
  }
  for (const slug of bundled) {
    if (!authored.has(slug)) {
      findings.push(
        `${slug} is bundled but missing from the authored inventory`,
      );
    }
  }
  for (const entry of MANAGED_SKILL_AUTHORSHIPS_V1) {
    const directory = resolve(root, entry.directory);
    if (!existsSync(resolve(directory, "SKILL.md"))) {
      findings.push(`${entry.slug}: missing ${entry.directory}/SKILL.md`);
      continue;
    }
    findings.push(
      ...findingsForSkillV1(
        readSkillDirectoryV1(directory, entry.slug),
        requiredTokensFor(entry.slug),
      ),
    );
  }
  const seededRoot = resolve(root, "app/plugins/seeded");
  for (const pluginId of readdirSync(seededRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()) {
    const directory = resolve(seededRoot, pluginId);
    const hasSkill = existsSync(resolve(directory, "SKILL.md"));
    const seed = seededPluginWordsV1(pluginId).seed;
    if (seed === "locked" && hasSkill) {
      findings.push(
        `${pluginId}: locked card Plugins ship no Skill; send_to_user already teaches them`,
      );
    }
    if (seed !== "locked" && !hasSkill) {
      findings.push(
        `${pluginId}: seeded Plugins that the Bot must operate ship a SKILL.md`,
      );
    }
    if (hasSkill) {
      const required =
        pluginId === "email"
          ? ["email_draft", "email_send", "email_discard"]
          : [];
      findings.push(
        ...findingsForSkillV1(
          readSkillDirectoryV1(directory, pluginId),
          required,
        ),
      );
    }
  }
  return findings;
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  const findings = findingsForCheckoutV1(root);
  if (findings.length > 0) {
    for (const finding of findings) console.error(finding);
    process.exit(1);
  }
  console.log(
    `managed Skills: ${MANAGED_SKILL_AUTHORSHIPS_V1.length} first-party recipes match the inventory.`,
  );
}
