import { expect, test } from "bun:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import type { GroupReplyEvidenceV1 } from "@frockbot/core/contracts";
import {
  gradeGroupReplyV1,
  groupReplyDecisionOfV1,
  groupReplyQuestionsV1,
  groupReplyStateV1,
  reviewGroupReplyV1,
  GROUP_REPLY_MODEL_V1,
  type GroupReplyAnswersV1,
} from "./group-reply.js";
import { groupReplyFixturesV1 } from "./group-reply.fixtures.js";

const evidence: GroupReplyEvidenceV1 = {
  groupName: "Ops",
  members: [
    { botId: "general", name: "General" },
    { botId: "books", name: "Xero Books", description: "Bookkeeping." },
    { botId: "codex", name: "Codex" },
  ],
  recent: [{ speaker: "User", text: "Morning." }],
  message: { speaker: "User", text: "Is Acme paid?", mentions: [] },
  botAuthored: false,
  candidates: ["general", "books", "codex"],
};

function noul(value: number) {
  return { type: "noul" as const, noul: value };
}

function answer(choice: string) {
  return {
    type: "choice" as const,
    choice,
    confidence: 0.9,
    probabilities: { [choice]: 0.9 },
  };
}

test("the state names members, not their ids", () => {
  expect(
    groupReplyStateV1({
      ...evidence,
      message: { ...evidence.message, mentions: ["books"] },
    }),
  ).toEqual({
    group: "Ops",
    members: [
      { name: "General" },
      { name: "Xero Books", description: "Bookkeeping." },
      { name: "Codex" },
    ],
    thread: [{ speaker: "User", text: "Morning." }],
    message: {
      speaker: "User",
      text: "Is Acme paid?",
      mentions: ["Xero Books"],
    },
  });
});

test("one question per candidate, and the flow only for a member's mentions", () => {
  expect(Object.keys(groupReplyQuestionsV1(evidence)).sort()).toEqual([
    "answer",
    "member_0",
    "member_1",
    "member_2",
  ]);
  expect(
    Object.keys(
      groupReplyQuestionsV1({
        ...evidence,
        botAuthored: true,
        message: { speaker: "General", text: "@Codex go", mentions: ["codex"] },
        candidates: ["books"],
      }),
    ).sort(),
  ).toEqual(["answer", "flow", "member_0"]);
});

test("members over the bar are asked, most likely first", () => {
  const answers: GroupReplyAnswersV1 = {
    answer: answer("needed"),
    member_0: noul(0.6),
    member_1: noul(0.9),
    member_2: noul(0.1),
  };
  expect(groupReplyDecisionOfV1(evidence, answers)).toEqual({
    reply: ["books", "general"],
  });
});

test("a message that needs someone is never left hanging", () => {
  const answers: GroupReplyAnswersV1 = {
    answer: answer("needed"),
    member_0: noul(0.2),
    member_1: noul(0.45),
    member_2: noul(0.1),
  };
  expect(groupReplyDecisionOfV1(evidence, answers).reply).toEqual(["books"]);
  expect(
    groupReplyDecisionOfV1(evidence, {
      ...answers,
      answer: answer("not_needed"),
    }).reply,
  ).toEqual([]);
});

test("grading compares the asked set and the flow", () => {
  expect(
    gradeGroupReplyV1({ reply: ["b", "a"] }, { reply: ["a", "b"] }).passed,
  ).toBe(true);
  expect(
    gradeGroupReplyV1(
      { reply: [], mentions: "loops" },
      { reply: [], mentions: "continues" },
    ).passed,
  ).toBe(false);
});

test("every fixture's expected members are candidates", () => {
  for (const fixture of groupReplyFixturesV1) {
    for (const botId of fixture.expected.reply) {
      expect(fixture.evidence.candidates, fixture.name).toContain(botId);
    }
  }
});

test("reviewGroupReplyV1 reads a bounded Jev answer", async () => {
  const fetch: Fetch = async () =>
    new Response(
      JSON.stringify({
        model: GROUP_REPLY_MODEL_V1,
        usage: { input_tokens: 1, output_tokens: 1 },
        answers: {
          answer: answer("needed"),
          member_0: noul(0.1),
          member_1: noul(0.95),
          member_2: noul(0.1),
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  const client = new TypeSafeClient({
    apiKey: "sk-test-group-reply",
    defaultModel: GROUP_REPLY_MODEL_V1,
    fetch,
  });
  const review = await reviewGroupReplyV1(client, evidence);
  expect(groupReplyDecisionOfV1(evidence, review.answers)).toEqual({
    reply: ["books"],
  });
});
