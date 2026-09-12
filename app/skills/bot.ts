// The Bot Durable Object's half of Skills, and the User-authored writes that
// land beside them.
//
// Two things live here. The seam an admitted Turn runs the Skills Package
// under — whether a Workspace surface exists and what provenance a write
// records — and the reads and writes a User makes as themselves: the composer's
// Skill catalog, the first-party page registry, and the two direct writes that
// stand in for a Computer's sync.
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
  PackageIframeCompositionV1,
  PackageIframeToolCommandV1,
  WorkspaceFilesV1,
  WorkspaceReadsV1,
  WorkspaceRootV1,
} from "@frockbot/core/contracts";
import type { BotIdentity } from "@frockbot/core/durable";
import type { SkillsRuntimeHostV1 } from "@frockbot/app/skills/agent";
import {
  loadFullSkillCatalogV1,
  loadSkillCatalogV1,
  skillRefForLoadedSkillV1,
} from "@frockbot/app/skills/catalog";
import { writeSkillDocumentV1 } from "@frockbot/app/skills/write";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { admitTurnV1 } from "@frockbot/app/composition/bot";
import { projectFirstPartyPackageIframeV1 } from "@frockbot/app/shell/composition-views";
import { appletsEnabled } from "@frockbot/app/applets-host/bot";
import { userAccountFeaturesV1 } from "@frockbot/app/settings/bot";
import type { UserFeaturesV1 } from "@frockbot/app/admin/shared";
import {
  APPLETS_SKILL_SLUG_V1,
  PLUGINS_SKILL_SLUG_V1,
} from "@frockbot/app/skills/managed";
import { PACKAGE_IFRAME_FOCUS_TOOL_V2 } from "@frockbot/core/contracts";
import {
  projectClientTurnV1,
  type ClientTurnV1,
} from "@frockbot/app/shell/run-protocol";
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
 * The Applets Skill is the Applets Package's own reference: it teaches the
 * `applet_*` tools, so it goes exactly where those tools go. With the
 * account's switch off the tools are not mounted, and a switch that cannot be
 * read is off here for the same reason it is off for the tools — listing the
 * Skill would tell the model the tools were there.
 */
async function withheldManagedSkillSlugs(
  state: ShellBotStateV1,
  identity: BotSkillsIdentity,
): Promise<readonly string[]> {
  // The same rule for each gated feature: the Skill goes exactly where the
  // tools go, and a switch that cannot be read is off. One read of the
  // account's features answers every gate.
  let features: UserFeaturesV1 | undefined;
  try {
    features = await userAccountFeaturesV1(state, identity);
  } catch {
    features = undefined;
  }
  const withheld: string[] = [];
  if (!features?.applets) withheld.push(APPLETS_SKILL_SLUG_V1);
  // The plugin tools also need the artifact bucket they store a module in, so
  // a deployment without it is handed no Skill teaching them either.
  if (!features?.pluginAuthoring || !state.env.APPLICATION_ARTIFACTS) {
    withheld.push(PLUGINS_SKILL_SLUG_V1);
  }
  return withheld;
}

/**
 * The Skills seam one admitted Turn runs under, or `undefined` when the Bot's
 * Workspace file surface is unavailable.
 */
export async function createBotSkillsHost(
  state: ShellBotStateV1,
  identity: BotSkillsIdentity,
  turn: BotSkillsTurn,
): Promise<SkillsRuntimeHostV1 | undefined> {
  // Absence is a supported state, not an error: a host that binds no
  // Workspace mounts no Skills.
  const files = state.env.WORKSPACE_FILES;
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
    withheldManagedSlugs: await withheldManagedSkillSlugs(state, identity),
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

/** Server-side allowlist for the untrusted page's only effectful message. */
export function requirePackageUiToolDeclarationV1(
  catalog: PackageIframeCompositionV1,
  command: Pick<PackageIframeToolCommandV1, "packageId" | "name">,
): PackageIframeCompositionV1["contributions"][number] {
  const contribution = catalog.contributions.find(
    (candidate) => candidate.packageId === command.packageId,
  );
  if (!contribution || !contribution.declaredTools.includes(command.name)) {
    throw new Error(
      `Package "${command.packageId}" did not declare tool "${command.name}"`,
    );
  }
  return contribution;
}

export async function runPackageUiTool(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: PackageIframeToolCommandV1,
): Promise<ClientTurnV1> {
  await state.authority.validateIdentity(identity);
  const catalog = await listPackageUi(state, identity);
  const contribution = requirePackageUiToolDeclarationV1(catalog, command);
  return projectClientTurnV1(
    await admitTurnV1(state, {
      ...identity,
      runId: command.commandId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: `${contribution.displayName} · ${command.name}`,
      directTool: {
        packageId: command.packageId,
        name: command.name,
        input: command.input,
      },
    }),
  );
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
  const catalog = await loadFullSkillCatalogV1(
    reads,
    { userId: identity.userId, botId: identity.botId },
    { withheldManagedSlugs: await withheldManagedSkillSlugs(state, identity) },
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

/**
 * The first-party page registry, as inert iframe metadata for one Bot.
 *
 * A Package whose pages may focus an Applet is offered only when an admin
 * has turned Applets on for this User. The client derives "Applets are here"
 * from exactly that declaration, so leaving the Package out is what makes
 * the canvas, the picker and the Applet routes silent for an account without
 * the feature.
 */
export async function listPackageUi(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<PackageIframeCompositionV1> {
  await state.authority.validateIdentity(identity);
  const projected = projectFirstPartyPackageIframeV1(identity.botId);
  let enabled: boolean;
  try {
    enabled = await appletsEnabled(state, identity);
  } catch {
    enabled = false;
  }
  if (enabled) return projected;
  return {
    ...projected,
    contributions: projected.contributions.filter(
      (contribution) =>
        !contribution.declaredTools.includes(PACKAGE_IFRAME_FOCUS_TOOL_V2),
    ),
  };
}

/**
 * Write one Skill into this Bot's own instruction root as its **User**.
 *
 * The importing User authored the recipe by choosing to materialize it, and
 * no Turn of the new Bot has run yet, so there is no Bot writer to record.
 * `isLoadableSkillSourceV1` admits a `user` writer under the Bot's own
 * instruction root, so an imported Skill is loadable on the Bot's first Turn
 * and its provenance says who put it there. The write goes through the same
 * `writeSkillDocumentV1` the Bot's own `skill_write` uses, quota included.
 */
export async function writeUserSkill(
  state: ShellBotStateV1,
  identity: BotIdentity,
  draft: { slug: string; name: string; description: string; body: string },
): Promise<
  | { status: "written"; generationId: string }
  | { status: "refused"; reason: string }
> {
  await state.authority.validateIdentity(identity);
  // The same binding `createBotSkillsHost` hands the Skills Package for a
  // Turn. Absent, and there is no writable instruction root to import into.
  const files = (state.env as { WORKSPACE_FILES?: WorkspaceFilesV1 })
    .WORKSPACE_FILES;
  if (!files) {
    return {
      status: "refused",
      reason: "this Bot has no writable instruction root",
    };
  }
  const outcome = await writeSkillDocumentV1(
    files,
    { userId: identity.userId, botId: identity.botId },
    { kind: "user", userId: identity.userId },
    draft,
  );
  return outcome.status === "written"
    ? { status: "written", generationId: outcome.generationId }
    : outcome;
}

/**
 * The Bot's own instruction root, bodies included.
 *
 * `listSkills` above is deliberately body-free: the composer's popover needs
 * names, and a body it does not need is a body it should not carry. This is
 * the other read — the one an export needs — and it is narrower in exactly
 * the way that matters: it calls `loadSkillCatalogV1`, which walks *only*
 * the Bot's own instruction root, so the managed set and the plugin-borne
 * index are not merely filtered out afterwards, they are never loaded. A
 * candidate the authority predicate refuses is not here either, and a Skill
 * whose body could not be read is absent rather than half-present.
 *
 * A Skill with no well-formed slug is dropped: the importing Bot needs a
 * directory name to write it under, and inventing one from a path that means
 * something only in this deployment would be a fallback, which the register
 * forbids.
 */
export async function listOwnSkillDocuments(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<
  {
    slug: string;
    name: string;
    description?: string;
    body: string;
  }[]
> {
  await state.authority.validateIdentity(identity);
  const reads = createBotSkillsReads(state.env);
  if (!reads) return [];
  const catalog = await loadSkillCatalogV1(reads, {
    userId: identity.userId,
    botId: identity.botId,
  });
  return catalog.skills.flatMap((skill) =>
    skill.ref
      ? [
          {
            slug: skill.ref.slug,
            name: skill.name,
            ...(skill.description ? { description: skill.description } : {}),
            body: skill.body,
          },
        ]
      : [],
  );
}
