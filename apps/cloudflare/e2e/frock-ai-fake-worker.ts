import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

const encoder = new TextEncoder();
const reply =
  'data: {"choices":[{"delta":{"content":"Reply from the Frock AI stub."}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

class FrockAiGatewayFake extends RpcTarget {
  run(_request: Record<string, unknown>): Response {
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(reply));
          controller.close();
        },
      }),
    );
  }
}

/** Local RPC stand-in for the production AI Gateway binding. */
export class FrockAiFake extends WorkerEntrypoint {
  gateway(_gatewayId: string): FrockAiGatewayFake {
    return new FrockAiGatewayFake();
  }

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
    return new Response("Frock AI fake speaks RPC only", { status: 404 });
  },
};
