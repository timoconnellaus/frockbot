// The whole grant surface hangs off `activeIsolateTurn`. Every Plugin in the
// User's one worker calls back under the shared attribution id
// `plugin-worker`, which is never a Composition member, so gating on member
// identity silently refused every grant a Plugin was given.
import { describe, expect, test } from "bun:test";
import type { ActiveTurnV1, ShellBotStateV1 } from "../shell/backend-state.js";
import {
  isolateWorkspaceRead,
  PLUGIN_WORKER_PACKAGE_ID,
  type IsolateCallScopeV1,
} from "./bot.ts";

const GENERATION = "2026-09-05T00:00:00.000Z:aaaaaaaaaaaaaaaa";

function scope(
  overrides: Partial<IsolateCallScopeV1> = {},
): IsolateCallScopeV1 {
  return {
    userId: "user-1",
    botId: "bot-1",
    runId: "run-1",
    sessionId: "user-1:bot-1",
    turnId: "run-1",
    packageId: PLUGIN_WORKER_PACKAGE_ID,
    generationId: GENERATION,
    request: { root: { kind: "user-instructions" }, path: "notes.md" },
    ...overrides,
  };
}

function state(members: { packageId: string; artifact?: unknown }[]) {
  const active = {
    runId: "run-1",
    sessionId: "user-1:bot-1",
    turnId: "run-1",
    generationId: GENERATION,
    turnType: "chat",
    mounted: { generation: { generationId: GENERATION, members } },
  } as unknown as ActiveTurnV1;
  return {
    turn: { current: active },
    env: {
      WORKSPACE_FILES: {
        read: () => Promise.resolve({ bytes: "hello" }),
      },
    },
  } as unknown as ShellBotStateV1;
}

describe("a capability call from the Plugin worker", () => {
  test("is served while the Turn that mounted the worker is running", async () => {
    const outcome = await isolateWorkspaceRead(
      state([{ packageId: "greeter", artifact: { contentHash: "a" } }]),
      scope(),
    );
    expect(outcome).toEqual({
      status: "available",
      value: { bytes: "hello" },
    });
  });

  test("is refused when the running generation put no plugin in the worker", async () => {
    const outcome = await isolateWorkspaceRead(state([]), scope());
    expect(outcome).toMatchObject({ status: "unavailable" });
  });

  test("is refused when it does not carry the worker's attribution id", async () => {
    const outcome = await isolateWorkspaceRead(
      state([{ packageId: "greeter", artifact: { contentHash: "a" } }]),
      scope({ packageId: "greeter" }),
    );
    expect(outcome).toMatchObject({ status: "unavailable" });
  });
});
