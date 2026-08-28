import { chunkMarkdown, hashMemoryContent } from "./chunker.js";
import type { MemoryDocumentStore } from "./storage.js";
import type {
  EmbedMemory,
  MemoryIndexResult,
  MemoryScope,
  MemoryVectorIndex,
} from "./types.js";

async function vectorId(
  scope: MemoryScope,
  path: string,
  documentHash: string,
  chunkKey: string,
): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      `${scope.vectorNamespace}\0${path}\0${documentHash}\0${chunkKey}`,
    ),
  );
  const hash = [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  return hash;
}

export async function indexDocument(
  scope: MemoryScope,
  path: string,
  content: string,
  embed: EmbedMemory,
  vectorize: MemoryVectorIndex,
  storage: MemoryDocumentStore,
): Promise<MemoryIndexResult> {
  const [chunks, documentHash] = await Promise.all([
    chunkMarkdown(content),
    hashMemoryContent(content),
  ]);
  const keyedChunks = chunks.map((chunk, index) => ({
    chunk,
    key: `${chunk.startLine}:${index}`,
  }));
  const chunkIds = await Promise.all(
    keyedChunks.map(({ key }) => vectorId(scope, path, documentHash, key)),
  );
  const hashes = Object.fromEntries(
    keyedChunks.map(({ key, chunk }) => [key, chunk.hash]),
  );
  const oldMeta = await storage.readMeta(scope, path);
  const documentChanged = oldMeta.documentHash !== documentHash;
  const changed = keyedChunks
    .map(({ chunk, key }, index) => ({
      chunk,
      key,
      id: chunkIds[index] ?? "",
    }))
    .filter(
      ({ chunk, key }) => documentChanged || oldMeta.hashes[key] !== chunk.hash,
    );

  if (changed.length > 0) {
    const vectors = await embed(changed.map(({ chunk }) => chunk.content));
    if (vectors.length !== changed.length) {
      throw new Error(
        `memory embedder returned ${vectors.length} vectors for ${changed.length} chunks`,
      );
    }
    await vectorize.upsert(
      changed.map(({ chunk, id }, index) => ({
        id,
        values: vectors[index] ?? [],
        namespace: scope.vectorNamespace,
        metadata: {
          path,
          tier: scope.tier,
          startLine: chunk.startLine,
          endLine: chunk.endLine,
          hash: chunk.hash,
          documentHash,
        },
      })),
    );
  }

  const currentIds = new Set(chunkIds);
  const staleIds = oldMeta.vectorIds.filter((id) => !currentIds.has(id));
  if (staleIds.length > 0) await vectorize.deleteByIds(staleIds);
  await storage.writeMeta(scope, path, {
    documentHash,
    hashes,
    vectorIds: chunkIds,
  });

  return {
    chunksTotal: chunks.length,
    chunksEmbedded: changed.length,
    vectorsDeleted: staleIds.length,
  };
}

export async function removeDocument(
  scope: MemoryScope,
  path: string,
  vectorize: MemoryVectorIndex,
  storage: MemoryDocumentStore,
): Promise<number> {
  const meta = await storage.readMeta(scope, path);
  if (meta.vectorIds.length > 0) {
    await vectorize.deleteByIds(meta.vectorIds);
  }
  await storage.deleteMeta(scope, path);
  return meta.vectorIds.length;
}
