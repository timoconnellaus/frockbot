import { describe, expect, test } from "bun:test";
import { projectCompletedRuns } from "./index.js";
import { shellClientPlugin } from "./index.js";
import type { FrockBotWebData } from "../shared.js";
import type { Ref } from "vue";

describe("detached Turn projection", () => {
  test("projects a completed run before it can be acknowledged", () => {
    const messages: Parameters<typeof projectCompletedRuns>[0] = [];
    const projected = projectCompletedRuns(
      messages,
      [
        {
          notificationId: "notification-run-1",
          runId: "run-1",
          createdAt: "2026-08-28T00:00:00.000Z",
          title: "Bot replied",
          body: "Done.",
        },
      ],
      [
        {
          runId: "run-1",
          input: "Finish the task",
          events: [],
          status: "completed",
          responseText: "Finished exactly.",
        },
      ],
    );

    expect(projected.has("notification-run-1")).toBe(true);
    expect(messages).toMatchObject([
      { role: "user", text: "Finish the task" },
      { role: "assistant", text: "Finished exactly." },
    ]);
  });
});

describe("Connection operation reconciliation", () => {
  test("reuses the command ID after a lost Connect Link response", async () => {
    const commandIds: string[] = [];
    let attempts = 0;
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        startConnection: (input) => {
          commandIds.push(input.commandId);
          attempts += 1;
          if (attempts === 1) return Promise.reject(new Error("response lost"));
          return Promise.resolve({
            connectionId: input.commandId,
            redirectUrl: "https://connect.example/authorize",
            expiresAt: "2026-08-28T01:00:00.000Z",
          });
        },
      },
      slot: () => () => {},
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");

    await expect(provided.value.startConnection("composio", "gmail")).rejects.toThrow(
      "response lost",
    );
    await provided.value.startConnection("composio", "gmail");

    expect(commandIds).toHaveLength(2);
    expect(commandIds[1]).toBe(commandIds[0]);
  });
});
