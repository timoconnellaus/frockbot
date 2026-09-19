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
import { loadArtifactSkillsV1 } from "./artifact.js";
import { SKILL_FILE_NAME } from "./skill-md.js";

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
    const attribution = `Plugin "${contribution.displayName ?? contribution.pluginId}"`;
    const loaded = await loadArtifactSkillsV1(
      contribution.skills,
      (document) => ({
        source: "plugin",
        ref: {
          schemaVersion: 1,
          source: "plugin",
          pluginId: contribution.pluginId,
          slug: document.slug,
        },
        path: pluginSkillPathV1(contribution.pluginId, document.slug),
        attribution,
      }),
    );
    skills.push(...loaded.skills);
    refusals.push(...loaded.refusals);
  }
  return { skills, refusals };
}
