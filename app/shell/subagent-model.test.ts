import { expect, test } from "bun:test";
import {
  decodeSubagentRunTaskRequestV1,
  subagentTaskContextV1,
} from "@frockbot/app/subagents/durable-binding";
import { taskContextKeyV1 } from "@frockbot/app/subagents/storage-keys";
import {
  pinnedSubagentModelV1,
  subagentEffectiveModelV1,
} from "./runtime-mount.js";
import type { ShellBotStateV1 } from "./backend-state.js";

const TASK_ID = "task-0123456789abcdef0123456789abcdef";

const request = {
  taskId: TASK_ID,
  type: "executor",
  parent: {
    userId: "user-1",
    botId: "bot-1",
    runId: "run-1",
    turnId: "turn-1",
    sessionId: "session-1",
  },
  compositionGenerationId: "generation-1",
  model: {
    binding: {
      packageId: "provider-flock-ai",
      capabilityId: "flock-ai-models",
      connectionId: "flock-ai-ambient",
      provider: "flock-ai",
      providerModelId: "@frock/writing",
    },
    slug: "provider-flock-ai/@frock/writing",
  },
  prompt: "Write the toast for Mia's wedding.",
};

function stateHolding(stored: unknown): ShellBotStateV1 {
  return {
    ctx: {
      storage: {
        get: async (key: string) =>
          key === taskContextKeyV1(TASK_ID) ? stored : undefined,
      },
    },
  } as unknown as ShellBotStateV1;
}

test("a child reads the model its task pinned off the task record", async () => {
  const context = subagentTaskContextV1(
    decodeSubagentRunTaskRequestV1(request),
    "2026-09-25T00:00:00.000Z",
  );
  expect(await pinnedSubagentModelV1(stateHolding(context), TASK_ID)).toEqual({
    connectionId: "flock-ai-ambient",
    providerModelId: "@frock/writing",
  });
  expect(
    await pinnedSubagentModelV1(stateHolding(undefined), TASK_ID),
  ).toBeUndefined();
  expect(
    await pinnedSubagentModelV1(stateHolding({ unreadable: true }), TASK_ID),
  ).toBeUndefined();
});

test("a child runs on its pin only when the pin is on the Bot's own connection", () => {
  const resolved = { providerModelId: "@frock/auto", displayName: "Auto" };
  const pin = {
    connectionId: "flock-ai-ambient",
    providerModelId: "@frock/writing",
  };
  expect(subagentEffectiveModelV1(resolved, "flock-ai-ambient", pin)).toEqual({
    providerModelId: "@frock/writing",
    displayName: "Auto",
  });
  expect(subagentEffectiveModelV1(resolved, "openai-byo", pin)).toBe(resolved);
  expect(
    subagentEffectiveModelV1(resolved, "flock-ai-ambient", undefined),
  ).toBe(resolved);
});
