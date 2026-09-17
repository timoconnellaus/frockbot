// The Skills a Plugin contributes (ADR 0030).
//
// A Plugin that ships a card ships the Skill that says when to use it, so the
// descriptor carries `skills` and this module turns the enabled ones into
// loaded Skills. Like the managed set, and for the same reason, these are not
// Workspace files: the text is bytes of the Plugin's artifact, which the
// Turn's Composition pins, so `isLoadableSkillSourceV1` never meets one and
// decides nothing new.
//
// WHAT MAKES A PLUGIN'S SKILL DIFFERENT is who it is offered to. A managed
// Skill is the deployment's; a Plugin's belongs to a Plugin, and the catalog
// offers it only to a Bot with that Plugin enabled — the same rule its tools
// run under. The host decides that (`app/skills/bot.ts`); this module is
// handed the contributions and asks nothing about them.
//
// A malformed document is a recorded refusal, never a throw: a Plugin is
// untrusted code, and a descriptor that shipped a bad `SKILL.md` must not take
// the Turn's whole catalog with it.
import type { PluginSkillV1 } from "@frockbot/core/contracts";
import type { LoadedSkillV1, SkillRefusalV1 } from "./catalog.js";
import {
  isSkillReferenceNameV1,
  isSkillSlugV1,
  parseSkillDocumentV1,
  skillReferencePathForV1,
  SKILL_FILE_NAME,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_REFERENCES,
} from "./skill-md.js";

/** One Plugin's Skills, as the Turn's host offers them. */
export interface PluginSkillContributionV1 {
  pluginId: string;
  /** What the Plugins page calls it; the attribution the catalog renders. */
  displayName?: string;
  skills: readonly PluginSkillV1[];
}

/** The synthetic path a Plugin's Skill is listed and loadable under. */
export function pluginSkillPathV1(pluginId: string, slug: string): string {
  return `plugin/${pluginId}/${slug}/${SKILL_FILE_NAME}`;
}

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
 * Parses the contributed documents into loaded Skills.
 *
 * The generation of a Plugin's Skill is its content hash, for the reason a
 * managed one's is: there is no mutable store to version it against, and the
 * Composition the Turn pinned is what makes the hash reproducible.
 */
export async function loadPluginSkillsV1(
  contributions: readonly PluginSkillContributionV1[],
): Promise<{ skills: LoadedSkillV1[]; refusals: SkillRefusalV1[] }> {
  const skills: LoadedSkillV1[] = [];
  const refusals: SkillRefusalV1[] = [];
  for (const contribution of contributions) {
    for (const document of contribution.skills) {
      const path = pluginSkillPathV1(contribution.pluginId, document.slug);
      if (!isSkillSlugV1(document.slug)) {
        refusals.push({
          path,
          kind: "malformed",
          reason: `the Plugin Skill slug "${document.slug}" is not a well-formed slug`,
        });
        continue;
      }
      const parsed = parseSkillDocumentV1(document.text);
      if (parsed.status !== "ok") {
        refusals.push({ path, kind: "malformed", reason: parsed.reason });
        continue;
      }
      const declared = document.references ?? [];
      if (declared.length > SKILL_MAX_REFERENCES) {
        refusals.push({
          path,
          kind: "oversized",
          reason: `the Skill offers ${declared.length} references; the bound is ${SKILL_MAX_REFERENCES}`,
        });
        continue;
      }
      const references = [];
      let refused: SkillRefusalV1 | undefined;
      for (const reference of declared) {
        if (!isSkillReferenceNameV1(reference.path)) {
          refused = {
            path,
            kind: "malformed",
            reason: `its reference "${reference.path}" is not a single .md file name`,
          };
          break;
        }
        const bytes = new TextEncoder().encode(reference.text).byteLength;
        if (bytes > SKILL_MAX_FILE_BYTES) {
          refused = {
            path,
            kind: "oversized",
            reason: `its reference ${reference.path} is ${bytes} bytes; the bound is ${SKILL_MAX_FILE_BYTES}`,
          };
          break;
        }
        references.push({
          path: skillReferencePathForV1(path, reference.path),
          generationId: await sha256Hex(reference.text),
          text: reference.text,
        });
      }
      if (refused) {
        refusals.push(refused);
        continue;
      }
      const contentHash = await sha256Hex(document.text);
      skills.push({
        path,
        source: "plugin",
        ref: {
          schemaVersion: 1,
          source: "plugin",
          pluginId: contribution.pluginId,
          slug: document.slug,
        },
        by: `Plugin "${contribution.displayName ?? contribution.pluginId}"`,
        name: parsed.document.name,
        description: parsed.document.description,
        body: parsed.document.body,
        references,
        generationId: contentHash,
        contentHash,
      });
    }
  }
  return { skills, refusals };
}
