import {
  EMBEDDING_MODEL,
  type EmbedMemory,
  type MemoryAiBinding,
} from "./types.js";

const MAX_BATCH_SIZE = 100;

export function createMemoryEmbedder(
  ai: MemoryAiBinding,
  model = EMBEDDING_MODEL,
): EmbedMemory {
  return async (texts) => {
    const vectors: number[][] = [];
    for (let index = 0; index < texts.length; index += MAX_BATCH_SIZE) {
      const response = await ai.run(model, {
        text: texts.slice(index, index + MAX_BATCH_SIZE),
      });
      vectors.push(...response.data);
    }
    return vectors;
  };
}
