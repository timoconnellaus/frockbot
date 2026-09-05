import { describe, expect, it } from "bun:test";
import { createWorkersAiModel, defaultWorkersAiModel } from "../src/workers-ai";
import { chatAnswer, fakeAi, frame, nativeAnswer } from "./helpers/ai";
import type { ModelChunk, ModelRequest } from "../src/workers-ai";

const request: ModelRequest = {
  turn: 1,
  step: 1,
  system: "Answer briefly.",
  messages: [{ role: "user", content: "find cats" }],
  tools: [
    {
      name: "search",
      description: "Search the index",
      parameters: { type: "object" },
    },
  ],
  options: {},
};

const collect = async (
  model: ReturnType<typeof createWorkersAiModel>,
): Promise<Array<ModelChunk>> => {
  const chunks: Array<ModelChunk> = [];
  for await (const chunk of model.stream(
    request,
    new AbortController().signal,
  )) {
    chunks.push(chunk);
  }
  return chunks;
};

describe("the Workers AI model provider", () => {
  it("streams native and OpenAI-shaped answer text", async () => {
    const native = fakeAi([{ frames: nativeAnswer(["Hello", " there"]) }]);
    expect(
      await collect(createWorkersAiModel({ binding: native.binding })),
    ).toEqual([
      { kind: "text", text: "Hello" },
      { kind: "text", text: " there" },
    ]);
    expect(native.calls[0]).toMatchObject({ model: defaultWorkersAiModel });

    const chat = fakeAi([{ frames: chatAnswer(["Same", " answer"]) }]);
    expect(
      await collect(createWorkersAiModel({ binding: chat.binding })),
    ).toEqual([
      { kind: "text", text: "Same" },
      { kind: "text", text: " answer" },
    ]);
  });

  it("assembles a function call whose arguments arrive in pieces", async () => {
    const ai = fakeAi([
      {
        frames: [
          frame({ choices: [{ delta: { content: "Looking" } }] }),
          frame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    {
                      index: 0,
                      id: "call_abc",
                      function: { name: "search", arguments: '{"query":' },
                    },
                  ],
                },
              },
            ],
          }),
          frame({
            choices: [
              {
                delta: {
                  tool_calls: [
                    { index: 0, function: { arguments: '"cats"}' } },
                  ],
                },
              },
            ],
          }),
          frame("[DONE]"),
        ],
      },
    ]);
    expect(
      await collect(createWorkersAiModel({ binding: ai.binding })),
    ).toEqual([
      { kind: "text", text: "Looking" },
      {
        kind: "tool-call",
        call: { id: "call_abc", name: "search", args: { query: "cats" } },
      },
    ]);
  });

  it("gives up on a model that goes quiet for longer than stallMs", async () => {
    const ai = fakeAi([
      { frames: [frame({ response: "thinking" })], hold: true },
    ]);
    await expect(
      collect(createWorkersAiModel({ binding: ai.binding, stallMs: 50 })),
    ).rejects.toThrow("the model sent nothing for 50 ms");
    expect(ai.cancelled()).toBe(1);
  });

  it("forwards prompt, tools and provider settings", async () => {
    const ai = fakeAi([{ frames: nativeAnswer(["done"]) }]);
    await collect(
      createWorkersAiModel({
        binding: ai.binding,
        options: { temperature: 0.25 },
      }),
    );
    expect(ai.calls[0]?.inputs).toMatchObject({
      messages: [
        { role: "system", content: "Answer briefly." },
        { role: "user", content: "find cats" },
      ],
      temperature: 0.25,
      tools: [{ function: { name: "search" } }],
    });
  });

  it("reports binding and streamed model failures", async () => {
    expect(() =>
      createWorkersAiModel({ binding: { run: "not a function" } as never }),
    ).toThrow(/binding with run\(\) is required/);
    const ai = fakeAi([
      { frames: [frame({ error: { message: "model overloaded" } })] },
    ]);
    await expect(
      collect(createWorkersAiModel({ binding: ai.binding })),
    ).rejects.toThrow(/model overloaded/);
  });
});
