// The Fly Computer's Workspace: `WorkspaceFilesV1` over one User's Sprite.
//
// Every durable root is named by `WorkspaceRootV1` — kind and owner — and this
// module is the only place that turns one into an absolute path, through the
// provider's declared `WorkspaceLayoutV1`. There is no `namespace` string and
// no `"bot" | "user"` scope argument any more: a caller that wants the Bot's
// instruction root asks for `{ kind: "bot-instructions", userId, botId }`.
//
// Two constitutional rules are enforced here rather than described:
//
//  - "every write to a durable root records its writer" — a write stores a
//    generation sidecar next to the file holding the minted generation id, the
//    sha-256 content address, the size, the writer, and the timestamp. A read
//    or a list answers with that recorded generation. A file with no sidecar
//    went around this surface — a shell command on the Computer wrote it — so
//    nothing recorded its writer and it is answered as `unattributed`, which
//    is data and never an instruction. A write may not *claim* that writer:
//    `unattributed` is refused on `write` and `delete`.
//  - "a Bot's instruction root and Bot Memory root are writable only by that
//    Bot or its User" — a write whose writer is neither is `refused`, as is
//    every write to a Memory root through the kernel-consumed surface, because
//    "The Memory Package is the single writer of Memory roots".
//
// Failures are declared variants, never exceptions: the Computer host is
// non-authoritative and its connections drop on every pause, so `unavailable`
// is an ordinary answer.
import { createHash } from "node:crypto";
import {
  ComputerError,
  refusedWorkspaceFilesV1,
  workspaceMountPathV1,
  type ComputerWorkspace,
  type WorkspaceLayoutV1,
} from "@frockbot/computer-core";
import {
  WORKSPACE_MAX_FILE_BYTES,
  WORKSPACE_MAX_LIST_ENTRIES,
  normalizeWorkspaceRelativePathV1,
  workspaceRootAcceptsKernelWriteV1,
  workspaceWriterMayWriteV1,
  type WorkspaceDeleteRequestV1,
  type WorkspaceEntryV1,
  type WorkspaceFailureV1,
  type WorkspaceFilesV1,
  type WorkspaceGenerationV1,
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
import type { FlySpriteAgentComputer } from "./computer.js";

/** Where a root records the generation of each file beneath it. */
export const WORKSPACE_GENERATIONS_DIR = ".frockbot-generations";
/** Where the durable-root sync keeps its own per-root bookkeeping. */
export const WORKSPACE_SYNC_DIR = ".frockbot-sync";
/** Where a removal is recorded, under `WORKSPACE_SYNC_DIR`. */
export const SYNC_TOMBSTONES_DIR = "tombstones";
/** Where a losing write is preserved on the Computer, under `WORKSPACE_SYNC_DIR`. */
export const SYNC_CONFLICTS_DIR = "conflicts";
const GENERATIONS_DIR = WORKSPACE_GENERATIONS_DIR;
const LOCKS_DIR = ".frockbot-locks";
/** The sha-256 of no bytes; a deletion tombstone's content address. */
export const WORKSPACE_EMPTY_SHA256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const EMPTY_SHA256 = WORKSPACE_EMPTY_SHA256;
const DEFAULT_LIST_LIMIT = 100;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function failure(
  status: WorkspaceFailureV1["status"],
  reason: string,
): WorkspaceFailureV1 {
  return { status, reason: reason.slice(0, 512) };
}

function digest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

let generationCounter = 0;

/**
 * A sortable, DO-shaped generation id. The Workspace is not an authority, so
 * this id orders generations the Computer minted; a Durable Object that adopts
 * a Workspace generation records its own alongside it.
 */
function mintGenerationId(at: Date): string {
  generationCounter = (generationCounter + 1) % 1_000_000;
  const millis = at.getTime().toString().padStart(15, "0");
  const counter = generationCounter.toString().padStart(6, "0");
  return `${millis}-${counter}`;
}

interface RecordedFile {
  generation: WorkspaceGenerationV1;
  bytes?: Uint8Array;
}

/** The four fields the Sprite emits for one file, plus its sidecar. */
interface RawFile {
  meta: string;
  contentHash: string;
  size: number;
  modifiedSeconds: number;
}

export interface FlyWorkspaceFilesOptions {
  computer: FlySpriteAgentComputer;
  layout: WorkspaceLayoutV1;
  /** The User whose Computer this is; every root must belong to them. */
  userId: string;
  /** The Bot tenant making the call. */
  botId: string;
  /** Maps a Bot id to the provider's directory key for that Bot. */
  botDirectoryKey: (botId: string) => string;
  /**
   * `"kernel"` is the surface the kernel consumes: it refuses every Memory
   * root. `"memory"` is the Memory Package's single-writer seam: it refuses
   * every other root. Nothing accepts both.
   */
  surface: "kernel" | "memory";
}

/** `WorkspaceFilesV1` backed by one Fly Sprite's durable filesystem. */
export class FlyWorkspaceFiles implements WorkspaceFilesV1 {
  constructor(private readonly options: FlyWorkspaceFilesOptions) {}

  private mount(root: WorkspaceRootV1): string {
    return workspaceMountPathV1(
      this.options.layout,
      root,
      this.options.botDirectoryKey,
    );
  }

  /**
   * The one place a root is admitted. It answers a failure rather than
   * throwing, because refusal is an ordinary outcome of this interface.
   */
  private admit(root: WorkspaceRootV1): WorkspaceFailureV1 | undefined {
    if (root.userId !== this.options.userId) {
      return failure(
        "refused",
        "This Computer belongs to a different User's Workspace",
      );
    }
    const isMemory = !workspaceRootAcceptsKernelWriteV1(root);
    if (this.options.surface === "memory" && !isMemory) {
      return failure("refused", "The Memory writer accepts Memory roots only");
    }
    try {
      this.mount(root);
    } catch (error) {
      return failure(
        error instanceof ComputerError &&
          error.code === "capability-unavailable"
          ? "not-found"
          : "refused",
        error instanceof Error ? error.message : String(error),
      );
    }
    return undefined;
  }

  /**
   * "a Bot's instruction root and Bot Memory root are writable only by that
   * Bot or its User". A first-party Package is neither, and `unattributed` is
   * not a writer at all.
   */
  private admitWrite(
    root: WorkspaceRootV1,
    writer: WorkspaceWriterV1,
  ): WorkspaceFailureV1 | undefined {
    const refused = this.admit(root);
    if (refused) return refused;
    if (!workspaceWriterMayWriteV1(writer)) {
      return failure(
        "refused",
        "Every write to a durable root records its writer; an unattributed writer records none",
      );
    }
    if (
      this.options.surface === "kernel" &&
      !workspaceRootAcceptsKernelWriteV1(root)
    ) {
      return failure(
        "refused",
        "The Workspace presents Memory roots read-only; the Memory Package is their only writer",
      );
    }
    if (root.kind === "bot-instructions" || root.kind === "bot-memory") {
      const byBot = writer.kind === "bot" && writer.botId === root.botId;
      const byUser = writer.kind === "user" && writer.userId === root.userId;
      if (!byBot && !byUser) {
        return failure(
          "refused",
          `Only Bot "${root.botId}" or its User may write this root`,
        );
      }
    }
    return undefined;
  }

  private path(path: WorkspacePathV1): WorkspaceFailureV1 | string {
    try {
      return normalizeWorkspaceRelativePathV1(path.path);
    } catch (error) {
      return failure(
        "refused",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async run(
    script: string,
    signal?: AbortSignal,
  ): Promise<string | WorkspaceFailureV1> {
    try {
      const output = await this.options.computer.runStorage(
        script,
        signal ?? new AbortController().signal,
      );
      return output;
    } catch (error) {
      return failure(
        "unavailable",
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * Recovers a generation for a file. A file the sidecar records answers with
   * exactly what was recorded. A file written by ordinary shell work on the
   * Computer — `computer_exec`, an installer, the Bot's own editor — went
   * around the Workspace file surface, so nothing recorded who wrote it. It is
   * attributed to `{ kind: "unattributed" }`, which is the truth: not the
   * User, not a Bot, nobody recorded. Attributing it to the User would be a
   * claim the Computer cannot support, and the User is a writer whose Skills
   * *are* loadable, so any Bot with a shell could have written itself an
   * instruction. Unattributed files stay visible and readable, and are never
   * loaded as instructions.
   */
  private generationOf(raw: RawFile): WorkspaceGenerationV1 {
    const recorded = this.decodeMeta(raw.meta);
    if (recorded) return recorded;
    return {
      schemaVersion: 1,
      generationId: `${raw.modifiedSeconds.toString().padStart(15, "0")}-shell`,
      contentHash: raw.contentHash,
      size: Math.min(raw.size, WORKSPACE_MAX_FILE_BYTES),
      writer: { kind: "unattributed" },
      writtenAt: new Date(raw.modifiedSeconds * 1000).toISOString(),
    };
  }

  private decodeMeta(encoded: string): WorkspaceGenerationV1 | undefined {
    if (!encoded) return undefined;
    try {
      const text = Buffer.from(encoded, "base64").toString("utf8");
      const body = text.slice(text.indexOf("\n") + 1);
      const parsed: unknown = JSON.parse(body);
      if (!parsed || typeof parsed !== "object") return undefined;
      return parsed as WorkspaceGenerationV1;
    } catch {
      return undefined;
    }
  }

  private encodeMeta(generation: WorkspaceGenerationV1): string {
    return Buffer.from(
      `${generation.generationId}\n${JSON.stringify(generation)}`,
    ).toString("base64");
  }

  private async load(
    path: WorkspacePathV1,
    withBytes: boolean,
    signal?: AbortSignal,
  ): Promise<RecordedFile | WorkspaceFailureV1> {
    const refused = this.admit(path.root);
    if (refused) return refused;
    const relative = this.path(path);
    if (typeof relative !== "string") return relative;
    const mount = this.mount(path.root);
    const script = [
      `ROOT=${shellQuote(mount)}`,
      `REL=${shellQuote(relative)}`,
      'TARGET="$ROOT/$REL"',
      `META="$ROOT/${GENERATIONS_DIR}/$REL"`,
      'if [ ! -f "$TARGET" ]; then echo __MISSING__; exit 0; fi',
      'SIZE=$(stat -c %s "$TARGET")',
      `if [ "$SIZE" -gt ${WORKSPACE_MAX_FILE_BYTES} ]; then echo __TOO_LARGE__; exit 0; fi`,
      '{ cat "$META" 2>/dev/null || printf ""; } | base64 -w0; echo',
      'sha256sum "$TARGET" | cut -d" " -f1',
      'printf "%s\\n" "$SIZE"',
      'stat -c %Y "$TARGET"',
      withBytes ? 'base64 -w0 "$TARGET"; echo' : "",
    ]
      .filter(Boolean)
      .join("\n");
    const output = await this.run(script, signal);
    if (typeof output !== "string") return output;
    const lines = output.split("\n");
    if (lines[0]?.trim() === "__MISSING__") {
      return failure("not-found", `No such Workspace file: ${relative}`);
    }
    if (lines[0]?.trim() === "__TOO_LARGE__") {
      return failure(
        "refused",
        `Workspace file exceeds ${WORKSPACE_MAX_FILE_BYTES} bytes`,
      );
    }
    const [
      meta = "",
      contentHash = "",
      size = "",
      modified = "",
      encoded = "",
    ] = lines;
    if (!contentHash.trim() || !size.trim() || !modified.trim()) {
      return failure("unavailable", "Invalid Fly Workspace file response");
    }
    const raw: RawFile = {
      meta: meta.trim(),
      contentHash: contentHash.trim(),
      size: Number(size.trim()),
      modifiedSeconds: Number(modified.trim()),
    };
    const generation = this.generationOf(raw);
    return {
      generation,
      ...(withBytes
        ? { bytes: Uint8Array.from(Buffer.from(encoded.trim(), "base64")) }
        : {}),
    };
  }

  async read(path: WorkspacePathV1): Promise<WorkspaceReadOutcomeV1> {
    const loaded = await this.load(path, true);
    if ("status" in loaded) return loaded;
    return {
      status: "ok",
      file: {
        path,
        generation: loaded.generation,
        bytes: loaded.bytes ?? new Uint8Array(),
      },
    };
  }

  async stat(path: WorkspacePathV1): Promise<WorkspaceStatOutcomeV1> {
    const loaded = await this.load(path, false);
    if ("status" in loaded) return loaded;
    return {
      status: "ok",
      entry: { path, generation: loaded.generation },
    };
  }

  async list(request: WorkspaceListRequestV1): Promise<WorkspaceListOutcomeV1> {
    const refused = this.admit(request.root);
    if (refused) return refused;
    let prefix = "";
    if (request.prefix !== undefined) {
      const normalized = this.path({
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
    const offset = request.cursor ? Number(request.cursor) : 0;
    if (!Number.isSafeInteger(offset) || offset < 0) {
      return failure("refused", "Invalid Workspace list cursor");
    }
    const mount = this.mount(request.root);
    const script = [
      `ROOT=${shellQuote(mount)}`,
      `PREFIX=${shellQuote(prefix)}`,
      `OFFSET=${offset}`,
      `LIMIT=${limit}`,
      'mkdir -p "$ROOT"',
      "INDEX=0",
      "EMITTED=0",
      `find "$ROOT" -type f ! -path "$ROOT/${LOCKS_DIR}/*" ! -path "$ROOT/${GENERATIONS_DIR}/*" ! -path "$ROOT/${WORKSPACE_SYNC_DIR}/*" -print0 | sort -z | while IFS= read -r -d "" FILE; do`,
      '  REL=${FILE#"$ROOT"/}',
      '  if [ -n "$PREFIX" ]; then case "$REL" in "$PREFIX"|"$PREFIX"/*) ;; *) continue ;; esac; fi',
      '  if [ "$INDEX" -lt "$OFFSET" ]; then INDEX=$((INDEX + 1)); continue; fi',
      `  META="$ROOT/${GENERATIONS_DIR}/$REL"`,
      '  printf "%s\\t%s\\t%s\\t%s\\t%s\\n" "$(printf %s "$REL" | base64 -w0)" "$({ cat "$META" 2>/dev/null || printf \'\'; } | base64 -w0)" "$(sha256sum "$FILE" | cut -d" " -f1)" "$(stat -c %s "$FILE")" "$(stat -c %Y "$FILE")"',
      "  EMITTED=$((EMITTED + 1))",
      '  if [ "$EMITTED" -gt "$LIMIT" ]; then break; fi',
      "done",
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    const rows = output.trim() ? output.trim().split("\n") : [];
    const entries: WorkspaceEntryV1[] = [];
    for (const row of rows) {
      const [
        encodedPath,
        meta = "",
        contentHash = "",
        size = "",
        modified = "",
      ] = row.split("\t");
      if (!encodedPath || !contentHash || !size || !modified) {
        return failure("unavailable", "Invalid Fly Workspace listing response");
      }
      const relative = Buffer.from(encodedPath, "base64").toString("utf8");
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
        generation: this.generationOf({
          meta,
          contentHash,
          size: Number(size),
          modifiedSeconds: Number(modified),
        }),
      });
    }
    const hasMore = entries.length > limit;
    return {
      status: "ok",
      entries: entries.slice(0, limit),
      ...(hasMore ? { cursor: String(offset + limit) } : {}),
    };
  }

  async write(
    request: WorkspaceWriteRequestV1,
  ): Promise<WorkspaceWriteOutcomeV1> {
    const refused = this.admitWrite(request.path.root, request.writer);
    if (refused) return refused;
    const relative = this.path(request.path);
    if (typeof relative !== "string") return relative;
    if (request.bytes.byteLength > WORKSPACE_MAX_FILE_BYTES) {
      return failure(
        "refused",
        `Workspace file exceeds ${WORKSPACE_MAX_FILE_BYTES} bytes`,
      );
    }
    const writtenAt = new Date();
    const generation: WorkspaceGenerationV1 = {
      schemaVersion: 1,
      generationId: mintGenerationId(writtenAt),
      contentHash: digest(request.bytes),
      size: request.bytes.byteLength,
      writer: request.writer,
      writtenAt: writtenAt.toISOString(),
    };
    const mount = this.mount(request.path.root);
    const script = [
      "set -eu",
      `ROOT=${shellQuote(mount)}`,
      `REL=${shellQuote(relative)}`,
      'TARGET="$ROOT/$REL"',
      `META="$ROOT/${GENERATIONS_DIR}/$REL"`,
      `mkdir -p "$(dirname "$TARGET")" "$(dirname "$META")" "$ROOT/${LOCKS_DIR}"`,
      'LOCK=$(printf %s "$REL" | sha256sum | cut -d" " -f1)',
      `exec 9>"$ROOT/${LOCKS_DIR}/$LOCK"`,
      "flock -x 9",
      "CURRENT=",
      'if [ -f "$TARGET" ] && [ -f "$META" ]; then CURRENT=$(sed -n 1p "$META"); fi',
      'if [ -f "$TARGET" ] && [ ! -f "$META" ]; then CURRENT=__UNRECORDED__; fi',
      `if [ "$CURRENT" != ${shellQuote(request.expectedGenerationId ?? "")} ]; then echo __CONFLICT__; exit 0; fi`,
      'TMP=$(mktemp "${TARGET}.XXXXXX")',
      `printf %s ${shellQuote(Buffer.from(request.bytes).toString("base64"))} | base64 -d > "$TMP"`,
      'chmod 600 "$TMP"',
      'mv "$TMP" "$TARGET"',
      'MTMP=$(mktemp "${META}.XXXXXX")',
      `printf %s ${shellQuote(this.encodeMeta(generation))} | base64 -d > "$MTMP"`,
      'chmod 600 "$MTMP"',
      'mv "$MTMP" "$META"',
      "echo __WRITTEN__",
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    if (output.includes("__CONFLICT__")) {
      return failure(
        "conflict",
        `Workspace file changed since the writer last saw it: ${relative}`,
      );
    }
    if (!output.includes("__WRITTEN__")) {
      return failure("unavailable", "Invalid Fly Workspace write response");
    }
    return { status: "ok", generation };
  }

  async delete(
    request: WorkspaceDeleteRequestV1,
  ): Promise<WorkspaceWriteOutcomeV1> {
    const refused = this.admitWrite(request.path.root, request.writer);
    if (refused) return refused;
    const relative = this.path(request.path);
    if (typeof relative !== "string") return relative;
    const writtenAt = new Date();
    const tombstone: WorkspaceGenerationV1 = {
      schemaVersion: 1,
      generationId: mintGenerationId(writtenAt),
      contentHash: EMPTY_SHA256,
      size: 0,
      writer: request.writer,
      writtenAt: writtenAt.toISOString(),
    };
    const mount = this.mount(request.path.root);
    const script = [
      "set -eu",
      `ROOT=${shellQuote(mount)}`,
      `REL=${shellQuote(relative)}`,
      'TARGET="$ROOT/$REL"',
      `META="$ROOT/${GENERATIONS_DIR}/$REL"`,
      `GRAVE="$ROOT/${WORKSPACE_SYNC_DIR}/${SYNC_TOMBSTONES_DIR}/$REL"`,
      `mkdir -p "$ROOT/${LOCKS_DIR}" "$(dirname "$META")"`,
      'LOCK=$(printf %s "$REL" | sha256sum | cut -d" " -f1)',
      `exec 9>"$ROOT/${LOCKS_DIR}/$LOCK"`,
      "flock -x 9",
      'if [ ! -f "$TARGET" ]; then echo __MISSING__; exit 0; fi',
      "CURRENT=__UNRECORDED__",
      'if [ -f "$META" ]; then CURRENT=$(sed -n 1p "$META"); fi',
      `if [ "$CURRENT" != ${shellQuote(request.expectedGenerationId)} ]; then echo __CONFLICT__; exit 0; fi`,
      // A delete leaves a durable tombstone on the Computer: the removal is
      // recorded with the generation it superseded and the writer that
      // performed it, so "this file is gone, deliberately, and here is who
      // removed it" survives the removal, and the durable-root sync carries it
      // to object storage instead of reading the absence as a file that never
      // existed. Its first line is the superseded generation id, which is what
      // a conditional delete against the store must present.
      `mkdir -p "$(dirname "$GRAVE")"`,
      'rm -f "$TARGET" "$META"',
      'GTMP=$(mktemp "${GRAVE}.XXXXXX")',
      `printf %s ${shellQuote(Buffer.from(`${request.expectedGenerationId}\n${JSON.stringify(tombstone)}`).toString("base64"))} | base64 -d > "$GTMP"`,
      'chmod 600 "$GTMP"',
      'mv "$GTMP" "$GRAVE"',
      "echo __DELETED__",
    ].join("\n");
    const output = await this.run(script);
    if (typeof output !== "string") return output;
    if (output.includes("__MISSING__")) {
      return failure("not-found", `No such Workspace file: ${relative}`);
    }
    if (output.includes("__CONFLICT__")) {
      return failure(
        "conflict",
        `Workspace file changed since the writer last saw it: ${relative}`,
      );
    }
    return { status: "ok", generation: tombstone };
  }
}

/**
 * The Fly Computer's Workspace: the kernel-consumed surface, which refuses
 * every Memory root.
 *
 * There is no Computer-side Memory writer any more. The Memory Package writes
 * object storage, and the durable-root sync (`./sync.ts`) materializes Memory
 * roots here read-only, so `memoryWriter` is a retired seam that refuses every
 * call rather than a second write path.
 */
export class FlyComputerWorkspace implements ComputerWorkspace {
  private readonly files: FlyWorkspaceFiles;
  readonly memoryWriter: WorkspaceFilesV1 = refusedWorkspaceFilesV1(
    "The Computer-side Memory writer is retired; the Memory Package writes object storage and the durable-root sync presents Memory roots read-only",
  );

  constructor(
    readonly layout: WorkspaceLayoutV1,
    options: Omit<FlyWorkspaceFilesOptions, "layout" | "surface">,
  ) {
    this.files = new FlyWorkspaceFiles({
      ...options,
      layout,
      surface: "kernel",
    });
  }

  read(path: WorkspacePathV1): Promise<WorkspaceReadOutcomeV1> {
    return this.files.read(path);
  }

  list(request: WorkspaceListRequestV1): Promise<WorkspaceListOutcomeV1> {
    return this.files.list(request);
  }

  stat(path: WorkspacePathV1): Promise<WorkspaceStatOutcomeV1> {
    return this.files.stat(path);
  }

  write(request: WorkspaceWriteRequestV1): Promise<WorkspaceWriteOutcomeV1> {
    return this.files.write(request);
  }

  delete(request: WorkspaceDeleteRequestV1): Promise<WorkspaceWriteOutcomeV1> {
    return this.files.delete(request);
  }
}
