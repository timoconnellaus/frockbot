// The Computer-side half of ADR 0013: the durable roots on the Workspace and
// the durable roots in object storage are one set of files.
//
// **Mechanism, and why it is not a FUSE mount.** The ADR's prior art
// (`docs/research/zerobsai-memory-sandbox.md`) mounts an R2 bucket into the
// sandbox with tigrisfs. That cannot be what FrockBot does, for three reasons
// that are constitutional rather than aesthetic:
//
//  1. "No secret lives on the Workspace except the User's browser profile." A
//     FUSE mount needs object-storage credentials *inside* the Computer. There
//     is no way to mount a bucket without giving the Workspace a key to it.
//  2. "a write that would overwrite a generation its writer has not seen is
//     preserved as a conflicting generation and surfaced, never merged or
//     dropped; last-writer-wins is prohibited." A filesystem write has no
//     `If-Match` and no losing-writer branch: tigrisfs is last-writer-wins by
//     construction, which is the one rule the ADR names as prohibited.
//  3. "every write to a durable root records its writer." A `write(2)` carries
//     no writer, so a mount cannot record one.
//
// So the sync is an agent, not a mount. It runs where the credentials and the
// generation ledger already are — the backend — and reaches the Computer only
// through the Sprite's storage exec path, which is the same path
// `FlyWorkspaceFiles` uses. Two consequences follow, and both are wanted: the
// object-storage side keeps working with the Computer hibernated (the store is
// a `WorkspaceFilesV1` in its own right, and Memory and Skills read it without
// waking anything), and nothing on the Computer holds a credential.
//
// On the Sprite there is one small provider-declared service,
// `WORKSPACE_SYNC_SERVICE`. It holds no credentials and does no network: it
// watches the declared roots and bumps a change signal, so the agent can tell
// "something changed while I was away" from "nothing to do" without scanning
// every root on every Turn. It is a *service* rather than a background process
// because "Only Computer-provider-declared services may be reattached; other
// processes are assumed dead after a cold pause."
//
// **What the agent does per root.**
//
//   push (non-Memory roots only)
//     a file whose bytes no longer match its generation sidecar, or which has
//     no sidecar at all, is a Computer-side write. It is pushed to the store
//     with `expectedGenerationId` set to the generation the sidecar last saw,
//     so the store's conditional write decides it. A losing write is preserved
//     by the store under its conflict key *and* on the Computer under
//     `.frockbot-sync/conflicts/`, and surfaced in the report — both
//     generations survive, neither is merged.
//   pull (every declared root)
//     a store generation the Computer has not got is materialized at its mount
//     path together with its sidecar, so `generationOf` answers with the
//     writer the store recorded. Memory roots are pull-only: a Memory file
//     edited on the Computer is never pushed, it is restored.
//   tombstones
//     a delete on either side becomes a removal on the other, recorded. A
//     Computer-side delete leaves `.frockbot-sync/tombstones/<rel>` naming the
//     generation it superseded; a store-side delete removes the file on the
//     Computer and leaves the same record. Neither side ever reads an absence
//     as "a file I never had" and silently re-creates it. A tombstone is a
//     file in an ordinary directory a shell can write, so a Computer-side
//     removal carries no writer at all: it is pushed as an unattributed
//     delete, and only on a non-Memory root, where the store accepts one. The
//     generation it names is still the conditional delete's precondition, so a
//     removal the store has moved past is refused and surfaced.
//
// **Writer attribution.** A file the sync finds with no valid sidecar was
// written by a shell on the Computer, so nothing recorded who wrote it, and it
// is pushed as `{ kind: "unattributed" }`. That is the constitution's own
// sentence — "A file that reaches a durable root without passing through the
// Workspace file surface (a shell write on the Computer) is mirrored to object
// storage by the sync with an unattributed writer" — and it is also the only
// honest answer: one Computer serves all of a User's Bots, so the sync cannot
// know which Bot's process wrote a file, and the Turn that happens to be
// running is a coincidence rather than evidence. A Bot that means to author a
// Skill writes it through the Workspace file surface, which records real
// provenance. The Skills loader refuses `unattributed`, so a shell-written
// file is durable data and never an instruction.
//
// **Effect identifiers.** "A mutation ... records intent and an effect
// identifier in the Bot's Durable Object and in the Workspace before it runs,
// so recovery can read its outcome or classify it as unknown without repeating
// it." Every push records its intent before the write, against a deterministic
// effect id derived from the root, the path, the bytes, and the generation the
// writer had seen. Connections to the Computer drop on every pause, so a push
// that never reported back is ordinary: the next run finds the unsettled
// intent, reads what the store actually holds, and adopts the generation
// instead of writing a second one.
import { createHash } from "node:crypto";
import {
  workspaceMountPathV1,
  type WorkspaceLayoutV1,
} from "@frockbot/computer-core";
import {
  decodeWorkspaceGenerationV1,
  isWorkspaceComputerReadOnlyRootV1,
  normalizeWorkspaceRelativePathV1,
  workspaceRootKeyV1,
  type WorkspaceFailureV1,
  type WorkspaceFilesV1,
  type WorkspaceGenerationV1,
  type WorkspaceGenerationsV1,
  type WorkspaceRootV1,
  type WorkspaceSyncEffectsV1,
  type WorkspaceSyncEffectV1,
} from "@frockbot/kernel-contracts";
import type { FlySpriteAgentComputer } from "./computer.js";
import {
  SYNC_CONFLICTS_DIR,
  SYNC_TOMBSTONES_DIR,
  WORKSPACE_EMPTY_SHA256,
  WORKSPACE_GENERATIONS_DIR,
  WORKSPACE_SYNC_DIR,
} from "./workspace.js";

/** Where the sync keeps notes that are not scoped to one root. */
const SYNC_NOTES_DIR = ".frockbot/sync";
/** The note kind holding unsettled push intents. */
const EFFECT_NOTE_KIND = "effects";
const MAX_STORE_PAGES = 100;
const STORE_PAGE_LIMIT = 500;

function failure(
  status: WorkspaceFailureV1["status"],
  reason: string,
): WorkspaceFailureV1 {
  return { status, reason: reason.slice(0, 512) };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function isFailure(value: { status: string }): value is WorkspaceFailureV1 {
  return value.status !== "ok";
}

/** A file the Computer holds under one durable root. */
export interface ComputerSyncEntryV1 {
  path: string;
  /** sha-256 of the bytes on disk right now. */
  contentHash: string;
  size: number;
  /** The generation its sidecar records, absent when a shell wrote it. */
  recorded?: WorkspaceGenerationV1;
}

/**
 * A file the Computer no longer holds, and the durable evidence of that: the
 * generation the removal superseded.
 *
 * There is deliberately no writer here. A tombstone is a file in an ordinary
 * directory on the Computer, so a shell can write one — copying the superseded
 * generation id straight out of the sidecar beside it — naming any writer it
 * likes. A generation sidecar survives that because the bytes it describes are
 * the proof, and a removal has no bytes; so a Computer-side removal records no
 * writer, and the sync does not carry a claim it cannot check. What
 * `supersedes` buys instead is the conditional delete: a removal that does not
 * name the generation the store holds is refused and surfaced as a conflict.
 */
export interface ComputerSyncRemovalV1 {
  path: string;
  supersedes?: string;
}

export interface ComputerSyncScanV1 {
  entries: ComputerSyncEntryV1[];
  removed: ComputerSyncRemovalV1[];
}

export type ComputerSyncOutcomeV1 = { status: "ok" } | WorkspaceFailureV1;
export type ComputerSyncScanOutcomeV1 =
  { status: "ok"; scan: ComputerSyncScanV1 } | WorkspaceFailureV1;
export type ComputerSyncBytesOutcomeV1 =
  { status: "ok"; bytes: Uint8Array } | WorkspaceFailureV1;
export type ComputerSyncNoteOutcomeV1 =
  { status: "ok"; text?: string } | WorkspaceFailureV1;

/**
 * The Computer half of the sync, as a narrow seam.
 *
 * It is deliberately not `WorkspaceFilesV1`: that interface is for *authoring*
 * a file — it mints a generation and refuses an `unattributed` writer — and
 * the sync authors nothing on the Computer, it materializes generations the
 * store already recorded. Keeping the two apart is what stops the sync from
 * being a second writer with an opinion.
 */
export interface ComputerSyncSurfaceV1 {
  /** Every file and every recorded removal under one durable root. */
  scan(root: WorkspaceRootV1): Promise<ComputerSyncScanOutcomeV1>;
  read(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<ComputerSyncBytesOutcomeV1>;
  /** Writes bytes and the generation sidecar that attributes them. */
  materialize(
    root: WorkspaceRootV1,
    path: string,
    bytes: Uint8Array,
    generation: WorkspaceGenerationV1,
  ): Promise<ComputerSyncOutcomeV1>;
  /** Removes a file and records the removal durably. */
  remove(
    root: WorkspaceRootV1,
    path: string,
    supersedes: string | undefined,
    tombstone: WorkspaceGenerationV1,
  ): Promise<ComputerSyncOutcomeV1>;
  /** Clears a removal record once the store has accepted it. */
  forget(root: WorkspaceRootV1, path: string): Promise<ComputerSyncOutcomeV1>;
  /** Keeps a losing write on the Computer beside the winner. */
  preserve(
    root: WorkspaceRootV1,
    path: string,
    bytes: Uint8Array,
    generation: WorkspaceGenerationV1,
  ): Promise<ComputerSyncOutcomeV1>;
  note(kind: string, id: string, text: string): Promise<ComputerSyncOutcomeV1>;
  readNote(kind: string, id: string): Promise<ComputerSyncNoteOutcomeV1>;
  clearNote(kind: string, id: string): Promise<ComputerSyncOutcomeV1>;
  /** The change signal the on-Sprite service maintains. */
  signal(): Promise<ComputerSyncNoteOutcomeV1>;
}

/**
 * Where a push records its intent, and the record it writes. Both are declared
 * by the kernel (`@frockbot/kernel-contracts`), because the Bot's Durable
 * Object implements the interface and a Package may not declare what an
 * authority must store. `createWorkspaceSidecarEffectsV1` below is the
 * Workspace half, which § Durable effects also allows ("in the Bot's Durable
 * Object **and** in the Workspace").
 */
export type {
  WorkspaceSyncEffectV1,
  WorkspaceSyncEffectsV1,
} from "@frockbot/kernel-contracts";

/** A conflict the sync preserved and is surfacing. */
export interface WorkspaceSyncConflictV1 {
  root: WorkspaceRootV1;
  path: string;
  reason: string;
  /** The generation that holds the file now. */
  current?: WorkspaceGenerationV1;
  /** The losing write, preserved in the store and on the Computer. */
  preserved?: WorkspaceGenerationV1;
}

export interface WorkspaceSyncFailureV1 extends WorkspaceFailureV1 {
  root: WorkspaceRootV1;
  path?: string;
}

export interface WorkspaceSyncRootReportV1 {
  root: WorkspaceRootV1;
  /** Store generations materialized on the Computer. */
  pulled: string[];
  /** Computer writes accepted by the store. */
  pushed: string[];
  /** Memory-root files put back from the store after a Computer-side edit. */
  restored: string[];
  /** Files removed on the Computer because the store no longer holds them. */
  removedOnComputer: string[];
  /** Files removed in the store because the Computer recorded a removal. */
  removedInStore: string[];
  /** Pushes a previous run had already applied, adopted rather than repeated. */
  adopted: string[];
  conflicts: WorkspaceSyncConflictV1[];
  failures: WorkspaceSyncFailureV1[];
}

export interface WorkspaceSyncReportV1 {
  roots: WorkspaceSyncRootReportV1[];
  conflicts: WorkspaceSyncConflictV1[];
  failures: WorkspaceSyncFailureV1[];
}

export interface WorkspaceRootSyncOptionsV1 {
  /** The object-storage side, built with `surface: "sync"`. */
  store: WorkspaceFilesV1;
  /** The Computer side. */
  computer: ComputerSyncSurfaceV1;
  /** The declared durable roots this Computer serves. */
  roots: WorkspaceRootV1[];
  /** Where a push records its intent; the Workspace sidecar when absent. */
  effects?: WorkspaceSyncEffectsV1;
  /**
   * The owning Durable Object's ledger, when it is reachable. It is read, never
   * written: a store-side delete is a tombstone record there, and object
   * storage forgets the key, so this is the only place the writer of a removal
   * can be recovered.
   */
  generations?: WorkspaceGenerationsV1;
  clock?: () => Date;
}

export interface WorkspaceRootSyncV1 {
  /** Reconciles every declared root. */
  sync(): Promise<WorkspaceSyncReportV1>;
  syncRoot(root: WorkspaceRootV1): Promise<WorkspaceSyncRootReportV1>;
  /**
   * The on-Sprite watcher's change signal. A caller runs the sync on wake and
   * whenever this changes, rather than scanning every root every Turn.
   */
  signal(): Promise<ComputerSyncNoteOutcomeV1>;
}

/** A deterministic effect id: the same pending push resolves to the same key. */
export function workspaceSyncEffectIdV1(
  root: WorkspaceRootV1,
  path: string,
  kind: "push" | "remove",
  contentHash: string,
  expectedGenerationId: string | null,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        workspaceRootKeyV1(root),
        path,
        kind,
        contentHash,
        expectedGenerationId,
      ]),
    )
    .digest("hex");
  return `workspace-sync-${digest.slice(0, 32)}`;
}

function emptyReport(root: WorkspaceRootV1): WorkspaceSyncRootReportV1 {
  return {
    root,
    pulled: [],
    pushed: [],
    restored: [],
    removedOnComputer: [],
    removedInStore: [],
    adopted: [],
    conflicts: [],
    failures: [],
  };
}

class WorkspaceRootSync implements WorkspaceRootSyncV1 {
  private readonly effects: WorkspaceSyncEffectsV1;
  private readonly clock: () => Date;

  constructor(private readonly options: WorkspaceRootSyncOptionsV1) {
    this.effects =
      options.effects ?? createWorkspaceSidecarEffectsV1(options.computer);
    this.clock = options.clock ?? (() => new Date());
  }

  signal(): Promise<ComputerSyncNoteOutcomeV1> {
    return this.options.computer.signal();
  }

  async sync(): Promise<WorkspaceSyncReportV1> {
    const roots: WorkspaceSyncRootReportV1[] = [];
    for (const root of this.options.roots) {
      roots.push(await this.syncRoot(root));
    }
    return {
      roots,
      conflicts: roots.flatMap((report) => report.conflicts),
      failures: roots.flatMap((report) => report.failures),
    };
  }

  async syncRoot(root: WorkspaceRootV1): Promise<WorkspaceSyncRootReportV1> {
    const report = emptyReport(root);
    const scanned = await this.options.computer.scan(root);
    if (isFailure(scanned)) {
      report.failures.push({ ...scanned, root });
      return report;
    }
    const stored = await this.listStore(root);
    if (isFailure(stored)) {
      report.failures.push({ ...stored, root });
      return report;
    }
    const local = new Map(
      scanned.scan.entries.map((entry) => [entry.path, entry] as const),
    );
    const settled = new Set<string>();
    const conflicted = new Set<string>();
    const held = new Set<string>();
    // Memory roots and the User-global instruction root are presented
    // read-only on the Computer: object storage is their single writer, so
    // this sync materializes them and never pushes out of them (ADR 0013,
    // ADR 0016).
    const readOnlyOnComputer = isWorkspaceComputerReadOnlyRootV1(root);

    if (!readOnlyOnComputer) {
      // Push first: a Computer-side write must reach the store's conditional
      // write before the pull could overwrite it.
      for (const entry of scanned.scan.entries) {
        if (this.clean(entry)) continue;
        const pushed = await this.push(root, entry, report);
        if (pushed === "pushed") settled.add(entry.path);
        else if (pushed === "conflict") conflicted.add(entry.path);
        else held.add(entry.path);
      }
      for (const removal of scanned.scan.removed) {
        await this.pushRemoval(root, removal, stored, report);
      }
    } else {
      // A Memory root is written only by the Memory Package, and the
      // User-global instruction root only by the Skills Package, both through
      // object storage. A removal recorded here is a Computer-side edit of a
      // read-only presentation: it is never pushed, and the pull below
      // restores the file.
      for (const removal of scanned.scan.removed) {
        await this.options.computer.forget(root, removal.path);
      }
    }

    for (const [path, generation] of stored.generations) {
      // A Computer-side write that has not reached the store is never
      // overwritten by the pull; leaving it is what "never dropped" means.
      if (held.has(path) || settled.has(path)) continue;
      const entry = local.get(path);
      if (
        !conflicted.has(path) &&
        entry &&
        this.clean(entry) &&
        entry.recorded?.generationId === generation.generationId
      ) {
        continue;
      }
      const materialized = await this.materialize(root, path);
      if (materialized) {
        report.failures.push({ ...materialized, root, path });
        continue;
      }
      if (entry && (readOnlyOnComputer || conflicted.has(path)))
        report.restored.push(path);
      else report.pulled.push(path);
    }

    for (const entry of scanned.scan.entries) {
      if (stored.generations.has(entry.path)) continue;
      if (held.has(entry.path) || settled.has(entry.path)) continue;
      if (conflicted.has(entry.path)) continue;
      if (!entry.recorded) continue;
      // The Computer holds a file the store recorded and no longer holds: a
      // delete happened there. It becomes a removal here, recorded, never a
      // silent overwrite.
      const removed = await this.removeLocally(root, entry, report);
      if (removed) report.removedOnComputer.push(entry.path);
    }
    return report;
  }

  /** True when the file's bytes are still the ones its sidecar attributes. */
  private clean(entry: ComputerSyncEntryV1): boolean {
    return (
      entry.recorded !== undefined &&
      entry.contentHash === entry.recorded.contentHash
    );
  }

  private async listStore(
    root: WorkspaceRootV1,
  ): Promise<
    | { status: "ok"; generations: Map<string, WorkspaceGenerationV1> }
    | WorkspaceFailureV1
  > {
    const generations = new Map<string, WorkspaceGenerationV1>();
    let cursor: string | undefined;
    for (let page = 0; page < MAX_STORE_PAGES; page += 1) {
      const listed = await this.options.store.list({
        root,
        limit: STORE_PAGE_LIMIT,
        ...(cursor ? { cursor } : {}),
      });
      if (listed.status !== "ok") return listed;
      for (const entry of listed.entries) {
        generations.set(entry.path.path, entry.generation);
      }
      if (!listed.cursor) return { status: "ok", generations };
      cursor = listed.cursor;
    }
    return failure("unavailable", "Durable root listing did not terminate");
  }

  /**
   * Pushes one Computer-side write. `"held"` means the store did not take it,
   * so the Computer's bytes stay exactly where they are.
   */
  private async push(
    root: WorkspaceRootV1,
    entry: ComputerSyncEntryV1,
    report: WorkspaceSyncRootReportV1,
  ): Promise<"pushed" | "conflict" | "held"> {
    const bytes = await this.options.computer.read(root, entry.path);
    if (isFailure(bytes)) {
      report.failures.push({ ...bytes, root, path: entry.path });
      return "held";
    }
    const expected = entry.recorded?.generationId ?? null;
    const effect: WorkspaceSyncEffectV1 = {
      effectId: workspaceSyncEffectIdV1(
        root,
        entry.path,
        "push",
        entry.contentHash,
        expected,
      ),
      root,
      path: entry.path,
      kind: "push",
      contentHash: entry.contentHash,
      expectedGenerationId: expected,
      at: this.clock().toISOString(),
    };
    // Recovery, before the effect: an intent that never reported back is
    // ordinary — connections to the Computer drop on every pause — so read
    // what the store holds and adopt it rather than writing again.
    const pending = await this.pendingEffect(effect);
    if (pending) {
      const adopted = await this.adopt(root, entry, bytes.bytes, report);
      if (adopted) {
        await this.effects.settle(effect);
        return "pushed";
      }
    }
    await this.effects.intent(effect);
    let outcome;
    try {
      outcome = await this.options.store.write({
        path: { root, path: entry.path },
        bytes: bytes.bytes,
        // Nothing on the Computer recorded who wrote these bytes, so nothing
        // here may claim one. See **Writer attribution** above.
        writer: { kind: "unattributed" },
        expectedGenerationId: expected,
      });
    } catch (error) {
      // The intent stays unsettled on purpose: the next run reads what the
      // store holds rather than writing a second generation.
      report.failures.push({
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
        root,
        path: entry.path,
      });
      return "held";
    }
    if (outcome.status === "ok") {
      const sidecar = await this.options.computer.materialize(
        root,
        entry.path,
        bytes.bytes,
        outcome.generation,
      );
      if (sidecar.status !== "ok") {
        // The intent stays unsettled on purpose. The store took the bytes but
        // the Computer has no sidecar for them, so the next run would see an
        // unrecorded file and push it again against `null` — a conflict the
        // store would be right to raise and nobody caused. Leaving the intent
        // is what makes that next run adopt the generation instead.
        report.failures.push({ ...sidecar, root, path: entry.path });
        return "held";
      }
      await this.effects.settle(effect);
      report.pushed.push(entry.path);
      return "pushed";
    }
    await this.effects.settle(effect);
    if (outcome.status === "conflict") {
      const conflict: WorkspaceSyncConflictV1 = {
        root,
        path: entry.path,
        reason: outcome.reason,
        ...("current" in outcome && outcome.current
          ? { current: outcome.current }
          : {}),
        ...("preserved" in outcome && outcome.preserved
          ? { preserved: outcome.preserved }
          : {}),
      };
      report.conflicts.push(conflict);
      if (conflict.preserved) {
        await this.options.computer.preserve(
          root,
          entry.path,
          bytes.bytes,
          conflict.preserved,
        );
      }
      // The winner is materialized by the pull below; leaving the loser at the
      // path would be a silent merge of two generations into one file.
      return "conflict";
    }
    report.failures.push({ ...outcome, root, path: entry.path });
    return "held";
  }

  private async pendingEffect(effect: WorkspaceSyncEffectV1): Promise<boolean> {
    try {
      return (await this.effects.pending(effect.effectId)) !== undefined;
    } catch {
      return false;
    }
  }

  /**
   * Adopts a generation the store already holds for exactly these bytes. This
   * is the reconciliation half of an effect identifier: the outcome is read,
   * never repeated.
   */
  private async adopt(
    root: WorkspaceRootV1,
    entry: ComputerSyncEntryV1,
    bytes: Uint8Array,
    report: WorkspaceSyncRootReportV1,
  ): Promise<boolean> {
    const current = await this.options.store.stat({ root, path: entry.path });
    if (current.status !== "ok") return false;
    if (current.entry.generation.contentHash !== entry.contentHash)
      return false;
    const sidecar = await this.options.computer.materialize(
      root,
      entry.path,
      bytes,
      current.entry.generation,
    );
    if (sidecar.status !== "ok") return false;
    report.adopted.push(entry.path);
    return true;
  }

  private async pushRemoval(
    root: WorkspaceRootV1,
    removal: ComputerSyncRemovalV1,
    stored: { generations: Map<string, WorkspaceGenerationV1> },
    report: WorkspaceSyncRootReportV1,
  ): Promise<void> {
    const held = stored.generations.get(removal.path);
    if (!held) {
      // Both sides agree the file is gone; the record has done its work.
      await this.options.computer.forget(root, removal.path);
      return;
    }
    const expected = removal.supersedes ?? held.generationId;
    const effect: WorkspaceSyncEffectV1 = {
      effectId: workspaceSyncEffectIdV1(
        root,
        removal.path,
        "remove",
        WORKSPACE_EMPTY_SHA256,
        expected,
      ),
      root,
      path: removal.path,
      kind: "remove",
      contentHash: WORKSPACE_EMPTY_SHA256,
      expectedGenerationId: expected,
      at: this.clock().toISOString(),
    };
    await this.effects.intent(effect);
    let outcome;
    try {
      outcome = await this.options.store.delete({
        path: { root, path: removal.path },
        // Nothing on the Computer can prove who removed the file; see
        // `ComputerSyncRemovalV1`.
        writer: { kind: "unattributed" },
        expectedGenerationId: expected,
      });
    } catch (error) {
      report.failures.push({
        status: "unavailable",
        reason: error instanceof Error ? error.message : String(error),
        root,
        path: removal.path,
      });
      return;
    }
    await this.effects.settle(effect);
    if (outcome.status === "ok" || outcome.status === "not-found") {
      stored.generations.delete(removal.path);
      await this.options.computer.forget(root, removal.path);
      report.removedInStore.push(removal.path);
      return;
    }
    if (outcome.status === "conflict") {
      report.conflicts.push({
        root,
        path: removal.path,
        reason: outcome.reason,
        ...("current" in outcome && outcome.current
          ? { current: outcome.current }
          : {}),
      });
      // The store moved on after the removal was recorded. The pull restores
      // the file; the removal is surfaced rather than applied.
      await this.options.computer.forget(root, removal.path);
      return;
    }
    report.failures.push({ ...outcome, root, path: removal.path });
  }

  /**
   * Materializes one store generation on the Computer, sidecar included, so
   * `generationOf` there answers with the writer the store recorded rather
   * than `unattributed`.
   */
  private async materialize(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<WorkspaceFailureV1 | undefined> {
    const read = await this.options.store.read({ root, path });
    if (read.status !== "ok") return read;
    const written = await this.options.computer.materialize(
      root,
      path,
      read.file.bytes,
      read.file.generation,
    );
    if (written.status !== "ok") return written;
    return undefined;
  }

  private async removeLocally(
    root: WorkspaceRootV1,
    entry: ComputerSyncEntryV1,
    report: WorkspaceSyncRootReportV1,
  ): Promise<boolean> {
    const tombstone = await this.storeTombstone(root, entry);
    const removed = await this.options.computer.remove(
      root,
      entry.path,
      entry.recorded?.generationId,
      tombstone,
    );
    if (removed.status !== "ok") {
      report.failures.push({ ...removed, root, path: entry.path });
      return false;
    }
    // The removal is now mirrored on both sides; the record would otherwise be
    // pushed back to the store as a second delete.
    await this.options.computer.forget(root, entry.path);
    return true;
  }

  /**
   * The tombstone generation to record on the Computer for a store-side
   * delete. The ledger holds the writer when the Durable Object is reachable;
   * otherwise the removal is recorded with no writer, which is the truth.
   */
  private async storeTombstone(
    root: WorkspaceRootV1,
    entry: ComputerSyncEntryV1,
  ): Promise<WorkspaceGenerationV1> {
    if (this.options.generations) {
      try {
        const record = await this.options.generations.current(root, entry.path);
        if (record?.deleted) return record.generation;
      } catch {
        // The ledger is unreachable; record the removal without a writer.
      }
    }
    const at = this.clock();
    return {
      schemaVersion: 1,
      generationId: `${at.getTime().toString().padStart(15, "0")}-sync`,
      contentHash: WORKSPACE_EMPTY_SHA256,
      size: 0,
      writer: { kind: "unattributed" },
      writtenAt: at.toISOString(),
    };
  }
}

/** The durable-root sync of ADR 0013, Computer side. */
export function createWorkspaceRootSyncV1(
  options: WorkspaceRootSyncOptionsV1,
): WorkspaceRootSyncV1 {
  return new WorkspaceRootSync(options);
}

/**
 * Push intents recorded in the Workspace rather than in a Durable Object. §
 * Durable effects wants both; this is the half that is always reachable while
 * the Computer is awake, and the half a sync driven from outside a Bot's
 * Durable Object has.
 */
export function createWorkspaceSidecarEffectsV1(
  computer: ComputerSyncSurfaceV1,
): WorkspaceSyncEffectsV1 {
  return {
    async intent(effect) {
      await computer.note(
        EFFECT_NOTE_KIND,
        effect.effectId,
        JSON.stringify(effect),
      );
    },
    async settle(effect) {
      await computer.clearNote(EFFECT_NOTE_KIND, effect.effectId);
    },
    async pending(effectId) {
      const note = await computer.readNote(EFFECT_NOTE_KIND, effectId);
      if (note.status !== "ok" || !note.text) return undefined;
      try {
        return JSON.parse(note.text) as WorkspaceSyncEffectV1;
      } catch {
        return undefined;
      }
    },
  };
}

export interface FlySpriteSyncSurfaceOptions {
  computer: FlySpriteAgentComputer;
  layout: WorkspaceLayoutV1;
  userId: string;
  botDirectoryKey: (botId: string) => string;
}

/**
 * `ComputerSyncSurfaceV1` over one Fly Sprite, through the same storage exec
 * path `FlyWorkspaceFiles` uses. Every failure is a declared variant: the
 * Sprite pauses, and a dropped connection is an ordinary answer the sync
 * resumes from rather than a failure.
 */
export class FlySpriteSyncSurface implements ComputerSyncSurfaceV1 {
  constructor(private readonly options: FlySpriteSyncSurfaceOptions) {}

  private mount(root: WorkspaceRootV1): string | WorkspaceFailureV1 {
    if (root.userId !== this.options.userId) {
      return failure(
        "refused",
        "This Computer belongs to a different User's Workspace",
      );
    }
    try {
      return workspaceMountPathV1(
        this.options.layout,
        root,
        this.options.botDirectoryKey,
      );
    } catch (error) {
      return failure(
        "not-found",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async run(script: string): Promise<string | WorkspaceFailureV1> {
    try {
      return await this.options.computer.runStorage(
        script,
        new AbortController().signal,
      );
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private relative(path: string): string | WorkspaceFailureV1 {
    try {
      return normalizeWorkspaceRelativePathV1(path);
    } catch (error) {
      return failure(
        "refused",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private decodeMeta(encoded: string): WorkspaceGenerationV1 | undefined {
    if (!encoded) return undefined;
    try {
      const text = Buffer.from(encoded, "base64").toString("utf8");
      const body = text.slice(text.indexOf("\n") + 1);
      return decodeWorkspaceGenerationV1(JSON.parse(body));
    } catch {
      return undefined;
    }
  }

  private encodeMeta(generation: WorkspaceGenerationV1): string {
    return Buffer.from(
      `${generation.generationId}\n${JSON.stringify(generation)}`,
    ).toString("base64");
  }

  async scan(root: WorkspaceRootV1): Promise<ComputerSyncScanOutcomeV1> {
    const mount = this.mount(root);
    if (typeof mount !== "string") return mount;
    const script = [
      `ROOT=${shellQuote(mount)}`,
      `mkdir -p "$ROOT" "$ROOT/${WORKSPACE_GENERATIONS_DIR}" "$ROOT/${WORKSPACE_SYNC_DIR}/${SYNC_TOMBSTONES_DIR}"`,
      `find "$ROOT" -type f ! -path "$ROOT/${WORKSPACE_GENERATIONS_DIR}/*" ! -path "$ROOT/${WORKSPACE_SYNC_DIR}/*" ! -path "$ROOT/.frockbot-locks/*" -print0 | sort -z | while IFS= read -r -d "" FILE; do`,
      '  REL=${FILE#"$ROOT"/}',
      `  META="$ROOT/${WORKSPACE_GENERATIONS_DIR}/$REL"`,
      '  printf "F\\t%s\\t%s\\t%s\\t%s\\n" "$(printf %s "$REL" | base64 -w0)" "$({ cat "$META" 2>/dev/null || printf \'\'; } | base64 -w0)" "$(sha256sum "$FILE" | cut -d" " -f1)" "$(stat -c %s "$FILE")"',
      "done",
      `GRAVES="$ROOT/${WORKSPACE_SYNC_DIR}/${SYNC_TOMBSTONES_DIR}"`,
      'find "$GRAVES" -type f -print0 | sort -z | while IFS= read -r -d "" FILE; do',
      '  REL=${FILE#"$GRAVES"/}',
      '  printf "T\\t%s\\t%s\\n" "$(printf %s "$REL" | base64 -w0)" "$(base64 -w0 "$FILE")"',
      "done",
      `METAS="$ROOT/${WORKSPACE_GENERATIONS_DIR}"`,
      'find "$METAS" -type f -print0 | sort -z | while IFS= read -r -d "" FILE; do',
      '  REL=${FILE#"$METAS"/}',
      '  if [ -f "$ROOT/$REL" ]; then continue; fi',
      '  printf "S\\t%s\\t%s\\n" "$(printf %s "$REL" | base64 -w0)" "$(base64 -w0 "$FILE")"',
      "done",
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    const entries: ComputerSyncEntryV1[] = [];
    const removed = new Map<string, ComputerSyncRemovalV1>();
    for (const row of output.split("\n")) {
      if (!row.trim()) continue;
      const [tag, encodedPath, second = "", third = "", fourth = ""] =
        row.split("\t");
      if (!encodedPath) continue;
      const path = Buffer.from(encodedPath, "base64").toString("utf8");
      const relative = this.relative(path);
      if (typeof relative !== "string") continue;
      if (tag === "F") {
        const recorded = this.decodeMeta(second.trim());
        entries.push({
          path: relative,
          contentHash: third.trim(),
          size: Number(fourth.trim()),
          ...(recorded ? { recorded } : {}),
        });
        continue;
      }
      if (tag === "T") {
        // Only the superseded generation id is read. The record's own writer
        // is not: see `ComputerSyncRemovalV1`.
        const text = Buffer.from(second.trim(), "base64").toString("utf8");
        const supersedes = text.slice(0, text.indexOf("\n")).trim();
        removed.set(relative, {
          path: relative,
          ...(supersedes && supersedes !== "null" ? { supersedes } : {}),
        });
        continue;
      }
      if (tag === "S" && !removed.has(relative)) {
        // A sidecar with no file: a shell removed the file it described.
        const recorded = this.decodeMeta(second.trim());
        removed.set(relative, {
          path: relative,
          ...(recorded ? { supersedes: recorded.generationId } : {}),
        });
      }
    }
    return {
      status: "ok",
      scan: { entries, removed: [...removed.values()] },
    };
  }

  async read(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<ComputerSyncBytesOutcomeV1> {
    const mount = this.mount(root);
    if (typeof mount !== "string") return mount;
    const relative = this.relative(path);
    if (typeof relative !== "string") return relative;
    const script = [
      `ROOT=${shellQuote(mount)}`,
      `REL=${shellQuote(relative)}`,
      'if [ ! -f "$ROOT/$REL" ]; then echo __MISSING__; exit 0; fi',
      'base64 -w0 "$ROOT/$REL"; echo',
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    if (output.includes("__MISSING__")) {
      return failure("not-found", `No such Workspace file: ${relative}`);
    }
    return {
      status: "ok",
      bytes: Uint8Array.from(Buffer.from(output.trim(), "base64")),
    };
  }

  async materialize(
    root: WorkspaceRootV1,
    path: string,
    bytes: Uint8Array,
    generation: WorkspaceGenerationV1,
  ): Promise<ComputerSyncOutcomeV1> {
    const mount = this.mount(root);
    if (typeof mount !== "string") return mount;
    const relative = this.relative(path);
    if (typeof relative !== "string") return relative;
    const script = [
      "set -eu",
      `ROOT=${shellQuote(mount)}`,
      `REL=${shellQuote(relative)}`,
      'TARGET="$ROOT/$REL"',
      `META="$ROOT/${WORKSPACE_GENERATIONS_DIR}/$REL"`,
      `GRAVE="$ROOT/${WORKSPACE_SYNC_DIR}/${SYNC_TOMBSTONES_DIR}/$REL"`,
      'mkdir -p "$(dirname "$TARGET")" "$(dirname "$META")"',
      'TMP=$(mktemp "${TARGET}.XXXXXX")',
      `printf %s ${shellQuote(Buffer.from(bytes).toString("base64"))} | base64 -d > "$TMP"`,
      'chmod 600 "$TMP"',
      'mv "$TMP" "$TARGET"',
      'MTMP=$(mktemp "${META}.XXXXXX")',
      `printf %s ${shellQuote(this.encodeMeta(generation))} | base64 -d > "$MTMP"`,
      'chmod 600 "$MTMP"',
      'mv "$MTMP" "$META"',
      'rm -f "$GRAVE"',
      "echo __SYNCED__",
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    if (!output.includes("__SYNCED__")) {
      return failure("unavailable", "Invalid Fly Workspace sync response");
    }
    return { status: "ok" };
  }

  async remove(
    root: WorkspaceRootV1,
    path: string,
    supersedes: string | undefined,
    tombstone: WorkspaceGenerationV1,
  ): Promise<ComputerSyncOutcomeV1> {
    const mount = this.mount(root);
    if (typeof mount !== "string") return mount;
    const relative = this.relative(path);
    if (typeof relative !== "string") return relative;
    const record = Buffer.from(
      `${supersedes ?? ""}\n${JSON.stringify(tombstone)}`,
    ).toString("base64");
    const script = [
      "set -eu",
      `ROOT=${shellQuote(mount)}`,
      `REL=${shellQuote(relative)}`,
      'TARGET="$ROOT/$REL"',
      `META="$ROOT/${WORKSPACE_GENERATIONS_DIR}/$REL"`,
      `GRAVE="$ROOT/${WORKSPACE_SYNC_DIR}/${SYNC_TOMBSTONES_DIR}/$REL"`,
      'mkdir -p "$(dirname "$GRAVE")"',
      'rm -f "$TARGET" "$META"',
      'GTMP=$(mktemp "${GRAVE}.XXXXXX")',
      `printf %s ${shellQuote(record)} | base64 -d > "$GTMP"`,
      'chmod 600 "$GTMP"',
      'mv "$GTMP" "$GRAVE"',
      "echo __REMOVED__",
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    if (!output.includes("__REMOVED__")) {
      return failure("unavailable", "Invalid Fly Workspace sync response");
    }
    return { status: "ok" };
  }

  async forget(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<ComputerSyncOutcomeV1> {
    const mount = this.mount(root);
    if (typeof mount !== "string") return mount;
    const relative = this.relative(path);
    if (typeof relative !== "string") return relative;
    const script = [
      `ROOT=${shellQuote(mount)}`,
      `REL=${shellQuote(relative)}`,
      `rm -f "$ROOT/${WORKSPACE_SYNC_DIR}/${SYNC_TOMBSTONES_DIR}/$REL"`,
      // The sidecar of a file that is gone is itself a removal record, so it
      // goes with the tombstone and not before it.
      `if [ ! -f "$ROOT/$REL" ]; then rm -f "$ROOT/${WORKSPACE_GENERATIONS_DIR}/$REL"; fi`,
      "echo __FORGOTTEN__",
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    return { status: "ok" };
  }

  async preserve(
    root: WorkspaceRootV1,
    path: string,
    bytes: Uint8Array,
    generation: WorkspaceGenerationV1,
  ): Promise<ComputerSyncOutcomeV1> {
    const mount = this.mount(root);
    if (typeof mount !== "string") return mount;
    const relative = this.relative(path);
    if (typeof relative !== "string") return relative;
    const script = [
      "set -eu",
      `ROOT=${shellQuote(mount)}`,
      `REL=${shellQuote(relative)}`,
      `KEPT="$ROOT/${WORKSPACE_SYNC_DIR}/${SYNC_CONFLICTS_DIR}/$REL/${generation.generationId}"`,
      'mkdir -p "$(dirname "$KEPT")"',
      `printf %s ${shellQuote(Buffer.from(bytes).toString("base64"))} | base64 -d > "$KEPT"`,
      'chmod 600 "$KEPT"',
      "echo __PRESERVED__",
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    if (!output.includes("__PRESERVED__")) {
      return failure("unavailable", "Invalid Fly Workspace sync response");
    }
    return { status: "ok" };
  }

  private notePath(kind: string, id: string): string | WorkspaceFailureV1 {
    const relative = this.relative(`${kind}/${id}`);
    if (typeof relative !== "string") return relative;
    return `${this.options.layout.home}/${SYNC_NOTES_DIR}/${relative}`;
  }

  async note(
    kind: string,
    id: string,
    text: string,
  ): Promise<ComputerSyncOutcomeV1> {
    const path = this.notePath(kind, id);
    if (typeof path !== "string") return path;
    const script = [
      "set -eu",
      `NOTE=${shellQuote(path)}`,
      'mkdir -p "$(dirname "$NOTE")"',
      `printf %s ${shellQuote(Buffer.from(text).toString("base64"))} | base64 -d > "$NOTE"`,
      'chmod 600 "$NOTE"',
      "echo __NOTED__",
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    return { status: "ok" };
  }

  async readNote(kind: string, id: string): Promise<ComputerSyncNoteOutcomeV1> {
    const path = this.notePath(kind, id);
    if (typeof path !== "string") return path;
    const script = [
      `NOTE=${shellQuote(path)}`,
      'if [ ! -f "$NOTE" ]; then echo __MISSING__; exit 0; fi',
      'base64 -w0 "$NOTE"; echo',
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    if (output.includes("__MISSING__")) return { status: "ok" };
    return {
      status: "ok",
      text: Buffer.from(output.trim(), "base64").toString("utf8"),
    };
  }

  async clearNote(kind: string, id: string): Promise<ComputerSyncOutcomeV1> {
    const path = this.notePath(kind, id);
    if (typeof path !== "string") return path;
    const output = await this.run(
      [`NOTE=${shellQuote(path)}`, 'rm -f "$NOTE"', "echo __CLEARED__"].join(
        "\n",
      ),
    );
    if (typeof output !== "string") return output;
    return { status: "ok" };
  }

  async signal(): Promise<ComputerSyncNoteOutcomeV1> {
    const script = [
      `SIGNAL=${shellQuote(`${this.options.layout.home}/${SYNC_NOTES_DIR}/signal`)}`,
      'if [ ! -f "$SIGNAL" ]; then echo __MISSING__; exit 0; fi',
      'cat "$SIGNAL"',
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    if (output.includes("__MISSING__")) return { status: "ok" };
    return { status: "ok", text: output.trim() };
  }
}

/**
 * The durable roots one Computer's layout declares for a User and the Bots
 * that are tenants on it. `package-declared` roots are named by Package and
 * root id rather than by the layout template, so a caller that has installed
 * Packages supplies them.
 */
export function declaredWorkspaceRootsV1(
  layout: WorkspaceLayoutV1,
  owner: {
    userId: string;
    botIds: readonly string[];
    projectIds?: readonly string[];
    packageRoots?: readonly { packageId: string; rootId: string }[];
  },
): WorkspaceRootV1[] {
  const roots: WorkspaceRootV1[] = [];
  const declares = (kind: WorkspaceRootV1["kind"]): boolean =>
    layout.roots.some((declaration) => declaration.kind === kind);
  for (const botId of owner.botIds) {
    if (declares("bot-instructions")) {
      roots.push({ kind: "bot-instructions", userId: owner.userId, botId });
    }
    if (declares("bot-memory")) {
      roots.push({ kind: "bot-memory", userId: owner.userId, botId });
    }
  }
  if (declares("user-instructions")) {
    roots.push({ kind: "user-instructions", userId: owner.userId });
  }
  if (declares("user-memory")) {
    roots.push({ kind: "user-memory", userId: owner.userId });
  }
  if (declares("project-memory")) {
    for (const projectId of owner.projectIds ?? []) {
      roots.push({ kind: "project-memory", userId: owner.userId, projectId });
    }
  }
  if (declares("package-declared")) {
    for (const declared of owner.packageRoots ?? []) {
      roots.push({
        kind: "package-declared",
        userId: owner.userId,
        packageId: declared.packageId,
        rootId: declared.rootId,
      });
    }
  }
  return roots;
}

export interface FlySpriteSyncOptionsV1 extends Omit<
  WorkspaceRootSyncOptionsV1,
  "computer" | "roots"
> {
  computer: FlySpriteAgentComputer;
  layout: WorkspaceLayoutV1;
  userId: string;
  botDirectoryKey: (botId: string) => string;
  /** Every root this Computer syncs; the layout's own roots when absent. */
  roots?: WorkspaceRootV1[];
  botIds?: readonly string[];
  projectIds?: readonly string[];
  packageRoots?: readonly { packageId: string; rootId: string }[];
}

/** The durable-root sync, wired to one Fly Sprite. */
export function createFlySpriteSyncV1(
  options: FlySpriteSyncOptionsV1,
): WorkspaceRootSyncV1 {
  const {
    computer,
    layout,
    userId,
    botDirectoryKey,
    roots,
    botIds,
    projectIds,
    packageRoots,
    ...rest
  } = options;
  return createWorkspaceRootSyncV1({
    ...rest,
    computer: new FlySpriteSyncSurface({
      computer,
      layout,
      userId,
      botDirectoryKey,
    }),
    roots:
      roots ??
      declaredWorkspaceRootsV1(layout, {
        userId,
        botIds: botIds ?? [computer.botId],
        ...(projectIds ? { projectIds } : {}),
        ...(packageRoots ? { packageRoots } : {}),
      }),
  });
}
