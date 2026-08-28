import { describe, expect, test } from "bun:test";
import type {
  ClientNotificationIntent,
  ClientRun,
} from "@frockbot/client-core";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import type { WebChatMessage } from "@frockbot/plugin-shell/shared";
import {
  MobileBotProjectionController,
  type MobileBotProjectionDependencies,
  type MobileBotProjectionState,
} from "./bot-projection.ts";

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function completedRun(
  runId: string,
  input: string,
  responseText: string,
): ClientRun {
  return { runId, input, responseText, events: [], status: "completed" };
}

function createController(
  state: MobileBotProjectionState,
  overrides: Partial<MobileBotProjectionDependencies> = {},
): MobileBotProjectionController {
  return new MobileBotProjectionController("default", {
    state: () => state,
    loadSettings: (botId) =>
      Promise.resolve(initializeBotSettingsV1(botId)),
    listRuns: () => Promise.resolve([]),
    listNotifications: () => Promise.resolve([]),
    deliverNotification: () => Promise.resolve(),
    acknowledgeNotification: () => Promise.resolve(),
    ...overrides,
  });
}

describe("mobile Bot projection", () => {
  test("hydrates terminal runs when notifications are disabled", async () => {
    const state: MobileBotProjectionState = { messages: [] };
    const controller = createController(state, {
      listRuns: () =>
        Promise.resolve([
          completedRun("run-1", "Continue detached", "Finished durably"),
        ]),
    });

    await controller.reload("default");

    expect(state.messages.map((message) => message.text)).toEqual([
      "Continue detached",
      "Finished durably",
    ]);
  });

  test("keeps projected history when notification retrieval fails", async () => {
    const state: MobileBotProjectionState = { messages: [] };
    const controller = createController(state, {
      listRuns: () =>
        Promise.resolve([
          completedRun("run-1", "Continue detached", "Finished durably"),
        ]),
      listNotifications: () => Promise.reject(new Error("notifications down")),
    });

    await controller.reload("default");

    expect(state.messages.map((message) => message.text)).toEqual([
      "Continue detached",
      "Finished durably",
    ]);
    expect(state.settingsError).toBe("notifications down");
  });

  test("projects failed durable runs visibly", async () => {
    const state: MobileBotProjectionState = { messages: [] };
    const controller = createController(state, {
      listRuns: () =>
        Promise.resolve([
          {
            runId: "failed-run",
            input: "Use provider",
            events: [],
            status: "failed",
            failure: "Provider reconciliation is required",
          },
        ]),
    });

    await controller.reload("default");

    expect(state.messages).toMatchObject([
      { role: "user", status: "completed" },
      {
        role: "assistant",
        text: "Provider reconciliation is required",
        status: "error",
      },
    ]);
  });

  test("replaces a matching nonterminal placeholder", async () => {
    const messages: WebChatMessage[] = [
      {
        id: "local-user",
        runId: "run-1",
        role: "user",
        text: "Keep working",
        status: "completed",
        tools: [],
      },
      {
        id: "local-assistant",
        runId: "run-1",
        role: "assistant",
        text: "",
        status: "streaming",
        tools: [],
      },
    ];
    const state: MobileBotProjectionState = { messages };
    const controller = createController(state, {
      listRuns: () =>
        Promise.resolve([
          completedRun("run-1", "Keep working", "Finished after reconnect"),
        ]),
    });

    await controller.reload("default");

    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({
      role: "assistant",
      text: "Finished after reconnect",
      status: "completed",
    });
  });

  test("invalidates synchronously and rejects stale Bot responses", async () => {
    const oldSettings = deferred<ReturnType<typeof initializeBotSettingsV1>>();
    const oldRuns = deferred<ClientRun[]>();
    const state: MobileBotProjectionState = {
      botSettings: initializeBotSettingsV1("default"),
      messages: [
        {
          id: "old-message",
          runId: "old-run",
          role: "assistant",
          text: "Old history",
          status: "completed",
          tools: [],
        },
      ],
      activeRunId: "old-run",
      error: "old error",
      settingsError: "old settings error",
    };
    const acknowledgements: string[] = [];
    const notifications: ClientNotificationIntent[] = [];
    const controller = createController(state, {
      loadSettings: (botId) =>
        botId === "old"
          ? oldSettings.promise
          : Promise.resolve(initializeBotSettingsV1(botId)),
      listRuns: (botId) =>
        botId === "old"
          ? oldRuns.promise
          : Promise.resolve([
              completedRun("new-run", "New prompt", "New reply"),
            ]),
      listNotifications: () => Promise.resolve(notifications),
      acknowledgeNotification: (_botId, notificationId) => {
        acknowledgements.push(notificationId);
        return Promise.resolve();
      },
    });

    const oldLoad = controller.switchBot("old");
    expect(state).toMatchObject({ messages: [] });
    expect(state.botSettings).toBeUndefined();
    expect(state.activeRunId).toBeUndefined();

    const newLoad = controller.switchBot("new");
    expect(state.messages).toEqual([]);
    await newLoad;
    oldSettings.resolve(initializeBotSettingsV1("old"));
    oldRuns.resolve([completedRun("old-run", "Old prompt", "Old reply")]);
    await oldLoad;

    expect(state.botSettings?.botId).toBe("new");
    expect(state.messages.map((message) => message.text)).toEqual([
      "New prompt",
      "New reply",
    ]);
    expect(acknowledgements).toEqual([]);
  });
});
