// A stand-in for the `AI` binding, as an auxiliary Worker with an RPC
// entrypoint.
//
// Why a stand-in and not the real thing: miniflare has no local AI Gateway
// simulator. The fake implements both production seams: Gateway chat via
// `env.AI.gateway(id).run(request)` and native image generation via
// `env.AI.run(model, input)`.
//
// What is real here: the wire shapes. `flux-1-schnell` answers
// `{ image: "<base64>" }` — measured against Cloudflare's model schema for
// `@cf/black-forest-labs/flux-1-schnell` on 2026-08-31 — and so does this. The
// bytes are a genuine 1×1 PNG, so `plugin-image`'s own container decoder reads
// a real IHDR out of them rather than being handed a shape it trusts.
//
// The call counter lives in the auxiliary Worker's module scope and is read
// back over the same RPC surface, which is what lets a test prove that a
// replayed Turn produced no second generation.

/**
 * The shape `miniflare.workers` accepts for one auxiliary Worker, declared
 * structurally: the `miniflare` package is a transitive dependency of the
 * Vitest pool and this app declares no direct dependency on it, so naming its
 * types here would be reaching past a boundary for a four-field object.
 */
export interface AuxiliaryWorkerOptionsV1 {
  // The pool's own option type is loose; the index signature is what makes
  // this structural declaration assignable to it.
  [field: string]: unknown;
  name: string;
  modules: true;
  script: string;
  compatibilityDate: string;
  compatibilityFlags: string[];
}

/** A 1×1 PNG. The smallest thing that is honestly an image. */
export const FAKE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

/** The service name both bindings point at. */
export const FROCK_AI_FAKE_NAME = "frock-ai-fake";
/** The RPC entrypoint the `AI` binding is wired to. */
export const FROCK_AI_FAKE_ENTRYPOINT = "FrockAiFake";

// Authored as a module string because miniflare's auxiliary Workers take
// JavaScript, not a TypeScript path: this file runs in Node at config load,
// and the script below runs in workerd.
const SCRIPT = `
import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

const PNG = ${JSON.stringify(FAKE_PNG_BASE64)};
const encoder = new TextEncoder();

let calls = [];

class FakeGateway extends RpcTarget {
  run(request) {
    const query = request?.query ?? {};
    const messages = Array.isArray(query.messages) ? query.messages : [];
    const prompt = String(messages.at(-1)?.content ?? "");
    calls.push({ model: String(query.model ?? ""), prompt });
    const payload =
      'data: {"choices":[{"delta":{"content":"Frock AI reply"}}]}\\n\\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\\n\\n' +
      'data: [DONE]\\n\\n';
    return new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(payload));
        controller.close();
      },
    }));
  }
}

export class ${FROCK_AI_FAKE_ENTRYPOINT} extends WorkerEntrypoint {
  gateway(_gatewayId) {
    return new FakeGateway();
  }

  run(model, input) {
    calls.push({ model, prompt: String(input?.prompt ?? "") });
    return { image: PNG };
  }

  // Not part of the binding: the suite's window onto what it was asked for.
  runCalls() {
    return calls;
  }

  resetCalls() {
    calls = [];
    return true;
  }
}

export default {
  fetch() {
    return new Response("frock-ai-fake speaks RPC only", { status: 404 });
  },
};
`;

/** The auxiliary Worker definition, for `miniflare.workers`. */
export function createFrockAiFakeWorker(
  compatibilityDate: string,
): AuxiliaryWorkerOptionsV1 {
  return {
    name: FROCK_AI_FAKE_NAME,
    modules: true,
    script: SCRIPT,
    compatibilityDate,
    compatibilityFlags: ["nodejs_compat"],
  };
}

/** The service designator both `AI` and the suite's probe binding use. */
export const FROCK_AI_FAKE_SERVICE = {
  name: FROCK_AI_FAKE_NAME,
  entrypoint: FROCK_AI_FAKE_ENTRYPOINT,
} as const;
