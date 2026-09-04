import { describe, expect, test } from "bun:test";
import { executeVoiceToolV1, type VoiceToolHostV1 } from "./tools.js";

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

  test("ask_bot stays outside the B1 tool table", async () => {
    await expect(
      executeVoiceToolV1(host(), { name: "ask_bot", args: {} }),
    ).rejects.toThrow("unavailable");
  });
});
