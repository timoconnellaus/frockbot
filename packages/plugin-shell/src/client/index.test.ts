import { afterEach, describe, expect, test } from "bun:test";
import { projectCompletedRuns } from "./index.js";
import { shellClientPlugin } from "./index.js";
import type { FrockBotWebData } from "../shared.js";
import type { Ref } from "vue";

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);

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
});
