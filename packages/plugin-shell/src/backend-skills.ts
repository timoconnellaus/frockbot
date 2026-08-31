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
// SEAM, open. The `WORKSPACE_FILES` binding named below does not exist yet:
// the Computer step of `docs/plans/slice-2.md` implements the Workspace file
// surface, and the Memory step implements the durable-root sync that backs it
// from object storage. Until one of them is bound, this returns `undefined`
// and the Skills Package is not mounted at all — a Turn with no readable
// instruction root loads no instructions, visibly, rather than inventing a
// second store to read them from.
import type { WorkspaceFilesV1 } from "@frockbot/kernel-contracts";
import type { SkillsRuntimeHostV1 } from "@frockbot/plugin-skills/agent";

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
 * The Skills seam one admitted Turn runs under, or `undefined` when the Bot's
 * Workspace file surface is unavailable.
 */
export function createBotSkillsHost(
  identity: BotSkillsIdentity,
  turn: BotSkillsTurn,
  env: object,
): SkillsRuntimeHostV1 | undefined {
  // SAFETY: the Workspace file surface is a dynamic Durable Object binding,
  // not part of the generated `Env`. Absence is the expected state today.
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
  };
}
