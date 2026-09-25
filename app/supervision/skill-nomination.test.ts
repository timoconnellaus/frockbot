import { expect, test } from "bun:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import {
  nominateSkillsV1,
  SKILL_NOMINATION_JUDGED_MAX_V1,
} from "./skill-nomination.js";

function client(fetch: Fetch): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: "sk-test-do-not-leak-4f3a",
    defaultModel: "jev-1.13.0",
    retry: { maxRetries: 0 },
    logLevel: "off",
    fetch,
  });
}

const answering =
  (scores: readonly number[]): Fetch =>
  async () =>
    Response.json({
      model: "jev-1.13.0",
      answers: Object.fromEntries(
        scores.map((noul, index) => [`s${index}`, { type: "noul", noul }]),
      ),
      usage: { input_tokens: 1, output_tokens: 0 },
    });

const skills = [
  {
    load: "bot/toasts",
    name: "Wedding toasts",
    description: "How I write toasts.",
  },
  { load: "bot/invoices", name: "Invoices", description: "Chasing invoices." },
  { load: "bot/emails", name: "Emails", description: "My email voice." },
];

test("names only strong matches, strongest first", async () => {
  const named = await nominateSkillsV1(client(answering([0.8, 0.1, 0.95])), {
    request: "Write the toast and email it to Mia.",
    skills,
  });
  expect(named.map((skill) => skill.load)).toEqual([
    "bot/emails",
    "bot/toasts",
  ]);
});

test("names nothing when Jev cannot say, the catalog is too big, or nothing was asked", async () => {
  const failing = client(async () => new Response("no", { status: 503 }));
  expect(
    await nominateSkillsV1(failing, { request: "Anything", skills }),
  ).toEqual([]);
  const many = Array.from(
    { length: SKILL_NOMINATION_JUDGED_MAX_V1 + 1 },
    (_, i) => ({
      load: `bot/s${i}`,
      name: `S${i}`,
      description: "d",
    }),
  );
  expect(
    await nominateSkillsV1(client(answering([1])), {
      request: "x",
      skills: many,
    }),
  ).toEqual([]);
  expect(
    await nominateSkillsV1(client(answering([1, 1, 1])), {
      request: " ",
      skills,
    }),
  ).toEqual([]);
});
