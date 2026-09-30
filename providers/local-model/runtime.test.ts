import { describe, expect, test } from "bun:test";
import {
  ModelProviderFailureError,
  type NormalizedModelRequest,
} from "@frockbot/core/contracts";
import {
  LOCAL_MODEL_DROPPED_V1,
  LOCAL_MODEL_OFFLINE_V1,
} from "@frockbot/core/machine-protocol/relay";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";

import {
  createLocalModelFeature,
  type LocalModelRelayRequestV1,
} from "./runtime.js";

const request: NormalizedModelRequest = {
  requestId: "effect-1",
  provider: "local",
  model: "llama3.2:latest",
  system: "",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  modelBinding: {
    connectionId: "connection-1",
    connectionGeneration: "generation-1",
  },
};

const ANSWER =
  'data: {"choices":[{"delta":{"content":"hi from your Mac"}}]}\n\n' +
  'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
  "data: [DONE]\n\n";

async function mounted(
  relay: (request: LocalModelRelayRequestV1) => Promise<Response>,
) {
  const root = createAgentRuntimeHarness();
  await root.mount(
    createLocalModelFeature({ connectionId: "connection-1", relay }),
  );
  return root;
}

async function collect(
  root: Awaited<ReturnType<typeof mounted>>,
  input: NormalizedModelRequest = request,
) {
  const events = [];
  for await (const event of root.llm.stream(
    input,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

describe("local model runtime", () => {
  test("streams the Mac's answer, keyed by the request id", async () => {
    const relayed: LocalModelRelayRequestV1[] = [];
    const root = await mounted(async (input) => {
      relayed.push(input);
      return new Response(ANSWER, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const events = await collect(root);
    expect(events).toContainEqual({
      type: "text-delta",
      text: "hi from your Mac",
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "completed" });
    expect(relayed).toHaveLength(1);
    expect(relayed[0]!.relayId).toBe("chat:effect-1");
    const body = JSON.parse(relayed[0]!.body) as {
      model: string;
      stream: boolean;
    };
    expect(body.model).toBe("llama3.2:latest");
    expect(body.stream).toBe(true);
  });

  test("an offline Mac fails permanently with the sentence, and nothing else answers", async () => {
    const root = await mounted(() =>
      Promise.reject(new Error(LOCAL_MODEL_OFFLINE_V1)),
    );
    const failure = await collect(root).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelProviderFailureError);
    expect((failure as ModelProviderFailureError).classification).toBe(
      "permanent",
    );
    expect((failure as Error).message).toContain(LOCAL_MODEL_OFFLINE_V1);
  });

  test("a Mac that drops mid-answer says so", async () => {
    const root = await mounted(async () => {
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"choices":[{"delta":{"content":"par"}}]}\n\n',
            ),
          );
          controller.error(new Error(LOCAL_MODEL_DROPPED_V1));
        },
      });
      return new Response(stream, {
        headers: { "content-type": "text/event-stream" },
      });
    });
    const failure = await collect(root).catch((error: unknown) => error);
    expect((failure as Error).message).toContain(LOCAL_MODEL_DROPPED_V1);
  });

  test("a request for another Connection is refused before the Mac is asked", async () => {
    let asked = false;
    const root = await mounted(async () => {
      asked = true;
      return new Response(ANSWER);
    });
    const failure = await collect(root, {
      ...request,
      modelBinding: { connectionId: "connection-2", connectionGeneration: "g" },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ModelProviderFailureError);
    expect(asked).toBe(false);
  });
});
