import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { voiceCostMicrosV1 } from "./pricing.js";
import type { UsageSqlV1 } from "./store.js";
import { BillingUserBackendContribution } from "./user.js";

function sqlV1(database: Database): UsageSqlV1 {
  return {
    exec(query, ...bindings) {
      const statement = database.query(query);
      if (/^\s*(SELECT|WITH|PRAGMA)/i.test(query)) {
        return { toArray: () => statement.all(...bindings) as never[] };
      }
      statement.run(...bindings);
      return { toArray: () => [] };
    },
  };
}

describe("BillingUserBackendContribution", () => {
  test("cumulative voice receipts settle to one report-frequency-invariant total", () => {
    const database = new Database(":memory:");
    const billing = new BillingUserBackendContribution({
      sql: sqlV1(database),
      now: () => Date.parse("2026-09-04T12:00:00.000Z"),
    });

    for (const sessionSeconds of [1, 2, 3]) {
      expect(
        billing.recordVoice({
          day: "2026-09-04",
          sessionId: "voice-one",
          sessionSeconds,
          recordedSeconds: 1,
          at: `2026-09-04T12:00:0${sessionSeconds}.000Z`,
        }),
      ).toEqual({ recorded: 1 });
    }

    expect(billing.report()).toMatchObject({
      currentMonthCostMicros: voiceCostMicrosV1(3),
      lifetimeCostMicros: voiceCostMicrosV1(3),
      currentMonthVoiceSeconds: 3,
    });
    database.close();
  });

  test("records Gemini Live duration without inventing a duration price", () => {
    const database = new Database(":memory:");
    const billing = new BillingUserBackendContribution({
      sql: sqlV1(database),
      now: () => Date.parse("2026-09-04T12:00:00.000Z"),
    });

    expect(
      billing.recordVoice({
        day: "2026-09-04",
        sessionId: "assistant-one",
        sessionSeconds: 30,
        recordedSeconds: 30,
        at: "2026-09-04T12:00:30.000Z",
        provider: "google-ai-studio",
        model: "gemini-3.1-flash-live-preview",
        pricing: "unpriced",
      }),
    ).toEqual({ recorded: 1 });

    expect(billing.report()).toMatchObject({
      currentMonthCostMicros: 0,
      lifetimeCostMicros: 0,
      currentMonthVoiceSeconds: 30,
      unknownPriceCalls: 1,
      models: [
        {
          id: "google-ai-studio/gemini-3.1-flash-live-preview",
          voiceSeconds: 30,
          costMicros: 0,
          unknownPriceCalls: 1,
        },
      ],
    });
    database.close();
  });
});
