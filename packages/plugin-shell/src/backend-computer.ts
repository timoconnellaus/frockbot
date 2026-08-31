// The Bot Durable Object's half of the Computer sync seam (ADR 0013).
//
// The durable-root sync reconciles two halves: the Workspace on the Computer,
// which the Computer provider Package owns, and object storage, whose
// authority is this Durable Object. This module supplies the second half for
// one admitted Turn — the store surface, the effect records a push writes
// before it runs, the generation ledger a removal's writer is recovered from,
// and the writer a shell-written file is attributed to. It runs no sync and
// implements no interface; the provider Package does both.
//
// HIBERNATION. Nothing here reaches a Computer. It is a description of what a
// sync may use if one happens, handed to the provider Package; whether a
// Computer is awake is decided by the Bot using it and by nothing on this
// path. "The Computer wakes only when a Bot uses it."
//
// SEAM. `WORKSPACE_SYNC_FILES` and `WORKSPACE_SYNC_EFFECTS` are constructed
// onto the Durable Object environment by `apps/cloudflare/src/bot-state.ts`,
// the same way `WORKSPACE_FILES` is: neither is a Worker binding, and a host
// that binds neither simply has no sync — the durable roots then live on the
// Computer alone, visibly, rather than syncing to a store this module invented.
import type {
  WorkspaceFilesV1,
  WorkspaceGenerationsV1,
  WorkspaceSyncEffectsV1,
} from "@frockbot/kernel-contracts";
import type { ComputerSyncHostV1 } from "@frockbot/computer-core";

/** The Bot and User whose durable roots a Turn's sync may reconcile. */
export interface BotComputerSyncIdentity {
  userId: string;
  botId: string;
}

/** The run, Turn, and Session a Computer-side write is attributed to. */
export interface BotComputerSyncTurn {
  runId: string;
  turnId: string;
  sessionId: string;
}

/**
 * The narrow slice of the Durable Object environment this module reads. Named
 * as its own type so each binding's absence is a typed state, not a cast.
 */
export interface BotComputerSyncEnv {
  /** The durable roots in object storage, built with the `sync` surface. */
  WORKSPACE_SYNC_FILES?: WorkspaceFilesV1;
  /** Where a push records its intent, in this Bot's Durable Object. */
  WORKSPACE_SYNC_EFFECTS?: WorkspaceSyncEffectsV1;
  /** This object's generation ledger, read to recover a removal's writer. */
  WORKSPACE_SYNC_GENERATIONS?: WorkspaceGenerationsV1;
}

/**
 * The Computer sync seam one admitted Turn runs under, or `undefined` when the
 * object-storage side is unavailable.
 */
export function createBotComputerSyncHost(
  identity: BotComputerSyncIdentity,
  turn: BotComputerSyncTurn,
  env: object,
): ComputerSyncHostV1 | undefined {
  // SAFETY: these surfaces are constructed onto the Durable Object environment
  // rather than declared in the generated `Env`; they are not Worker bindings.
  const bound = env as BotComputerSyncEnv;
  const store = bound.WORKSPACE_SYNC_FILES;
  if (!store) return undefined;
  return {
    store,
    ...(bound.WORKSPACE_SYNC_EFFECTS
      ? { effects: bound.WORKSPACE_SYNC_EFFECTS }
      : {}),
    ...(bound.WORKSPACE_SYNC_GENERATIONS
      ? { generations: bound.WORKSPACE_SYNC_GENERATIONS }
      : {}),
    // A file a shell wrote on the Computer recorded no writer. It becomes a
    // durable generation attributed to the Bot whose Turn had the Computer
    // open — data the Bot can read, never an instruction it may load, because
    // `isLoadableSkillSourceV1` answers on the root and the writer, not on the
    // fact that a generation exists.
    writer: {
      kind: "bot",
      botId: identity.botId,
      sessionId: turn.sessionId,
      turnId: turn.turnId,
      runId: turn.runId,
    },
  };
}
