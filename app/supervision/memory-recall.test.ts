import { expect, test } from "bun:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import {
  judgeMemoryRecallV1,
  MEMORY_RECALL_JUDGED_MAX_V1,
  rankRecalledV1,
} from "./memory-recall.js";

function client(fetch: Fetch): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: "sk-test-do-not-leak-4f3a",
    defaultModel: "jev-1.13.0",
    retry: { maxRetries: 0 },
    logLevel: "off",
    fetch,
  });
}

function answering(scores: readonly number[], seen: unknown[] = []): Fetch {
  return async (_input, init) => {
    seen.push(JSON.parse(String(init?.body)));
    return Response.json({
      model: "jev-1.13.0",
      answers: Object.fromEntries(
        scores.map((noul, index) => [`m${index}`, { type: "noul", noul }]),
      ),
      usage: { input_tokens: 1, output_tokens: 0 },
    });
  };
}

const candidates = [
  { id: "a", text: "Tim's sister Mia is a vet." },
  { id: "b", text: "Tim prefers aisle seats." },
  { id: "c", text: "Mia's wedding is on 11 October." },
];

test("keeps what bears on the request, most relevant first", async () => {
  const seen: unknown[] = [];
  const scores = await judgeMemoryRecallV1(
    client(answering([0.7, 0.05, 0.95], seen)),
    { request: "Write a toast for Mia's wedding.", candidates },
  );
  expect(scores).toEqual([0.7, 0.05, 0.95]);
  expect(rankRecalledV1(candidates, scores).map((hit) => hit.id)).toEqual([
    "c",
    "a",
  ]);
  expect((seen[0] as { state: unknown }).state).toEqual({
    request: "Write a toast for Mia's wedding.",
    candidates: candidates.map((candidate) => candidate.text),
  });
});

test("leaves recall as it was when Jev cannot say", async () => {
  const failing = client(async () => new Response("no", { status: 503 }));
  const scores = await judgeMemoryRecallV1(failing, {
    request: "Anything",
    candidates,
  });
  expect(scores).toBeUndefined();
  expect(rankRecalledV1(candidates, scores)).toEqual(candidates);
});

test("judges a bounded window and keeps the rest in recall order after it", () => {
  const many = Array.from(
    { length: MEMORY_RECALL_JUDGED_MAX_V1 + 2 },
    (_, i) => ({
      id: `m${i}`,
    }),
  );
  const scores = many
    .slice(0, MEMORY_RECALL_JUDGED_MAX_V1)
    .map((_, i) => (i === 3 ? 0.9 : 0.5));
  const ranked = rankRecalledV1(many, scores).map((hit) => hit.id);
  expect(ranked[0]).toBe("m3");
  expect(ranked.slice(-2)).toEqual([
    `m${MEMORY_RECALL_JUDGED_MAX_V1}`,
    `m${MEMORY_RECALL_JUDGED_MAX_V1 + 1}`,
  ]);
});
