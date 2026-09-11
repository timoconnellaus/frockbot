import { describe, expect, test } from "bun:test";
import type {
  AssistantMessage,
  AssistantMessageEvent,
} from "@earendil-works/pi-ai";
import {
  decodeIsolateModelEventV1,
  decodeNormalizedModelRequestV1,
  decodeSessionEvent,
  requireModelReplayStateV1,
  type LlmStreamEvent,
  type NormalizedModelRequest,
} from "@frockbot/core/contracts";
import { catalogContextV1, decodeCatalogStreamV1 } from "./runtime.js";
import { providerModelsV1 } from "./models.js";
import { bedrockStreamV1 } from "./bedrock.js";
import { catalogProviderDefinitionsV1 } from "./definition.js";

const request: NormalizedModelRequest = {
  requestId: "request-1",
  provider: "google",
  model: "gemini-2.5-pro",
  system: "Be helpful",
  messages: [{ role: "user", content: "Hello" }],
  tools: [
    {
      name: "lookup",
      description: "Look up a value",
      inputSchema: { type: "object", properties: {} },
    },
  ],
};
const response: AssistantMessage = {
  role: "assistant",
  api: "google-generative-ai",
  provider: request.provider,
  model: request.model,
  timestamp: 0,
  stopReason: "toolUse",
  usage: {
    input: 10,
    output: 6,
    cacheRead: 4,
    cacheWrite: 2,
    reasoning: 3,
    totalTokens: 22,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  },
  content: [
    {
      type: "thinking",
      thinking: "private provider reasoning",
      thinkingSignature: "c2ln",
    },
    {
      type: "toolCall",
      id: "call-1",
      name: "lookup",
      arguments: {},
      thoughtSignature: "c2ln",
    },
  ],
};
async function* events(...items: AssistantMessageEvent[]) {
  yield* items;
}
async function collect(stream: AsyncIterable<LlmStreamEvent>) {
  const result: LlmStreamEvent[] = [];
  for await (const event of stream) result.push(event);
  return result;
}

describe("catalog provider bridge", () => {
  test("ships every provider from the pinned Harness catalog with unique connection identities", () => {
    expect(catalogProviderDefinitionsV1).toHaveLength(40);
    expect(
      new Set(catalogProviderDefinitionsV1.map((definition) => definition.id))
        .size,
    ).toBe(40);
    expect(
      catalogProviderDefinitionsV1.filter(
        (definition) =>
          definition.connectionTypes?.[0]?.authorization?.kind === "api-key",
      ),
    ).toHaveLength(39);
    expect(
      catalogProviderDefinitionsV1
        .filter(
          (definition) =>
            definition.connectionTypes?.[0]?.authorization?.kind === "grant",
        )
        .map((definition) => definition.id),
    ).toEqual(["provider-openai-codex"]);
  });

  test("holds tool calls until completion and counts cached input in the total", async () => {
    const result = await collect(
      decodeCatalogStreamV1(
        events(
          {
            type: "toolcall_end",
            contentIndex: 1,
            toolCall: response.content[1] as Extract<
              AssistantMessage["content"][number],
              { type: "toolCall" }
            >,
            partial: response,
          },
          { type: "done", reason: "toolUse", message: response },
        ),
        request,
      ),
    );
    expect(result.map((event) => event.type)).toEqual([
      "provider-state",
      "usage",
      "tool-call",
      "finish",
    ]);
    expect(result[1]).toEqual({
      type: "usage",
      usage: {
        inputTokens: 16,
        outputTokens: 6,
        cachedInputTokens: 4,
        reasoningTokens: 3,
      },
    });
  });

  test("preserves signed reasoning and calls through durable and isolate decoding", async () => {
    const result = await collect(
      decodeCatalogStreamV1(
        events({ type: "done", reason: "toolUse", message: response }),
        request,
      ),
    );
    const event = decodeIsolateModelEventV1(
      JSON.parse(JSON.stringify(result[0])),
    );
    if (event.type !== "provider-state")
      throw new Error("Missing replay state");
    const stored = decodeSessionEvent({
      type: "assistant/message",
      seq: 1,
      timestamp: "2026-09-09T00:00:00.000Z",
      turn: 1,
      step: 1,
      requestId: request.requestId,
      text: "",
      toolCalls: [{ id: "call-1", name: "lookup", input: {} }],
      providerState: event.state,
    });
    if (stored.type !== "assistant/message") throw new Error("Missing message");
    const replay = decodeNormalizedModelRequestV1({
      ...request,
      messages: [
        {
          role: "assistant",
          content: stored.text,
          toolCalls: stored.toolCalls,
          providerState: stored.providerState,
        },
      ],
    });
    const model = providerModelsV1("google").find(
      (model) => model.id === request.model,
    )!;
    expect(catalogContextV1(replay, model).messages[0]?.content).toEqual(
      response.content,
    );
    expect(
      catalogContextV1({ ...replay, provider: "other" }, model).messages[0]
        ?.content,
    ).toEqual([
      { type: "toolCall", id: "call-1", name: "lookup", arguments: {} },
    ]);
  });

  test("rejects truncated streams and never releases their speculative tools", async () => {
    const emitted: LlmStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of decodeCatalogStreamV1(
          events({
            type: "toolcall_end",
            contentIndex: 1,
            toolCall: response.content[1] as Extract<
              AssistantMessage["content"][number],
              { type: "toolCall" }
            >,
            partial: response,
          }),
          request,
        ))
          emitted.push(event);
      })(),
    ).rejects.toThrow("without a terminal response");
    expect(emitted).toEqual([]);
  });

  test("bounds provider replay data before it enters the durable log", () => {
    expect(() =>
      decodeIsolateModelEventV1({
        type: "provider-state",
        state: {
          provider: "google",
          model: "model",
          content: '"' + "x".repeat(524_288) + '"',
        },
      }),
    ).toThrow("exceeds its limit");
  });

  test("Bedrock uses bearer auth, retains signed response blocks, and sends the effect key", async () => {
    let outbound: Request | undefined;
    const blocks = [
      {
        reasoningContent: {
          reasoningText: { text: "reasoning", signature: "signed" },
        },
      },
      { toolUse: { toolUseId: "lookup-1", name: "lookup", input: {} } },
    ];
    const input = {
      ...request,
      provider: "amazon-bedrock",
      model: "anthropic.claude-test",
    };
    const result = await collect(
      bedrockStreamV1(input, {
        apiKey: "bedrock-secret",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        maxTokens: 100,
        signal: new AbortController().signal,
        fetch: (async (url, init) => {
          outbound = new Request(url, init);
          return Response.json({
            output: { message: { content: blocks } },
            stopReason: "tool_use",
            usage: { inputTokens: 10, outputTokens: 5 },
          });
        }) as typeof fetch,
      }),
    );
    expect(outbound?.headers.get("authorization")).toBe(
      "Bearer bedrock-secret",
    );
    expect(outbound?.headers.get("idempotency-key")).toBe("request-1");
    expect(result[0]).toEqual({
      type: "provider-state",
      state: {
        provider: input.provider,
        model: input.model,
        content: JSON.stringify(blocks),
      },
    });
    expect(result.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
  });
  test("never forwards opaque replay state to another connection or rotated key", async () => {
    const bound = {
      ...request,
      modelBinding: {
        connectionId: "original",
        connectionGeneration: "generation-1",
      },
    };
    const result = await collect(
      decodeCatalogStreamV1(
        events({ type: "done", reason: "toolUse", message: response }),
        bound,
      ),
    );
    const stateEvent = result[0];
    if (stateEvent?.type !== "provider-state") throw new Error("Missing state");
    const replay: NormalizedModelRequest = {
      ...bound,
      messages: [
        {
          role: "assistant",
          content: "",
          toolCalls: [{ id: "call-1", name: "lookup", input: {} }],
          providerState: stateEvent.state,
        },
      ],
    };
    const model = providerModelsV1("google").find(
      (candidate) => candidate.id === request.model,
    )!;
    expect(catalogContextV1(replay, model).messages[0]?.content).toEqual(
      response.content,
    );
    for (const binding of [
      { connectionId: "other", connectionGeneration: "generation-1" },
      { connectionId: "original", connectionGeneration: "generation-2" },
    ]) {
      expect(
        catalogContextV1({ ...replay, modelBinding: binding }, model)
          .messages[0]?.content,
      ).toEqual([
        { type: "toolCall", id: "call-1", name: "lookup", arguments: {} },
      ]);
    }
  });
  test("carries only the Connection's own fields into the replay state", async () => {
    // The account's catalog revision rides on the binding snapshot and the
    // session event decoder refuses it: a replay state that spread the whole
    // snapshot failed every Turn with "model replay state has invalid fields".
    const result = await collect(
      decodeCatalogStreamV1(
        events({ type: "done", reason: "toolUse", message: response }),
        {
          ...request,
          modelBinding: {
            connectionId: "connection-1",
            connectionGeneration: "generation-1",
            catalogGeneration: "catalog-7",
          },
        },
      ),
    );
    const stateEvent = result[0];
    if (stateEvent?.type !== "provider-state") throw new Error("Missing state");
    expect(() => requireModelReplayStateV1(stateEvent.state)).not.toThrow();
    expect(Object.keys(stateEvent.state).sort()).toEqual([
      "connectionGeneration",
      "connectionId",
      "content",
      "model",
      "provider",
    ]);
  });
});
