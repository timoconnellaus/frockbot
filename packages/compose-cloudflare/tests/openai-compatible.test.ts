import { describe, expect, it } from "bun:test";
import { handleChatCompletions } from "../src/openai-compatible";
import { fakeAi, nativeAnswer } from "./helpers/ai";

const post = (body: unknown) =>
  new Request("https://worker.example/ai/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("the OpenAI-compatible Workers AI handler", () => {
  it("streams text and forwards model and tools", async () => {
    const ai = fakeAi([{ frames: nativeAnswer(["Hello", " there"]) }]);
    const response = await handleChatCompletions(
      post({
        model: "workers-ai-test",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "search" } }],
        stream: true,
      }),
      ai.binding,
    );
    expect(response.status).toBe(200);
    expect(await response.text()).toContain("Hello");
    expect(ai.calls[0]).toMatchObject({
      model: "workers-ai-test",
      inputs: { tools: [{ function: { name: "search" } }] },
    });
  });

  it("adds CORS only when opted into", async () => {
    const closedAi = fakeAi([{ frames: nativeAnswer(["hi"]) }]);
    const closed = await handleChatCompletions(
      post({ messages: [{ role: "user", content: "hello" }], stream: true }),
      closedAi.binding,
    );
    expect(closed.headers.get("access-control-allow-origin")).toBeNull();

    const openAi = fakeAi([{ frames: nativeAnswer(["hi"]) }]);
    const open = await handleChatCompletions(
      post({ messages: [{ role: "user", content: "hello" }], stream: true }),
      openAi.binding,
      { cors: true },
    );
    expect(open.headers.get("access-control-allow-origin")).toBe("*");
    const preflight = await handleChatCompletions(
      new Request("https://worker.example/ai/chat/completions", {
        method: "OPTIONS",
      }),
      openAi.binding,
      { cors: true },
    );
    expect(preflight.status).toBe(204);
  });

  it("refuses malformed requests before spending the binding", async () => {
    const ai = fakeAi([]);
    const response = await handleChatCompletions(
      post({ messages: [] }),
      ai.binding,
    );
    expect(response.status).toBe(400);
    expect(ai.calls).toEqual([]);
  });
});
