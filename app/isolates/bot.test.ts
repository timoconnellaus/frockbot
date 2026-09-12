// The whole grant surface hangs off `activeIsolateTurn`. Every Plugin in the
// User's one worker calls back with its own id in the scope the wrapper put
// on the call, so the gate is that the running generation mounted *that*
// Plugin — never a shared attribution id, and never a Plugin the generation
// does not hold.
import { describe, expect, test } from "bun:test";
import type {
  ActiveTurnV1,
  ShellBotStateV1,
  StandaloneIsolateCallV1,
} from "../shell/backend-state.js";
import { isolateWorkspaceRead, type IsolateCallScopeV1 } from "./bot.ts";

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
    packageId: "greeter",
    generationId: GENERATION,
    request: { root: { kind: "user-instructions" }, path: "notes.md" },
    ...overrides,
  };
}

function state(
  members: { packageId: string; artifact?: unknown }[],
  standalone?: StandaloneIsolateCallV1,
) {
  const active = {
    runId: "run-1",
    sessionId: "user-1:bot-1",
    turnId: "run-1",
    generationId: GENERATION,
    turnType: "chat",
    mounted: { generation: { generationId: GENERATION, members } },
  } as unknown as ActiveTurnV1;
  return {
    turn: {
      current: standalone ? undefined : active,
      standalone: (runId: string) =>
        standalone?.runId === runId ? standalone : undefined,
    },
    env: {
      WORKSPACE_FILES: {
        read: () => Promise.resolve({ bytes: "hello" }),
      },
    },
  } as unknown as ShellBotStateV1;
}

describe("a capability call from the Plugin worker", () => {
  test("is served while the Turn that mounted the Plugin is running", async () => {
    const outcome = await isolateWorkspaceRead(
      state([{ packageId: "greeter", artifact: { contentHash: "a" } }]),
      scope(),
    );
    expect(outcome).toEqual({
      status: "available",
      value: { bytes: "hello" },
    });
  });

  test("is refused when the running generation did not mount that Plugin", async () => {
    expect(await isolateWorkspaceRead(state([]), scope())).toMatchObject({
      status: "unavailable",
    });
    expect(
      await isolateWorkspaceRead(
        state([{ packageId: "weather", artifact: { contentHash: "a" } }]),
        scope({ packageId: "greeter" }),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  test("is served for a standalone call this object registered, for the Plugin it mounted", async () => {
    const call: StandaloneIsolateCallV1 = {
      runId: "views:bot-1",
      sessionId: "user-1:bot-1",
      turnId: "views:bot-1",
      generationId: GENERATION,
      members: [{ packageId: "greeter", artifact: { contentHash: "a" } }],
    };
    const standalone = scope({ runId: "views:bot-1", turnId: "views:bot-1" });
    expect(await isolateWorkspaceRead(state([], call), standalone)).toEqual({
      status: "available",
      value: { bytes: "hello" },
    });
    expect(
      await isolateWorkspaceRead(
        state([], call),
        scope({
          runId: "views:bot-1",
          turnId: "views:bot-1",
          packageId: "weather",
        }),
      ),
    ).toMatchObject({ status: "unavailable" });
    expect(
      await isolateWorkspaceRead(
        state([], call),
        scope({ runId: "views:bot-2" }),
      ),
    ).toMatchObject({ status: "unavailable" });
  });

  test("is refused for another Turn than the one running", async () => {
    expect(
      await isolateWorkspaceRead(
        state([{ packageId: "greeter", artifact: { contentHash: "a" } }]),
        scope({ runId: "run-2" }),
      ),
    ).toMatchObject({ status: "unavailable" });
  });
});
