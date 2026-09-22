// Durable Skill metadata for one instruction root.
//
// The catalog a Turn starts from is this index, not a walk of the root. Bytes
// of a Skill the Turn was promised live at a content address, written before
// the index names them. R2 and the Durable Object cannot commit together, so a
// path is pending — and not served as the previous body — until the generation
// record and the index name the same bytes.

import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  decodeWorkspaceWriterV1,
  isLoadableSkillSourceV1,
  isWorkspaceInstructionRootV1,
  type SkillSourceV1,
  type WorkspaceGenerationV1,
  type WorkspaceInstructionRootV1,
  type WorkspaceWriterV1,
} from "@frockbot/core/contracts";
import {
  isSkillDocumentPathV1,
  parseSkillDocumentV1,
  skillReferenceNameForV1,
  SKILL_DIRECTORY,
  SKILL_FILE_NAME,
  SKILL_MAX_FILE_BYTES,
  SKILL_MAX_REFERENCES,
  SKILL_REFERENCES_DIRECTORY,
} from "./skill-md.js";

export const SKILL_BODY_PREFIX_V1 = "skill-bodies/v1/";
export const SKILL_INDEX_ENTRY_LIMIT_V1 = 200;

export function skillBodyKeyV1(contentHash: string): string {
  return `${SKILL_BODY_PREFIX_V1}${contentHash}`;
}

/** A path the index maintains. Anything else in the root is not a Skill. */
export function isSkillIndexPathV1(path: string): boolean {
  if (!path.startsWith(`${SKILL_DIRECTORY}/`)) return false;
  if (isSkillDocumentPathV1(path)) return true;
  const marker = `/${SKILL_REFERENCES_DIRECTORY}/`;
  const cut = path.lastIndexOf(marker);
  if (cut < 0) return false;
  const documentPath = `${path.slice(0, cut + 1)}${SKILL_FILE_NAME}`;
  return skillReferenceNameForV1(documentPath, path) !== undefined;
}

export function skillDocumentPathForReferenceV1(
  path: string,
): string | undefined {
  const marker = `/${SKILL_REFERENCES_DIRECTORY}/`;
  const cut = path.lastIndexOf(marker);
  if (cut < 0) return undefined;
  const documentPath = `${path.slice(0, cut + 1)}${SKILL_FILE_NAME}`;
  return skillReferenceNameForV1(documentPath, path) !== undefined
    ? documentPath
    : undefined;
}

export type SkillIndexRefusalKindV1 =
  "authority" | "malformed" | "oversized" | "unreadable";

export interface SkillIndexReferenceMetaV1 {
  path: string;
  generationId: string;
  contentHash: string;
  bodyKey: string;
  size: number;
  writer: WorkspaceWriterV1;
}

export interface SkillIndexEntryV1 {
  path: string;
  generationId: string;
  contentHash: string;
  bodyKey: string;
  size: number;
  writer: WorkspaceWriterV1;
  name?: string;
  description?: string;
  refusal?: { kind: SkillIndexRefusalKindV1; reason: string };
  references: SkillIndexReferenceMetaV1[];
}

export interface SkillIndexPendingV1 {
  path: string;
  generationId?: string;
  reason: "publishing" | "ledger-failed";
}

export interface SkillMetadataIndexV1 {
  schemaVersion: 1;
  revision: string;
  status: "ready" | "rebuilding";
  /** Set when the instruction root itself is gone. Pins do not survive it. */
  deleted: boolean;
  /**
   * The admitted snapshot could not be read. Callers must not fill this from
   * the live index.
   */
  missing?: boolean;
  entries: SkillIndexEntryV1[];
  pending: SkillIndexPendingV1[];
  detachedReferences: SkillIndexReferenceMetaV1[];
}

export function emptySkillMetadataIndexV1(): SkillMetadataIndexV1 {
  return {
    schemaVersion: 1,
    revision: "",
    status: "ready",
    deleted: false,
    entries: [],
    pending: [],
    detachedReferences: [],
  };
}

export type SkillIndexPinV1 = "serve" | "removed" | "revoked" | "deleted";

function writerLabel(writer: WorkspaceWriterV1): string {
  if (writer.kind === "first-party") {
    return `first-party Package "${writer.packageId}"`;
  }
  if (writer.kind === "user") return `User "${writer.userId}"`;
  if (writer.kind === "bot") return `Bot "${writer.botId}"`;
  return "no recorded writer (written outside the Workspace file surface)";
}

function rootLabel(root: WorkspaceInstructionRootV1): string {
  return root.kind === "user-instructions"
    ? `User "${root.userId}"'s instruction root`
    : `Bot "${root.botId}"'s instruction root`;
}

function authorityOwner(
  root: WorkspaceInstructionRootV1,
  writer: WorkspaceWriterV1,
): { userId: string; botId: string } {
  if (root.kind === "bot-instructions") {
    return { userId: root.userId, botId: root.botId };
  }
  return {
    userId: root.userId,
    botId: writer.kind === "bot" ? writer.botId : root.userId,
  };
}

function sourceOf(
  root: WorkspaceInstructionRootV1,
  path: string,
  writer: WorkspaceWriterV1,
  generation: WorkspaceGenerationV1,
): SkillSourceV1 {
  return { path: { root, path }, writer, generation };
}

function referenceOf(
  generation: WorkspaceGenerationV1,
  path: string,
): SkillIndexReferenceMetaV1 {
  return {
    path,
    generationId: generation.generationId,
    contentHash: generation.contentHash,
    bodyKey: skillBodyKeyV1(generation.contentHash),
    size: generation.size,
    writer: generation.writer,
  };
}

async function revisionOf(
  entries: readonly SkillIndexEntryV1[],
  detached: readonly SkillIndexReferenceMetaV1[],
): Promise<string> {
  if (entries.length === 0 && detached.length === 0) return "";
  const body = JSON.stringify({
    entries: [...entries]
      .sort((left, right) => left.path.localeCompare(right.path))
      .map((entry) => ({
        path: entry.path,
        generationId: entry.generationId,
        contentHash: entry.contentHash,
        bodyKey: entry.bodyKey,
        size: entry.size,
        writer: entry.writer,
        name: entry.name ?? null,
        description: entry.description ?? null,
        refusal: entry.refusal ?? null,
        references: [...entry.references].sort((left, right) =>
          left.path.localeCompare(right.path),
        ),
      })),
    detached: [...detached].sort((left, right) =>
      left.path.localeCompare(right.path),
    ),
  });
  return sha256HexTextV1(body);
}

function withoutPath(
  index: SkillMetadataIndexV1,
  path: string,
): Pick<SkillMetadataIndexV1, "entries" | "detachedReferences"> {
  const document = skillDocumentPathForReferenceV1(path) ?? path;
  return {
    entries: index.entries.flatMap((entry) => {
      if (entry.path === path) return [];
      if (entry.path !== document) return [entry];
      const references = entry.references.filter(
        (reference) => reference.path !== path,
      );
      return references.length === entry.references.length
        ? [entry]
        : [{ ...entry, references }];
    }),
    detachedReferences: index.detachedReferences.filter(
      (reference) => reference.path !== path,
    ),
  };
}

/**
 * Drops the path from the trusted index before the generation record is
 * known to have landed. A failed record leaves this pending entry, not the
 * previous body.
 */
export async function beginSkillIndexPublicationV1(
  index: SkillMetadataIndexV1,
  path: string,
  generationId: string | undefined,
  ledgerFailed: boolean,
): Promise<SkillMetadataIndexV1> {
  if (index.deleted) return index;
  const removed = withoutPath(index, path);
  const pending = [
    ...index.pending.filter((item) => item.path !== path),
    {
      path,
      ...(generationId ? { generationId } : {}),
      reason: ledgerFailed
        ? ("ledger-failed" as const)
        : ("publishing" as const),
    },
  ];
  return {
    ...index,
    ...removed,
    pending,
    revision: await revisionOf(removed.entries, removed.detachedReferences),
    status: "rebuilding",
  };
}

function validateReferences(
  root: WorkspaceInstructionRootV1,
  entry: SkillIndexEntryV1,
): SkillIndexEntryV1 {
  if (entry.references.length > SKILL_MAX_REFERENCES) {
    return {
      ...entry,
      refusal: {
        kind: "oversized",
        reason: `the Skill offers ${entry.references.length} references; the bound is ${SKILL_MAX_REFERENCES}`,
      },
    };
  }
  for (const reference of entry.references) {
    const generation: WorkspaceGenerationV1 = {
      schemaVersion: 1,
      generationId: reference.generationId,
      contentHash: reference.contentHash,
      size: reference.size,
      writer: reference.writer,
      writtenAt: "1970-01-01T00:00:00.000Z",
    };
    if (
      !isLoadableSkillSourceV1(
        sourceOf(root, reference.path, reference.writer, generation),
        authorityOwner(root, reference.writer),
      )
    ) {
      return {
        ...entry,
        refusal: {
          kind: "authority",
          reason: `its reference ${reference.path} was written by ${writerLabel(reference.writer)}; only this Bot or its User may write an instruction`,
        },
      };
    }
    if (reference.size > SKILL_MAX_FILE_BYTES) {
      return {
        ...entry,
        refusal: {
          kind: "oversized",
          reason: `its reference ${reference.path} is ${reference.size} bytes; the bound is ${SKILL_MAX_FILE_BYTES}`,
        },
      };
    }
  }
  return entry;
}

function documentEntry(
  root: WorkspaceInstructionRootV1,
  path: string,
  generation: WorkspaceGenerationV1,
  bytes: Uint8Array,
  references: SkillIndexReferenceMetaV1[],
): SkillIndexEntryV1 {
  const base: SkillIndexEntryV1 = {
    path,
    generationId: generation.generationId,
    contentHash: generation.contentHash,
    bodyKey: skillBodyKeyV1(generation.contentHash),
    size: generation.size,
    writer: generation.writer,
    references,
  };
  if (
    !isLoadableSkillSourceV1(
      sourceOf(root, path, generation.writer, generation),
      authorityOwner(root, generation.writer),
    )
  ) {
    return {
      ...base,
      refusal: {
        kind: "authority",
        reason: `written by ${writerLabel(generation.writer)} under ${rootLabel(root)}; only this Bot or its User, under this Bot's own instruction root, may write an instruction`,
      },
    };
  }
  if (
    bytes.byteLength > SKILL_MAX_FILE_BYTES ||
    generation.size > SKILL_MAX_FILE_BYTES
  ) {
    return {
      ...base,
      refusal: {
        kind: "oversized",
        reason: `the Skill is ${Math.max(bytes.byteLength, generation.size)} bytes; the bound is ${SKILL_MAX_FILE_BYTES}`,
      },
    };
  }
  const parsed = parseSkillDocumentV1(new TextDecoder().decode(bytes));
  if (parsed.status !== "ok") {
    return {
      ...base,
      refusal: { kind: "malformed", reason: parsed.reason },
    };
  }
  return validateReferences(root, {
    ...base,
    name: parsed.document.name,
    description: parsed.document.description,
  });
}

function fitEntries(entries: SkillIndexEntryV1[]): SkillIndexEntryV1[] {
  if (entries.length <= SKILL_INDEX_ENTRY_LIMIT_V1) return entries;
  return entries.slice(0, SKILL_INDEX_ENTRY_LIMIT_V1);
}

async function finish(
  index: SkillMetadataIndexV1,
  path: string,
  entries: SkillIndexEntryV1[],
  detached: SkillIndexReferenceMetaV1[],
): Promise<SkillMetadataIndexV1> {
  const pending = index.pending.filter((item) => item.path !== path);
  const bounded = fitEntries(entries);
  return {
    ...index,
    entries: bounded,
    detachedReferences: detached,
    pending,
    revision: await revisionOf(bounded, detached),
    status: pending.length === 0 ? "ready" : "rebuilding",
    deleted: false,
    missing: undefined,
  };
}

export async function commitSkillDocumentV1(
  index: SkillMetadataIndexV1,
  root: WorkspaceInstructionRootV1,
  path: string,
  generation: WorkspaceGenerationV1,
  bytes: Uint8Array,
): Promise<SkillMetadataIndexV1> {
  if (index.deleted) return index;
  const removed = withoutPath(index, path);
  const attached = [
    ...removed.detachedReferences.filter(
      (reference) => skillDocumentPathForReferenceV1(reference.path) === path,
    ),
  ];
  const detached = removed.detachedReferences.filter(
    (reference) => skillDocumentPathForReferenceV1(reference.path) !== path,
  );
  const entry = documentEntry(root, path, generation, bytes, attached);
  const entries = [
    ...removed.entries.filter((candidate) => candidate.path !== path),
    entry,
  ];
  return finish(index, path, entries, detached);
}

export async function commitSkillReferenceV1(
  index: SkillMetadataIndexV1,
  root: WorkspaceInstructionRootV1,
  path: string,
  generation: WorkspaceGenerationV1,
): Promise<SkillMetadataIndexV1> {
  if (index.deleted) return index;
  const documentPath = skillDocumentPathForReferenceV1(path);
  const removed = withoutPath(index, path);
  const reference = referenceOf(generation, path);
  if (!documentPath) {
    return finish(index, path, removed.entries, [
      ...removed.detachedReferences,
      reference,
    ]);
  }
  const parent = removed.entries.find((entry) => entry.path === documentPath);
  if (!parent) {
    return finish(index, path, removed.entries, [
      ...removed.detachedReferences,
      reference,
    ]);
  }
  const references = [
    ...parent.references.filter((candidate) => candidate.path !== path),
    reference,
  ].sort((left, right) => left.path.localeCompare(right.path));
  const updated = validateReferences(root, { ...parent, references });
  const entries = removed.entries.map((entry) =>
    entry.path === documentPath ? updated : entry,
  );
  return finish(index, path, entries, removed.detachedReferences);
}

export async function commitSkillDeletionV1(
  index: SkillMetadataIndexV1,
  path: string,
): Promise<SkillMetadataIndexV1> {
  if (index.deleted) return index;
  const removed = withoutPath(index, path);
  return finish(index, path, removed.entries, removed.detachedReferences);
}

/** Root deletion wins over every pin, including admitted revisions. */
export function tombstoneSkillIndexV1(
  index: SkillMetadataIndexV1,
): SkillMetadataIndexV1 {
  return {
    ...emptySkillMetadataIndexV1(),
    deleted: true,
    revision: index.revision,
  };
}

export function skillIndexPinV1(
  live: SkillMetadataIndexV1,
  root: WorkspaceInstructionRootV1,
  path: string,
  writer: WorkspaceWriterV1,
  generation: WorkspaceGenerationV1,
): SkillIndexPinV1 {
  if (live.deleted) return "deleted";
  if (
    !isLoadableSkillSourceV1(
      sourceOf(root, path, writer, generation),
      authorityOwner(root, writer),
    )
  ) {
    return "revoked";
  }
  const present = live.entries.some((entry) => entry.path === path);
  const pending = live.pending.some((item) => item.path === path);
  if (!present && !pending) return "removed";
  return "serve";
}

function plain(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exact(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw new Error(`${label} has unknown fields`);
  }
}

function decodeReference(
  value: unknown,
  label: string,
): SkillIndexReferenceMetaV1 {
  const record = plain(value, label);
  exact(
    record,
    ["path", "generationId", "contentHash", "bodyKey", "size", "writer"],
    label,
  );
  if (typeof record.path !== "string" || record.path.length === 0) {
    throw new Error(`${label}.path is invalid`);
  }
  if (
    typeof record.generationId !== "string" ||
    record.generationId.length === 0
  ) {
    throw new Error(`${label}.generationId is invalid`);
  }
  if (
    typeof record.contentHash !== "string" ||
    record.contentHash.length !== 64
  ) {
    throw new Error(`${label}.contentHash is invalid`);
  }
  if (record.bodyKey !== skillBodyKeyV1(record.contentHash)) {
    throw new Error(`${label}.bodyKey is invalid`);
  }
  if (!Number.isSafeInteger(record.size) || (record.size as number) < 0) {
    throw new Error(`${label}.size is invalid`);
  }
  return {
    path: record.path,
    generationId: record.generationId,
    contentHash: record.contentHash,
    bodyKey: record.bodyKey,
    size: record.size as number,
    writer: decodeWorkspaceWriterV1(record.writer, `${label}.writer`),
  };
}

function decodeEntry(value: unknown, label: string): SkillIndexEntryV1 {
  const record = plain(value, label);
  exact(
    record,
    [
      "path",
      "generationId",
      "contentHash",
      "bodyKey",
      "size",
      "writer",
      "name",
      "description",
      "refusal",
      "references",
    ],
    label,
  );
  if (!Array.isArray(record.references)) {
    throw new Error(`${label}.references must be an array`);
  }
  let refusal: SkillIndexEntryV1["refusal"];
  if (record.refusal !== undefined) {
    const refusalRecord = plain(record.refusal, `${label}.refusal`);
    exact(refusalRecord, ["kind", "reason"], `${label}.refusal`);
    const kind = refusalRecord.kind;
    if (
      kind !== "authority" &&
      kind !== "malformed" &&
      kind !== "oversized" &&
      kind !== "unreadable"
    ) {
      throw new Error(`${label}.refusal.kind is invalid`);
    }
    if (typeof refusalRecord.reason !== "string") {
      throw new Error(`${label}.refusal.reason is invalid`);
    }
    refusal = { kind, reason: refusalRecord.reason };
  }
  return {
    path:
      typeof record.path === "string"
        ? record.path
        : (() => {
            throw new Error(`${label}.path is invalid`);
          })(),
    generationId:
      typeof record.generationId === "string"
        ? record.generationId
        : (() => {
            throw new Error(`${label}.generationId is invalid`);
          })(),
    contentHash:
      typeof record.contentHash === "string" && record.contentHash.length === 64
        ? record.contentHash
        : (() => {
            throw new Error(`${label}.contentHash is invalid`);
          })(),
    bodyKey:
      record.bodyKey === skillBodyKeyV1(String(record.contentHash))
        ? (record.bodyKey as string)
        : (() => {
            throw new Error(`${label}.bodyKey is invalid`);
          })(),
    size: Number.isSafeInteger(record.size)
      ? (record.size as number)
      : (() => {
          throw new Error(`${label}.size is invalid`);
        })(),
    writer: decodeWorkspaceWriterV1(record.writer, `${label}.writer`),
    ...(typeof record.name === "string" ? { name: record.name } : {}),
    ...(typeof record.description === "string"
      ? { description: record.description }
      : {}),
    ...(refusal ? { refusal } : {}),
    references: record.references.map((reference, index) =>
      decodeReference(reference, `${label}.references[${index}]`),
    ),
  };
}

export function decodeSkillMetadataIndexV1(
  value: unknown,
): SkillMetadataIndexV1 {
  const record = plain(value, "skill index");
  exact(
    record,
    [
      "schemaVersion",
      "revision",
      "status",
      "deleted",
      "entries",
      "pending",
      "detachedReferences",
      "missing",
    ],
    "skill index",
  );
  if (record.schemaVersion !== 1) {
    throw new Error("skill index schemaVersion is unsupported");
  }
  if (typeof record.revision !== "string" || record.revision.length > 64) {
    throw new Error("skill index revision is invalid");
  }
  if (record.status !== "ready" && record.status !== "rebuilding") {
    throw new Error("skill index status is invalid");
  }
  if (record.deleted !== true && record.deleted !== false) {
    throw new Error("skill index deleted is invalid");
  }
  if (!Array.isArray(record.entries) || !Array.isArray(record.pending)) {
    throw new Error("skill index entries are invalid");
  }
  if (!Array.isArray(record.detachedReferences)) {
    throw new Error("skill index detached references are invalid");
  }
  return {
    schemaVersion: 1,
    revision: record.revision,
    status: record.status,
    deleted: record.deleted,
    entries: record.entries.map((entry, index) =>
      decodeEntry(entry, `skill index.entries[${index}]`),
    ),
    pending: record.pending.map((item, index) => {
      const pending = plain(item, `skill index.pending[${index}]`);
      exact(
        pending,
        ["path", "generationId", "reason"],
        `skill index.pending[${index}]`,
      );
      if (
        pending.reason !== "publishing" &&
        pending.reason !== "ledger-failed"
      ) {
        throw new Error(`skill index.pending[${index}].reason is invalid`);
      }
      if (typeof pending.path !== "string") {
        throw new Error(`skill index.pending[${index}].path is invalid`);
      }
      return {
        path: pending.path,
        reason: pending.reason,
        ...(typeof pending.generationId === "string"
          ? { generationId: pending.generationId }
          : {}),
      };
    }),
    detachedReferences: record.detachedReferences.map((reference, index) =>
      decodeReference(reference, `skill index.detachedReferences[${index}]`),
    ),
    ...(record.missing === true ? { missing: true } : {}),
  };
}

export function assertInstructionRootV1(
  root: unknown,
): WorkspaceInstructionRootV1 {
  if (!root || typeof root !== "object") {
    throw new Error("skill index root is invalid");
  }
  if (!isWorkspaceInstructionRootV1(root as WorkspaceInstructionRootV1)) {
    throw new Error("skill index root is not an instruction root");
  }
  return root as WorkspaceInstructionRootV1;
}
