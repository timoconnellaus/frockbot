// Plugin-borne Skills: an index, never a copy.
//
// PARITY. GrokBot's `plugin-skills/cache.json` "is only an *index* of skills
// that arrived with installed plugins, mapping pluginId → name → filePath into
// `plugins/cache/…` — no `SKILL.md` lives there"
// (`docs/research/grokbot-computer.md` lines 74, 285-286). This module is that
// index. A Skill contributed by an installed Package is read from the Catalog
// entry at the generation the User is pinned to, and is never written into any
// instruction root: nothing is copied, so nothing can go stale, and an
// uninstall removes the Skill by removing the installation it was indexed
// from — visible on the Bot's next admitted Turn, like every other Skill edit.
//
// AUTHORITY. A plugin Skill is not a Workspace file and therefore never meets
// `isLoadableSkillSourceV1`. It is a Package contributing prompt content,
// admitted by an explicit act of the User — the install — and pinned to one
// immutable Catalog generation. That is the same standing a Package's tools
// have, and it is why the constitution's rule about instruction roots is
// untouched by this file.
//
// SEAM. This module names no Catalog type and reaches no bucket. The host
// supplies an already-read index through `PluginSkillsSourceV1`, so the Package
// stays testable with a plain object and the Cloudflare adapter keeps the R2
// read where the other object-storage reads live.
import {
  parseSkillDocumentV1,
  renderSkillDocumentV1,
  skillSlugFromNameV1,
} from "./skill-md.js";
import type { LoadedSkillV1, SkillRefusalV1 } from "./catalog.js";

/** The directory prefix a plugin Skill's synthetic path carries. */
export const PLUGIN_SKILL_PATH_PREFIX = "plugin";

/** One Skill as a Catalog entry declares it. */
export interface PluginSkillDeclarationV1 {
  name: string;
  description?: string;
  /** The Markdown recipe. Absent means the entry announced a Skill it does not ship. */
  body?: string;
}

/** One installed Package's Skills, at the generation the User is pinned to. */
export interface PluginSkillPackageV1 {
  packageId: string;
  catalogId: string;
  /** The immutable Catalog generation the declarations were read from. */
  generation: string;
  skills: readonly PluginSkillDeclarationV1[];
}

/**
 * What reading the index produced. `unavailable` is a declared answer, not a
 * throw: a Catalog that cannot be read yields no plugin Skills and says so in
 * `skill/injected.refusals`, rather than failing the Turn.
 */
export type PluginSkillsOutcomeV1 =
  | { status: "ok"; packages: readonly PluginSkillPackageV1[] }
  | { status: "unavailable"; reason: string };

/** The host seam: the User's installed Catalog entries, read once per Turn. */
export interface PluginSkillsSourceV1 {
  read(): Promise<PluginSkillsOutcomeV1>;
}

/** The synthetic path a plugin Skill is listed and loadable under. */
export function pluginSkillPathV1(packageId: string, slug: string): string {
  return `${PLUGIN_SKILL_PATH_PREFIX}/${packageId}/${slug}/SKILL.md`;
}

const PACKAGE_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Builds the plugin-borne half of a Turn's Skill catalog.
 *
 * Every declaration is re-rendered as a `SKILL.md` and parsed by this
 * Package's own parser before it is admitted. The Catalog decoder already
 * bounded the strings; parsing them here is what makes a plugin Skill *the
 * same kind of thing* as every other Skill — same name and description bounds,
 * same refusal for a body that is empty — rather than a second format that
 * happens to reach the same prompt.
 */
export async function loadPluginSkillsV1(
  source: PluginSkillsSourceV1,
): Promise<{ skills: LoadedSkillV1[]; refusals: SkillRefusalV1[] }> {
  const skills: LoadedSkillV1[] = [];
  const refusals: SkillRefusalV1[] = [];
  const outcome = await source.read();
  if (outcome.status !== "ok") {
    refusals.push({
      path: PLUGIN_SKILL_PATH_PREFIX,
      kind: "unreadable",
      reason: `the installed Packages' Skills could not be indexed: ${outcome.reason}`,
    });
    return { skills, refusals };
  }
  const ordered = [...outcome.packages].sort((left, right) =>
    left.packageId.localeCompare(right.packageId),
  );
  for (const installed of ordered) {
    if (!PACKAGE_ID_PATTERN.test(installed.packageId)) {
      refusals.push({
        path: `${PLUGIN_SKILL_PATH_PREFIX}/${installed.packageId}`,
        kind: "malformed",
        reason: `Package id "${installed.packageId}" cannot name a Skill ref`,
      });
      continue;
    }
    const seen = new Set<string>();
    for (const declared of installed.skills) {
      const slug = skillSlugFromNameV1(declared.name);
      const path = pluginSkillPathV1(
        installed.packageId,
        slug ?? declared.name,
      );
      if (!slug) {
        refusals.push({
          path,
          kind: "malformed",
          reason: `the Skill name "${declared.name}" yields no usable slug`,
        });
        continue;
      }
      if (seen.has(slug)) {
        // Two declarations reducing to one slug would be one ref naming two
        // bodies. The first wins and the second is recorded, rather than
        // silently shadowing it.
        refusals.push({
          path,
          kind: "malformed",
          reason: `Package "${installed.packageId}" declares "${slug}" more than once`,
        });
        continue;
      }
      seen.add(slug);
      if (declared.body === undefined) {
        refusals.push({
          path,
          kind: "malformed",
          reason: "the Catalog entry lists this Skill without a body",
        });
        continue;
      }
      if (declared.description === undefined) {
        // The description is the only part of a Skill always in the prompt, so
        // a Skill without one is a name the Bot can never decide to use.
        refusals.push({
          path,
          kind: "malformed",
          reason: "the Catalog entry lists this Skill without a description",
        });
        continue;
      }
      const text = renderSkillDocumentV1({
        name: declared.name,
        description: declared.description,
        body: declared.body,
      });
      const parsed = parseSkillDocumentV1(text);
      if (parsed.status !== "ok") {
        refusals.push({ path, kind: "malformed", reason: parsed.reason });
        continue;
      }
      skills.push({
        path,
        ref: {
          schemaVersion: 1,
          source: "plugin",
          slug,
          packageId: installed.packageId,
        },
        by: `Package "${installed.packageId}"`,
        name: parsed.document.name,
        description: parsed.document.description,
        body: parsed.document.body,
        // The generation is the pinned Catalog generation the body was read
        // from, so `skill/injected` names an immutable, content-addressed set
        // of objects rather than "whatever the pointer said".
        generationId: `catalog:${installed.generation}`,
        contentHash: await sha256Hex(text),
      });
    }
  }
  return { skills, refusals };
}
