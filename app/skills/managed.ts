// The managed Skills: first-party recipes compiled into this Package.
//
// They are authored as directories — one `SKILL.md` and the Markdown under
// `references/` — and copied into generated modules by
// `scripts/build-applets-assets.ts`. A Worker has no filesystem, so the
// bytes travel in the bundle. That is the whole design: "the kernel treats
// every Workspace file as data. Only Skills under the Bot's own instruction
// root, written under the Bot's own authority or its User's, are loaded as
// instructions" stays exactly true, because a managed Skill is not a
// Workspace file at all. It is a Package contributing prompt content, which
// the Composition already pins: the Turn's `CompositionPinV1.artifactSetHash`
// covers the artifact these bytes live in.
//
// READ-ONLY follows from the same fact. There is no path from `skill_write`
// to an artifact, so `scope: "managed"` is refused rather than routed
// anywhere.
import { SKILL_FILE_NAME } from "./skill-md.js";
import type { LoadedSkillV1, SkillRefusalV1 } from "./catalog.js";
import { loadArtifactSkillsV1 } from "./artifact.js";
import { MANAGED_RECIPE_SKILLS_V1 } from "./managed-recipes.generated.js";
import {
  APPLETS_SKILL_DOCUMENT_V1,
  APPLETS_SKILL_REFERENCES_V1,
  APPLETS_SKILL_SLUG_V1,
} from "./managed-applets.generated.js";
import {
  PLUGINS_SKILL_DOCUMENT_V1,
  PLUGINS_SKILL_REFERENCES_V1,
  PLUGINS_SKILL_SLUG_V1,
} from "./managed-plugins.generated.js";
import {
  A2UI_SKILL_DOCUMENT_V1,
  A2UI_SKILL_REFERENCES_V1,
  A2UI_SKILL_SLUG_V1,
} from "./managed-a2ui.generated.js";

// Re-exported because the generated modules they come from are not package
// exports, and a caller outside this package needs the slugs to withhold them.
// `a2ui` is not among them: it is offered to every Bot, so nothing withholds it.
export { APPLETS_SKILL_SLUG_V1, PLUGINS_SKILL_SLUG_V1 };

/** The directory prefix a managed Skill is listed and loadable under. */
export const MANAGED_SKILL_PATH_PREFIX = "managed";

/** Who a managed Skill is attributed to in the rendered catalog. */
export const MANAGED_SKILL_ATTRIBUTION = "FrockBot";

/** One bundled `SKILL.md`, exactly as it would sit on disk. */
export interface ManagedSkillDocumentV1 {
  slug: string;
  text: string;
  /**
   * The Markdown files bundled beside it, by file name (ADR 0030). A managed
   * Skill is a directory like any other; the generator copies one where it
   * copied a file, and a Skill with none declares none.
   */
  references?: readonly { path: string; text: string }[];
}

/**
 * The bundled documents, in slug order. Ordering is fixed here rather than
 * sorted later so the catalog a Turn assembles is the same on every host.
 */
export const MANAGED_SKILL_DOCUMENTS_V1: readonly ManagedSkillDocumentV1[] = [
  ...MANAGED_RECIPE_SKILLS_V1,
  {
    slug: APPLETS_SKILL_SLUG_V1,
    text: APPLETS_SKILL_DOCUMENT_V1,
    references: APPLETS_SKILL_REFERENCES_V1,
  },
  {
    slug: PLUGINS_SKILL_SLUG_V1,
    text: PLUGINS_SKILL_DOCUMENT_V1,
    references: PLUGINS_SKILL_REFERENCES_V1,
  },
  {
    slug: A2UI_SKILL_SLUG_V1,
    text: A2UI_SKILL_DOCUMENT_V1,
    references: A2UI_SKILL_REFERENCES_V1,
  },
];

/** The synthetic path a managed Skill is listed and loadable under. */
export function managedSkillPathV1(slug: string): string {
  return `${MANAGED_SKILL_PATH_PREFIX}/${slug}/${SKILL_FILE_NAME}`;
}

/**
 * Parses the bundled documents into loaded Skills.
 *
 * A malformed bundled document is a recorded refusal, never a throw. The
 * bodies here are first-party and reviewed, but a Turn that dies because one
 * of them was mis-edited would take the Bot's whole prompt with it, and a
 * loader with two failure modes has one too many: every other source in this
 * catalog answers a bad document with a refusal, and so does this one.
 *
 * The generation of a managed Skill is its content hash. There is no mutable
 * store to version it against — the bytes are the artifact's — so the hash is
 * the only honest name for "which one this Turn used", and the artifact set
 * hash the Composition pins is what makes that name reproducible.
 */
export async function loadManagedSkillsV1(
  documents: readonly ManagedSkillDocumentV1[] = MANAGED_SKILL_DOCUMENTS_V1,
): Promise<{ skills: LoadedSkillV1[]; refusals: SkillRefusalV1[] }> {
  return loadArtifactSkillsV1(documents, (document) => ({
    source: "managed",
    ref: { schemaVersion: 1, source: "managed", slug: document.slug },
    path: managedSkillPathV1(document.slug),
    attribution: MANAGED_SKILL_ATTRIBUTION,
  }));
}
