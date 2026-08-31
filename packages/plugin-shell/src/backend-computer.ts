// The Bot Durable Object's half of the Computer sync seam (ADR 0013).
//
// The durable-root sync reconciles two halves: the Workspace on the Computer,
// which the Computer provider Package owns, and object storage, whose
// authority is this Durable Object. This module supplies the second half for
// one admitted Turn — the store surface, the effect records a push writes
// before it runs, and the generation ledger a removal's writer is recovered
// from. It runs no sync and implements no interface; the provider Package does
// both.
//
// ATTRIBUTION. Nothing here names a writer for what the sync finds. "A file
// that reaches a durable root without passing through the Workspace file
// surface (a shell write on the Computer) is mirrored to object storage by the
// sync with an unattributed writer": one Computer serves all of a User's Bots,
// so this object cannot know which Bot's process wrote a file, and the Turn
// that happens to be running is not evidence. A Bot that means to author a
// Skill writes it through the Workspace file surface, which records real
// provenance.
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
 *
 * It takes no identity and no Turn, and that is the point: see ATTRIBUTION
 * above. What a sync finds on the Computer is attributed to nobody, so knowing
 * which Bot, Session, and Turn asked for the sync would only be an invitation
 * to record a writer this seam cannot support.
 */
export function createBotComputerSyncHost(
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
  };
}
