import { describe, expect, test } from "bun:test";
import { executeVoiceToolV1, type VoiceToolHostV1 } from "./tools.js";

const AT = "2026-09-04T01:02:03.000Z";

function host(): VoiceToolHostV1 {
  return {
    async listBots() {
      return [{ botId: "one", name: "Research", status: "active" }];
    },
    async botActivity(botId, since) {
      return {
        botId,
        since: since ?? "all",
        runs: [],
        tasks: [],
        pendingInbox: 0,
      };
    },
    async memorySearch({ query, botId }) {
      return [
        {
          scope: botId ? "bot" : "user",
          botId,
          path: "memory.md",
          snippet: query,
          score: 1,
        },
      ];
    },
    async pendingAnswers() {
      return [];
    },
    async askBot(input) {
      return { status: "accepted", message: `Asked ${input.bot}` };
    },
  };
}

describe("Voice read-only tools", () => {
  test("executes the declared list tool", async () => {
    expect(
      await executeVoiceToolV1(host(), { name: "list_bots", args: {} }),
    ).toMatchObject({
      name: "list_bots",
      label: "Checked your Bots",
      result: { bots: [{ botId: "one" }] },
    });
  });

  test("validates arguments at the runtime seam", async () => {
    await expect(
      executeVoiceToolV1(host(), {
        name: "bot_activity",
        args: { bot: "one", since: "yesterday" },
      }),
    ).rejects.toThrow("ISO timestamp");
    await expect(
      executeVoiceToolV1(host(), {
        name: "pending_answers",
        args: { surprise: true },
      }),
    ).rejects.toThrow("arguments");
  });

  test("executes ask_bot through the same table", async () => {
    expect(
      await executeVoiceToolV1(host(), {
        name: "ask_bot",
        args: { bot: "one", question: "What changed?" },
        context: { sessionId: "voice-1", callId: "call-1", at: AT },
      }),
    ).toMatchObject({
      name: "ask_bot",
      label: "Asked one",
      result: { status: "accepted", message: "Asked one" },
    });
  });
});
