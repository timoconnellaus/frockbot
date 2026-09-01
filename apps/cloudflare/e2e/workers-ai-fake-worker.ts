import { WorkerEntrypoint } from "cloudflare:workers";

const encoder = new TextEncoder();
const reply =
  'data: {"choices":[{"delta":{"content":"Reply from the Workers AI stub."}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

/** Local RPC stand-in for the production `AI.run(model, input)` binding. */
export class WorkersAiFake extends WorkerEntrypoint {
  run(_model: string, _input: Record<string, unknown>): ReadableStream {
    return new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(reply));
        controller.close();
      },
    });
  }
}

export default {
  fetch(): Response {
    return new Response("Workers AI fake speaks RPC only", { status: 404 });
  },
};
