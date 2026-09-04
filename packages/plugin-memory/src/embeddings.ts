import { remoteCallV1 } from "@frockbot/kernel-contracts";
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
      // Workers AI is remote in every environment. Without a deadline a hung
      // binding held the whole Turn open to the platform limit.
      const response = await remoteCallV1("the embedding model", () =>
        ai.run(model, { text: texts.slice(index, index + MAX_BATCH_SIZE) }),
      );
      vectors.push(...response.data);
    }
    return vectors;
  };
}
