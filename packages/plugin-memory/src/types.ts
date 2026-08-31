// The optional bindings the derived index consumes, and nothing else.
//
// Memory itself needs none of these: facts are Markdown files, read and
// written through `WorkspaceFilesV1`. Embeddings are derived state over those
// files, so their bindings are optional throughout — a Bot with no Workers AI
// binding indexes and searches its Memory lexically.
import type { MemoryScopeNameV1 } from "@frockbot/kernel-contracts";

export const EMBEDDING_MODEL = "@cf/baai/bge-base-en-v1.5";
export const EMBEDDING_DIMENSIONS = 768;

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

/** One search hit: where the text is, never the authority for what it says. */
export interface MemorySearchResult {
  scope: MemoryScopeNameV1;
  /** `""` for the two unprojected tiers. */
  projectId: string;
  path: string;
  startLine: number;
  endLine: number;
  snippet: string;
  score?: number;
}
