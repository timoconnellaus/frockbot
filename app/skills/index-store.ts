// Durable Object storage for one instruction root's Skill index, and the
// publication steps the workspace store calls after a generation is minted.
//
// Content-addressed bytes are written before the index names them. A hold
// keeps a revision an admitted run still names; root deletion drops holds.

import {
  RUN_PREFIX,
  skillIndexCurrentKeyV1,
  skillIndexHoldKeyV1,
  skillIndexSnapshotKeyV1,
  SKILL_INDEX_PREFIX,
} from "@frockbot/core/durable";
import type { WorkspaceGenerationPublicationV1 } from "@frockbot/core/workspace-store";
import { sha256HexBytesV1 } from "@frockbot/core/crypto";
import {
  workspaceRootKeyV1,
  type WorkspaceInstructionRootV1,
} from "@frockbot/core/contracts";
import {
  beginSkillIndexPublicationV1,
  commitSkillDeletionV1,
  commitSkillDocumentV1,
  commitSkillReferenceV1,
  decodeSkillMetadataIndexV1,
  emptySkillMetadataIndexV1,
  isSkillIndexPathV1,
  skillBodyKeyV1,
  skillDocumentPathForReferenceV1,
  tombstoneSkillIndexV1,
  type SkillMetadataIndexV1,
} from "./metadata-index.js";
import { isSkillDocumentPathV1 } from "./skill-md.js";

export interface SkillIndexStorageV1 {
  get(key: string): Promise<unknown>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean | void>;
  list(options: {
    prefix?: string;
    limit?: number;
    start?: string;
  }): Promise<Map<string, unknown>>;
}

export interface SkillBodyStoreV1 {
  put(key: string, bytes: Uint8Array): Promise<void>;
  get(key: string): Promise<Uint8Array | undefined>;
  delete(key: string): Promise<void>;
}

const HOLD_PAGE = 50;

async function readIndex(
  storage: SkillIndexStorageV1,
  root: WorkspaceInstructionRootV1,
): Promise<SkillMetadataIndexV1> {
  const stored = await storage.get(
    skillIndexCurrentKeyV1(workspaceRootKeyV1(root)),
  );
  if (stored === undefined) return emptySkillMetadataIndexV1();
  return decodeSkillMetadataIndexV1(stored);
}

async function writeIndex(
  storage: SkillIndexStorageV1,
  root: WorkspaceInstructionRootV1,
  index: SkillMetadataIndexV1,
  previousRevision: string,
): Promise<void> {
  const rootKey = workspaceRootKeyV1(root);
  const stored = { ...index };
  delete stored.missing;
  if (
    index.revision !== previousRevision &&
    index.revision !== "" &&
    !index.deleted
  ) {
    await storage.put(skillIndexSnapshotKeyV1(rootKey, index.revision), {
      schemaVersion: 1,
      revision: index.revision,
      entries: stored.entries,
      detachedReferences: stored.detachedReferences,
    });
  }
  await storage.put(skillIndexCurrentKeyV1(rootKey), stored);
}

export async function readDurableSkillIndexV1(
  storage: SkillIndexStorageV1,
  root: WorkspaceInstructionRootV1,
): Promise<SkillMetadataIndexV1> {
  return readIndex(storage, root);
}

export async function readDurableSkillSnapshotV1(
  storage: SkillIndexStorageV1,
  root: WorkspaceInstructionRootV1,
  revision: string,
): Promise<SkillMetadataIndexV1> {
  if (revision === "") return emptySkillMetadataIndexV1();
  const current = await readIndex(storage, root);
  if (current.revision === revision && !current.missing) return current;
  const stored = await storage.get(
    skillIndexSnapshotKeyV1(workspaceRootKeyV1(root), revision),
  );
  if (stored === undefined) {
    return {
      ...emptySkillMetadataIndexV1(),
      missing: true,
      status: "rebuilding",
    };
  }
  const record = stored as Record<string, unknown>;
  const index = decodeSkillMetadataIndexV1({
    schemaVersion: 1,
    revision,
    status: "ready",
    deleted: false,
    entries: record.entries,
    pending: [],
    detachedReferences: record.detachedReferences ?? [],
  });
  return index;
}

export async function beginDurableSkillPublicationV1(
  storage: SkillIndexStorageV1,
  root: WorkspaceInstructionRootV1,
  path: string,
  generationId: string | undefined,
  ledgerFailed: boolean,
): Promise<void> {
  if (!isSkillIndexPathV1(path)) return;
  const current = await readIndex(storage, root);
  const next = await beginSkillIndexPublicationV1(
    current,
    path,
    generationId,
    ledgerFailed,
  );
  await writeIndex(storage, root, next, current.revision);
}

export async function commitDurableSkillPublicationV1(
  storage: SkillIndexStorageV1,
  bodies: SkillBodyStoreV1,
  root: WorkspaceInstructionRootV1,
  path: string,
  generation: WorkspaceGenerationPublicationV1["generation"],
  bytes: Uint8Array | undefined,
  deleted: boolean,
): Promise<void> {
  if (!isSkillIndexPathV1(path)) return;
  const current = await readIndex(storage, root);
  if (deleted) {
    const next = await commitSkillDeletionV1(current, path);
    await writeIndex(storage, root, next, current.revision);
    return;
  }
  if (!bytes) {
    const next = await beginSkillIndexPublicationV1(
      current,
      path,
      generation.generationId,
      true,
    );
    await writeIndex(storage, root, next, current.revision);
    return;
  }
  const hash = await sha256HexBytesV1(bytes);
  if (hash !== generation.contentHash) {
    const next = await beginSkillIndexPublicationV1(
      current,
      path,
      generation.generationId,
      true,
    );
    await writeIndex(storage, root, next, current.revision);
    return;
  }
  // Bytes first. The index reference is the next write.
  await bodies.put(skillBodyKeyV1(hash), bytes);
  const next = isSkillDocumentPathV1(path)
    ? await commitSkillDocumentV1(current, root, path, generation, bytes)
    : skillDocumentPathForReferenceV1(path)
      ? await commitSkillReferenceV1(current, root, path, generation)
      : await commitSkillDeletionV1(current, path);
  await writeIndex(storage, root, next, current.revision);
}

export async function tombstoneDurableSkillIndexV1(
  storage: SkillIndexStorageV1,
  bodies: SkillBodyStoreV1,
  root: WorkspaceInstructionRootV1,
): Promise<void> {
  const rootKey = workspaceRootKeyV1(root);
  const current = await readIndex(storage, root);
  const hashes = new Set<string>();
  const collect = (index: SkillMetadataIndexV1) => {
    for (const entry of index.entries) {
      hashes.add(entry.contentHash);
      for (const reference of entry.references)
        hashes.add(reference.contentHash);
    }
    for (const reference of index.detachedReferences) {
      hashes.add(reference.contentHash);
    }
  };
  collect(current);
  let start: string | undefined;
  for (;;) {
    const page = await storage.list({
      prefix: `${SKILL_INDEX_PREFIX}rev:${rootKey}:`,
      limit: HOLD_PAGE,
      ...(start ? { start } : {}),
    });
    if (page.size === 0) break;
    let last = "";
    for (const [key, value] of page) {
      last = key;
      if (start !== undefined && key === start) continue;
      try {
        const decoded = decodeSkillMetadataIndexV1({
          schemaVersion: 1,
          revision: "a".repeat(64),
          status: "ready",
          deleted: false,
          entries: (value as { entries?: unknown }).entries,
          pending: [],
          detachedReferences:
            (value as { detachedReferences?: unknown }).detachedReferences ??
            [],
        });
        collect(decoded);
      } catch {
        // An undecodable snapshot is deleted with the rest of the root.
      }
      await storage.delete(key);
    }
    if (page.size < HOLD_PAGE) break;
    start = `${last}\0`;
  }
  await writeIndex(
    storage,
    root,
    tombstoneSkillIndexV1(current),
    current.revision,
  );
  for (const hash of hashes) await bodies.delete(skillBodyKeyV1(hash));
}

export interface SkillIndexHoldV1 {
  schemaVersion: 1;
  botRevision: string;
  userRevision: string;
}

export async function holdSkillIndexRevisionsV1(
  storage: SkillIndexStorageV1,
  runId: string,
  hold: { botRevision: string; userRevision: string },
): Promise<void> {
  const record: SkillIndexHoldV1 = { schemaVersion: 1, ...hold };
  await storage.put(skillIndexHoldKeyV1(runId), record);
}

/** Revisions still named by a hold. A truncated scan deletes nothing. */
export async function heldSkillRevisionsV1(
  storage: SkillIndexStorageV1,
): Promise<{ revisions: Set<string>; truncated: boolean }> {
  const revisions = new Set<string>();
  let start: string | undefined;
  let pages = 0;
  for (;;) {
    pages += 1;
    if (pages > 20) return { revisions, truncated: true };
    const page = await storage.list({
      prefix: `${SKILL_INDEX_PREFIX}hold:`,
      limit: HOLD_PAGE,
      ...(start ? { start } : {}),
    });
    if (page.size === 0) return { revisions, truncated: false };
    let last = "";
    for (const [key, value] of page) {
      last = key;
      if (start !== undefined && key === start) continue;
      const record = value as Partial<SkillIndexHoldV1> | undefined;
      if (!record || record.schemaVersion !== 1) continue;
      if (typeof record.botRevision === "string" && record.botRevision !== "") {
        revisions.add(record.botRevision);
      }
      if (
        typeof record.userRevision === "string" &&
        record.userRevision !== ""
      ) {
        revisions.add(record.userRevision);
      }
    }
    if (page.size < HOLD_PAGE) return { revisions, truncated: false };
    start = `${last}\0`;
  }
}

export async function releaseUnreferencedSkillSnapshotsV1(
  storage: SkillIndexStorageV1,
  bodies: SkillBodyStoreV1,
  root: WorkspaceInstructionRootV1,
  held: ReadonlySet<string>,
): Promise<string[]> {
  const current = await readIndex(storage, root);
  if (current.deleted) return [];
  const rootKey = workspaceRootKeyV1(root);
  const keep = new Set(held);
  if (current.revision !== "") keep.add(current.revision);
  const dropped: string[] = [];
  let start: string | undefined;
  for (;;) {
    const page = await storage.list({
      prefix: `${SKILL_INDEX_PREFIX}rev:${rootKey}:`,
      limit: HOLD_PAGE,
      ...(start ? { start } : {}),
    });
    if (page.size === 0) break;
    let last = "";
    for (const [key, value] of page) {
      last = key;
      if (start !== undefined && key === start) continue;
      const revision = key.slice(`${SKILL_INDEX_PREFIX}rev:${rootKey}:`.length);
      if (keep.has(revision)) continue;
      const record = value as {
        entries?: Array<{
          contentHash?: string;
          references?: Array<{ contentHash?: string }>;
        }>;
        detachedReferences?: Array<{ contentHash?: string }>;
      };
      await storage.delete(key);
      dropped.push(revision);
      const hashes = new Set<string>();
      for (const entry of record.entries ?? []) {
        if (typeof entry.contentHash === "string")
          hashes.add(entry.contentHash);
        for (const reference of entry.references ?? []) {
          if (typeof reference.contentHash === "string") {
            hashes.add(reference.contentHash);
          }
        }
      }
      for (const reference of record.detachedReferences ?? []) {
        if (typeof reference.contentHash === "string") {
          hashes.add(reference.contentHash);
        }
      }
      for (const hash of hashes) {
        if (await hashStillReferenced(storage, rootKey, hash, keep)) continue;
        await bodies.delete(skillBodyKeyV1(hash));
      }
    }
    if (page.size < HOLD_PAGE) break;
    start = `${last}\0`;
  }
  return dropped;
}

async function hashStillReferenced(
  storage: SkillIndexStorageV1,
  rootKey: string,
  hash: string,
  keep: ReadonlySet<string>,
): Promise<boolean> {
  const current = await storage.get(skillIndexCurrentKeyV1(rootKey));
  if (current && JSON.stringify(current).includes(hash)) return true;
  for (const revision of keep) {
    const snapshot = await storage.get(
      skillIndexSnapshotKeyV1(rootKey, revision),
    );
    if (snapshot && JSON.stringify(snapshot).includes(hash)) return true;
  }
  return false;
}

const TERMINAL_RUN = new Set([
  "completed",
  "failed",
  "cancelled",
  "superseded",
]);

/** Drops holds whose runs have already settled. A truncated scan stops. */
export async function releaseSettledSkillHoldsV1(
  storage: SkillIndexStorageV1,
): Promise<string[]> {
  const released: string[] = [];
  let start: string | undefined;
  let pages = 0;
  const prefix = `${SKILL_INDEX_PREFIX}hold:`;
  for (;;) {
    pages += 1;
    if (pages > 20) return released;
    const page = await storage.list({
      prefix,
      limit: HOLD_PAGE,
      ...(start ? { start } : {}),
    });
    if (page.size === 0) return released;
    let last = "";
    for (const [key] of page) {
      last = key;
      if (start !== undefined && key === start) continue;
      const runId = key.slice(prefix.length);
      const run = await storage.get(`${RUN_PREFIX}${runId}`);
      const status =
        run && typeof run === "object"
          ? (run as { status?: unknown }).status
          : undefined;
      if (typeof status === "string" && TERMINAL_RUN.has(status)) {
        await storage.delete(key);
        released.push(runId);
      }
    }
    if (page.size < HOLD_PAGE) return released;
    start = `${last}\0`;
  }
}

export async function releaseSkillIndexHoldV1(
  storage: SkillIndexStorageV1,
  runId: string,
): Promise<void> {
  await storage.delete(skillIndexHoldKeyV1(runId));
}

export interface SkillIndexUserRpcV1 {
  beginSkillIndex(input: unknown): Promise<void>;
  commitSkillIndex(input: unknown): Promise<void>;
  readSkillIndex(input: unknown): Promise<unknown>;
  holdSkillIndex(input: unknown): Promise<void>;
  releaseSkillIndexHold(input: unknown): Promise<void>;
}

/**
 * The workspace store's publication callback. Bot roots stay on this object.
 * The User root is the User Durable Object: every Bot of that User reads one
 * index.
 */
export async function publishWorkspaceSkillGenerationV1(options: {
  event: WorkspaceGenerationPublicationV1;
  storage: SkillIndexStorageV1;
  bodies: SkillBodyStoreV1;
  user?: SkillIndexUserRpcV1;
  userId: string;
}): Promise<void> {
  const event = options.event;
  if (
    event.root.kind !== "bot-instructions" &&
    event.root.kind !== "user-instructions"
  ) {
    return;
  }
  if (!isSkillIndexPathV1(event.path)) return;
  if (event.root.kind === "user-instructions") {
    if (!options.user) {
      throw new Error("the User skill index is not reachable");
    }
    if (event.phase === "begin") {
      await options.user.beginSkillIndex({
        schemaVersion: 1,
        userId: options.userId,
        root: event.root,
        path: event.path,
        generationId: event.generation.generationId,
        ledgerPending: event.ledgerPending,
      });
      return;
    }
    await options.user.commitSkillIndex({
      schemaVersion: 1,
      userId: options.userId,
      root: event.root,
      path: event.path,
      generation: event.generation,
      deleted: event.deleted,
      ...(event.bytes ? { bytesBase64: bytesToBase64(event.bytes) } : {}),
    });
    return;
  }
  if (event.phase === "begin") {
    await beginDurableSkillPublicationV1(
      options.storage,
      event.root,
      event.path,
      event.generation.generationId,
      event.ledgerPending,
    );
    return;
  }
  await commitDurableSkillPublicationV1(
    options.storage,
    options.bodies,
    event.root,
    event.path,
    event.generation,
    event.bytes,
    event.deleted,
  );
  const held = await heldSkillRevisionsV1(options.storage);
  if (!held.truncated && event.root.kind === "bot-instructions") {
    await releaseUnreferencedSkillSnapshotsV1(
      options.storage,
      options.bodies,
      event.root,
      held.revisions,
    );
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

export function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}
