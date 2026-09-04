// `WorkspaceFilesV1` over object storage, with every generation recorded in
// the owning Durable Object.
//
// This is the object-storage half of ADR 0013. The Computer-side half —
// `FlyWorkspaceFiles` in `@frockbot/plugin-fly-sprite` — implements the same
// interface over a Sprite's filesystem, and the two must answer the same way,
// because the same durable root is reachable through both: a refusal here is a
// refusal there, `unavailable` is an ordinary answer on both, and a losing
// conditional write is preserved on both rather than dropped.
//
// It is not kernel code. The kernel declares `WorkspaceFilesV1`; this package
// implements it and imports nothing but that declaration.
//
// Four constitutional rules are enforced here rather than described:
//
//  - "every write to a durable root records its writer" — a write mints a
//    generation, stores it beside the bytes, and records it in the Durable
//    Object that owns the root. An `unattributed` writer is refused: it is a
//    reader's answer about a file nobody recorded, never a writer a caller may
//    present.
//  - "a write that would overwrite a generation its writer has not seen is
//    preserved as a conflicting generation and surfaced, never merged or
//    dropped" — every `put` is conditional (`If-Match` on the current object's
//    ETag, `If-None-Match: *` when the writer asserts absence), and the loser
//    is written to its own conflict key, recorded as a conflicting generation,
//    and returned to the caller with both generations.
//  - "within a shared root each Bot's shard is written only on that Bot's
//    behalf" — a Bot writer may write only under `by-agent/<its own id>/`,
//    decided by `writerOwnsMemoryPathV1` and nowhere else.
//  - "a Bot's instruction root and Bot Memory root are writable only by that
//    Bot or its User" — a first-party Package is neither, exactly as the Fly
//    implementation has it. The User-global instruction root (ADR 0016) is
//    writable by that User or any of their Bots, and by nothing else; this is
//    its only writer, because the Computer presents it read-only.
//
// A delete leaves a durable tombstone. Object storage forgets a deleted key
// entirely, so without one, "this file is gone, deliberately, and here is who
// removed it" would exist nowhere in durable state after the Durable Object is
// evicted — which is the same hole `unattributed` closes for arriving files.
// The delete is itself conditional, because object storage offers no
// conditional delete: it overwrites the file with an empty tombstone marker
// under `If-Match`, and the marker *stays* as the object, so a write racing a
// delete is preserved rather than destroyed. `delete` below has the detail,
// and `gcTombstoneMarkersV1` collects markers old enough that no create can
// still be conditioned on one.
import {
  retryOnceV1,
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_LIST_ENTRIES,
  isWorkspaceComputerReadOnlyRootV1,
  isWorkspaceMemoryRootV1,
  normalizeWorkspaceRelativePathV1,
  workspaceWriterMayWriteV1,
  writerOwnsMemoryPathV1,
  decodeWorkspaceGenerationV1,
  type WorkspaceDeleteRequestV1,
  type WorkspaceEntryV1,
  type WorkspaceFailureV1,
  type WorkspaceFilesV1,
  type WorkspaceGenerationRecordV1,
  type WorkspaceGenerationV1,
  type WorkspaceGenerationsV1,
  type WorkspaceListOutcomeV1,
  type WorkspaceListRequestV1,
  type WorkspacePathV1,
  type WorkspaceReadOutcomeV1,
  type WorkspaceRootV1,
  type WorkspaceStatOutcomeV1,
  type WorkspaceWriteOutcomeV1,
  type WorkspaceWriteRequestV1,
  type WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import type {
  ObjectBucketV1,
  ObjectConditionsV1,
  ObjectHeadV1,
} from "./bucket.js";
import {
  isWorkspaceConflictKeyV1,
  workspaceConflictKeyV1,
  workspaceObjectKeyV1,
  workspaceObjectPrefixV1,
  workspaceRelativeFromKeyV1,
  WORKSPACE_OBJECT_PREFIX,
} from "./keys.js";

/** The sha-256 of no bytes; a deletion tombstone's content address. */
export const WORKSPACE_EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Where a generation rides beside its bytes in the object store. */
export const WORKSPACE_GENERATION_METADATA_KEY = "frockbot-generation";
/**
 * Marks the empty object a delete leaves in the file's place.
 *
 * R2 has no conditional delete, so a delete fences with a conditional
 * *overwrite* — see `delete` below. `read`, `stat`, and `list` treat a marker
 * as absence, so the file reads as deleted rather than as an empty one, and
 * the next create replaces the marker under `If-Match` on the marker's own
 * ETag.
 */
export const WORKSPACE_TOMBSTONE_METADATA_KEY = "frockbot-tombstone";
/** Beyond this the generation is recorded durably but not mirrored on the object. */
const MAX_METADATA_BYTES = 1800;
const DEFAULT_LIST_LIMIT = 100;
const DEFAULT_MEDIA_TYPE = "application/octet-stream";

function failure(
  status: WorkspaceFailureV1["status"],
  reason: string,
): WorkspaceFailureV1 {
  return { status, reason: reason.slice(0, 512) };
}

async function digestV1(bytes: Uint8Array): Promise<string> {
  const buffer = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return [...new Uint8Array(buffer)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** True for the empty marker a delete leaves while it sweeps the key. */
function isTombstoneMarkerV1(head: ObjectHeadV1): boolean {
  return head.customMetadata?.[WORKSPACE_TOMBSTONE_METADATA_KEY] !== undefined;
}

/**
 * `"kernel"` is the surface the kernel consumes: it refuses a write to every
 * Memory root, because "The Memory Package is the single writer of Memory
 * roots". `"memory"` is the Memory Package's own surface: it serves Memory
 * roots and nothing else. Nothing accepts both — the same split the Fly
 * Workspace makes.
 *
 * `"sync"` is the Computer-side durable-root sync of ADR 0013, and it is a
 * mirror rather than an author. It reads every root — a Memory root has to be
 * readable for the sync to present it read-only on the Computer — and writes
 * every root except a Memory one, because pushing a Memory root would give
 * that root a second writer. It is also the one surface that accepts an
 * `unattributed` writer, and only on a non-Memory root: the file it is
 * mirroring was written by a shell on the Computer, so nothing recorded who
 * wrote it, and the choice is between recording that truthfully and losing a
 * durable-root file at the next image rebuild. `unattributed` carries no
 * authority — `isLoadableSkillSourceV1` refuses it — so the mirrored file is
 * data the Bot can read and never an instruction it loads.
 */
export type WorkspaceStoreSurfaceV1 = "kernel" | "memory" | "sync";

export interface ObjectWorkspaceFilesOptionsV1 {
  bucket: ObjectBucketV1;
  /** The owning Durable Object's generation ledger. */
  generations: WorkspaceGenerationsV1;
  clock?: () => Date;
  /** The User whose durable roots this store serves, when it serves one. */
  owner?: { userId: string };
  surface?: WorkspaceStoreSurfaceV1;
}

class ObjectWorkspaceFiles implements WorkspaceFilesV1 {
  private readonly bucket: ObjectBucketV1;
  private readonly generations: WorkspaceGenerationsV1;
  private readonly clock: () => Date;
  private readonly owner: { userId: string } | undefined;
  private readonly surface: WorkspaceStoreSurfaceV1;

  constructor(options: ObjectWorkspaceFilesOptionsV1) {
    this.bucket = options.bucket;
    this.generations = options.generations;
    this.clock = options.clock ?? (() => new Date());
    this.owner = options.owner;
    this.surface = options.surface ?? "kernel";
  }

  /**
   * The one place a root is admitted for reading. Refusal is an ordinary
   * outcome of this interface, so it answers a failure rather than throwing.
   */
  private admit(root: WorkspaceRootV1): WorkspaceFailureV1 | undefined {
    if (this.owner && root.userId !== this.owner.userId) {
      return failure(
        "refused",
        "This store serves a different User's durable roots",
      );
    }
    if (this.surface === "memory" && !isWorkspaceMemoryRootV1(root)) {
      return failure("refused", "The Memory writer accepts Memory roots only");
    }
    return undefined;
  }

  private admitWrite(
    path: WorkspacePathV1,
    writer: WorkspaceWriterV1,
  ): WorkspaceFailureV1 | undefined {
    const root = path.root;
    const refused = this.admit(root);
    if (refused) return refused;
    // The sync mirrors a file whose writer the Computer did not record. It is
    // the only caller that may carry `unattributed`, and never into a Memory
    // root, which it does not write at all.
    const mirroring =
      this.surface === "sync" &&
      writer.kind === "unattributed" &&
      !isWorkspaceComputerReadOnlyRootV1(root);
    if (!workspaceWriterMayWriteV1(writer) && !mirroring) {
      return failure(
        "refused",
        "Every write to a durable root records its writer; an unattributed writer records none",
      );
    }
    if (isWorkspaceMemoryRootV1(root)) {
      if (this.surface !== "memory") {
        return failure(
          "refused",
          "The Workspace presents Memory roots read-only; the Memory Package is their only writer",
        );
      }
      if (!writerOwnsMemoryPathV1(path, writer)) {
        return failure(
          "refused",
          `Only the Bot that owns this Memory shard, or User "${root.userId}", may write "${path.path}"`,
        );
      }
      return undefined;
    }
    if (root.kind === "bot-instructions") {
      const byBot = writer.kind === "bot" && writer.botId === root.botId;
      const byUser = writer.kind === "user" && writer.userId === root.userId;
      if (!byBot && !byUser && !mirroring) {
        return failure(
          "refused",
          `Only Bot "${root.botId}" or its User may write this root`,
        );
      }
    }
    if (root.kind === "user-instructions") {
      // The User-global instruction root is shared by every Bot this User
      // owns (ADR 0016), so any `bot` writer is admitted — `this.admit` above
      // has already confined the store to one User's roots, and a Bot writes
      // through the Durable Object that holds its own identity, so a recorded
      // `bot` generation here is a Bot of this User. A `first-party` writer is
      // not; nor is the sync, which never pushes into this root at all.
      const byBot = writer.kind === "bot";
      const byUser = writer.kind === "user" && writer.userId === root.userId;
      if (!byBot && !byUser) {
        return failure(
          "refused",
          `Only User "${root.userId}" or one of their Bots may write this root`,
        );
      }
    }
    return undefined;
  }

  private relative(path: WorkspacePathV1): WorkspaceFailureV1 | string {
    try {
      return normalizeWorkspaceRelativePathV1(path.path);
    } catch (error) {
      return failure(
        "refused",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async recordOf(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<WorkspaceGenerationRecordV1 | undefined> {
    try {
      return await this.generations.current(root, path);
    } catch {
      return undefined;
    }
  }

  private encodeMetadata(
    generation: WorkspaceGenerationV1,
  ): Record<string, string> | undefined {
    const encoded = JSON.stringify(generation);
    if (encoded.length > MAX_METADATA_BYTES) return undefined;
    return { [WORKSPACE_GENERATION_METADATA_KEY]: encoded };
  }

  private decodeMetadata(
    head: ObjectHeadV1,
  ): WorkspaceGenerationV1 | undefined {
    const encoded = head.customMetadata?.[WORKSPACE_GENERATION_METADATA_KEY];
    if (!encoded) return undefined;
    try {
      return decodeWorkspaceGenerationV1(JSON.parse(encoded));
    } catch {
      return undefined;
    }
  }

  /**
   * Records what the bytes already say, when the ledger does not say it.
   *
   * A tombstone marker is never reconciled: it is an absence being swept, not
   * a file, and the deletion has its own recorded generation. Nor is a ledger
   * record ever moved backwards — the head may be one this caller read before
   * a concurrent write landed, and generation ids sort, so a record naming a
   * later generation stands.
   */
  private async reconcile(
    root: WorkspaceRootV1,
    path: string,
    head: ObjectHeadV1,
    generation: WorkspaceGenerationV1,
    recorded: WorkspaceGenerationRecordV1 | undefined,
  ): Promise<void> {
    if (isTombstoneMarkerV1(head)) return;
    if (
      recorded &&
      recorded.generation.generationId >= generation.generationId
    ) {
      return;
    }
    try {
      await this.generations.record({
        schemaVersion: 1,
        root,
        path,
        generation,
        etag: head.etag,
      });
    } catch {
      // The ledger is briefly unreachable. The generation still rides beside
      // the bytes, so the next read repairs it rather than wedging the file.
    }
  }

  /**
   * Recovers the generation of one object.
   *
   * The Durable Object is the authority, so its record wins whenever it still
   * describes these bytes — that is what `etag` proves. Otherwise the
   * generation the writer stored beside the bytes is used, which is how a file
   * written straight into object storage by the Computer-side sync keeps its
   * writer. A file with neither is `unattributed`: nobody recorded who wrote
   * it, so it is data the Bot can read and never an instruction it loads.
   *
   * Falling back to the metadata also *repairs* the ledger. `record` runs
   * after the `put` that produced its etag, so a `record` that fails leaves
   * bytes whose generation exists only beside them. Without the repair the
   * ledger would answer "no current generation" forever, and every later
   * conditional write on that file would be treated as unseen — a file no
   * authorized writer could ever overwrite. The repair is best-effort: if the
   * ledger is still unreachable the generation is still returned, and the next
   * read tries again.
   */
  private async generationOf(
    root: WorkspaceRootV1,
    path: string,
    head: ObjectHeadV1,
    bytes?: Uint8Array,
  ): Promise<WorkspaceGenerationV1> {
    const recorded = await this.recordOf(root, path);
    if (recorded && !recorded.deleted && recorded.etag === head.etag) {
      return recorded.generation;
    }
    const beside = this.decodeMetadata(head);
    if (beside) {
      await this.reconcile(root, path, head, beside, recorded);
      return beside;
    }
    const body = bytes ?? (await (await this.bucket.get(head.key))?.bytes());
    return {
      schemaVersion: 1,
      generationId: `${head.uploaded.getTime().toString().padStart(15, "0")}-object`,
      contentHash: body ? await digestV1(body) : WORKSPACE_EMPTY_SHA256,
      size: Math.min(head.size, WORKSPACE_MAX_FILE_BYTES),
      writer: { kind: "unattributed" },
      writtenAt: head.uploaded.toISOString(),
    };
  }

  async read(path: WorkspacePathV1): Promise<WorkspaceReadOutcomeV1> {
    const refused = this.admit(path.root);
    if (refused) return refused;
    const relative = this.relative(path);
    if (typeof relative !== "string") return relative;
    const key = workspaceObjectKeyV1(path.root, relative);
    let object;
    try {
      object = await this.bucket.get(key);
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!object || isTombstoneMarkerV1(object)) {
      return failure("not-found", `No such Workspace file: ${relative}`);
    }
    if (object.size > WORKSPACE_MAX_FILE_BYTES) {
      return failure(
        "refused",
        `Workspace file exceeds ${WORKSPACE_MAX_FILE_BYTES} bytes`,
      );
    }
    const bytes = await object.bytes();
    return {
      status: "ok",
      file: {
        path: { root: path.root, path: relative },
        generation: await this.generationOf(path.root, relative, object, bytes),
        bytes,
      },
    };
  }

  async stat(path: WorkspacePathV1): Promise<WorkspaceStatOutcomeV1> {
    const refused = this.admit(path.root);
    if (refused) return refused;
    const relative = this.relative(path);
    if (typeof relative !== "string") return relative;
    let head;
    try {
      head = await this.bucket.head(workspaceObjectKeyV1(path.root, relative));
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!head || isTombstoneMarkerV1(head)) {
      return failure("not-found", `No such Workspace file: ${relative}`);
    }
    return {
      status: "ok",
      entry: {
        path: { root: path.root, path: relative },
        generation: await this.generationOf(path.root, relative, head),
      },
    };
  }

  /**
   * Lists one durable root.
   *
   * A shared Memory root is sharded per writing Bot, so a listing with no
   * prefix returns every Bot's shard merged into one page — "readers merge
   * shards" — while a prefix naming one shard returns that shard alone.
   * Preserved losing writes are never listed as files; they are read through
   * the generation ledger, which is where a conflict is surfaced.
   */
  async list(request: WorkspaceListRequestV1): Promise<WorkspaceListOutcomeV1> {
    const refused = this.admit(request.root);
    if (refused) return refused;
    let prefix = "";
    if (request.prefix !== undefined) {
      const normalized = this.relative({
        root: request.root,
        path: request.prefix,
      });
      if (typeof normalized !== "string") return normalized;
      prefix = normalized;
    }
    const limit = Math.max(
      1,
      Math.min(request.limit ?? DEFAULT_LIST_LIMIT, WORKSPACE_MAX_LIST_ENTRIES),
    );
    let page;
    try {
      page = await this.bucket.list({
        prefix: `${workspaceObjectPrefixV1(request.root)}${prefix}`,
        limit,
        ...(request.cursor ? { cursor: request.cursor } : {}),
      });
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    const entries: WorkspaceEntryV1[] = [];
    for (const object of page.objects) {
      if (isWorkspaceConflictKeyV1(object.key)) continue;
      // A tombstone marker is a delete mid-sweep, not a file.
      if (isTombstoneMarkerV1(object)) continue;
      const relative = workspaceRelativeFromKeyV1(request.root, object.key);
      if (relative === undefined) continue;
      // A raw key prefix would also match a sibling whose name merely starts
      // with it — `by-agent/bot-1` must not list `by-agent/bot-10/`.
      if (prefix && relative !== prefix && !relative.startsWith(`${prefix}/`)) {
        continue;
      }
      let path: WorkspacePathV1;
      try {
        path = {
          root: request.root,
          path: normalizeWorkspaceRelativePathV1(relative),
        };
      } catch {
        continue;
      }
      entries.push({
        path,
        generation: await this.generationOf(request.root, relative, object),
      });
    }
    return {
      status: "ok",
      entries,
      ...(page.truncated && page.cursor ? { cursor: page.cursor } : {}),
    };
  }

  /**
   * The conditional one write is sent under, or `undefined` when the writer
   * has not seen what the store holds and must therefore lose.
   *
   * A tombstone marker is an absence being swept: a writer asserting absence
   * conditions on the marker's own ETag rather than on `If-None-Match`, so a
   * delete that could not sweep its marker never blocks the next create.
   */
  private async precondition(
    root: WorkspaceRootV1,
    relative: string,
    head: ObjectHeadV1 | null,
    expectedGenerationId: string | null,
  ): Promise<ObjectConditionsV1 | undefined> {
    if (!head) {
      return expectedGenerationId === null
        ? { etagDoesNotMatch: "*" }
        : undefined;
    }
    if (isTombstoneMarkerV1(head)) {
      const removed = this.decodeMetadata(head);
      return expectedGenerationId === null ||
        expectedGenerationId === removed?.generationId
        ? { etagMatches: head.etag }
        : undefined;
    }
    const holder = await this.generationOf(root, relative, head);
    return holder.generationId === expectedGenerationId
      ? { etagMatches: head.etag }
      : undefined;
  }

  async write(
    request: WorkspaceWriteRequestV1,
  ): Promise<WorkspaceWriteOutcomeV1> {
    const refused = this.admitWrite(request.path, request.writer);
    if (refused) return refused;
    const relative = this.relative(request.path);
    if (typeof relative !== "string") return relative;
    if (request.bytes.byteLength > WORKSPACE_MAX_FILE_BYTES) {
      return failure(
        "refused",
        `Workspace file exceeds ${WORKSPACE_MAX_FILE_BYTES} bytes`,
      );
    }
    const root = request.path.root;
    const at = this.clock();
    const key = workspaceObjectKeyV1(root, relative);
    const current = await this.recordOf(root, relative);
    let generation: WorkspaceGenerationV1;
    try {
      generation = {
        schemaVersion: 1,
        generationId: await this.generations.mint(at, root),
        contentHash: await digestV1(request.bytes),
        size: request.bytes.byteLength,
        writer: request.writer,
        writtenAt: at.toISOString(),
      };
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    // The caller's `expectedGenerationId` is mapped to the ETag that
    // generation produced. `null` asserts absence, which is `If-None-Match: *`.
    //
    // The mapping is derived from what object storage actually holds, not from
    // the ledger alone. `generationOf` prefers the Durable Object's record
    // whenever that record still describes these bytes, and falls back to the
    // generation stored beside them — so a writer that passes exactly the
    // generation `read` or `stat` handed it wins, even when the ledger has no
    // record at all because a `record` failed after its `put` or the object
    // was mirrored with metadata only. Without that, an unrecorded file could
    // never be overwritten by anyone: the writer would be judged unseen, and
    // `null` would fail `If-None-Match`.
    let head: ObjectHeadV1 | null;
    try {
      head = await this.bucket.head(key);
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    const seen = await this.precondition(
      root,
      relative,
      head,
      request.expectedGenerationId,
    );
    if (seen) {
      const metadata = this.encodeMetadata(generation);
      let written: ObjectHeadV1 | null;
      try {
        written = await this.bucket.put(key, request.bytes, {
          onlyIf: seen,
          contentType: request.mediaType ?? DEFAULT_MEDIA_TYPE,
          ...(metadata ? { customMetadata: metadata } : {}),
        });
      } catch (error) {
        return failure(
          "unavailable",
          error instanceof Error ? error.message : String(error),
        );
      }
      if (written) {
        // The bytes are durable. The ledger is the index of that fact, not
        // the fact: reporting a failure here told the model nothing was
        // written while object storage held it, and the write then turned up
        // in the next injection anyway — exactly the intent/outcome
        // divergence the record exists to prevent. So the ledger call is
        // retried, and a still-failing ledger is `ok` with `ledgerPending`:
        // the metadata beside the bytes lets `reconcile` repair the entry.
        try {
          await retryOnceV1(() =>
            this.generations.record({
              schemaVersion: 1,
              root,
              path: relative,
              generation,
              etag: written.etag,
            }),
          );
        } catch {
          return { status: "ok", generation, ledgerPending: true };
        }
        return { status: "ok", generation };
      }
    }
    return this.preserve(root, relative, request.bytes, generation, current);
  }

  /**
   * Preserves a losing write. ADR 0013: the loser is stored under its own
   * conflict key and recorded as a conflicting generation, so both sides
   * survive and the caller is handed both — never merged, never dropped.
   */
  private async preserve(
    root: WorkspaceRootV1,
    relative: string,
    bytes: Uint8Array,
    generation: WorkspaceGenerationV1,
    current: WorkspaceGenerationRecordV1 | undefined,
  ): Promise<WorkspaceWriteOutcomeV1> {
    let head: ObjectHeadV1 | null = null;
    try {
      head = await this.bucket.head(workspaceObjectKeyV1(root, relative));
    } catch {
      head = null;
    }
    const holder = head
      ? await this.generationOf(root, relative, head)
      : current && !current.deleted
        ? current.generation
        : undefined;
    const preserved: WorkspaceGenerationV1 = {
      ...generation,
      ...(holder ? { conflictsWith: holder.generationId } : {}),
    };
    const conflictKey = workspaceConflictKeyV1(
      root,
      relative,
      preserved.generationId,
    );
    try {
      const metadata = this.encodeMetadata(preserved);
      const stored = await this.bucket.put(conflictKey, bytes, {
        contentType: DEFAULT_MEDIA_TYPE,
        ...(metadata ? { customMetadata: metadata } : {}),
      });
      await this.generations.conflict({
        schemaVersion: 1,
        root,
        path: relative,
        generation: preserved,
        conflictKey,
        ...(stored ? { etag: stored.etag } : {}),
      });
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    return {
      status: "conflict",
      reason: `Workspace file changed since the writer last saw it: ${relative}`,
      ...(holder ? { current: holder } : {}),
      preserved,
    };
  }

  /**
   * Deletes a file, fenced by a conditional overwrite.
   *
   * Object storage has no conditional delete, so `head` then `delete` would
   * destroy a write that landed in between — last-writer-wins, which ADR 0013
   * names as the one outcome that is prohibited. The delete therefore *writes*
   * first: an empty object carrying `frockbot-tombstone` and the tombstone
   * generation replaces the file under `If-Match` on the ETag the deleter saw.
   * That put is the fence. A racing write either won before it — in which case
   * the `If-Match` fails and the deletion is preserved as a conflicting
   * generation, so both generations survive and the caller is handed both — or
   * it arrives after, and then its own `If-Match` on the file's old ETag fails
   * and it is preserved instead.
   *
   * The marker is *not* swept. An unconditional `delete` after the fence would
   * reopen the race from the other side: a create that read the marker and
   * conditioned on its ETag would land between the fence and the sweep, and
   * the sweep would erase bytes that had already won their precondition —
   * last-writer-wins, from the deleter this time. So the marker stays as the
   * object: `read`, `stat`, and `list` treat it as absence, the next create
   * replaces it under `If-Match` on the marker's ETag, and
   * `gcTombstoneMarkersV1` collects markers only once they are old enough that
   * no create can still be racing one.
   */
  async delete(
    request: WorkspaceDeleteRequestV1,
  ): Promise<WorkspaceWriteOutcomeV1> {
    const refused = this.admitWrite(request.path, request.writer);
    if (refused) return refused;
    const relative = this.relative(request.path);
    if (typeof relative !== "string") return relative;
    const root = request.path.root;
    const key = workspaceObjectKeyV1(root, relative);
    let head: ObjectHeadV1 | null;
    try {
      head = await this.bucket.head(key);
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!head || isTombstoneMarkerV1(head)) {
      return failure("not-found", `No such Workspace file: ${relative}`);
    }
    const holder = await this.generationOf(root, relative, head);
    if (holder.generationId !== request.expectedGenerationId) {
      return {
        status: "conflict",
        reason: `Workspace file changed since the writer last saw it: ${relative}`,
        current: holder,
      };
    }
    const at = this.clock();
    let tombstone: WorkspaceGenerationV1;
    try {
      tombstone = {
        schemaVersion: 1,
        generationId: await this.generations.mint(at, root),
        contentHash: WORKSPACE_EMPTY_SHA256,
        size: 0,
        writer: request.writer,
        writtenAt: at.toISOString(),
      };
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    const empty = new Uint8Array(0);
    let fenced: ObjectHeadV1 | null;
    try {
      fenced = await this.bucket.put(key, empty, {
        onlyIf: { etagMatches: head.etag },
        contentType: DEFAULT_MEDIA_TYPE,
        customMetadata: {
          ...(this.encodeMetadata(tombstone) ?? {}),
          [WORKSPACE_TOMBSTONE_METADATA_KEY]: "1",
        },
      });
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!fenced) {
      // A write landed between the head and the fence. It holds the file; the
      // deletion is the loser, preserved as a conflicting generation like any
      // other losing write, with both generations returned to the caller.
      return this.preserve(
        root,
        relative,
        empty,
        tombstone,
        await this.recordOf(root, relative),
      );
    }
    try {
      // The ledger tombstone is the durable evidence that the file was
      // removed, by whom, and when: the marker is an absence in object
      // storage, and object storage forgets a key entirely once the marker is
      // collected. Its ETag is recorded too, so the record still describes
      // exactly the object that stands in the file's place.
      await this.generations.tombstone({
        schemaVersion: 1,
        root,
        path: relative,
        generation: tombstone,
        etag: fenced.etag,
        deleted: true,
      });
      return { status: "ok", generation: tombstone };
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }
}

/**
 * `WorkspaceFilesV1` over object storage. The kernel consumes Memory roots
 * through `workspaceMemoryProjectionV1` of the result, which has no `write`
 * and no `delete` to call.
 */
export function createObjectWorkspaceFilesV1(
  options: ObjectWorkspaceFilesOptionsV1,
): WorkspaceFilesV1 {
  return new ObjectWorkspaceFiles(options);
}

export interface GcTombstoneMarkersOptionsV1 {
  bucket: ObjectBucketV1;
  /**
   * Markers uploaded at or after this instant are left alone. It is the
   * declared age at which a marker is assumed to be racing nobody — longer
   * than any single create can take between reading a marker and writing over
   * it.
   */
  olderThan: Date;
  /** Object keys to sweep. Defaults to every durable root. */
  prefix?: string;
  /** Most objects examined in one run. */
  limit?: number;
}

/** What one collection run looked at, and what it removed. */
export interface GcTombstoneMarkersReportV1 {
  scanned: number;
  collected: number;
  /** Markers left alone: too young, or no longer a marker when re-read. */
  skipped: number;
  /** True when the scan bound stopped the run before the listing ended. */
  truncated: boolean;
}

/** Most objects one collection run examines when the caller names no bound. */
const DEFAULT_GC_SCAN_LIMIT = 1000;
const GC_PAGE_LIMIT = 200;

/**
 * Collects tombstone markers old enough that no create can still be racing
 * one.
 *
 * A delete leaves its marker in place (see `delete`), because sweeping it
 * would erase a create that had already won its `If-Match` against the
 * marker's ETag. Markers are therefore collected out of band, and only under
 * two conditions checked immediately before the removal: `head` still answers
 * with the tombstone metadata — so an object that has since become a real file
 * is never touched — and its `uploaded` is older than the declared threshold.
 *
 * The residual: object storage has no conditional delete, so a create that
 * lands in the round trip between that `head` and the `delete` is still lost.
 * `olderThan` is what shrinks it to nothing in practice — a create racing a
 * marker that has stood untouched for the threshold is not a race anyone is
 * running — and either way a create that arrives *after* the collection is at
 * worst refused, its `If-Match` on the now-absent marker failing, which the
 * store preserves as a conflicting generation rather than dropping.
 *
 * It is not a `WorkspaceFilesV1` operation and mints no generation: the
 * removal it performs is of an absence, and the deletion's own generation was
 * recorded in the Durable Object when the marker was written.
 */
export async function gcTombstoneMarkersV1(
  options: GcTombstoneMarkersOptionsV1,
): Promise<GcTombstoneMarkersReportV1> {
  const bucket = options.bucket;
  const threshold = options.olderThan.getTime();
  const scanLimit = Math.max(1, options.limit ?? DEFAULT_GC_SCAN_LIMIT);
  const report: GcTombstoneMarkersReportV1 = {
    scanned: 0,
    collected: 0,
    skipped: 0,
    truncated: false,
  };
  let cursor: string | undefined;
  for (;;) {
    const page = await bucket.list({
      prefix: options.prefix ?? `${WORKSPACE_OBJECT_PREFIX}/`,
      limit: Math.min(GC_PAGE_LIMIT, scanLimit - report.scanned),
      ...(cursor ? { cursor } : {}),
    });
    for (const object of page.objects) {
      report.scanned += 1;
      // Only a marker is a candidate; a file, and a preserved losing write,
      // are data this must never touch.
      if (!isTombstoneMarkerV1(object)) continue;
      if (object.uploaded.getTime() >= threshold) {
        report.skipped += 1;
        continue;
      }
      const current = await bucket.head(object.key);
      if (
        !current ||
        !isTombstoneMarkerV1(current) ||
        current.uploaded.getTime() >= threshold
      ) {
        report.skipped += 1;
        continue;
      }
      await bucket.delete(object.key);
      report.collected += 1;
    }
    if (!page.truncated || !page.cursor) return report;
    if (report.scanned >= scanLimit) {
      report.truncated = true;
      return report;
    }
    cursor = page.cursor;
  }
}
