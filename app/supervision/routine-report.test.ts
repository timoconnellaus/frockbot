import { expect, test } from "bun:test";
import { TypeSafeClient, type Fetch } from "@typesafe-ai/sdk";
import {
  createJevRoutineReportJudgeV1,
  routineReportVerdictV1,
} from "./routine-report.js";

function client(fetch: Fetch): TypeSafeClient {
  return new TypeSafeClient({
    apiKey: "sk-test-do-not-leak-4f3a",
    defaultModel: "jev-1.13.0",
    retry: { maxRetries: 0 },
    logLevel: "off",
    fetch,
  });
}

test("a report is dismissed only when Jev is sure nobody wants it, and quiet while it can wait", () => {
  expect(
    routineReportVerdictV1({
      worthTelling: { noul: 0.1 },
      urgency: { score: 0 },
    }),
  ).toMatchObject({ tell: false });
  expect(
    routineReportVerdictV1({
      worthTelling: { noul: 0.5 },
      urgency: { score: 0.3 },
    }),
  ).toMatchObject({ tell: true, quiet: true });
  expect(
    routineReportVerdictV1({
      worthTelling: { noul: 0.9 },
      urgency: { score: 2.6 },
    }),
  ).toMatchObject({ tell: true, quiet: false });
});

test("a judge that cannot answer says nothing, so the report is delivered as before", async () => {
  const judge = createJevRoutineReportJudgeV1(
    client(async () => new Response("no", { status: 503 })),
  );
  expect(
    await judge({ routine: "Inbox check", report: "Two new invoices." }),
  ).toBeUndefined();
});
