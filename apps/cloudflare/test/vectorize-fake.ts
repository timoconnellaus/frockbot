import type { AuxiliaryWorkerOptionsV1 } from "./frock-ai-fake.ts";

export const VECTORIZE_FAKE_NAME = "vectorize-fake";
export const VECTORIZE_FAKE_ENTRYPOINT = "VectorizeFake";

const SCRIPT = `
import { WorkerEntrypoint } from "cloudflare:workers";

let deletions = [];

export class ${VECTORIZE_FAKE_ENTRYPOINT} extends WorkerEntrypoint {
  deleteByIds(ids) {
    deletions.push([...ids]);
    return { count: ids.length };
  }

  deletedBatches() {
    return deletions;
  }

  reset() {
    deletions = [];
    return true;
  }
}

export default {
  fetch() {
    return new Response("vectorize-fake speaks RPC only", { status: 404 });
  },
};
`;

export function createVectorizeFakeWorker(
  compatibilityDate: string,
): AuxiliaryWorkerOptionsV1 {
  return {
    name: VECTORIZE_FAKE_NAME,
    modules: true,
    script: SCRIPT,
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
  };
}

export const VECTORIZE_FAKE_SERVICE = {
  name: VECTORIZE_FAKE_NAME,
  entrypoint: VECTORIZE_FAKE_ENTRYPOINT,
} as const;
