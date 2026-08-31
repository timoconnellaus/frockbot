// Memory files as documents, for the derived index.
//
// "Indexes, embeddings, and summaries are derived from Memory files and are
// always rebuildable from them." That sentence is only true if there is one
// place the index reads its inputs from, and it is the files — not a sidecar,
// not a cache, not a second store. This module is that place: it enumerates
// every Memory file of every tier a Bot can see, through the same
// `WorkspaceReadsV1` the renderer uses, and hands back bytes and content
// addresses. Nothing derived is stored here.
import type {
  MemoryScopeNameV1,
  WorkspaceMemoryRootV1,
  WorkspaceReadsV1,
} from "@frockbot/kernel-contracts";
import {
  memoryFileKindV1,
  memoryProjectIdOfRootV1,
  memoryScopeOfRootV1,
} from "./roots.js";
import { MEMORY_MAX_FILES_PER_TIER, MEMORY_MAX_LIST_PAGES } from "./store.js";

/** One Memory file, addressed by its content and its generation. */
export interface MemoryDocumentV1 {
  scope: MemoryScopeNameV1;
  projectId: string;
  /** Relative to its root, shard prefix included. */
  path: string;
  /** The Bot whose shard holds it. */
  botId: string;
  kind: "profile" | "log";
  text: string;
  contentHash: string;
  generationId: string;
}

/** A stable key for one document across every tier. */
export function memoryDocumentKeyV1(document: {
  scope: MemoryScopeNameV1;
  projectId: string;
  path: string;
}): string {
  return `${document.scope}:${document.projectId}:${document.path}`;
}

/**
 * Reads every Memory file under one root. A file that cannot be read is
 * skipped rather than thrown: an index is derived state, and a partial rebuild
 * that says so beats a Turn that fails because one object was briefly
 * unreachable.
 */
export async function listMemoryDocumentsV1(
  reads: WorkspaceReadsV1,
  root: WorkspaceMemoryRootV1,
): Promise<MemoryDocumentV1[]> {
  const scope = memoryScopeOfRootV1(root);
  const projectId = memoryProjectIdOfRootV1(root);
  const documents: MemoryDocumentV1[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MEMORY_MAX_LIST_PAGES; page += 1) {
    const outcome = await reads.list(
      cursor === undefined ? { root } : { root, cursor },
    );
    if (outcome.status !== "ok") return documents;
    for (const entry of outcome.entries) {
      if (documents.length >= MEMORY_MAX_FILES_PER_TIER) return documents;
      const classified = memoryFileKindV1(root, entry.path.path);
      if (!classified) continue;
      const read = await reads.read(entry.path);
      if (read.status !== "ok") continue;
      documents.push({
        scope,
        projectId,
        path: entry.path.path,
        botId: classified.shard,
        kind: classified.kind,
        text: new TextDecoder().decode(read.file.bytes),
        contentHash: read.file.generation.contentHash,
        generationId: read.file.generation.generationId,
      });
    }
    if (!outcome.cursor) break;
    cursor = outcome.cursor;
  }
  return documents;
}

/** Every Memory document of every root a Bot can see, in tier order. */
export async function listAllMemoryDocumentsV1(
  reads: WorkspaceReadsV1,
  roots: WorkspaceMemoryRootV1[],
): Promise<MemoryDocumentV1[]> {
  const documents: MemoryDocumentV1[] = [];
  for (const root of roots) {
    documents.push(...(await listMemoryDocumentsV1(reads, root)));
  }
  return documents;
}
