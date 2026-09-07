import { describe, expect, test } from "bun:test";
import {
  type LlmProvider,
  LoopHookListV1,
  type NormalizedModelRequest,
} from "@frockbot/core/contracts";
import { LlmRegistry } from "./llm.js";

const schema = {
  type: "object" as const,
  properties: { answer: { type: "string" as const } },
  required: ["answer"],
  additionalProperties: false,
};

function request(): NormalizedModelRequest {
  return {
    requestId: "request-1",
    provider: "fake-structured",
    model: "fake-model",
    system: "Answer briefly.",
    messages: [{ role: "user", content: "Is this typed?" }],
    tools: [],
  };
}

function fakeProvider(content: string): LlmProvider {
  return {
    id: "fake-structured",
    supports: { structuredOutput: "json_schema" },
    async *stream(modelRequest) {
      expect(modelRequest.responseFormat).toEqual({
        type: "json_schema",
        name: "answer",
        schema,
      });
      yield { type: "text-delta", text: content };
      yield { type: "finish", reason: "completed" };
    },
  };
}

function mounted(content: string): LlmRegistry {
  const llm = new LlmRegistry(new LoopHookListV1());
  llm.register(fakeProvider(content));
  return llm;
}

describe("structured output through a fake provider", () => {
  test("round-trips a validated typed value", async () => {
    const llm = mounted('{"answer":"yes"}');
    const result = await llm.structured<{ answer: string }>(
      request(),
      { name: "answer", schema },
      new AbortController().signal,
    );
    expect(result).toEqual({
      status: "completed",
      value: { answer: "yes" },
      raw: '{"answer":"yes"}',
    });
  });

  test("emits and returns a typed validation failure", async () => {
    const llm = mounted('{"answer":4}');
    const events = [];
    for await (const event of llm.stream(
      {
        ...request(),
        responseFormat: { type: "json_schema", name: "answer", schema },
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events.at(-2)).toEqual({
      type: "structured-output-failure",
      failure: {
        code: "schema-mismatch",
        message: "The model response did not match the requested schema",
        issues: [
          {
            path: "$.answer",
            code: "type",
            message: "$.answer must be a string",
          },
        ],
      },
    });

    const result = await llm.structured<{ answer: string }>(
      { ...request(), requestId: "request-2" },
      { name: "answer", schema },
      new AbortController().signal,
    );
    expect(result.status).toBe("failed");
    if (result.status === "failed") {
      expect(result.failure.code).toBe("schema-mismatch");
    }
  });

  test("emits a typed invalid-JSON failure for schema-free JSON mode", async () => {
    const llm = new LlmRegistry(new LoopHookListV1());
    llm.register({
      id: "fake-json",
      supports: { structuredOutput: "json" },
      async *stream(modelRequest) {
        expect(modelRequest.responseFormat).toEqual({ type: "json" });
        yield { type: "text-delta", text: "not json" };
        yield { type: "finish", reason: "completed" };
      },
    });
    const events = [];
    for await (const event of llm.stream(
      {
        ...request(),
        provider: "fake-json",
        responseFormat: { type: "json" },
      },
      new AbortController().signal,
    )) {
      events.push(event);
    }
    expect(events.at(-2)).toMatchObject({
      type: "structured-output-failure",
      failure: { code: "invalid-json" },
    });
  });
});
