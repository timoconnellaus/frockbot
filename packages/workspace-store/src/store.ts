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
//    implementation has it.
//
// A delete leaves a durable tombstone. Object storage forgets a deleted key
// entirely, so without one, "this file is gone, deliberately, and here is who
// removed it" would exist nowhere in durable state after the Durable Object is
// evicted — which is the same hole `unattributed` closes for arriving files.
import {
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_LIST_ENTRIES,
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
import type { ObjectBucketV1, ObjectHeadV1 } from "./bucket.js";
import {
  isWorkspaceConflictKeyV1,
  workspaceConflictKeyV1,
  workspaceObjectKeyV1,
  workspaceObjectPrefixV1,
  workspaceRelativeFromKeyV1,
} from "./keys.js";

/** The sha-256 of no bytes; a deletion tombstone's content address. */
export const WORKSPACE_EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
/** Where a generation rides beside its bytes in the object store. */
export const WORKSPACE_GENERATION_METADATA_KEY = "frockbot-generation";
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
      !isWorkspaceMemoryRootV1(root);
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
   * Recovers the generation of one object.
   *
   * The Durable Object is the authority, so its record wins whenever it still
   * describes these bytes — that is what `etag` proves. Otherwise the
   * generation the writer stored beside the bytes is used, which is how a file
   * written straight into object storage by the Computer-side sync keeps its
   * writer. A file with neither is `unattributed`: nobody recorded who wrote
   * it, so it is data the Bot can read and never an instruction it loads.
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
    if (beside) return beside;
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
    if (!object) {
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
    if (!head) {
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
    const seen =
      request.expectedGenerationId === null
        ? { etagDoesNotMatch: "*" }
        : current &&
            !current.deleted &&
            current.etag &&
            current.generation.generationId === request.expectedGenerationId
          ? { etagMatches: current.etag }
          : undefined;
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
        try {
          await this.generations.record({
            schemaVersion: 1,
            root,
            path: relative,
            generation,
            etag: written.etag,
          });
        } catch (error) {
          return failure(
            "unavailable",
            error instanceof Error ? error.message : String(error),
          );
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
    if (!head) {
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
    try {
      const tombstone: WorkspaceGenerationV1 = {
        schemaVersion: 1,
        generationId: await this.generations.mint(at, root),
        contentHash: WORKSPACE_EMPTY_SHA256,
        size: 0,
        writer: request.writer,
        writtenAt: at.toISOString(),
      };
      await this.bucket.delete(key);
      // Recorded after the effect and never before it is reachable: object
      // storage forgets the key, so the tombstone is the only durable evidence
      // that the file was removed, by whom, and when.
      await this.generations.tombstone({
        schemaVersion: 1,
        root,
        path: relative,
        generation: tombstone,
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
