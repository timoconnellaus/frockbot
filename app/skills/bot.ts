// The Bot Durable Object's half of Skills, and the User-authored writes that
// land beside them.
//
// Two things live here. The seam an admitted Turn runs the Skills Package
// under — whether a Workspace surface exists and what provenance a write
// records — and the reads and writes a User makes as themselves: the composer's
// Skill catalog and the two direct writes that stand in for a Computer's sync.
//
// HIBERNATION. "The Agent loop, Memory, Skills, Package composition, and
// Routines function correctly while the Computer is hibernated and do not wake
// it." Nothing here reaches the Computer registry, a Computer provider, or a
// Computer. The Workspace surface handed to the Skills Package is a binding on
// the Durable Object's environment, and the durable-root sync backs it from
// object storage; whether a Computer host happens to be running changes nothing
// above this line.
//
// SEAM. `WORKSPACE_FILES` is bound in production by
// `apps/cloudflare/src/workspace.ts`: `WorkspaceFilesV1` over object storage,
// with every generation recorded in this Bot's Durable Object. A host that
// binds nothing — a test, a shell with no bucket — still gets `undefined` here,
// and the Skills Package is then not mounted at all: a Turn with no readable
// instruction root loads no instructions, visibly, rather than inventing a
// second store to read them from.

import type {
  WorkspaceFilesV1,
  WorkspaceReadsV1,
  WorkspaceRootV1,
} from "@frockbot/core/contracts";
import type { BotIdentity } from "@frockbot/core/durable";
import type {
  SkillIndexSourceV1,
  SkillsRuntimeHostV1,
} from "@frockbot/app/skills/agent";
import {
  loadFullSkillCatalogV1,
  loadSkillCatalogV1,
  skillRefForLoadedSkillV1,
  type SkillIndexLoadV1,
} from "@frockbot/app/skills/catalog";
import type { PluginSkillContributionV1 } from "@frockbot/app/skills/plugin";
import { writeSkillDocumentV1 } from "@frockbot/app/skills/write";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import {
  userAccountFeaturesReaderV1,
  type UserAccountFeaturesReadV1,
} from "@frockbot/app/settings/bot";
import type { UserFeaturesV1 } from "@frockbot/app/admin/shared";
import { PLUGINS_SKILL_SLUG_V1 } from "@frockbot/app/skills/managed";
import { readBotPluginRosterV1 } from "@frockbot/app/plugins/worker-bot";
import {
  clientSkillCatalogEntryV1,
  type ClientSkillCatalogEntryV1,
  type ClientSkillCatalogV1,
} from "@frockbot/app/shell/skill-protocol";

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
}

/**
 * The managed Skills this Bot's account is not offered.
 *
 * The same rule for each gated feature: the Skill goes exactly where the tools
 * go, and a switch that cannot be read is off.
 */
async function withheldManagedSkillSlugs(
  state: ShellBotStateV1,
  features: UserAccountFeaturesReadV1,
): Promise<readonly string[]> {
  let read: UserFeaturesV1 | undefined;
  try {
    read = await features();
  } catch {
    read = undefined;
  }
  const withheld: string[] = [];
  // The plugin tools also need the artifact bucket they store a module in, so
  // a deployment without it is handed no Skill teaching them either.
  if (!read?.pluginAuthoring || !state.env.APPLICATION_ARTIFACTS) {
    withheld.push(PLUGINS_SKILL_SLUG_V1);
  }
  return withheld;
}

/**
 * The Skills the Plugins this Bot runs contribute (ADR 0030).
 *
 * A Plugin's Skill goes exactly where its tools go: the User's Composition
 * installs the Plugin and this Bot's enable map switches it on, and only then
 * is its Skill in the Turn's catalog. That is the same roster the Plugin
 * worker mounts from, read here rather than re-derived.
 *
 * A roster that cannot be read contributes nothing, for the reason a feature
 * gate that cannot be read is off: listing a Skill for a Plugin that may not
 * be running would teach the model about tools the Turn does not have.
 */
async function enabledPluginSkillsV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<PluginSkillContributionV1[]> {
  let roster: Awaited<ReturnType<typeof readBotPluginRosterV1>>;
  try {
    roster = await readBotPluginRosterV1(state, identity);
  } catch {
    return [];
  }
  return roster.members.flatMap((member) =>
    roster.enabled.includes(member.packageId) &&
    member.descriptor.skills &&
    member.descriptor.skills.length > 0
      ? [
          {
            pluginId: member.packageId,
            displayName: member.descriptor.displayName,
            skills: member.descriptor.skills,
          },
        ]
      : [],
  );
}

/**
 * The two gates a catalog reads before it is assembled: which managed Skills
 * this account is withheld, and which Plugins this Bot runs.
 *
 * Resolved together, for the reason `loadFullSkillCatalogV1` lists its two
 * roots together: both are round trips off the Bot, and the turn-start path
 * pays them once in parallel rather than one after the other.
 */
async function botSkillGatesV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  features: UserAccountFeaturesReadV1,
): Promise<{
  withheldManagedSlugs: readonly string[];
  pluginSkills: PluginSkillContributionV1[];
}> {
  const [withheldManagedSlugs, pluginSkills] = await Promise.all([
    withheldManagedSkillSlugs(state, features),
    enabledPluginSkillsV1(state, identity),
  ]);
  return { withheldManagedSlugs, pluginSkills };
}

/**
 * The Skills seam one admitted Turn runs under, or `undefined` when the Bot's
 * Workspace file surface is unavailable.
 */
export async function createBotSkillsHost(
  state: ShellBotStateV1,
  identity: BotSkillsIdentity,
  turn: BotSkillsTurn,
  features: UserAccountFeaturesReadV1,
  /**
   * When the caller supplies this array, it is the mounted generation's
   * Skills and it is not fetched again. The caller may fill it before the
   * catalog is constructed.
   */
  pluginSkills?: PluginSkillContributionV1[],
  admitted?: { botRevision: string; userRevision: string },
): Promise<SkillsRuntimeHostV1 | undefined> {
  // Absence is a supported state, not an error: a host that binds no
  // Workspace mounts no Skills.
  const files = state.env.WORKSPACE_FILES;
  if (!files) return undefined;
  const gates = pluginSkills
    ? {
        withheldManagedSlugs: await withheldManagedSkillSlugs(state, features),
        pluginSkills,
      }
    : await botSkillGatesV1(state, identity, features);
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
    ...gates,
    skillIndexes: skillIndexSourceForTurnV1(state, identity, admitted),
  };
}

function skillIndexSourceForTurnV1(
  state: ShellBotStateV1,
  identity: BotSkillsIdentity,
  admitted?: { botRevision: string; userRevision: string },
): SkillIndexSourceV1 {
  const storage = {
    get: (key: string) => state.ctx.storage.get(key),
    put: (key: string, value: unknown) => state.ctx.storage.put(key, value),
    delete: (key: string) => state.ctx.storage.delete(key),
    list: (options: { prefix?: string; limit?: number; start?: string }) =>
      state.ctx.storage.list(options),
  };
  const user = () =>
    state.env.USER_CONFIGURATIONS.get(
      state.env.USER_CONFIGURATIONS.idFromName(identity.userId),
    );
  const loadRoot = async (
    source: "bot" | "user",
    revision: string | undefined,
  ) => {
    if (source === "bot") {
      const { readDurableSkillIndexV1, readDurableSkillSnapshotV1 } =
        await import("./index-store.js");
      const root = {
        kind: "bot-instructions" as const,
        userId: identity.userId,
        botId: identity.botId,
      };
      return revision === undefined
        ? readDurableSkillIndexV1(storage, root)
        : readDurableSkillSnapshotV1(storage, root, revision);
    }
    const loaded = await user().readSkillIndex({
      schemaVersion: 1,
      userId: identity.userId,
      root: { kind: "user-instructions", userId: identity.userId },
      ...(revision !== undefined ? { revision } : {}),
    });
    const { decodeSkillMetadataIndexV1 } = await import("./metadata-index.js");
    return decodeSkillMetadataIndexV1(loaded);
  };
  return {
    load: async (): Promise<SkillIndexLoadV1> => {
      const [liveBot, liveUser] = await Promise.all([
        loadRoot("bot", undefined),
        loadRoot("user", undefined),
      ]);
      if (!admitted) {
        return { bot: liveBot, user: liveUser, liveBot, liveUser };
      }
      const [bot, userIndex] = await Promise.all([
        loadRoot("bot", admitted.botRevision),
        loadRoot("user", admitted.userRevision),
      ]);
      return { bot, user: userIndex, liveBot, liveUser };
    },
    readBody: async (bodyKey) => {
      const object = await state.env.MEMORY_FILES.get(bodyKey);
      if (!object) return undefined;
      return new Uint8Array(await object.arrayBuffer());
    },
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
 * The Bot's invocable Skills, for the composer's `/` and `@` popover.
 *
 * A read of the same instruction root the Turn loader reads, through the
 * same `WorkspaceReadsV1`, so the popover can never offer a Skill a Turn
 * would refuse as an instruction: a refused candidate is not in the catalog
 * here either. Names and descriptions only — never a body.
 *
 * An unbound Workspace surface is an empty catalog, not a failure: the
 * Skills Package is not mounted in that host either, so "no Skills" is the
 * true answer rather than an error the composer has to explain.
 */
export async function listSkills(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<ClientSkillCatalogV1> {
  await state.authority.validateIdentity(identity);
  const reads = createBotSkillsReads(state.env);
  if (!reads) return { schemaVersion: 1, skills: [] };
  // The same withholding the Turn applies, so the popover never offers a
  // managed Skill the Turn would not list.
  const gates = await botSkillGatesV1(
    state,
    identity,
    userAccountFeaturesReaderV1(state, identity),
  );
  const catalog = await loadFullSkillCatalogV1(
    reads,
    { userId: identity.userId, botId: identity.botId },
    {
      ...gates,
      indexes: await skillIndexSourceForTurnV1(state, identity).load(),
    },
  );
  const entries: ClientSkillCatalogEntryV1[] = [];
  for (const skill of catalog.skills) {
    const ref = skillRefForLoadedSkillV1(skill);
    // A Skill whose directory is not a well-formed slug has no ref, so it
    // cannot be invoked and is not offered. It is still listed to the model
    // in `<agent_skills>` and still loadable by path.
    if (!ref) continue;
    entries.push(
      clientSkillCatalogEntryV1({
        skill: ref,
        name: skill.name,
        description: skill.description,
        path: skill.path,
      }),
    );
  }
  return { schemaVersion: 1, skills: entries };
}
