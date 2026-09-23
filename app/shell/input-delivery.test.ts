// The Turn a pending input opens, and when it rides one already waiting.
import { describe, expect, test } from "bun:test";
import {
  PENDING_AGENT_RUN_PREFIX,
  type OwnedBotTurnCommand,
} from "@frockbot/core/durable";
import { INPUT_DELIVERY_CUE_V1 } from "../routines/inbox.js";
import { createMemoryRoutineStorageV1 } from "../routines/testing.js";
import type { ShellBotStateV1 } from "./backend-state.js";
import {
  inputDeliveryRunIdV1,
  openInputDeliveryTurnV1,
} from "./input-delivery.js";

const IDENTITY = { userId: "user-1", botId: "bot-1" };

function harness(
  admit: (command: OwnedBotTurnCommand) => Promise<unknown> = (command) =>
    Promise.resolve({ runId: command.runId, state: "running" }),
) {
  const storage = createMemoryRoutineStorageV1();
  const headers = new Map<string, unknown>();
  const admitted: OwnedBotTurnCommand[] = [];
  // SAFETY: opening the Turn reads the waiting agent-lane runs and admits;
  // the User's Composition is unreachable here, which the sync tolerates.
  const state = {
    ctx: { storage },
    env: {},
    authority: {
      readRunHeader: (runId: string) => Promise.resolve(headers.get(runId)),
      admit: (command: OwnedBotTurnCommand) => {
        admitted.push(command);
        return admit(command);
      },
    },
  } as unknown as ShellBotStateV1;
  /** A Turn admitted on the agent lane and not yet started. */
  const waiting = async (
    runId: string,
    origin: { kind: string; inputId?: string },
  ) => {
    await storage.put(
      `${PENDING_AGENT_RUN_PREFIX}2026-09-23T10:00:00.000Z:${runId}`,
      runId,
    );
    headers.set(runId, {
      admission: { turnType: "chat", lane: "agent", origin },
    });
  };
  return { state, admitted, waiting };
}

describe("the Turn a pending input opens", () => {
  test("is a chat Turn on the Bot's conversation that queues behind any other", async () => {
    const { state, admitted } = harness();

    await openInputDeliveryTurnV1(state, IDENTITY, {
      inputId: "machine-result:cmd-1",
    });

    expect(admitted).toEqual([
      expect.objectContaining({
        userId: "user-1",
        botId: "bot-1",
        runId: await inputDeliveryRunIdV1("machine-result:cmd-1"),
        sessionId: "user-1:bot-1",
        text: INPUT_DELIVERY_CUE_V1,
        turnType: "chat",
        lane: "agent",
        origin: { kind: "input-delivery", inputId: "machine-result:cmd-1" },
      }),
    ]);
  });

  test("the same input asks for the same Turn, so a retry admits no second one", async () => {
    const { state, admitted } = harness();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await openInputDeliveryTurnV1(state, IDENTITY, {
        inputId: "card-action:press-1",
      });
    }

    // The kernel refuses the second by run id; both asked for the same one.
    expect(new Set(admitted.map((command) => command.runId)).size).toBe(1);
  });

  test("rides an input-delivery Turn that has not started yet", async () => {
    const { state, admitted, waiting } = harness();
    await waiting("dl-waiting", {
      kind: "input-delivery",
      inputId: "card-action:press-1",
    });

    await openInputDeliveryTurnV1(state, IDENTITY, {
      inputId: "card-action:press-2",
    });

    // That Turn drains the whole queue when it starts, this press included.
    expect(admitted).toEqual([]);
  });

  test("does not ride other waiting work, which drains nothing", async () => {
    const { state, admitted, waiting } = harness();
    await waiting("handoff-1", { kind: "handoff" });

    await openInputDeliveryTurnV1(state, IDENTITY, {
      inputId: "card-action:press-1",
    });

    expect(admitted).toHaveLength(1);
  });

  test("an approval answered while one waits rides it too", async () => {
    // The waiting Turn drains the decision when it starts either way, so a
    // Turn of the approval's own behind it would only find the queue empty.
    const { state, admitted, waiting } = harness();
    await waiting("dl-waiting", {
      kind: "input-delivery",
      inputId: "card-action:press-1",
    });

    await openInputDeliveryTurnV1(state, IDENTITY, {
      inputId: "ap-1",
      key: "approval\u0000ask-1\u0000ap-1",
    });

    expect(admitted).toEqual([]);
  });

  test("an approval's run id is derived from its key, not its bare id", async () => {
    const { state, admitted } = harness();

    await openInputDeliveryTurnV1(state, IDENTITY, {
      inputId: "ap-1",
      key: "approval\u0000ask-1\u0000ap-1",
    });

    expect(admitted.map((command) => command.runId)).toEqual([
      await inputDeliveryRunIdV1("approval\u0000ask-1\u0000ap-1"),
    ]);
  });

  test("a Turn the kernel refuses costs the reply, never the caller", async () => {
    const { state, admitted } = harness(() =>
      Promise.reject(new Error("bot agent queue is full (32 Turns)")),
    );

    await openInputDeliveryTurnV1(state, IDENTITY, {
      inputId: "machine-result:cmd-1",
    });

    expect(admitted).toHaveLength(1);
  });
});
