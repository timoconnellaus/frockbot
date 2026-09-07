// The derived Memory index: chunks, hashes, and optional embeddings.
//
// "Indexes, embeddings, and summaries are derived from Memory files and are
// always rebuildable from them." Two operations therefore have to agree, and
// the package's test proves they do:
//
//   rebuild(documents)                 — from nothing
//   update(previousIndex, documents)   — incrementally
//
// `updateMemoryIndexV1` re-chunks only the documents whose content address
// changed and drops the ones that are gone; `buildMemoryIndexV1` chunks
// everything. Both answer the same index for the same documents, which is what
// "rebuildable" means operationally: nothing the incremental path accumulates
// can survive a rebuild, so nothing can drift.
//
// The index is process-local by construction. It holds no authority and is
// never the source of a fact — a search result is hydrated back out of the
// files before it is shown.
import { remoteCallV1 } from "@frockbot/core/contracts";
import { chunkMarkdown, type MemoryChunk } from "./chunker.js";
import { memoryDocumentKeyV1, type MemoryDocumentV1 } from "./documents.js";
import type { EmbedMemory, MemoryVectorIndex } from "./types.js";

/** One indexed chunk, addressed by the document generation it came from. */
export interface MemoryIndexChunkV1 {
  /** `<scope>:<projectId>:<path>`. */
  documentKey: string;
  scope: MemoryDocumentV1["scope"];
  projectId: string;
  path: string;
  botId: string;
  startLine: number;
  endLine: number;
  content: string;
  /** sha-256 of the chunk text. */
  hash: string;
  /** sha-256 of the whole document the chunk came from. */
  documentHash: string;
}

/** The whole derived index. Deterministic in the documents it was built from. */
export interface MemoryIndexV1 {
  chunks: MemoryIndexChunkV1[];
  /** Content address per document key, the incremental path's only state. */
  documentHashes: Record<string, string>;
}

export function emptyMemoryIndexV1(): MemoryIndexV1 {
  return { chunks: [], documentHashes: {} };
}

function sortChunks(chunks: MemoryIndexChunkV1[]): MemoryIndexChunkV1[] {
  return [...chunks].sort((left, right) => {
    if (left.documentKey !== right.documentKey) {
      return left.documentKey.localeCompare(right.documentKey);
    }
    return left.startLine - right.startLine;
  });
}

async function chunksOf(
  document: MemoryDocumentV1,
): Promise<MemoryIndexChunkV1[]> {
  const key = memoryDocumentKeyV1(document);
  const chunks: MemoryChunk[] = await chunkMarkdown(document.text);
  return chunks.map((chunk) => ({
    documentKey: key,
    scope: document.scope,
    projectId: document.projectId,
    path: document.path,
    botId: document.botId,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    content: chunk.content,
    hash: chunk.hash,
    documentHash: document.contentHash,
  }));
}

/** A full rebuild from the files. The definition the incremental path matches. */
export async function buildMemoryIndexV1(
  documents: MemoryDocumentV1[],
): Promise<MemoryIndexV1> {
  const index = emptyMemoryIndexV1();
  for (const document of documents) {
    index.documentHashes[memoryDocumentKeyV1(document)] = document.contentHash;
    index.chunks.push(...(await chunksOf(document)));
  }
  index.chunks = sortChunks(index.chunks);
  return index;
}

/** What one incremental update actually did, for the tool's answer. */
export interface MemoryIndexUpdateV1 {
  index: MemoryIndexV1;
  documentsChanged: number;
  documentsRemoved: number;
  chunksTotal: number;
}

/**
 * Re-chunks only what changed. The previous index is treated as a cache of
 * `documentHashes`; every chunk of a changed document is discarded and rebuilt
 * rather than diffed, because a partial chunk merge is exactly the kind of
 * accumulated state a rebuildable index must not have.
 */
export async function updateMemoryIndexV1(
  previous: MemoryIndexV1,
  documents: MemoryDocumentV1[],
): Promise<MemoryIndexUpdateV1> {
  const present = new Set(documents.map(memoryDocumentKeyV1));
  const documentHashes: Record<string, string> = {};
  const kept: MemoryIndexChunkV1[] = previous.chunks.filter((chunk) =>
    present.has(chunk.documentKey),
  );
  let changed = 0;
  const rebuilt: MemoryIndexChunkV1[] = [];
  const stale = new Set<string>();
  for (const document of documents) {
    const key = memoryDocumentKeyV1(document);
    documentHashes[key] = document.contentHash;
    if (previous.documentHashes[key] === document.contentHash) continue;
    changed += 1;
    stale.add(key);
    rebuilt.push(...(await chunksOf(document)));
  }
  const removed = Object.keys(previous.documentHashes).filter(
    (key) => !present.has(key),
  ).length;
  const index: MemoryIndexV1 = {
    chunks: sortChunks([
      ...kept.filter((chunk) => !stale.has(chunk.documentKey)),
      ...rebuilt,
    ]),
    documentHashes,
  };
  return {
    index,
    documentsChanged: changed,
    documentsRemoved: removed,
    chunksTotal: index.chunks.length,
  };
}

/** A stable vector id for one chunk: its content address, not its position. */
export async function memoryChunkVectorIdV1(
  chunk: MemoryIndexChunkV1,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${chunk.documentKey}\u0000${chunk.documentHash}\u0000${chunk.startLine}\u0000${chunk.hash}`,
    ),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/** The namespace one tier's vectors live in. */
export function memoryVectorNamespaceV1(chunk: MemoryIndexChunkV1): string {
  return chunk.projectId
    ? `${chunk.scope}:${chunk.projectId}`
    : `${chunk.scope}`;
}

/**
 * Mirrors an index into a vector store, when one is configured. Optional by
 * design: the index above is complete without it, and a Bot with no embedding
 * binding still searches its Memory lexically.
 */
export async function embedMemoryIndexV1(
  index: MemoryIndexV1,
  embed: EmbedMemory,
  vectorize: MemoryVectorIndex,
): Promise<number> {
  if (index.chunks.length === 0) return 0;
  const vectors = await embed(index.chunks.map((chunk) => chunk.content));
  if (vectors.length !== index.chunks.length) {
    throw new Error(
      `memory embedder returned ${vectors.length} vectors for ${index.chunks.length} chunks`,
    );
  }
  const upserts = await Promise.all(
    index.chunks.map(async (chunk, position) => ({
      id: await memoryChunkVectorIdV1(chunk),
      values: vectors[position] ?? [],
      namespace: memoryVectorNamespaceV1(chunk),
      metadata: {
        path: chunk.path,
        scope: chunk.scope,
        projectId: chunk.projectId,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
        hash: chunk.hash,
        documentHash: chunk.documentHash,
      },
    })),
  );
  await remoteCallV1("the memory index", () => vectorize.upsert(upserts));
  return upserts.length;
}
