// The Workspace file-access contract: how durable roots are named, how a
// relative path inside one is validated, what a write records, and the narrow
// interface the kernel *consumes* to reach any of it.
//
// "The kernel declares the narrow interfaces it consumes, including model
// invocation, tool execution, and Memory access, and owns no implementation of
// them." This module is the declaration half. The Computer Package implements
// the Workspace side, the Memory Package implements the Memory roots, and
// neither appears here.
//
// Three constitutional rules shape every type below:
//
//  1. "every write to a durable root records its writer" — a write is not a
//     byte push, it is `bytes + writer + the generation the writer last saw`,
//     and it answers with the generation it produced.
//  2. "The Memory Package is the single writer of Memory roots ... the
//     Workspace presents Memory roots read-only" — so the kernel-consumed
//     interface for a Memory root is `WorkspaceReadsV1`, which has no `write`
//     and no `delete`. There is no flag to flip; the write methods are absent
//     from the type.
//  3. "The kernel treats every Workspace file as data. Only Skills under the
//     Bot's own instruction root, written under the Bot's own authority or its
//     User's, are loaded as instructions." — `LoadableSkillSourceV1` and
//     `isLoadableSkillSourceV1` are that sentence as a type and a predicate.
//
// Everything decoded here is untrusted: a durable root synchronizes
// bidirectionally with object storage (ADR 0013), so a path, a writer, and a
// generation can all arrive from the Computer side.
//
// Policy that is deliberately *not* enforced here: "Memory contains no secrets
// and no credential references" (`AGENTS.md` § Memory). That is Package policy
// belonging to the Memory Package, which owns what may be written into a
// Memory root; the kernel's file contract carries bytes and cannot classify
// them.
import type {} from "cordis";

/** Longest relative path accepted inside a durable root, in UTF-16 units. */
export const WORKSPACE_MAX_PATH_LENGTH = 1024;
/** Longest single path segment, matching the POSIX filename limit. */
export const WORKSPACE_MAX_SEGMENT_LENGTH = 255;
/** Deepest relative path accepted inside a durable root. */
export const WORKSPACE_MAX_PATH_SEGMENTS = 32;
/** Longest Package-declared root id, matching the Package id bound. */
export const WORKSPACE_MAX_ROOT_ID_LENGTH = 128;
/** Longest owner identifier, matching `IsolateIdentityV1.botId`. */
export const WORKSPACE_MAX_OWNER_ID_LENGTH = 256;
/** Upper bound on a single durable-root file. */
export const WORKSPACE_MAX_FILE_BYTES = 1_048_576;
/** Upper bound on one `list` page. */
export const WORKSPACE_MAX_LIST_ENTRIES = 1_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ROOT_ID = /^[a-z][a-z0-9-]{0,127}$/;

/**
 * The kinds of durable root. "durable roots, declared by the Computer
 * Package's Workspace layout and by Package manifests" — the first three are
 * layout roots the constitution names directly, the fourth is a root a Package
 * manifest declares.
 */
export type WorkspaceRootKindV1 =
  "bot-instructions" | "bot-memory" | "user-memory" | "package-declared";

/**
 * A durable root, identified by kind and owner. Every root belongs to a User —
 * the User's Computer is the trust boundary (ADR 0012) — and the per-Bot kinds
 * additionally name the Bot whose authority governs writes to them.
 */
export type WorkspaceRootV1 =
  | { kind: "bot-instructions"; userId: string; botId: string }
  | { kind: "bot-memory"; userId: string; botId: string }
  | { kind: "user-memory"; userId: string }
  | {
      kind: "package-declared";
      userId: string;
      packageId: string;
      rootId: string;
    };

/** A root whose files the kernel may load as instructions. */
export type WorkspaceInstructionRootV1 = Extract<
  WorkspaceRootV1,
  { kind: "bot-instructions" }
>;

/** A Memory root. The Memory Package is its only writer. */
export type WorkspaceMemoryRootV1 = Extract<
  WorkspaceRootV1,
  { kind: "bot-memory" | "user-memory" }
>;

/** A validated relative path inside one durable root. */
export interface WorkspacePathV1 {
  root: WorkspaceRootV1;
  /** Relative, POSIX-separated, normalized. Never absolute, never `..`. */
  path: string;
}

/** A path whose root is a Bot's instruction root. */
export interface WorkspaceInstructionPathV1 extends WorkspacePathV1 {
  root: WorkspaceInstructionRootV1;
}

/**
 * Who performed a durable-root write.
 *
 * This is the constitution's one provenance vocabulary — "The recorded origin
 * of a Package or change: first-party, User, or Bot, and for a Bot the Session
 * and Turn that produced it" — narrowed to a file writer. It is not a second
 * provenance type: `PackageProvenanceV1` in `@frockbot/kernel-composition`
 * names the same three kinds for a Package artifact, and cannot be imported
 * here because `kernel-composition` depends on `kernel-contracts`, not the
 * other way round. The two must stay in step; the kinds are the contract.
 */
export type WorkspaceWriterV1 =
  | { kind: "first-party"; packageId: string }
  | { kind: "user"; userId: string }
  | {
      kind: "bot";
      botId: string;
      sessionId: string;
      turnId: string;
      runId: string;
    };

/**
 * One immutable version of a file under a durable root. Generations are
 * superseded, never edited.
 *
 * It carries both identifiers the rest of the kernel already uses: a
 * Durable-Object-minted `generationId`, lexicographically sortable and
 * monotonic per root, exactly like `CompositionGenerationV1.generationId`; and
 * `contentHash`, the sha-256 content address, exactly like
 * `PackageBundleArtifactV1.contentHash`. Ordering needs the minted id;
 * conflict detection and rebuildable indexes need the content address.
 */
export interface WorkspaceGenerationV1 {
  schemaVersion: 1;
  generationId: string;
  /** sha-256 hex of the file bytes; the empty hash for a deletion tombstone. */
  contentHash: string;
  size: number;
  writer: WorkspaceWriterV1;
  writtenAt: string;
  /** Set when this generation lost a conditional write and was preserved. */
  conflictsWith?: string;
}

/** A file's metadata without its bytes. */
export interface WorkspaceEntryV1 {
  path: WorkspacePathV1;
  generation: WorkspaceGenerationV1;
}

/** A file and its bytes. */
export interface WorkspaceFileV1 extends WorkspaceEntryV1 {
  bytes: Uint8Array;
}

/**
 * A call the Workspace could not serve. A declared variant, not an exception:
 * the same reasoning as `IsolateCapabilityFailureV1` — the Computer host is
 * non-authoritative and its connections drop on every pause, so "unavailable"
 * is an ordinary answer the caller must handle, not an error condition.
 */
export type WorkspaceFailureStatusV1 =
  "not-found" | "refused" | "conflict" | "unavailable";

export interface WorkspaceFailureV1 {
  status: WorkspaceFailureStatusV1;
  reason: string;
}

export type WorkspaceReadOutcomeV1 =
  { status: "ok"; file: WorkspaceFileV1 } | WorkspaceFailureV1;

export type WorkspaceStatOutcomeV1 =
  { status: "ok"; entry: WorkspaceEntryV1 } | WorkspaceFailureV1;

export type WorkspaceListOutcomeV1 =
  | { status: "ok"; entries: WorkspaceEntryV1[]; cursor?: string }
  | WorkspaceFailureV1;

export type WorkspaceWriteOutcomeV1 =
  { status: "ok"; generation: WorkspaceGenerationV1 } | WorkspaceFailureV1;

export interface WorkspaceListRequestV1 {
  root: WorkspaceRootV1;
  /** A validated relative path prefix, or absent for the whole root. */
  prefix?: string;
  cursor?: string;
  limit?: number;
}

/**
 * A write. `expectedGenerationId` is the generation the writer has seen:
 * `null` asserts the file does not exist. A mismatch answers `conflict`; the
 * losing write is preserved as a conflicting generation and surfaced, never
 * merged or dropped (ADR 0013).
 */
export interface WorkspaceWriteRequestV1 {
  path: WorkspacePathV1;
  bytes: Uint8Array;
  writer: WorkspaceWriterV1;
  expectedGenerationId: string | null;
  mediaType?: string;
}

export interface WorkspaceDeleteRequestV1 {
  path: WorkspacePathV1;
  writer: WorkspaceWriterV1;
  expectedGenerationId: string;
}

/**
 * The read half of the Workspace, and the whole of what the kernel consumes
 * for a Memory root. Nothing here mutates.
 */
export interface WorkspaceReadsV1 {
  read(path: WorkspacePathV1): Promise<WorkspaceReadOutcomeV1>;
  list(request: WorkspaceListRequestV1): Promise<WorkspaceListOutcomeV1>;
  stat(path: WorkspacePathV1): Promise<WorkspaceStatOutcomeV1>;
}

/**
 * The narrow file interface the kernel declares and consumes. Writes require a
 * writer and answer with the generation they produced.
 */
export interface WorkspaceFilesV1 extends WorkspaceReadsV1 {
  write(request: WorkspaceWriteRequestV1): Promise<WorkspaceWriteOutcomeV1>;
  delete(request: WorkspaceDeleteRequestV1): Promise<WorkspaceWriteOutcomeV1>;
}

/**
 * The read-only projection of the roots the Memory Package owns. A Memory root
 * reaches the kernel only through this type, which has no `write` and no
 * `delete` to call.
 */
export type WorkspaceMemoryProjectionV1 = WorkspaceReadsV1;

/**
 * True when a root accepts a write through the kernel-consumed interface.
 * False for every Memory root: the Memory Package writes object storage
 * directly and the Workspace presents Memory read-only.
 */
export function workspaceRootAcceptsKernelWriteV1(
  root: WorkspaceRootV1,
): boolean {
  return root.kind !== "bot-memory" && root.kind !== "user-memory";
}

/**
 * Narrows a full file interface to the read-only projection. The returned
 * object carries only `read`, `list`, and `stat`, so a Memory root handed
 * across this function cannot be written even by a caller that reaches for
 * `write` dynamically.
 */
export function workspaceMemoryProjectionV1(
  files: WorkspaceReadsV1,
): WorkspaceMemoryProjectionV1 {
  return {
    read: (path) => files.read(path),
    list: (request) => files.list(request),
    stat: (path) => files.stat(path),
  };
}

/**
 * A candidate Skill: a file under some durable root together with the writer
 * the root recorded for it. The kernel loads it as an instruction only when
 * `isLoadableSkillSourceV1` says so.
 */
export interface SkillSourceV1 {
  path: WorkspacePathV1;
  writer: WorkspaceWriterV1;
  generation: WorkspaceGenerationV1;
}

/** A Skill source the kernel may load: the root kind is proven by the type. */
export interface LoadableSkillSourceV1 extends SkillSourceV1 {
  path: WorkspaceInstructionPathV1;
}

/**
 * "Only Skills under the Bot's own instruction root, written under the Bot's
 * own authority or its User's, are loaded as instructions."
 *
 * Pure, total, and the only place that sentence is decided. A first-party
 * writer is not the Bot's authority nor its User's, so it is refused too: a
 * Package that wants to ship instructions ships a Package, not a Skill.
 */
export function isLoadableSkillSourceV1(
  source: SkillSourceV1,
  owner: { botId: string; userId: string },
): source is LoadableSkillSourceV1 {
  const root = source.path.root;
  if (root.kind !== "bot-instructions") return false;
  if (root.userId !== owner.userId || root.botId !== owner.botId) return false;
  const writer = source.writer;
  if (writer.kind === "user") return writer.userId === owner.userId;
  if (writer.kind === "bot") return writer.botId === owner.botId;
  return false;
}

/** A stable, collision-free key for one durable root. */
export function workspaceRootKeyV1(root: WorkspaceRootV1): string {
  const user = encodeURIComponent(root.userId);
  if (root.kind === "user-memory") return `user-memory:${user}`;
  if (root.kind === "package-declared") {
    return `package-declared:${user}:${encodeURIComponent(root.packageId)}:${root.rootId}`;
  }
  return `${root.kind}:${user}:${encodeURIComponent(root.botId)}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set<string>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function ownerId(value: unknown, label: string): string {
  return boundedString(value, label, WORKSPACE_MAX_OWNER_ID_LENGTH);
}

/**
 * Validates one relative path inside a durable root. Rejects absolute paths,
 * `.` and `..` segments, empty segments, backslashes, NUL and other control
 * characters, untrimmed text, and anything past the length or depth bound.
 * Returns the path unchanged: a path that needs normalizing is refused rather
 * than rewritten, so what a caller asked for is what a generation records.
 */
export function normalizeWorkspaceRelativePathV1(
  input: unknown,
  label = "workspace path",
): string {
  const path = boundedString(input, label, WORKSPACE_MAX_PATH_LENGTH);
  if (
    path !== path.trim() ||
    path.startsWith("/") ||
    path.includes("\\") ||
    /[\u0000-\u001f\u007f]/.test(path)
  ) {
    throw new Error(`${label} must be a relative POSIX path`);
  }
  const segments = path.split("/");
  if (segments.length > WORKSPACE_MAX_PATH_SEGMENTS) {
    throw new Error(`${label} exceeds its depth bound`);
  }
  for (const segment of segments) {
    if (
      !segment ||
      segment === "." ||
      segment === ".." ||
      segment.length > WORKSPACE_MAX_SEGMENT_LENGTH ||
      segment !== segment.trim()
    ) {
      throw new Error(`${label} has an invalid segment`);
    }
  }
  return path;
}

export function decodeWorkspaceRootV1(
  input: unknown,
  label = "workspace root",
): WorkspaceRootV1 {
  const value = record(input, label);
  if (value.kind === "bot-instructions" || value.kind === "bot-memory") {
    exactKeys(value, ["kind", "userId", "botId"], label);
    return {
      kind: value.kind,
      userId: ownerId(value.userId, `${label}.userId`),
      botId: ownerId(value.botId, `${label}.botId`),
    };
  }
  if (value.kind === "user-memory") {
    exactKeys(value, ["kind", "userId"], label);
    return {
      kind: "user-memory",
      userId: ownerId(value.userId, `${label}.userId`),
    };
  }
  if (value.kind === "package-declared") {
    exactKeys(value, ["kind", "userId", "packageId", "rootId"], label);
    const rootId = boundedString(
      value.rootId,
      `${label}.rootId`,
      WORKSPACE_MAX_ROOT_ID_LENGTH,
    );
    if (!ROOT_ID.test(rootId)) throw new Error(`${label}.rootId is invalid`);
    return {
      kind: "package-declared",
      userId: ownerId(value.userId, `${label}.userId`),
      packageId: boundedString(value.packageId, `${label}.packageId`, 128),
      rootId,
    };
  }
  throw new Error(`${label}.kind is invalid`);
}

export function decodeWorkspacePathV1(
  input: unknown,
  label = "workspace path",
): WorkspacePathV1 {
  const value = record(input, label);
  exactKeys(value, ["root", "path"], label);
  return {
    root: decodeWorkspaceRootV1(value.root, `${label}.root`),
    path: normalizeWorkspaceRelativePathV1(value.path, `${label}.path`),
  };
}

export function decodeWorkspaceWriterV1(
  input: unknown,
  label = "workspace writer",
): WorkspaceWriterV1 {
  const value = record(input, label);
  if (value.kind === "first-party") {
    exactKeys(value, ["kind", "packageId"], label);
    return {
      kind: "first-party",
      packageId: boundedString(value.packageId, `${label}.packageId`, 128),
    };
  }
  if (value.kind === "user") {
    exactKeys(value, ["kind", "userId"], label);
    return { kind: "user", userId: ownerId(value.userId, `${label}.userId`) };
  }
  if (value.kind === "bot") {
    exactKeys(value, ["kind", "botId", "sessionId", "turnId", "runId"], label);
    return {
      kind: "bot",
      botId: ownerId(value.botId, `${label}.botId`),
      sessionId: boundedString(value.sessionId, `${label}.sessionId`, 257),
      turnId: boundedString(value.turnId, `${label}.turnId`, 128),
      runId: boundedString(value.runId, `${label}.runId`, 128),
    };
  }
  throw new Error(`${label}.kind is invalid`);
}

export function decodeWorkspaceGenerationV1(
  input: unknown,
  label = "workspace generation",
): WorkspaceGenerationV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "generationId",
      "contentHash",
      "size",
      "writer",
      "writtenAt",
    ],
    label,
    ["conflictsWith"],
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (
    typeof value.contentHash !== "string" ||
    !SHA256_HEX.test(value.contentHash)
  ) {
    throw new Error(`${label}.contentHash must be a sha-256 hex digest`);
  }
  if (
    !Number.isSafeInteger(value.size) ||
    (value.size as number) < 0 ||
    (value.size as number) > WORKSPACE_MAX_FILE_BYTES
  ) {
    throw new Error(`${label}.size is out of range`);
  }
  const generation: WorkspaceGenerationV1 = {
    schemaVersion: 1,
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      256,
    ),
    contentHash: value.contentHash,
    size: value.size as number,
    writer: decodeWorkspaceWriterV1(value.writer, `${label}.writer`),
    writtenAt: boundedString(value.writtenAt, `${label}.writtenAt`, 64),
  };
  if (value.conflictsWith !== undefined) {
    generation.conflictsWith = boundedString(
      value.conflictsWith,
      `${label}.conflictsWith`,
      256,
    );
  }
  return generation;
}

export function decodeWorkspaceEntryV1(
  input: unknown,
  label = "workspace entry",
): WorkspaceEntryV1 {
  const value = record(input, label);
  exactKeys(value, ["path", "generation"], label);
  return {
    path: decodeWorkspacePathV1(value.path, `${label}.path`),
    generation: decodeWorkspaceGenerationV1(
      value.generation,
      `${label}.generation`,
    ),
  };
}

const FAILURE_STATUSES: readonly WorkspaceFailureStatusV1[] = [
  "not-found",
  "refused",
  "conflict",
  "unavailable",
];

export function decodeWorkspaceFailureV1(
  input: unknown,
  label = "workspace failure",
): WorkspaceFailureV1 {
  const value = record(input, label);
  exactKeys(value, ["status", "reason"], label);
  const status = FAILURE_STATUSES.find(
    (candidate) => candidate === value.status,
  );
  if (!status) throw new Error(`${label}.status is invalid`);
  return {
    status,
    reason: boundedString(value.reason, `${label}.reason`, 512),
  };
}

export function decodeSkillSourceV1(
  input: unknown,
  label = "skill source",
): SkillSourceV1 {
  const value = record(input, label);
  exactKeys(value, ["path", "writer", "generation"], label);
  return {
    path: decodeWorkspacePathV1(value.path, `${label}.path`),
    writer: decodeWorkspaceWriterV1(value.writer, `${label}.writer`),
    generation: decodeWorkspaceGenerationV1(
      value.generation,
      `${label}.generation`,
    ),
  };
}
