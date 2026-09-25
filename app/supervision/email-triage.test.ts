import { expect, test } from "bun:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import { createJevEmailTriageJudgeV1 } from "./email-triage.js";

function judge(fyi: number | "down") {
  const fetch: Fetch = async () =>
    fyi === "down"
      ? Response.json({ error: { message: "down" } }, { status: 503 })
      : Response.json({
          model: "jev-1.13.0",
          answers: {
            kind: {
              type: "choice",
              choice: fyi >= 0.5 ? "fyi" : "asks",
              probabilities: { asks: 1 - fyi, fyi },
              confidence: 0.9,
            },
          },
          usage: { input_tokens: 1, output_tokens: 0 },
        });
  return createJevEmailTriageJudgeV1(
    new TypeSafeClient({
      apiKey: "k",
      logLevel: "off",
      retry: { maxRetries: 0 },
      fetch,
    }),
  );
}

test("only a message Jev is sure passes something on is quiet", async () => {
  const email = { text: "Subject: Fwd: receipt" };
  expect(await judge(0.9)(email)).toEqual({ quiet: true, fyi: 0.9 });
  expect(await judge(0.7)(email)).toEqual({ quiet: false, fyi: 0.7 });
  expect(await judge(0.1)(email)).toEqual({ quiet: false, fyi: 0.1 });
});

test("a judgment that fails leaves the Turn loud", async () => {
  expect(await judge("down")({ text: "Subject: hi" })).toBeUndefined();
});
