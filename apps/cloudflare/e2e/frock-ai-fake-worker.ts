import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

const encoder = new TextEncoder();
const reply =
  'data: {"choices":[{"delta":{"content":"Reply from the Frock AI stub."}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

class FrockAiGatewayFake extends RpcTarget {
  run(request: Record<string, unknown>): Response {
    const query = request.query as
      | {
          tools?: Array<{ function?: { name?: string } }>;
          messages?: Array<{
            role?: string;
            tool_calls?: Array<{ function?: { name?: string } }>;
          }>;
        }
      | undefined;
    const messages = query?.messages ?? [];
    const canSend = query?.tools?.some(
      (tool) => tool.function?.name === "send_to_user",
    );
    const sinceUser = messages.slice(
      messages.findLastIndex((message) => message.role === "user") + 1,
    );
    const sent = sinceUser.some((message) =>
      message.tool_calls?.some(
        (call) => call.function?.name === "send_to_user",
      ),
    );
    const delta =
      canSend && !sent
        ? {
            tool_calls: [
              {
                index: 0,
                id: "send-reply",
                function: {
                  name: "send_to_user",
                  arguments: JSON.stringify({
                    payload: {
                      type: "text",
                      text: "Reply from the Frock AI stub.",
                    },
                  }),
                },
              },
            ],
          }
        : { content: canSend ? "" : "Reply from the Frock AI stub." };
    const response =
      `data: ${JSON.stringify({ choices: [{ delta }] })}\n\n` +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    return new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(response));
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

/**
 * The name the deployed `frockbot-flock-ai-e2e` Worker was bound under before
 * the provider was renamed. An RPC entrypoint name is part of a deployed
 * Worker's surface, and this Worker and the app Worker that binds it are
 * deployed separately, so exporting both names means neither order of the two
 * deploys breaks the end-to-end environment. Remove it once the deployed
 * Worker is renamed.
 */
export { FrockAiFake as FlockAiFake };

export default {
  fetch(): Response {
    return new Response("Frock AI fake speaks RPC only", { status: 404 });
  },
};
