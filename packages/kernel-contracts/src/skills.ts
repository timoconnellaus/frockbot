// How a Turn names one Skill.
//
// A `SkillRefV1` is the wire identity of a Skill: it crosses the client's turn
// command, the Bot Durable Object's run RPC, the Agent loop's queued input, and
// the durable session log. That is why it lives in the kernel rather than in
// `plugin-skills` — "Cross-runtime communication uses narrow, versioned DTOs,
// and every inbound value is decoded at its seam", and the seam here is a
// kernel event. What a ref *resolves to* is Package policy and stays in
// `plugin-skills`: the kernel holds the name and no opinion about the file.
//
/** Where a Skill comes from. */
export type SkillRefSourceV1 = "bot" | "user" | "managed";

/** The declared sources, in the catalog's canonical ordering. */
export const SKILL_REF_SOURCES_V1: readonly SkillRefSourceV1[] = [
  "bot",
  "user",
  "managed",
];

/**
 * One Skill named for invocation.
 *
 * Every source is unique on its slug alone, so refs are globally unique and
 * there is no shadowing rule.
 */
export interface SkillRefV1 {
  schemaVersion: 1;
  source: SkillRefSourceV1;
  slug: string;
}

/** Most Skills one Turn may invoke. */
export const MAX_INVOKED_SKILLS_V1 = 3;

const SKILL_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** True when a slug is well formed. Total; never throws. */
export function isSkillRefSlugV1(value: unknown): value is string {
  return typeof value === "string" && SKILL_SLUG_PATTERN.test(value);
}

/** The canonical string form: `bot/<slug>`. */
export function formatSkillRefV1(ref: SkillRefV1): string {
  return `${ref.source}/${ref.slug}`;
}

/**
 * Reads the canonical string form back. Returns `undefined` rather than
 * throwing: a ref arriving as text is untrusted input like any other.
 */
export function parseSkillRefV1(value: unknown): SkillRefV1 | undefined {
  if (typeof value !== "string") return undefined;
  const segments = value.split("/");
  const source = SKILL_REF_SOURCES_V1.find(
    (candidate) => candidate === segments[0],
  );
  if (!source) return undefined;
  if (segments.length !== 2) return undefined;
  const slug = segments[1] ?? "";
  if (!SKILL_SLUG_PATTERN.test(slug)) return undefined;
  return { schemaVersion: 1, source, slug };
}

/**
 * The strict decoder for one ref crossing a seam. Exact keys: an unknown field
 * is a refusal, never a value carried through to durable state.
 */
export function decodeSkillRefV1(
  value: unknown,
  label = "skill ref",
): SkillRefV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const candidate = value as Record<string, unknown>;
  const allowed = new Set(["schemaVersion", "source", "slug"]);
  for (const key of Reflect.ownKeys(candidate)) {
    if (typeof key !== "string" || !allowed.has(key)) {
      throw new Error(`${label} has unknown fields`);
    }
  }
  if (candidate.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is invalid`);
  }
  const source = SKILL_REF_SOURCES_V1.find(
    (declared) => declared === candidate.source,
  );
  if (!source) throw new Error(`${label}.source is invalid`);
  if (!isSkillRefSlugV1(candidate.slug)) {
    throw new Error(`${label}.slug is invalid`);
  }
  return { schemaVersion: 1, source, slug: candidate.slug };
}

/**
 * The strict decoder for the list one Turn invokes. Bounded at
 * {@link MAX_INVOKED_SKILLS_V1}, and duplicates are refused: invoking the same
 * Skill twice would expand its body twice with no way to say which won.
 */
export function decodeSkillRefsV1(
  value: unknown,
  label = "skill refs",
): SkillRefV1[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > MAX_INVOKED_SKILLS_V1) {
    throw new Error(
      `${label} may name at most ${MAX_INVOKED_SKILLS_V1} Skills`,
    );
  }
  const refs = value.map((entry, index) =>
    decodeSkillRefV1(entry, `${label}[${index}]`),
  );
  const seen = new Set<string>();
  for (const ref of refs) {
    const canonical = formatSkillRefV1(ref);
    if (seen.has(canonical)) {
      throw new Error(`${label} names "${canonical}" more than once`);
    }
    seen.add(canonical);
  }
  return refs;
}
