/**
 * The Bot-scoped ledger of Vectorize ids produced from its own Memory root.
 *
 * One id per key makes the ledger its own durable deletion cursor: a purge
 * removes a key only after Vectorize accepted the matching delete. A retry
 * after eviction therefore either advances to the next key or harmlessly
 * repeats an id whose external delete succeeded before the local commit.
 */
export const MEMORY_CHUNK_INDEX_PREFIX_V1 = "memory:chunk-index:v1:";

export interface MemoryChunkIndexEntryV1 {
  schemaVersion: 1;
  vectorId: string;
}

/** The narrow durable seam used before Bot-Memory vectors are upserted. */
export interface MemoryChunkIndexWriterV1 {
  record(vectorIds: readonly string[]): Promise<void>;
}

export function memoryChunkIndexKeyV1(vectorId: string): string {
  if (!vectorId || new TextEncoder().encode(vectorId).byteLength > 64) {
    throw new Error("Memory vector id must contain between 1 and 64 bytes");
  }
  return `${MEMORY_CHUNK_INDEX_PREFIX_V1}${encodeURIComponent(vectorId)}`;
}

export function decodeMemoryChunkIndexEntryV1(
  key: string,
  input: unknown,
): MemoryChunkIndexEntryV1 {
  if (
    typeof input !== "object" ||
    input === null ||
    Array.isArray(input) ||
    Reflect.get(input, "schemaVersion") !== 1 ||
    typeof Reflect.get(input, "vectorId") !== "string" ||
    Object.keys(input).some(
      (field) => field !== "schemaVersion" && field !== "vectorId",
    )
  ) {
    throw new Error("Stored Memory chunk index entry is invalid");
  }
  const vectorId = Reflect.get(input, "vectorId") as string;
  if (memoryChunkIndexKeyV1(vectorId) !== key) {
    throw new Error(
      "Stored Memory chunk index key does not match its vector id",
    );
  }
  return { schemaVersion: 1, vectorId };
}

export function memoryChunkIndexEntriesV1(
  vectorIds: readonly string[],
): Record<string, MemoryChunkIndexEntryV1> {
  return Object.fromEntries(
    [...new Set(vectorIds)].map((vectorId) => [
      memoryChunkIndexKeyV1(vectorId),
      { schemaVersion: 1, vectorId },
    ]),
  );
}
