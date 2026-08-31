// The `SKILL.md` format, decoded.
//
// Parity target: GrokBot's skill format (`docs/research/grokbot-computer.md`
// §2.8) — "a folder containing one `SKILL.md`: YAML frontmatter with `name`
// and `description` ("use this when …"), then a markdown recipe body". pi and
// Claude use the same shape (`docs/research/pi-coding-agent.md` §14), so a
// FrockBot instruction root is portable to and from those harnesses.
//
// Deliberately not a YAML parser. A Skill is untrusted content that becomes
// part of a system prompt, so the frontmatter grammar accepted here is the
// smallest one that reads every skill the parity target writes: `key: value`
// lines, one per line, optionally quoted, no nesting, no anchors, no aliases,
// no multi-line scalars. Anything else is a refusal, never a partial parse.

/** Longest `SKILL.md` accepted, in bytes. Well under `WORKSPACE_MAX_FILE_BYTES`. */
export const SKILL_MAX_FILE_BYTES = 65_536;
/** Longest `name`, matching the Agent Skills standard. */
export const SKILL_MAX_NAME_LENGTH = 64;
/** Longest `description`, matching the Agent Skills standard. */
export const SKILL_MAX_DESCRIPTION_LENGTH = 1_024;
/** Most frontmatter keys read before the file is refused as malformed. */
export const SKILL_MAX_FRONTMATTER_KEYS = 32;
/** The file name that marks a directory as a Skill. */
export const SKILL_FILE_NAME = "SKILL.md";
/** The directory, relative to the instruction root, a written Skill lands in. */
export const SKILL_DIRECTORY = "skills";

const SLUG = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** One parsed `SKILL.md`. `body` is the markdown recipe after the frontmatter. */
export interface SkillDocumentV1 {
  name: string;
  description: string;
  body: string;
}

/** A `SKILL.md` that could not be parsed. Declared, never thrown at the caller. */
export interface SkillParseFailureV1 {
  reason: string;
}

export type SkillParseOutcomeV1 =
  | { status: "ok"; document: SkillDocumentV1 }
  | ({ status: "malformed" } & SkillParseFailureV1);

function unquote(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' || first === "'") && first === last) {
      return value.slice(1, -1);
    }
  }
  return value;
}

function malformed(reason: string): SkillParseOutcomeV1 {
  return { status: "malformed", reason };
}

/**
 * Parses one `SKILL.md`. Total: every rejection is a `malformed` outcome, so a
 * hostile file in an instruction root cannot abort a Turn's catalog load.
 */
export function parseSkillDocumentV1(text: string): SkillParseOutcomeV1 {
  if (text.length > SKILL_MAX_FILE_BYTES) {
    return malformed(`SKILL.md exceeds ${SKILL_MAX_FILE_BYTES} bytes`);
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return malformed("SKILL.md must open with a --- frontmatter fence");
  }
  let closing = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      closing = index;
      break;
    }
  }
  if (closing < 0) {
    return malformed("SKILL.md frontmatter is not closed by ---");
  }
  const fields = new Map<string, string>();
  for (let index = 1; index < closing; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    if (fields.size >= SKILL_MAX_FRONTMATTER_KEYS) {
      return malformed("SKILL.md frontmatter has too many keys");
    }
    const separator = line.indexOf(":");
    if (separator <= 0 || line !== line.trimStart()) {
      return malformed(`SKILL.md frontmatter line ${index + 1} is invalid`);
    }
    const key = line.slice(0, separator).trim();
    if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(key)) {
      return malformed(`SKILL.md frontmatter key "${key}" is invalid`);
    }
    if (fields.has(key)) {
      return malformed(`SKILL.md frontmatter key "${key}" is duplicated`);
    }
    fields.set(key, unquote(line.slice(separator + 1).trim()));
  }
  const name = fields.get("name")?.trim() ?? "";
  const description = fields.get("description")?.trim() ?? "";
  if (!name || name.length > SKILL_MAX_NAME_LENGTH) {
    return malformed("SKILL.md frontmatter needs a bounded name");
  }
  if (!description || description.length > SKILL_MAX_DESCRIPTION_LENGTH) {
    return malformed("SKILL.md frontmatter needs a bounded description");
  }
  const body = lines
    .slice(closing + 1)
    .join("\n")
    .trim();
  if (!body) return malformed("SKILL.md has no body");
  return { status: "ok", document: { name, description, body } };
}

/** Renders a `SKILL.md`. The inverse of `parseSkillDocumentV1` for what it writes. */
export function renderSkillDocumentV1(document: SkillDocumentV1): string {
  return [
    "---",
    `name: ${document.name}`,
    `description: ${document.description}`,
    "---",
    "",
    document.body.trim(),
    "",
  ].join("\n");
}

/** True when a relative path inside a root names a Skill's `SKILL.md`. */
export function isSkillDocumentPathV1(path: string): boolean {
  const segments = path.split("/");
  return (
    segments.length >= 2 && segments[segments.length - 1] === SKILL_FILE_NAME
  );
}

/** The relative path a Skill with this slug occupies inside the instruction root. */
export function skillDocumentPathV1(slug: string): string {
  if (!SLUG.test(slug)) {
    throw new Error("skill slug must be lowercase letters, digits, or hyphens");
  }
  return `${SKILL_DIRECTORY}/${slug}/${SKILL_FILE_NAME}`;
}

/** True when a slug is well formed. Total; never throws. */
export function isSkillSlugV1(slug: unknown): slug is string {
  return typeof slug === "string" && SLUG.test(slug);
}

/** Derives a slug from a Skill name, for a `skill_write` that omits one. */
export function skillSlugFromNameV1(name: string): string | undefined {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");
  return SLUG.test(slug) ? slug : undefined;
}
