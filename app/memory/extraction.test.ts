import { expect, test } from "bun:test";
import type { UsageReservation, UsageSettlement } from "../billing/ledger.js";
import type { AccountUsage } from "../billing/model.js";
import type { HostedModelRatesV1 } from "../billing/rates.js";
import {
  MEMORY_EXTRACTION_MAX_FACTS_V1,
  memoryExtractionRequestV1,
  parseMemoryExtractionV1,
} from "./extraction.js";
import { createHostedMemoryExtractorV1 } from "./extraction-host.js";
import { MemoryExtractionNotSentError } from "./processing.js";
import type { MemoryExtractionDispatchV1 } from "./processing.js";

const dispatch: MemoryExtractionDispatchV1 = {
  obligationId: "job-1",
  capturedText: "I moved to Thirroul last month. Book me a table for Friday.",
  principal: {
    userId: "user-1",
    botId: "bot-1",
    actor: "bot",
    sessionId: "user-1:bot-1",
    runId: "run-9",
  } as MemoryExtractionDispatchV1["principal"],
  scope: {
    kind: "bot",
    id: "bot-1",
  } as unknown as MemoryExtractionDispatchV1["scope"],
};

test("the request names its prompt version, asks for the schema and runs on the summary model", () => {
  const request = memoryExtractionRequestV1({
    dispatch,
    provider: "flock-ai",
    model: "@frock/structured",
  });
  expect(request.requestId).toBe("memory-extract-extract-1-job-1");
  expect(request.responseFormat).toMatchObject({
    type: "json_schema",
    name: "memories",
  });
  expect(request.messages[0]?.content).toContain("I moved to Thirroul");
  expect(request.tools).toEqual([]);
});

test("reads the memories, once each, and leaves out what is malformed", () => {
  expect(
    parseMemoryExtractionV1(
      JSON.stringify({
        memories: [
          { text: "Tim moved to Thirroul in August.", kind: "experience" },
          { text: "tim moved to thirroul in august.", kind: "experience" },
          { text: "  ", kind: "fact" },
          { text: 42, kind: "fact" },
          { text: "x".repeat(400), kind: "fact" },
          { text: "Tim prefers aisle seats.", kind: "opinion" },
        ],
      }),
    ),
  ).toEqual([
    { text: "Tim moved to Thirroul in August.", kind: "experience" },
  ]);
  const many = {
    memories: Array.from({ length: 20 }, (_, index) => ({
      text: `Fact ${index}.`,
      kind: "fact",
    })),
  };
  expect(parseMemoryExtractionV1(JSON.stringify(many))).toHaveLength(
    MEMORY_EXTRACTION_MAX_FACTS_V1,
  );
  expect(parseMemoryExtractionV1('Sure! {"memories":[]}')).toEqual([]);
  expect(() => parseMemoryExtractionV1("I found nothing.")).toThrow();
});

test("without Frock AI there is no extractor, and jobs wait as before", () => {
  expect(createHostedMemoryExtractorV1({})).toBeUndefined();
});

test("the hosted extractor asks the summary model once, billed to the Turn as a summary", async () => {
  const reservations: UsageReservation[] = [];
  const settlements: UsageSettlement[] = [];
  const account: AccountUsage = {
    async reserve(value) {
      reservations.push(value);
      return { status: "reserved", created: true };
    },
    async settle(value) {
      settlements.push(value);
    },
  };
  const rate = {
    inputMicrosPerToken: 1,
    cachedInputMicrosPerToken: 0.5,
    outputMicrosPerToken: 2,
    maximumInputTokens: 4_000,
    maximumOutputTokens: 800,
  };
  const rates: HostedModelRatesV1 = {
    schemaVersion: 1,
    version: 3,
    createdAt: "2026-09-27T00:00:00.000Z",
    createdBy: "owner@example.com",
    routes: { "@frock/structured": rate },
    served: {},
  } as HostedModelRatesV1;
  const sent: unknown[] = [];
  const answer = JSON.stringify({
    memories: [{ text: "Tim moved to Thirroul.", kind: "experience" }],
  });
  const extract = createHostedMemoryExtractorV1({
    gateway: {
      autoRoute: "flock-auto",
      runChatCompletion: async (body) => {
        sent.push(body);
        return new Response(
          `data: ${JSON.stringify({ choices: [{ delta: { content: answer }, finish_reason: "stop" }] })}\n\n` +
            'data: {"choices":[],"usage":{"input_tokens":120,"output_tokens":20}}\n\n' +
            "data: [DONE]\n\n",
        ).body!;
      },
    },
    billing: (userId, botId, sessionId, spend) => ({
      account,
      rates: async () => rates,
      botId,
      sessionId,
      ...(spend ? { spend } : {}),
    }),
  })!;
  expect(await extract(dispatch)).toEqual([
    { text: "Tim moved to Thirroul.", kind: "experience" },
  ]);
  expect(sent).toHaveLength(1);
  expect(reservations).toMatchObject([
    {
      id: "model:memory-extract-extract-1-job-1",
      kind: "model",
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      attribution: {
        runId: "run-9",
        summary: true,
        model: "@frock/structured",
      },
    },
  ]);
  expect(settlements).toHaveLength(1);
});

test("a hosted extraction refused before it is sent says so, and nothing reaches the model", async () => {
  const sent: unknown[] = [];
  const extract = createHostedMemoryExtractorV1({
    gateway: {
      autoRoute: "flock-auto",
      runChatCompletion: async (body) => {
        sent.push(body);
        throw new Error("must not be sent");
      },
    },
    billing: (_userId, botId, sessionId) => ({
      account: {
        async reserve() {
          throw new Error("This account is out of credit.");
        },
        async settle() {},
      },
      rates: async () =>
        ({
          schemaVersion: 1,
          version: 3,
          createdAt: "2026-09-27T00:00:00.000Z",
          createdBy: "owner@example.com",
          routes: {
            "@frock/structured": {
              inputMicrosPerToken: 1,
              cachedInputMicrosPerToken: 0.5,
              outputMicrosPerToken: 2,
              maximumInputTokens: 4_000,
              maximumOutputTokens: 800,
            },
          },
          served: {},
        }) as HostedModelRatesV1,
      botId,
      sessionId,
    }),
  })!;
  await expect(extract(dispatch)).rejects.toBeInstanceOf(
    MemoryExtractionNotSentError,
  );
  expect(sent).toHaveLength(0);
});

test("a hosted extraction that fails once sent is not reported as unsent", async () => {
  const extract = createHostedMemoryExtractorV1({
    gateway: {
      autoRoute: "flock-auto",
      runChatCompletion: async () => {
        throw new Error("the connection dropped");
      },
    },
  })!;
  const error = await extract(dispatch).catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(Error);
  expect(error).not.toBeInstanceOf(MemoryExtractionNotSentError);
});
