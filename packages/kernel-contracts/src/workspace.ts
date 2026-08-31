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
/** Longest Project identifier, matching the Package-declared root id bound. */
export const WORKSPACE_MAX_PROJECT_ID_LENGTH = 128;
/** Upper bound on a single durable-root file. */
export const WORKSPACE_MAX_FILE_BYTES = 1_048_576;
/** Upper bound on one `list` page. */
export const WORKSPACE_MAX_LIST_ENTRIES = 1_000;

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ROOT_ID = /^[a-z][a-z0-9-]{0,127}$/;
/** A Project is named by a slug, exactly as GrokBot names one on disk. */
const PROJECT_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;

/**
 * The kinds of durable root. "durable roots, declared by the Computer
 * Package's Workspace layout and by Package manifests" — the first three are
 * layout roots the constitution names directly, the fourth is a root a Package
 * manifest declares.
 */
export type WorkspaceRootKindV1 =
  | "bot-instructions"
  | "bot-memory"
  | "user-memory"
  | "project-memory"
  | "package-declared";

/**
 * A durable root, identified by kind and owner. Every root belongs to a User —
 * the User's Computer is the trust boundary (ADR 0012) — and the per-Bot kinds
 * additionally name the Bot whose authority governs writes to them.
 */
export type WorkspaceRootV1 =
  | { kind: "bot-instructions"; userId: string; botId: string }
  | { kind: "bot-memory"; userId: string; botId: string }
  | { kind: "user-memory"; userId: string }
  | { kind: "project-memory"; userId: string; projectId: string }
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

/**
 * A Memory root. The Memory Package is its only writer.
 *
 * "Memory is Markdown files under durable roots of the Workspace in three
 * tiers: a Bot Memory root per Bot, a User Memory root shared by the User's
 * Bots, and a Project Memory root per Project that a Bot has joined." All
 * three kinds are covered here; the two shared ones are additionally
 * `WorkspaceSharedMemoryRootV1`, because sharding is what makes a shared tier
 * single-writer per file.
 */
export type WorkspaceMemoryRootV1 = Extract<
  WorkspaceRootV1,
  { kind: "bot-memory" | "user-memory" | "project-memory" }
>;

/**
 * A Memory root more than one Bot writes. "Shared tiers are sharded per
 * writing Bot on disk so every Memory file has exactly one writer; readers
 * merge shards, newest fact wins on conflict, and every shared fact records
 * which Bot learned it."
 */
export type WorkspaceSharedMemoryRootV1 = Extract<
  WorkspaceRootV1,
  { kind: "user-memory" | "project-memory" }
>;

/** True for the three Memory kinds and nothing else. */
export function isWorkspaceMemoryRootV1(
  root: WorkspaceRootV1,
): root is WorkspaceMemoryRootV1 {
  return (
    root.kind === "bot-memory" ||
    root.kind === "user-memory" ||
    root.kind === "project-memory"
  );
}

/** True for the Memory kinds whose files are sharded per writing Bot. */
export function isWorkspaceSharedMemoryRootV1(
  root: WorkspaceRootV1,
): root is WorkspaceSharedMemoryRootV1 {
  return root.kind === "user-memory" || root.kind === "project-memory";
}

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
 * The first three kinds are the constitution's one provenance vocabulary —
 * "The recorded origin of a Package or change: first-party, User, or Bot, and
 * for a Bot the Session and Turn that produced it" — narrowed to a file
 * writer. They are not a second provenance type: `PackageProvenanceV1` in
 * `@frockbot/kernel-composition` names the same three kinds for a Package
 * artifact, and cannot be imported here because `kernel-composition` depends
 * on `kernel-contracts`, not the other way round. The two must stay in step;
 * the kinds are the contract.
 *
 * `unattributed` is the fourth kind, and it is not a fourth provenance: it
 * denotes a file whose writer was *not recorded* — written by a process on the
 * Computer outside the Workspace file surface (`computer_exec`, an installer,
 * a shell redirect), so no generation names who produced it. It is what a
 * reader answers about such a file, never what a writer may claim: "every
 * write to a durable root records its writer", so a `write` or a `delete` that
 * names `unattributed` is refused. An unattributed file is ordinary data — it
 * can be read, listed, and overwritten by an authorized writer — but it
 * carries no authority, so `isLoadableSkillSourceV1` refuses it and it is
 * never loaded as an instruction.
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
    }
  | { kind: "unattributed" };

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

/**
 * A write that lost a conditional write. "a write that would overwrite a
 * generation its writer has not seen is preserved as a conflicting generation
 * and surfaced, never merged or dropped" (ADR 0013), so the outcome carries
 * both sides: the generation that holds the file now, and the losing write,
 * preserved under its own generation with `conflictsWith` set.
 */
export interface WorkspaceConflictV1 extends WorkspaceFailureV1 {
  status: "conflict";
  /** The generation the file holds now, when the store could read one. */
  current?: WorkspaceGenerationV1;
  /** The losing write, preserved rather than dropped. */
  preserved?: WorkspaceGenerationV1;
}

/**
 * Narrows a write outcome to the conflict variant. `WorkspaceFailureV1` can
 * also carry the `conflict` status — a store that has no generations to report
 * still answers `conflict` — so the status alone does not discriminate the
 * union, and this predicate is how a caller reaches the two generations.
 */
export function isWorkspaceConflictV1(
  outcome: WorkspaceWriteOutcomeV1,
): outcome is WorkspaceConflictV1 {
  return outcome.status === "conflict";
}

export type WorkspaceWriteOutcomeV1 =
  | { status: "ok"; generation: WorkspaceGenerationV1 }
  | WorkspaceConflictV1
  | WorkspaceFailureV1;

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
 * True when a root accepts a write through the kernel-consumed interface, and
 * — when a writer is supplied — when that writer may name itself on a write.
 *
 * False for every Memory root: the Memory Package writes object storage
 * directly and the Workspace presents Memory read-only. False for an
 * `unattributed` writer whatever the root: "every write to a durable root
 * records its writer", so a write must always name a real one. `unattributed`
 * is an answer a reader gives about a file nobody recorded, not a writer a
 * caller may present.
 */
export function workspaceRootAcceptsKernelWriteV1(
  root: WorkspaceRootV1,
  writer?: WorkspaceWriterV1,
): boolean {
  if (writer !== undefined && !workspaceWriterMayWriteV1(writer)) return false;
  return !isWorkspaceMemoryRootV1(root);
}

/**
 * True when a writer may be named on a `write` or a `delete`. Only
 * `unattributed` may not: it records the absence of a recorded writer, and a
 * write that recorded nothing would be a write with no writer.
 */
export function workspaceWriterMayWriteV1(writer: WorkspaceWriterV1): boolean {
  return writer.kind !== "unattributed";
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
 * The directory a shared Memory tier gives one writing Bot. GrokBot's own
 * layout, kept verbatim: `user-memory/by-agent/<agent-uuid>/`, and
 * `projects/<slug>/memory/by-agent/<assistantId>/` for a Project. The prefix
 * is the mechanism behind "every Memory file has exactly one writer".
 */
export const WORKSPACE_MEMORY_SHARD_PREFIX = "by-agent";

/**
 * One writing Bot's slice of a Memory root.
 *
 * A Bot Memory root has exactly one writer already, so its shard is the whole
 * root and its `prefix` is empty. A shared root's shard is
 * `by-agent/<botId>/`, and a reader that wants the tier merges every shard by
 * listing the root without one.
 */
export interface WorkspaceShardV1 {
  root: WorkspaceMemoryRootV1;
  /** The Bot whose files live under `prefix`. */
  botId: string;
  /** Relative prefix inside the root; `""` for a Bot Memory root. */
  prefix: string;
}

/**
 * The relative prefix a Bot's files sit under inside a Memory root. Empty for
 * `bot-memory` — that root is already single-writer, so sharding it would add
 * a directory level that means nothing.
 */
export function memoryShardPrefixV1(
  root: WorkspaceMemoryRootV1,
  botId: string,
): string {
  if (root.kind === "bot-memory") return "";
  const shard = boundedString(
    botId,
    "shard botId",
    WORKSPACE_MAX_OWNER_ID_LENGTH,
  );
  if (shard.includes("/") || shard === "." || shard === "..") {
    throw new Error("shard botId is not a single path segment");
  }
  return `${WORKSPACE_MEMORY_SHARD_PREFIX}/${encodeURIComponent(shard)}/`;
}

/** The shard a Bot writes in one Memory root. */
export function workspaceMemoryShardV1(
  root: WorkspaceMemoryRootV1,
  botId: string,
): WorkspaceShardV1 {
  return { root, botId, prefix: memoryShardPrefixV1(root, botId) };
}

/**
 * Places one writing Bot's Memory file inside the root that owns it: under
 * `by-agent/<botId>/` in a shared tier, directly in the root for `bot-memory`.
 * The result is a validated path, so a `relative` that escapes its root is
 * refused here rather than reaching object storage.
 */
export function memoryShardPathV1(
  root: WorkspaceMemoryRootV1,
  botId: string,
  relative: string,
): WorkspacePathV1 {
  const tail = normalizeWorkspaceRelativePathV1(relative, "memory shard path");
  return {
    root,
    path: normalizeWorkspaceRelativePathV1(
      `${memoryShardPrefixV1(root, botId)}${tail}`,
      "memory shard path",
    ),
  };
}

/**
 * The Bot whose shard a path falls in, or `undefined` when the path is not
 * inside a shard. `bot-memory` answers the root's own Bot: the whole root is
 * that Bot's shard.
 */
export function memoryShardOwnerV1(path: WorkspacePathV1): string | undefined {
  const root = path.root;
  if (root.kind === "bot-memory") return root.botId;
  if (!isWorkspaceSharedMemoryRootV1(root)) return undefined;
  const segments = path.path.split("/");
  if (segments.length < 3 || segments[0] !== WORKSPACE_MEMORY_SHARD_PREFIX) {
    return undefined;
  }
  const shard = segments[1] ?? "";
  if (!shard) return undefined;
  try {
    return decodeURIComponent(shard);
  } catch {
    return undefined;
  }
}

/**
 * "within a shared root each Bot's shard is written only on that Bot's
 * behalf".
 *
 * True only when the writer may own the file at `path`: a Bot writer when the
 * path is inside its own shard, a User writer for any shard of a root the User
 * owns — the User's Computer is the trust boundary, and a User may correct
 * their own Memory — and never a first-party Package (a Package that wants to
 * ship instructions ships a Package) or an `unattributed` writer (nothing
 * recorded who wrote it, so ownership is not merely false but unprovable).
 *
 * Pure, total, and false for every non-Memory root: this predicate answers the
 * Memory sharding rule only, never the wider question of who may write a root.
 */
export function writerOwnsMemoryPathV1(
  path: WorkspacePathV1,
  writer: WorkspaceWriterV1,
): boolean {
  const root = path.root;
  if (!isWorkspaceMemoryRootV1(root)) return false;
  if (writer.kind === "user") return writer.userId === root.userId;
  if (writer.kind !== "bot") return false;
  if (root.kind === "bot-memory") return writer.botId === root.botId;
  return memoryShardOwnerV1(path) === writer.botId;
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
 * Package that wants to ship instructions ships a Package, not a Skill. An
 * `unattributed` writer is refused for a stronger reason: nothing recorded who
 * wrote the file, so "written under the Bot's own authority or its User's" is
 * not merely false but unprovable. A file a shell command dropped into an
 * instruction root is data the Bot can read, never an instruction it loads.
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
  if (root.kind === "project-memory") {
    return `project-memory:${user}:${encodeURIComponent(root.projectId)}`;
  }
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
  if (value.kind === "project-memory") {
    exactKeys(value, ["kind", "userId", "projectId"], label);
    const projectId = boundedString(
      value.projectId,
      `${label}.projectId`,
      WORKSPACE_MAX_PROJECT_ID_LENGTH,
    );
    if (!PROJECT_ID.test(projectId)) {
      throw new Error(`${label}.projectId is invalid`);
    }
    return {
      kind: "project-memory",
      userId: ownerId(value.userId, `${label}.userId`),
      projectId,
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
  if (value.kind === "unattributed") {
    exactKeys(value, ["kind"], label);
    return { kind: "unattributed" };
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
  exactKeys(value, ["status", "reason"], label, ["current", "preserved"]);
  const status = FAILURE_STATUSES.find(
    (candidate) => candidate === value.status,
  );
  if (!status) throw new Error(`${label}.status is invalid`);
  const failure: WorkspaceFailureV1 = {
    status,
    reason: boundedString(value.reason, `${label}.reason`, 512),
  };
  if (value.current === undefined && value.preserved === undefined) {
    return failure;
  }
  if (status !== "conflict") {
    throw new Error(
      `${label} carries conflicting generations without a conflict`,
    );
  }
  return decodeWorkspaceConflictV1(value, label);
}

/**
 * A conflict outcome with the two generations ADR 0013 requires to survive.
 * Both are optional: a store that could not read the current generation still
 * answers `conflict` rather than inventing one.
 */
export function decodeWorkspaceConflictV1(
  input: unknown,
  label = "workspace conflict",
): WorkspaceConflictV1 {
  const value = record(input, label);
  exactKeys(value, ["status", "reason"], label, ["current", "preserved"]);
  if (value.status !== "conflict") {
    throw new Error(`${label}.status must be "conflict"`);
  }
  const conflict: WorkspaceConflictV1 = {
    status: "conflict",
    reason: boundedString(value.reason, `${label}.reason`, 512),
  };
  if (value.current !== undefined) {
    conflict.current = decodeWorkspaceGenerationV1(
      value.current,
      `${label}.current`,
    );
  }
  if (value.preserved !== undefined) {
    conflict.preserved = decodeWorkspaceGenerationV1(
      value.preserved,
      `${label}.preserved`,
    );
  }
  return conflict;
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

/**
 * One durable generation record: what a Durable Object stores about a single
 * file in a durable root.
 *
 * "The Workspace and its object-storage twin are the only durable state
 * outside a Durable Object. They hold files, never authority: a Durable Object
 * records every intent, effect, and generation that concerns them." The bytes
 * live in object storage; this record is the authority for which generation
 * those bytes are, who wrote them, and — through `etag` — which conditional
 * write may replace them.
 */
export interface WorkspaceGenerationRecordV1 {
  schemaVersion: 1;
  root: WorkspaceRootV1;
  /** Validated relative path inside `root`. */
  path: string;
  generation: WorkspaceGenerationV1;
  /**
   * The object-storage entity tag the generation's bytes landed under. It is
   * what an `If-Match` write is conditioned on, so a writer that has seen
   * `generation.generationId` can prove it. Absent on a tombstone, and absent
   * when the record was recovered from a store that reported none.
   */
  etag?: string;
  /** True when the record is a deletion tombstone rather than a file. */
  deleted?: boolean;
  /** Object key holding a preserved losing write, on a conflict record. */
  conflictKey?: string;
}

/**
 * The generation ledger a durable root's owning Durable Object keeps, declared
 * here and implemented there. "The User's Durable Object is the authority for
 * ... the generation records of User Memory roots"; the Bot's Durable Object is
 * the authority for its own roots. An object-storage implementation of
 * `WorkspaceFilesV1` consumes this interface and owns none of it.
 */
export interface WorkspaceGenerationsV1 {
  /**
   * A sortable generation id, minted by the authority that owns `root` and
   * monotonic within it.
   *
   * The root is a parameter because ordering is only meaningful inside one
   * authority: "The User's Durable Object is the authority for ... the
   * generation records of User Memory roots", so a shared Memory root's ids
   * must come from the User object even when the Bot object is doing the
   * writing. Two Bots minting from two counters would produce ids that do not
   * order, and "newest fact wins on conflict" would have no answer.
   */
  mint(at: Date, root: WorkspaceRootV1): Promise<string>;
  /** The generation the authority believes the file currently holds. */
  current(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<WorkspaceGenerationRecordV1 | undefined>;
  /** Records a generation that won its conditional write. */
  record(entry: WorkspaceGenerationRecordV1): Promise<void>;
  /**
   * Records a deletion. A delete leaves a durable tombstone, so "nothing is
   * here" is a recorded outcome with a writer rather than an absence nobody
   * can account for after a Durable Object is evicted.
   */
  tombstone(entry: WorkspaceGenerationRecordV1): Promise<void>;
  /** Records a losing write, preserved beside the winner and surfaced. */
  conflict(entry: WorkspaceGenerationRecordV1): Promise<void>;
  /** Every preserved losing write for one file, oldest first. */
  conflicts(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<WorkspaceGenerationRecordV1[]>;
}

export function decodeWorkspaceGenerationRecordV1(
  input: unknown,
  label = "workspace generation record",
): WorkspaceGenerationRecordV1 {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", "root", "path", "generation"], label, [
    "etag",
    "deleted",
    "conflictKey",
  ]);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const entry: WorkspaceGenerationRecordV1 = {
    schemaVersion: 1,
    root: decodeWorkspaceRootV1(value.root, `${label}.root`),
    path: normalizeWorkspaceRelativePathV1(value.path, `${label}.path`),
    generation: decodeWorkspaceGenerationV1(
      value.generation,
      `${label}.generation`,
    ),
  };
  if (value.etag !== undefined) {
    entry.etag = boundedString(value.etag, `${label}.etag`, 256);
  }
  if (value.deleted !== undefined) {
    if (typeof value.deleted !== "boolean") {
      throw new Error(`${label}.deleted must be a boolean`);
    }
    entry.deleted = value.deleted;
  }
  if (value.conflictKey !== undefined) {
    entry.conflictKey = boundedString(
      value.conflictKey,
      `${label}.conflictKey`,
      2048,
    );
  }
  return entry;
}

/**
 * One recorded push intent of the durable-root sync (ADR 0013).
 *
 * Constitution, Computer and Workspace: "A mutation ... records intent and an
 * effect identifier in the Bot's Durable Object and in the Workspace before it
 * runs, so recovery can read its outcome or classify it as unknown without
 * repeating it." A sync push is such a mutation, and this is the record it
 * writes first. `effectId` is deterministic in the root, path, kind, bytes and
 * expected generation, so the same pending push resolves to the same key
 * however many times a dropped connection makes the sync try again.
 */
export interface WorkspaceSyncEffectV1 {
  effectId: string;
  root: WorkspaceRootV1;
  path: string;
  kind: "push" | "remove";
  /** sha-256 of the bytes the push carries; the empty digest for a remove. */
  contentHash: string;
  expectedGenerationId: string | null;
  at: string;
}

/**
 * Where a durable-root push records its intent.
 *
 * Declared by the kernel and implemented by the Bot's Durable Object
 * (`packages/kernel-do/src/workspace-sync-effects.ts`), the same way
 * `WorkspaceGenerationsV1` is: the sync agent lives in a Computer provider
 * Package and holds no authority, so the record it depends on belongs to the
 * object that owns the root. A provider with no Durable Object reachable falls
 * back to the Workspace sidecar half, which § Durable effects also allows
 * ("in the Bot's Durable Object **and** in the Workspace").
 */
export interface WorkspaceSyncEffectsV1 {
  intent(effect: WorkspaceSyncEffectV1): Promise<void>;
  settle(effect: WorkspaceSyncEffectV1): Promise<void>;
  pending(effectId: string): Promise<WorkspaceSyncEffectV1 | undefined>;
}

export function decodeWorkspaceSyncEffectV1(
  input: unknown,
  label = "workspace sync effect",
): WorkspaceSyncEffectV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "effectId",
      "root",
      "path",
      "kind",
      "contentHash",
      "expectedGenerationId",
      "at",
    ],
    label,
  );
  if (value.kind !== "push" && value.kind !== "remove") {
    throw new Error(`${label}.kind is invalid`);
  }
  if (
    typeof value.contentHash !== "string" ||
    !SHA256_HEX.test(value.contentHash)
  ) {
    throw new Error(`${label}.contentHash must be a sha-256 hex digest`);
  }
  if (
    value.expectedGenerationId !== null &&
    typeof value.expectedGenerationId !== "string"
  ) {
    throw new Error(`${label}.expectedGenerationId must be a string or null`);
  }
  return {
    effectId: boundedString(value.effectId, `${label}.effectId`, 256),
    root: decodeWorkspaceRootV1(value.root, `${label}.root`),
    path: normalizeWorkspaceRelativePathV1(value.path, `${label}.path`),
    kind: value.kind,
    contentHash: value.contentHash,
    expectedGenerationId:
      value.expectedGenerationId === null
        ? null
        : boundedString(
            value.expectedGenerationId,
            `${label}.expectedGenerationId`,
            256,
          ),
    at: boundedString(value.at, `${label}.at`, 64),
  };
}
