// The Bot Durable Object's half of the Skills seam.
//
// The Skills Package reads a Bot's instruction root through the
// kernel-declared `WorkspaceReadsV1` and writes through `WorkspaceFilesV1`.
// This module decides, for one admitted Turn, whether such a surface exists
// and what provenance a write records. It implements neither interface.
//
// HIBERNATION. "The Agent loop, Memory, Skills, Package composition, and
// Routines function correctly while the Computer is hibernated and do not wake
// it." Nothing here reaches the Computer registry, a Computer provider, or a
// Sprite. The Workspace surface handed to the Skills Package is a binding on
// the Durable Object's environment, and the durable-root sync of ADR 0013
// backs it from object storage; whether a Computer host happens to be running
// changes nothing above this line.
//
// SEAM. `WORKSPACE_FILES` is bound in production by
// `apps/cloudflare/src/workspace.ts`: `WorkspaceFilesV1` over object storage,
// with every generation recorded in this Bot's Durable Object (Step 3a of
// `docs/plans/slice-2.md`). A host that binds nothing — a test, a shell with no
// bucket — still gets `undefined` here, and the Skills Package is then not
// mounted at all: a Turn with no readable instruction root loads no
// instructions, visibly, rather than inventing a second store to read them
// from.
import type {
  WorkspaceFilesV1,
  WorkspaceReadsV1,
} from "@frockbot/kernel-contracts";
import type { SkillsRuntimeHostV1 } from "@frockbot/plugin-skills/agent";
import type {
  PluginSkillPackageV1,
  PluginSkillsSourceV1,
} from "@frockbot/plugin-skills/plugin-index";

/** The Bot and User whose Skills a Turn may load. */
export interface BotSkillsIdentity {
  userId: string;
  botId: string;
}

/** The run, Turn, and Session a Bot-authored Skill records as its provenance. */
export interface BotSkillsTurn {
  runId: string;
  turnId: string;
  sessionId: string;
}

/**
 * The narrow slice of the Durable Object environment this module reads. Named
 * as its own type so the binding's absence is a typed state, not a cast.
 */
export interface BotSkillsEnv {
  WORKSPACE_FILES?: WorkspaceFilesV1;
  /**
   * The Package Catalog reader, constructed onto the Bot Durable Object's
   * environment the same way `WORKSPACE_FILES` is. Absent for a deployment
   * with no Catalog, and the Turn then carries no plugin-borne Skills.
   */
  PACKAGE_CATALOG_ENTRIES?: BotSkillCatalogReaderV1;
}

/**
 * The Skills seam one admitted Turn runs under, or `undefined` when the Bot's
 * Workspace file surface is unavailable.
 */
export function createBotSkillsHost(
  identity: BotSkillsIdentity,
  turn: BotSkillsTurn,
  env: object,
  pluginSkills?: PluginSkillsSourceV1,
): SkillsRuntimeHostV1 | undefined {
  // SAFETY: the Workspace file surface is constructed onto the Durable Object
  // environment rather than declared in the generated `Env`, because it is not
  // a Worker binding. Absence is a supported state, not an error.
  const files = (env as BotSkillsEnv).WORKSPACE_FILES;
  if (!files) return undefined;
  return {
    owner: { userId: identity.userId, botId: identity.botId },
    reads: files,
    files,
    // A Bot writes a Skill only inside a Turn whose run, Turn and Session its
    // provenance names — the same rule Package authoring follows.
    writer: {
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    },
    ...(pluginSkills ? { pluginSkills } : {}),
  };
}

/**
 * The read-only half of the same seam, for a question asked outside a Turn.
 *
 * The composer's `/` and `@` popover needs the Bot's Skill catalog before any
 * Turn exists, and reading a catalog needs no provenance: there is nothing to
 * attribute. So this returns reads and no writer at all — a caller holding it
 * can enumerate an instruction root and can write nothing.
 */
export function createBotSkillsReads(
  env: object,
): WorkspaceReadsV1 | undefined {
  return (env as BotSkillsEnv).WORKSPACE_FILES;
}

/**
 * The Catalog reader the plugin-borne Skill index needs, named structurally.
 *
 * Structural rather than imported so this module keeps naming no Cloudflare
 * type: `R2PackageCatalog` in `apps/cloudflare/src/package-catalog.ts` already
 * satisfies it, and a test satisfies it with an object literal. The reader is
 * asked for one entry at one *pinned* generation, never for the live pointer:
 * a Turn reads exactly the immutable generation its User is pinned to.
 */
export interface BotSkillCatalogReaderV1 {
  readEntry(
    generation: string,
    catalogId: string,
  ): Promise<
    | {
        packageId: string;
        skills: readonly {
          name: string;
          description?: string;
          body?: string;
        }[];
      }
    | undefined
  >;
}

/** One installed Package, as the User's settings record it. */
export interface BotInstalledPackageV1 {
  packageId: string;
  state: "installed" | "disabled" | "failed";
  catalogId?: string;
  catalogGeneration?: string;
}

/**
 * The plugin-borne Skill index for one Turn.
 *
 * Reads only the entries the User has actually installed, at the generation
 * each install recorded. That is what makes an uninstall remove a Skill: the
 * row is gone from the User's settings, so the next Turn's index does not
 * name it, and no copy of the body exists anywhere to go stale. A disabled
 * Package contributes nothing either — a Bot that may not run a Package's
 * tools should not be reading its recipes.
 */
export function createBotPluginSkillsSource(
  installed: readonly BotInstalledPackageV1[],
  reader: BotSkillCatalogReaderV1 | undefined,
): PluginSkillsSourceV1 | undefined {
  if (!reader) return undefined;
  const rows = installed.filter(
    (row) =>
      row.state === "installed" &&
      row.catalogId !== undefined &&
      row.catalogGeneration !== undefined,
  );
  return {
    read: async () => {
      const packages: PluginSkillPackageV1[] = [];
      for (const row of rows) {
        const catalogId = row.catalogId as string;
        const generation = row.catalogGeneration as string;
        try {
          const entry = await reader.readEntry(generation, catalogId);
          if (!entry) continue;
          if (entry.skills.length === 0) continue;
          packages.push({
            packageId: entry.packageId,
            catalogId,
            generation,
            skills: entry.skills,
          });
        } catch (error) {
          // A Catalog read that fails is an unavailable index, not a failed
          // Turn: the loader records it as a refusal in `skill/injected` and
          // the Bot runs with the Skills it could read.
          return {
            status: "unavailable",
            reason: `Catalog entry "${catalogId}" at generation "${generation}" could not be read: ${
              error instanceof Error ? error.message : String(error)
            }`,
          };
        }
      }
      return { status: "ok", packages };
    },
  };
}

/** The Catalog reader bound on this host, or `undefined` when there is none. */
export function createBotSkillCatalogReader(
  env: object,
): BotSkillCatalogReaderV1 | undefined {
  return (env as BotSkillsEnv).PACKAGE_CATALOG_ENTRIES;
}
