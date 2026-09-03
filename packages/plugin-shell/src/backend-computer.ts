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
import type { FrockBotManifest } from "@frockbot/kernel-composition";

/**
 * One installed Package, as the durable-root supplier needs to see it: what
 * the User installed, and what that exact version's manifest declares.
 */
export interface DeclaredPackageRootSourceV1 {
  /** The User's installations, from the User configuration view. */
  installations: readonly {
    packageId: string;
    version: string;
    state: "installed" | "disabled" | "failed";
  }[];
  /** The application's compiled Packages, each with the manifest it shipped. */
  packages: readonly {
    id: string;
    version: string;
    manifest: FrockBotManifest;
  }[];
}

/**
 * The `package-declared` durable roots this User's *enabled* Packages declare.
 *
 * "Durable roots, declared by the Computer Package's Workspace layout and by
 * Package manifests." Until this existed the second half of that sentence had
 * no supplier: `declaredWorkspaceRootsV1` took a `packageRoots` argument that
 * nothing in production passed, so `image/generated` — a root the Image
 * Package has written since it shipped — never reached the durable-root sync
 * and never appeared on a Computer. This is the missing half, and
 * `applets/source` (ADR 0022) is the reason it could no longer be missing.
 *
 * ENABLEMENT decides membership, by the same `state === "installed"` test
 * `resolveBotExecutionPlanV1` applies to Capabilities and against the same
 * exact version the application compiled. A root of a Package the User
 * disabled or never installed is not synchronized: materializing files for a
 * Package that cannot run would grow directories on a Computer that no Bot on
 * it could explain, and would keep syncing them after an uninstall.
 *
 * SCOPE is the User's, always. A `package-declared` root names no Bot, so this
 * takes no Bot and answers the same for every tenant on one Computer.
 */
export function declaredPackageRootsV1(
  source: DeclaredPackageRootSourceV1,
): { packageId: string; rootId: string }[] {
  const roots: { packageId: string; rootId: string }[] = [];
  for (const installation of source.installations) {
    if (installation.state !== "installed") continue;
    const declared = source.packages.find(
      (candidate) =>
        candidate.id === installation.packageId &&
        candidate.version === installation.version,
    );
    for (const root of declared?.manifest.roots ?? []) {
      const entry = { packageId: installation.packageId, rootId: root.id };
      // One entry per root: the sync walks this list, and a duplicate would
      // reconcile the same root twice in a single pass.
      if (
        !roots.some(
          (candidate) =>
            candidate.packageId === entry.packageId &&
            candidate.rootId === entry.rootId,
        )
      ) {
        roots.push(entry);
      }
    }
  }
  roots.sort(
    (left, right) =>
      left.packageId.localeCompare(right.packageId) ||
      left.rootId.localeCompare(right.rootId),
  );
  return roots;
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
 *
 * It takes no identity and no Turn, and that is the point: see ATTRIBUTION
 * above. What a sync finds on the Computer is attributed to nobody, so knowing
 * which Bot, Session, and Turn asked for the sync would only be an invitation
 * to record a writer this seam cannot support.
 *
 * `packageRoots` is the one thing it does take beyond the bindings, because a
 * Package's declared roots are a fact about the *User's* installation rather
 * than about the Turn: see {@link declaredPackageRootsV1}.
 */
export function createBotComputerSyncHost(
  env: object,
  packageRoots: readonly { packageId: string; rootId: string }[] = [],
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
    ...(packageRoots.length > 0 ? { packageRoots } : {}),
  };
}
