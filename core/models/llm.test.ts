import { describe, expect, test } from "bun:test";
import {
  LlmEffectNotStartedError,
  LoopHookListV1,
  type LlmStreamEvent,
  type NormalizedModelRequest,
} from "@frockbot/core/contracts";
import { LlmRegistry } from "./llm.js";

const REQUEST: NormalizedModelRequest = {
  requestId: "request-1",
  provider: "fake",
  model: "fake-model",
  system: "",
  messages: [
    {
      role: "user",
      content: "Look",
      attachments: [
        {
          kind: "image",
          uploadId: "a".repeat(64),
          name: "beach.jpg",
          mediaType: "image/jpeg",
          bytes: 3,
        },
      ],
    },
  ],
  tools: [],
};

async function drain(events: AsyncIterable<LlmStreamEvent>): Promise<void> {
  for await (const _event of events) {
    // Consumed for its effect on the provider.
  }
}

describe("the model registry's attachment resolver", () => {
  test("the provider sees resolved bytes; the caller's request keeps none", async () => {
    const seen: NormalizedModelRequest[] = [];
    const registry = new LlmRegistry(new LoopHookListV1(), {
      resolve: async (request) => ({
        ...request,
        messages: request.messages.map((message) =>
          message.role === "user"
            ? {
                ...message,
                attachments: message.attachments?.map((item) => ({
                  ...item,
                  dataBase64: "AAAA",
                })),
              }
            : message,
        ),
      }),
    });
    registry.register({
      id: "fake",
      async *stream(request) {
        seen.push(request);
        yield { type: "finish", reason: "completed" } as LlmStreamEvent;
      },
    });
    await drain(registry.stream(REQUEST, new AbortController().signal));
    expect(seen).toHaveLength(1);
    const user = seen[0]!.messages[0]!;
    expect(user.role === "user" && user.attachments?.[0]?.dataBase64).toBe(
      "AAAA",
    );
    const original = REQUEST.messages[0]!;
    expect(
      original.role === "user" && original.attachments?.[0]?.dataBase64,
    ).toBeUndefined();
  });

  test("a resolver that fails is a call that never started", async () => {
    let called = false;
    const registry = new LlmRegistry(new LoopHookListV1(), {
      resolve: async () => {
        throw new Error("object store unavailable");
      },
    });
    registry.register({
      id: "fake",
      async *stream() {
        called = true;
        yield { type: "finish", reason: "completed" } as LlmStreamEvent;
      },
    });
    await expect(
      drain(registry.stream(REQUEST, new AbortController().signal)),
    ).rejects.toBeInstanceOf(LlmEffectNotStartedError);
    expect(called).toBe(false);
  });
});
