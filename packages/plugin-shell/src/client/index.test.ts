import { afterEach, describe, expect, test } from "bun:test";
import { initializeBotSettingsV1 } from "@frockbot/configuration-core";
import { projectCompletedRuns, projectDurableRuns } from "./index.js";
import { shellClientPlugin } from "./index.js";
import type { FrockBotWebData } from "../shared.js";
import type { Ref } from "vue";

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");

function installMemoryStorage(): void {
  const values = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
      clear: () => values.clear(),
      key: (index: number) => [...values.keys()][index] ?? null,
      get length() {
        return values.size;
      },
    } satisfies Storage,
  });
}

afterEach(() => {
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  } else {
    Reflect.deleteProperty(globalThis, "localStorage");
  }
  if (originalWindow) {
    Object.defineProperty(globalThis, "window", originalWindow);
  } else {
    Reflect.deleteProperty(globalThis, "window");
  }
});

describe("composer hydration context", () => {
  test("uses the selected Bot before settings hydration resolves", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/?bot=work" } },
    });
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      },
      slot: () => () => {},
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");

    expect(provided.value.composerContext).toBe("work");
    expect(provided.value.botSettings).toBeUndefined();
  });
});

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

  test("projects detached completions when notifications are disabled", () => {
    const messages: Parameters<typeof projectCompletedRuns>[0] = [];
    const projected = projectCompletedRuns(
      messages,
      [],
      [
        {
          runId: "run-without-notification",
          input: "Continue while detached",
          events: [],
          status: "completed",
          responseText: "Completed while detached",
        },
      ],
    );

    expect(projected.size).toBe(0);
    expect(messages.map((message) => message.text)).toEqual([
      "Continue while detached",
      "Completed while detached",
    ]);
  });

  test("replaces a local placeholder with the durable completion", () => {
    const messages: Parameters<typeof projectCompletedRuns>[0] = [
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
        text: "Request stopped locally.",
        status: "aborted",
        tools: [],
      },
    ];

    projectCompletedRuns(
      messages,
      [],
      [
        {
          runId: "run-1",
          input: "Keep working",
          events: [],
          status: "completed",
          responseText: "Finished durably.",
        },
      ],
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      text: "Finished durably.",
      status: "completed",
    });
  });

  test("projects durable failures visibly", () => {
    const messages: Parameters<typeof projectCompletedRuns>[0] = [];

    projectCompletedRuns(
      messages,
      [],
      [
        {
          runId: "failed-run",
          input: "Do something risky",
          events: [],
          status: "failed",
          failure: "Provider reconciliation is required",
        },
      ],
    );

    expect(messages).toMatchObject([
      { role: "user", status: "completed" },
      {
        role: "assistant",
        text: "Provider reconciliation is required",
        status: "error",
      },
    ]);
  });
});

describe("active durable Turn projection", () => {
  test("restores busy state and replaces a stale running placeholder", () => {
    const state: Pick<
      FrockBotWebData,
      "messages" | "activeRunId" | "activeRun" | "error"
    > = {
      activeRunId: "run-1",
      error: "Observer disconnected",
      messages: [
        {
          id: "local-user",
          runId: "run-1",
          role: "user",
          text: "Keep going",
          status: "completed",
          tools: [],
        },
        {
          id: "local-assistant",
          runId: "run-1",
          role: "assistant",
          text: "Request stopped locally.",
          status: "aborted",
          tools: [],
        },
      ],
    };

    projectDurableRuns(
      state,
      [],
      [
        {
          runId: "run-1",
          input: "Keep going",
          events: [],
          status: "running",
        },
      ],
    );

    expect(state.activeRunId).toBe("run-1");
    expect(state.error).toBeUndefined();
    expect(state.activeRun).toMatchObject({
      runId: "run-1",
      status: "running",
      canResume: false,
    });
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({
      text: "Working…",
      status: "streaming",
    });
  });

  test("projects interrupted and reconciliation-required recovery states", () => {
    const interrupted: Pick<
      FrockBotWebData,
      "messages" | "activeRunId" | "activeRun"
    > = { messages: [] };
    projectDurableRuns(
      interrupted,
      [],
      [
        {
          runId: "run-interrupted",
          input: "Continue",
          events: [],
          status: "interrupted",
        },
      ],
    );
    expect(interrupted.activeRun).toMatchObject({
      status: "interrupted",
      canResume: false,
    });
    expect(interrupted.messages[1]).toMatchObject({ status: "interrupted" });

    const reconciliation: Pick<
      FrockBotWebData,
      "messages" | "activeRunId" | "activeRun"
    > = { messages: [] };
    projectDurableRuns(
      reconciliation,
      [],
      [
        {
          runId: "run-reconciliation",
          input: "Continue",
          events: [],
          status: "reconciliation-required",
          failure: "Provider result needs confirmation",
          recovery: {
            action: "resume",
            message: "Provider result needs confirmation",
          },
        },
      ],
    );
    expect(reconciliation.activeRun).toEqual({
      runId: "run-reconciliation",
      status: "reconciliation-required",
      message: "Provider result needs confirmation",
      canResume: true,
    });
    expect(reconciliation.messages[1]).toMatchObject({
      text: "Provider result needs confirmation",
      status: "reconciliation-required",
    });
  });

  test("keeps busy state until the durable run becomes terminal", () => {
    const state: Pick<
      FrockBotWebData,
      "messages" | "activeRunId" | "activeRun"
    > = { messages: [] };
    projectDurableRuns(
      state,
      [],
      [
        {
          runId: "run-1",
          input: "Continue",
          events: [],
          status: "reconciliation-required",
          recovery: {
            action: "resume",
            message: "Provider reconciliation is required",
          },
        },
      ],
    );
    projectDurableRuns(
      state,
      [],
      [
        {
          runId: "run-1",
          input: "Continue",
          events: [],
          status: "completed",
          responseText: "Done",
        },
      ],
    );

    expect(state.activeRunId).toBeUndefined();
    expect(state.activeRun).toBeUndefined();
    expect(state.messages[1]).toMatchObject({
      text: "Done",
      status: "completed",
    });
  });

  test("uses the hosted reconciliation action and projects its result", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    let status: "reconciliation-required" | "completed" =
      "reconciliation-required";
    const reconciled: string[] = [];
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: () =>
          Promise.resolve(initializeBotSettingsV1("default")),
        listRuns: () =>
          Promise.resolve([
            {
              runId: "run-1",
              input: "Continue",
              events: [],
              status,
              ...(status === "completed" ? { responseText: "Done" } : {}),
              ...(status === "reconciliation-required"
                ? {
                    recovery: {
                      action: "resume" as const,
                      message: "Provider confirmation required",
                    },
                  }
                : {}),
            },
          ]),
        listNotifications: () =>
          Promise.reject(new Error("notifications unavailable")),
        reconcileRun: (runId) => {
          reconciled.push(runId);
          status = "completed";
          return Promise.resolve({ runId, text: "Done", events: [] });
        },
      },
      slot: () => () => {},
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");

    await provided.value.loadBotSettings();
    expect(provided.value.activeRunId).toBe("run-1");
    await provided.value.resumeRun("run-1");

    expect(reconciled).toEqual(["run-1"]);
    expect(provided.value.activeRunId).toBeUndefined();
    expect(provided.value.messages[1]).toMatchObject({
      text: "Done",
      status: "completed",
    });
  });
});

describe("Connection operation reconciliation", () => {
  test("reuses the command ID after a lost Connect Link response", async () => {
    installMemoryStorage();
    const commandIds: string[] = [];
    let attempts = 0;
    const mount = async (): Promise<Ref<FrockBotWebData>> => {
      let provided: Ref<FrockBotWebData> | undefined;
      await shellClientPlugin({
        transport: {
          turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
          startConnection: (input) => {
            commandIds.push(input.commandId);
            attempts += 1;
            if (attempts === 1)
              return Promise.reject(new Error("response lost"));
            return Promise.resolve({
              connectionId: input.commandId,
              redirectUrl: "https://connect.example/authorize",
              expiresAt: new Date(Date.now() + 60_000).toISOString(),
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
      return provided;
    };
    const first = await mount();

    await expect(
      first.value.startConnection("composio", "gmail"),
    ).rejects.toThrow("response lost");
    const afterRefresh = await mount();
    await afterRefresh.value.startConnection("composio", "gmail");

    expect(commandIds).toHaveLength(2);
    expect(commandIds[1]).toBe(commandIds[0]);
  });

  test("validates browser authorization targets before opening them", async () => {
    installMemoryStorage();
    const opened: string[] = [];
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        openExternalAuthorization: (url) => {
          opened.push(url);
          return Promise.resolve();
        },
      },
      slot: () => () => {},
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");

    await provided.value.openConnectionAuthorization(
      "https://connect.example/authorize",
    );
    await expect(
      provided.value.openConnectionAuthorization(
        "https://connect.example/authorize#unsafe",
      ),
    ).rejects.toThrow("invalid external authorization URL");

    expect(opened).toEqual(["https://connect.example/authorize"]);
  });

  test("retires a settled callback operation before later revocation", async () => {
    installMemoryStorage();
    const commandIds: string[] = [];
    let connectionState: "ready" | "revoked" | undefined;
    let connectionId: string | undefined;
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        startConnection: (input) => {
          commandIds.push(input.commandId);
          connectionId = input.commandId;
          return Promise.resolve({
            connectionId: input.commandId,
            redirectUrl: "https://connect.example/authorize",
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          });
        },
        readConfiguration: () =>
          Promise.resolve({
            schemaVersion: 1,
            revision: 1,
            profile: { name: "User" },
            packages: [],
            connections:
              connectionState && connectionId
                ? [
                    {
                      connectionId,
                      packageId: "composio",
                      connectionTypeId: "gmail",
                      displayName: "Gmail",
                      state: connectionState,
                      safeMetadata: {},
                    },
                  ]
                : [],
          }),
      },
      slot: () => () => {},
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");

    await provided.value.startConnection("composio", "gmail");
    connectionState = "ready";
    await provided.value.loadUserSettings();
    connectionState = "revoked";
    await provided.value.loadUserSettings();
    await provided.value.startConnection("composio", "gmail");

    expect(commandIds).toHaveLength(2);
    expect(commandIds[1]).not.toBe(commandIds[0]);
  });
});
