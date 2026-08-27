export type MemoryTier = "agent" | "global";

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;

export interface MemoryBucketObject {
  text(): Promise<string>;
  json<T>(): Promise<T>;
}

export interface MemoryBucket {
  get(key: string): Promise<MemoryBucketObject | null>;
  put(
    key: string,
    value: string,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
  list(options: { prefix: string; cursor?: string }): Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface MemoryVector {
  id: string;
  values: number[];
  namespace: string;
  metadata: Record<string, string | number>;
}

export interface MemoryVectorMatch {
  id: string;
  score?: number;
  metadata?: Record<string, unknown>;
}

export interface MemoryVectorIndex {
  upsert(vectors: MemoryVector[]): Promise<unknown>;
  query(
    vector: number[],
    options: {
      topK: number;
      namespace: string;
      returnMetadata: "all";
    },
  ): Promise<{ matches: MemoryVectorMatch[] }>;
  deleteByIds(ids: string[]): Promise<unknown>;
}

export interface MemoryAiBinding {
  run(model: string, input: { text: string[] }): Promise<{ data: number[][] }>;
}

export type EmbedMemory = (texts: string[]) => Promise<number[][]>;

export interface MemoryScope {
  tier: MemoryTier;
  storagePrefix: string;
  vectorNamespace: string;
}

export interface MemorySearchResult {
  path: string;
  tier: MemoryTier;
  startLine: number;
  endLine: number;
  snippet: string;
  score?: number;
}

export interface MemoryIndexResult {
  chunksTotal: number;
  chunksEmbedded: number;
  vectorsDeleted: number;
}
