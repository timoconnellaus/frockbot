import { plugin } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import type { ClientRun } from "@frockbot/client-core";
import {
  initializeBotSettingsV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";

plugin({
  name: "shell-client-vue-test-loader",
  setup(build) {
    build.onLoad({ filter: /FrockBotApp\.vue$/ }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
});

const {
  decodePluginCatalog,
  projectCompletedRuns,
  projectDurableRuns,
  shellClientPlugin,
} = await import("./index.js");
import type { FrockBotWebData } from "../shared.js";
import type { Ref } from "vue";

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage",
);
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const originalDocument = Object.getOwnPropertyDescriptor(
  globalThis,
  "document",
);

async function secretDerivations(secret: string): Promise<string[]> {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret)),
  );
  const hex = Array.from(digest, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return [
    hex,
    hex.toUpperCase(),
    btoa(String.fromCharCode(...digest)),
    btoa(String.fromCharCode(...digest))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, ""),
  ];
}

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
  if (originalDocument) {
    Object.defineProperty(globalThis, "document", originalDocument);
  } else {
    Reflect.deleteProperty(globalThis, "document");
  }
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

describe("application manifest protocol", () => {
  const emptyManifest = {
    schemaVersion: 1,
    deployment: { userId: "user-1", applicationHash: "hash-1" },
    applicationHash: "hash-1",
    packages: [],
  };

  test("requires the exact owned manifest response", () => {
    expect(decodePluginCatalog(emptyManifest)).toEqual([]);
    expect(
      decodePluginCatalog({
        ...emptyManifest,
        packages: [
          {
            id: "provider-ollama-cloud",
            displayName: "Ollama Cloud",
            version: "0.0.1",
            contributions: ["backend", "runtime", "client"],
            configuration: {
              settings: [],
              capabilities: [
                {
                  id: "ollama-cloud-models",
                  kind: "model",
                  connectionTypes: ["ollama-cloud-account"],
                },
              ],
              connectionTypes: [
                {
                  id: "ollama-cloud-account",
                  displayName: "Ollama Cloud account",
                  allowMultiple: true,
                  authorization: {
                    kind: "api-key",
                    driverId: "ollama-api-key",
                  },
                  capabilities: ["ollama-cloud-models"],
                },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        packageId: "provider-ollama-cloud",
        capabilities: [
          {
            id: "ollama-cloud-models",
            kind: "model",
            connectionTypes: ["ollama-cloud-account"],
          },
        ],
        connectionTypes: [
          expect.objectContaining({ id: "ollama-cloud-account" }),
        ],
      }),
    ]);
    for (const manifest of [
      { packages: [] },
      { ...emptyManifest, schemaVersion: 2 },
      { ...emptyManifest, schemaVersion: "1" },
      { ...emptyManifest, unexpected: true },
      { ...emptyManifest, packages: [42] },
    ]) {
      expect(() => decodePluginCatalog(manifest)).toThrow();
    }
  });
});

describe("composer hydration context", () => {
  test("hides Connection controls when the platform cannot authorize", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        connectionsAvailable: false,
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    expect(provided?.value.connectionsAvailable).toBe(false);
  });

  test("does not treat a query-selected Bot as backend authority", async () => {
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
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");

    expect(provided.value.composerContext).toBeUndefined();
    expect(provided.value.activeBotId).toBeUndefined();
    expect(provided.value.botSettings).toBeUndefined();
    expect(provided.value.modelReady).toBe(false);
  });
});

describe("hosted Assignment commands", () => {
  test("uses distinct atomic Assign, Replace, and Unassign commands", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    const commands: unknown[] = [];
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: () =>
          Promise.resolve(initializeBotSettingsV1("primary")),
        executeConfiguration: (command) => {
          commands.push(command);
          return Promise.resolve({
            schemaVersion: 1,
            commandId: command.commandId,
            revision: command.expectedRevision + 1,
            status: "applied",
          });
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "primary";
    provided.value.botSettings = initializeBotSettingsV1("primary");
    const assignment = {
      assignmentId: "mail",
      packageId: "mail",
      capabilityId: "send",
      connectionId: "mail-1",
    };
    await provided.value.assignCapability(assignment);
    provided.value.botSettings = {
      ...initializeBotSettingsV1("primary"),
      revision: 1,
    };
    await provided.value.replaceCapability(assignment);
    provided.value.botSettings = {
      ...initializeBotSettingsV1("primary"),
      revision: 2,
    };
    await provided.value.unassignCapability("mail");
    expect(commands).toMatchObject([
      { type: "bot/assign-capability", expectedRevision: 0, assignment },
      { type: "bot/replace-capability", expectedRevision: 1, assignment },
      {
        type: "bot/unassign-capability",
        expectedRevision: 2,
        assignmentId: "mail",
      },
    ]);
  });

  test("surfaces rejected and retrying Assignment receipts", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    const receipts = [
      {
        schemaVersion: 1 as const,
        commandId: "rejected",
        revision: 0,
        status: "rejected" as const,
        failure: "Connection is unavailable",
      },
      {
        schemaVersion: 1 as const,
        commandId: "pending",
        revision: 0,
        status: "pending" as const,
      },
    ];
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: () =>
          Promise.resolve(initializeBotSettingsV1("primary")),
        executeConfiguration: () => Promise.resolve(receipts.shift()!),
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "primary";
    provided.value.botSettings = initializeBotSettingsV1("primary");
    const assignment = {
      assignmentId: "mail",
      packageId: "mail",
      capabilityId: "send",
      connectionId: "mail-1",
    };

    await expect(provided.value.assignCapability(assignment)).rejects.toThrow(
      "Connection is unavailable",
    );
    expect(provided.value.settingsError).toBe("Connection is unavailable");
    await expect(provided.value.assignCapability(assignment)).resolves.toBe(
      undefined,
    );
    expect(provided.value.settingsError).toBe(
      "Assignment operation is retrying.",
    );
  });
});

describe("Bot selection", () => {
  test("passes explicit Bot IDs and ignores stale hydration", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.example/" },
        history: { replaceState: () => undefined },
      },
    });
    let resolveOld!: (
      value: ReturnType<typeof initializeBotSettingsV1>,
    ) => void;
    let resolveNew!: (
      value: ReturnType<typeof initializeBotSettingsV1>,
    ) => void;
    const oldSettings = new Promise<ReturnType<typeof initializeBotSettingsV1>>(
      (resolve) => {
        resolveOld = resolve;
      },
    );
    const newSettings = new Promise<ReturnType<typeof initializeBotSettingsV1>>(
      (resolve) => {
        resolveNew = resolve;
      },
    );
    const requested: string[] = [];
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: (query) => {
          if (query.type === "user/get")
            throw new Error("unexpected User query");
          requested.push(query.botId);
          return query.botId === "old" ? oldSettings : newSettings;
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    const oldLoad = provided.value.selectBot("old");
    const newLoad = provided.value.selectBot("new");
    resolveNew(initializeBotSettingsV1("new"));
    await newLoad;
    resolveOld(initializeBotSettingsV1("old"));
    await oldLoad;
    expect(requested).toEqual(["old", "new"]);
    expect(provided.value.activeBotId).toBe("new");
    expect(provided.value.botSettings?.botId).toBe("new");
  });
  test("preserves load failures and ignores stale User settings", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    const older = Promise.withResolvers<UserSettingsViewV1>();
    const newer = Promise.withResolvers<UserSettingsViewV1>();
    let userReads = 0;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: (query) => {
          if (query.type === "bot/get") {
            return Promise.reject(new Error("Bot settings unavailable"));
          }
          userReads += 1;
          return userReads === 1 ? older.promise : newer.promise;
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "primary";
    const botLoad = provided.value.loadBotSettings();
    const olderLoad = provided.value.loadUserSettings();
    const newerLoad = provided.value.loadUserSettings();
    newer.resolve({
      schemaVersion: 1,
      revision: 2,
      profile: { name: "Newer" },
      packages: [],
      connections: [],
    });
    await newerLoad;
    older.resolve({
      schemaVersion: 1,
      revision: 1,
      profile: { name: "Older" },
      packages: [],
      connections: [],
    });
    await Promise.all([botLoad, olderLoad]);

    expect(provided.value.userSettings?.profile.name).toBe("Newer");
    expect(provided.value.settingsError).toBe("Bot settings unavailable");
  });

  test("commits a catalog without overwriting newer User settings", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    const catalogManifest = Promise.withResolvers<unknown>();
    const catalogUser = Promise.withResolvers<UserSettingsViewV1>();
    const directUser = Promise.withResolvers<UserSettingsViewV1>();
    let userReads = 0;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readApplicationManifest: () => catalogManifest.promise,
        readConfiguration: () => {
          userReads += 1;
          return userReads === 1 ? catalogUser.promise : directUser.promise;
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.pluginCatalog = [
      {
        packageId: "stale-package",
        displayName: "Stale",
        version: "0.0.1",
        capabilities: [],
        connectionTypes: [],
      },
    ];

    const catalogLoad = provided.value.loadPluginCatalog();
    const userLoad = provided.value.loadUserSettings();
    directUser.resolve({
      schemaVersion: 1,
      revision: 2,
      profile: { name: "Newer" },
      packages: [],
      connections: [],
    });
    await userLoad;
    catalogUser.resolve({
      schemaVersion: 1,
      revision: 1,
      profile: { name: "Older" },
      packages: [],
      connections: [],
    });
    catalogManifest.resolve({
      schemaVersion: 1,
      deployment: { userId: "user-1", applicationHash: "hash-1" },
      applicationHash: "hash-1",
      packages: [],
    });
    await catalogLoad;

    expect(provided.value.pluginCatalog).toEqual([]);
    expect(provided.value.userSettings?.profile.name).toBe("Newer");
  });

  test("labels an explicitly bound Ollama Bot by its provider", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    const bot = {
      ...initializeBotSettingsV1("ollama-bot"),
      model: {
        connectionId: "ollama-work",
        providerModelId: "glm-5.3-flash:cloud",
      },
      assignments: [
        {
          assignmentId: "ollama-model",
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: "ollama-work",
          state: "enabled" as const,
        },
      ],
    };
    const user: UserSettingsViewV1 = {
      schemaVersion: 1,
      revision: 1,
      profile: { name: "User" },
      packages: [
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
        },
      ],
      connections: [
        {
          connectionId: "ollama-work",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Work",
          state: "ready",
          providerType: "ollama-cloud",
          safeMetadata: {},
        },
      ],
    };
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: (query) =>
          Promise.resolve(query.type === "user/get" ? user : bot),
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = bot.botId;
    provided.value.pluginCatalog = [
      {
        packageId: "provider-ollama-cloud",
        displayName: "Ollama Cloud",
        version: "0.0.1",
        capabilities: [
          {
            id: "ollama-cloud-models",
            kind: "model",
            connectionTypes: ["ollama-cloud-account"],
          },
          {
            id: "ollama-cloud-tools",
            kind: "tool",
            connectionTypes: ["ollama-cloud-account"],
          },
        ],
        connectionTypes: [
          {
            id: "ollama-cloud-account",
            displayName: "Ollama Cloud account",
            allowMultiple: true,
            authorizationKind: "api-key",
            capabilities: ["ollama-cloud-models", "ollama-cloud-tools"],
          },
        ],
      },
    ];

    await provided.value.loadBotSettings();
    await provided.value.loadUserSettings();

    expect(provided.value.modelLabel).toBe("Ollama Cloud · Dynamic Worker");
    expect(provided.value.modelReady).toBe(true);

    bot.assignments[0] = {
      ...bot.assignments[0]!,
      capabilityId: "ollama-cloud-tools",
    };
    await provided.value.loadBotSettings();
    expect(provided.value.modelReady).toBe(false);
  });

  test("assigns a newly connected model capability before model selection", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    let bot = initializeBotSettingsV1("ollama-bot");
    const commands: Array<{ type: string; expectedRevision: number }> = [];
    const user: UserSettingsViewV1 = {
      schemaVersion: 1,
      revision: 1,
      profile: { name: "User" },
      packages: [
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
        },
      ],
      connections: [
        {
          connectionId: "ollama-work",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Work",
          state: "ready",
          providerType: "ollama-cloud",
          safeMetadata: {},
        },
      ],
    };
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: (query) =>
          Promise.resolve(query.type === "user/get" ? user : bot),
        executeConfiguration: (command) => {
          if (!("botId" in command)) throw new Error("unexpected User command");
          commands.push({
            type: command.type,
            expectedRevision: command.expectedRevision,
          });
          if (command.type === "bot/assign-capability") {
            bot = {
              ...bot,
              revision: 1,
              model: command.model,
              assignments: [{ ...command.assignment, state: "enabled" }],
            };
          } else if (command.type === "bot/select-model") {
            bot = { ...bot, revision: bot.revision + 1, model: command.model };
          } else if (command.type === "bot/unbind-model") {
            bot = {
              ...bot,
              revision: bot.revision + 1,
              model: undefined,
              assignments: bot.assignments.map((assignment) =>
                assignment.assignmentId === command.assignmentId
                  ? { ...assignment, state: "unavailable" }
                  : assignment,
              ),
            };
          } else {
            throw new Error("unexpected Bot command");
          }
          return Promise.resolve({
            schemaVersion: 1,
            commandId: command.commandId,
            revision: bot.revision,
            status: "applied" as const,
          });
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = bot.botId;
    provided.value.botSettings = bot;
    provided.value.userSettings = user;
    provided.value.pluginCatalog = [
      {
        packageId: "provider-ollama-cloud",
        displayName: "Ollama Cloud",
        version: "0.0.1",
        capabilities: [
          {
            id: "ollama-cloud-models",
            kind: "model",
            connectionTypes: ["ollama-cloud-account"],
          },
        ],
        connectionTypes: [
          {
            id: "ollama-cloud-account",
            displayName: "Ollama Cloud account",
            allowMultiple: true,
            authorizationKind: "api-key",
            capabilities: ["ollama-cloud-models"],
          },
        ],
      },
    ];

    await provided.value.saveBotModel({
      connectionId: "ollama-work",
      providerModelId: "glm-5.3-flash:cloud",
    });

    expect(commands).toEqual([
      { type: "bot/assign-capability", expectedRevision: 0 },
    ]);
    expect(bot).toMatchObject({
      revision: 1,
      model: {
        connectionId: "ollama-work",
        providerModelId: "glm-5.3-flash:cloud",
      },
      assignments: [
        {
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: "ollama-work",
          state: "enabled",
        },
      ],
    });

    bot = {
      ...bot,
      assignments: bot.assignments.map((assignment) => ({
        ...assignment,
        state: "unavailable",
      })),
    };
    provided.value.botSettings = bot;

    await provided.value.clearBotModel();

    expect(commands.at(-1)).toEqual({
      type: "bot/unbind-model",
      expectedRevision: 1,
    });
    expect(bot).toMatchObject({
      revision: 2,
      model: undefined,
      assignments: [{ state: "unavailable" }],
    });
  });

  test("does not resubmit an unchanged unavailable model", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    const bot = {
      ...initializeBotSettingsV1("ollama-bot"),
      model: {
        connectionId: "revoked-connection",
        providerModelId: "glm-5.3-flash:cloud",
      },
      assignments: [],
    };
    let executed = false;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        executeConfiguration: () => {
          executed = true;
          throw new Error("model was resubmitted");
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = bot.botId;
    provided.value.botSettings = bot;
    provided.value.userSettings = {
      schemaVersion: 1,
      revision: 1,
      profile: { name: "User" },
      packages: [],
      connections: [],
    };

    await provided.value.saveBotModel(bot.model);

    expect(executed).toBe(false);
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

  test("projects reconciliation-required recovery state", () => {
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
        reconcileRun: (_botId, runId) => {
          reconciled.push(runId);
          status = "completed";
          return Promise.resolve({ runId, text: "Done", events: [] });
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "default";
    provided.value.composerContext = "default";

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

describe("hosted Stop", () => {
  test("sends one durable command and projects accepted, reconciling, then cancelled", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    const commands: {
      botId: string;
      runId: string;
      commandId: string;
    }[] = [];
    const projections: ClientRun[] = [
      {
        runId: "run-1",
        input: "Continue",
        events: [],
        status: "running",
        stopRequestedAt: "2026-08-30T00:00:01.000Z",
      },
      {
        runId: "run-1",
        input: "Continue",
        events: [],
        status: "reconciliation-required",
        stopRequestedAt: "2026-08-30T00:00:01.000Z",
        recovery: { action: "resume", message: "Provider confirmation" },
      },
      {
        runId: "run-1",
        input: "Continue",
        events: [],
        status: "cancelled",
        stopRequestedAt: "2026-08-30T00:00:01.000Z",
        failure: "Stopped by an authenticated Stop command.",
      },
    ];
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
              status: "running",
            },
          ]),
        listNotifications: () => Promise.resolve([]),
        stopRun: (botId, runId, commandId) => {
          commands.push({ botId, runId, commandId });
          return Promise.resolve(projections[commands.length - 1]);
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "default";
    provided.value.composerContext = "default";
    await provided.value.loadBotSettings();
    expect(provided.value.activeRunId).toBe("run-1");

    await provided.value.stopRun();
    expect(provided.value.activeRun).toMatchObject({
      runId: "run-1",
      status: "running",
      message: "Stop accepted; waiting for durable settlement.",
      canResume: false,
    });

    await provided.value.stopRun();
    expect(provided.value.activeRun).toMatchObject({
      status: "reconciliation-required",
      message:
        "Stop accepted; reconciling the provider outcome before cancelling.",
      canResume: false,
    });

    await provided.value.stopRun();
    expect(provided.value.activeRun).toBeUndefined();
    expect(provided.value.activeRunId).toBeUndefined();
    expect(provided.value.messages[1]).toMatchObject({
      text: "Stopped by an authenticated Stop command.",
      status: "aborted",
    });

    // Repeated Stops replay exactly one durable command identifier.
    expect(commands).toHaveLength(3);
    expect(new Set(commands.map((command) => command.commandId)).size).toBe(1);
    expect(commands[0]).toMatchObject({ botId: "default", runId: "run-1" });
  });

  test("observes an accepted Stop until the durable run is terminal", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    let lookups = 0;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        stopRun: () =>
          Promise.resolve({
            runId: "run-1",
            input: "Continue",
            events: [],
            status: "running",
            stopRequestedAt: "2026-08-30T00:00:01.000Z",
          }),
        lookupRun: () => {
          lookups += 1;
          return Promise.resolve({
            runId: "run-1",
            input: "Continue",
            events: [],
            status: "cancelled",
            stopRequestedAt: "2026-08-30T00:00:01.000Z",
            failure: "Stopped by an authenticated Stop command.",
          });
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "default";
    provided.value.activeRunId = "run-1";
    provided.value.activeRun = {
      runId: "run-1",
      status: "running",
      message: "Running",
      canResume: false,
    };

    await provided.value.stopRun();

    expect(lookups).toBe(1);
    expect(provided.value.activeRun).toBeUndefined();
    expect(provided.value.activeRunId).toBeUndefined();
    expect(provided.value.messages.at(-1)).toMatchObject({
      runId: "run-1",
      text: "Stopped by an authenticated Stop command.",
      status: "aborted",
    });
  });

  test("detaches without commanding the backend when switching Bots", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.example/" },
        history: { replaceState: () => {} },
      },
    });
    let provided: Ref<FrockBotWebData> | undefined;
    let stops = 0;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: () =>
          Promise.resolve(initializeBotSettingsV1("other")),
        listRuns: () => Promise.resolve([]),
        listNotifications: () => Promise.resolve([]),
        stopRun: () => {
          stops += 1;
          return Promise.reject(new Error("must not command a Stop"));
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "default";
    provided.value.activeRunId = "run-1";

    await provided.value.abort();
    await provided.value.selectBot("other");

    expect(stops).toBe(0);
    expect(provided.value.activeBotId).toBe("other");
    expect(provided.value.activeRunId).toBeUndefined();
  });
});

describe("uncertain Turn admission", () => {
  test("clears retry state and listeners after durable terminal state", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/?bot=primary" } },
    });
    const originalAddEventListener = AbortSignal.prototype.addEventListener;
    const originalRemoveEventListener =
      AbortSignal.prototype.removeEventListener;
    let outstandingAbortListeners = 0;
    AbortSignal.prototype.addEventListener = function (
      type: string,
      callback: EventListenerOrEventListenerObject,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (type === "abort") outstandingAbortListeners += 1;
      return originalAddEventListener.call(this, type, callback, options);
    };
    AbortSignal.prototype.removeEventListener = function (
      type: string,
      callback: EventListenerOrEventListenerObject,
      options?: boolean | EventListenerOptions,
    ) {
      if (type === "abort") outstandingAbortListeners -= 1;
      return originalRemoveEventListener.call(this, type, callback, options);
    };
    let provided: Ref<FrockBotWebData> | undefined;
    let lookups = 0;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.reject(new Error("response lost")),
        lookupRun: (_botId, runId) => {
          lookups += 1;
          if (lookups === 1) {
            return Promise.reject(new Error("lookup unavailable"));
          }
          return Promise.resolve({
            runId,
            admittedAt: "2026-08-29T00:00:00.000Z",
            input: "continue",
            status: lookups === 2 ? "running" : "completed",
            events: [],
            ...(lookups === 2 ? {} : { responseText: "Done durably" }),
          });
        },
        fenceRunAdmission: () =>
          Promise.reject(new Error("fence must not be called")),
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "primary";
    provided.value.composerContext = "primary";

    let result: Awaited<ReturnType<FrockBotWebData["sendPrompt"]>>;
    try {
      result = await provided.value.sendPrompt("continue");
    } finally {
      AbortSignal.prototype.addEventListener = originalAddEventListener;
      AbortSignal.prototype.removeEventListener = originalRemoveEventListener;
    }

    expect(result.accepted).toBe(true);
    expect(lookups).toBe(3);
    expect(provided.value.activeRunId).toBeUndefined();
    expect(provided.value.activeRun).toBeUndefined();
    expect(provided.value.settingsError).toBeUndefined();
    expect(outstandingAbortListeners).toBe(0);
    expect(provided.value.messages.at(-1)).toMatchObject({
      text: "Done durably",
      status: "completed",
    });
  });

  test("detaches a rejected Turn without starting a stale observer after Bot switch", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.example/?bot=primary" },
        history: { replaceState: () => undefined },
      },
    });
    let provided: Ref<FrockBotWebData> | undefined;
    let lookups = 0;
    await shellClientPlugin({
      transport: {
        turn: (_botId, _text, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("switched", "AbortError")),
              { once: true },
            );
          }),
        readConfiguration: (query) =>
          Promise.resolve(
            initializeBotSettingsV1(
              "botId" in query ? query.botId : "secondary",
            ),
          ),
        lookupRun: () => {
          lookups += 1;
          return Promise.resolve(undefined);
        },
        fenceRunAdmission: () => Promise.resolve(undefined),
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "primary";
    provided.value.composerContext = "primary";

    const oldTurn = provided.value.sendPrompt("continue");
    await Promise.resolve();
    await provided.value.selectBot("secondary");
    expect(await oldTurn).toMatchObject({ accepted: true });
    expect(lookups).toBe(0);
    expect(provided.value.activeBotId).toBe("secondary");
    expect(provided.value.activeRunId).toBeUndefined();
    expect(provided.value.activeRun).toBeUndefined();
  });

  test("continues admission reconciliation after stopping the local request", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/?bot=primary" } },
    });
    let provided: Ref<FrockBotWebData> | undefined;
    let lookups = 0;
    await shellClientPlugin({
      transport: {
        turn: (_botId, _text, signal) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener(
              "abort",
              () => reject(new DOMException("stopped", "AbortError")),
              { once: true },
            );
          }),
        lookupRun: (_botId, runId) => {
          lookups += 1;
          return Promise.resolve({
            runId,
            admittedAt: "2026-08-29T00:00:00.000Z",
            input: "continue",
            status: lookups === 1 ? "running" : "completed",
            events: [],
            ...(lookups === 1 ? {} : { responseText: "Finished later" }),
          });
        },
        fenceRunAdmission: () => Promise.resolve(undefined),
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = "primary";
    provided.value.composerContext = "primary";

    const pending = provided.value.sendPrompt("continue");
    await Promise.resolve();
    await provided.value.abort();
    const result = await pending;

    expect(result.accepted).toBe(true);
    expect(lookups).toBe(2);
    expect(provided.value.activeRunId).toBeUndefined();
    expect(provided.value.activeRun).toBeUndefined();
    expect(provided.value.messages.at(-1)).toMatchObject({
      text: "Finished later",
      status: "completed",
    });
  });
});

describe("Connection operation reconciliation", () => {
  test("reuses API-key command identity after an ambiguous response loss", async () => {
    installMemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/?bot=primary" } },
    });
    const commandIds: string[] = [];
    const requestBodies: string[] = [];
    let attempts = 0;
    const mount = async (): Promise<Ref<FrockBotWebData>> => {
      let provided: Ref<FrockBotWebData> | undefined;
      await shellClientPlugin({
        transport: {
          turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
          readAuthenticatedUserId: () => Promise.resolve("user-a"),
          executeConnection: (command) => {
            commandIds.push(command.commandId);
            requestBodies.push(JSON.stringify(command));
            attempts += 1;
            if (attempts === 1) {
              return Promise.reject(new Error("response lost"));
            }
            return Promise.resolve({
              schemaVersion: 1,
              commandId: command.commandId,
              connectionId: "connection-1",
              status: "applied",
            });
          },
        },
        slot: () => () => {},
        inject: () => {
          throw new Error("unexpected client provider injection");
        },
        provide: (_key, value) => {
          provided = value as Ref<FrockBotWebData>;
          return () => {};
        },
      });
      if (!provided) throw new Error("shell data was not provided");
      return provided;
    };
    const input = {
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "super-secret-api-key",
    };

    const first = await mount();
    await expect(first.value.createApiKeyConnection(input)).rejects.toThrow(
      "response lost",
    );
    const retained =
      globalThis.localStorage.getItem(
        "frockbot.pending-connection-operations.v1",
      ) ?? "";
    expect(retained).not.toContain(input.apiKey);
    for (const derived of await secretDerivations(input.apiKey)) {
      expect(retained).not.toContain(derived);
    }
    const second = await mount();
    await second.value.createApiKeyConnection(input);

    expect(commandIds).toHaveLength(2);
    expect(new Set(commandIds).size).toBe(1);
    expect(requestBodies).toHaveLength(2);
    for (const body of requestBodies) {
      const envelope = JSON.parse(body) as Record<string, unknown>;
      expect(envelope.apiKey).toBe(input.apiKey);
      const withoutSecret = JSON.stringify({ ...envelope, apiKey: undefined });
      for (const derived of await secretDerivations(input.apiKey)) {
        expect(withoutSecret).not.toContain(derived);
      }
    }
  });

  test("mints a fresh operation identity for a settled submission", async () => {
    installMemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/?bot=primary" } },
    });
    const commandIds: string[] = [];
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readAuthenticatedUserId: () => Promise.resolve("user-a"),
        executeConnection: (command) => {
          commandIds.push(command.commandId);
          return Promise.resolve({
            schemaVersion: 1,
            commandId: command.commandId,
            connectionId: "connection-1",
            status: "applied",
          });
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    const input = {
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "super-secret-api-key",
    };

    await provided.value.createApiKeyConnection(input);
    await provided.value.createApiKeyConnection({
      ...input,
      apiKey: "another-secret-api-key",
    });

    expect(commandIds).toHaveLength(2);
    expect(commandIds[1]).not.toBe(commandIds[0]);
    expect(
      globalThis.localStorage.getItem(
        "frockbot.pending-connection-operations.v1",
      ),
    ).toBe("{}");
  });

  test("retires a lost rotation from its durable command receipt", async () => {
    installMemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/?bot=primary" } },
    });
    let generation = "generation-1";
    const commandIds: string[] = [];
    const receipts = new Map<
      string,
      {
        schemaVersion: 1;
        commandId: string;
        connectionId: string;
        status: "applied";
      }
    >();
    let lostResponses = 2;
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readAuthenticatedUserId: () => Promise.resolve("user-a"),
        readConfiguration: () =>
          Promise.resolve({
            schemaVersion: 1,
            revision: 1,
            profile: { name: "User" },
            packages: [],
            connections: [
              {
                connectionId: "connection-1",
                packageId: "provider-ollama-cloud",
                connectionTypeId: "ollama-cloud-account",
                displayName: "Work",
                state: "ready",
                providerType: "ollama-cloud",
                generation,
                safeMetadata: {},
              },
            ],
          }),
        executeConnection: (command) => {
          commandIds.push(command.commandId);
          generation = `generation-${commandIds.length + 1}`;
          receipts.set(command.commandId, {
            schemaVersion: 1,
            commandId: command.commandId,
            connectionId: "connection-1",
            status: "applied",
          });
          if (lostResponses > 0) {
            lostResponses -= 1;
            return Promise.reject(new Error("response lost"));
          }
          return Promise.resolve(receipts.get(command.commandId)!);
        },
        lookupConnectionCommand: (_packageId, commandId) =>
          Promise.resolve(receipts.get(commandId)),
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    await provided.value.loadUserSettings();

    await expect(
      provided.value.rotateApiKeyConnection("connection-1", "key-a"),
    ).rejects.toThrow("response lost");
    const lostCommandId = commandIds[0];
    await expect(
      provided.value.rotateApiKeyConnection("connection-1", "key-b"),
    ).rejects.toThrow("response lost");
    await provided.value.rotateApiKeyConnection("connection-1", "key-a");

    expect(commandIds).toHaveLength(3);
    expect(commandIds[2]).not.toBe(lostCommandId);
  });

  test("retires a lost API-key create from its durable Connection projection", async () => {
    installMemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/?bot=primary" } },
    });
    const commandIds: string[] = [];
    let createdCommandId: string | undefined;
    let attempts = 0;
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readAuthenticatedUserId: () => Promise.resolve("user-a"),
        readConfiguration: () =>
          Promise.resolve({
            schemaVersion: 1,
            revision: 1,
            profile: { name: "User" },
            packages: [],
            connections: createdCommandId
              ? [
                  {
                    connectionId: "connection-created",
                    packageId: "provider-ollama-cloud",
                    connectionTypeId: "ollama-cloud-account",
                    displayName: "Work",
                    state: "ready",
                    safeMetadata: { creationCommandId: createdCommandId },
                  },
                ]
              : [],
          }),
        executeConnection: (command) => {
          commandIds.push(command.commandId);
          attempts += 1;
          if (attempts === 1) {
            createdCommandId = command.commandId;
            return Promise.reject(new Error("response lost"));
          }
          return Promise.resolve({
            schemaVersion: 1,
            commandId: command.commandId,
            connectionId: "connection-recreated",
            status: "applied",
          });
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    const input = {
      packageId: "provider-ollama-cloud",
      connectionTypeId: "ollama-cloud-account",
      label: "Work",
      apiKey: "super-secret-api-key",
    };

    await expect(provided.value.createApiKeyConnection(input)).rejects.toThrow(
      "response lost",
    );
    await provided.value.loadUserSettings();
    expect(
      globalThis.localStorage.getItem(
        "frockbot.pending-connection-operations.v1",
      ),
    ).toBe("{}");
    createdCommandId = undefined;
    await provided.value.createApiKeyConnection(input);

    expect(commandIds).toHaveLength(2);
    expect(commandIds[1]).not.toBe(commandIds[0]);
  });

  test("surfaces failed label, disable, and disconnect receipts", async () => {
    const commands: string[] = [];
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        executeConnection: (command) => {
          commands.push(command.type);
          return Promise.resolve({
            schemaVersion: 1,
            commandId: command.commandId,
            connectionId:
              "connectionId" in command
                ? command.connectionId
                : "created-connection",
            status: "failed",
          });
        },
      },
      slot: () => () => {},
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");

    await expect(
      provided.value.updateConnectionLabel("connection-1", "Renamed"),
    ).rejects.toThrow("Connection label update failed");
    await expect(
      provided.value.setConnectionEnabled("connection-1", false),
    ).rejects.toThrow("Connection state update failed");
    await expect(
      provided.value.disconnectConnection("connection-1"),
    ).rejects.toThrow("Connection revocation failed");
    expect(commands).toEqual([
      "connection/update-label",
      "connection/set-enabled",
      "connection/disconnect",
    ]);
  });

  test("reuses the desktop command ID and nonce until durable settlement", async () => {
    installMemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.example/?bot=primary" },
        frockbotDesktop: {},
      },
    });
    const commandIds: string[] = [];
    const nativeReturnNonces: Array<string | undefined> = [];
    let attempts = 0;
    const mount = async (): Promise<Ref<FrockBotWebData>> => {
      let provided: Ref<FrockBotWebData> | undefined;
      await shellClientPlugin({
        transport: {
          turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
          readAuthenticatedUserId: () => Promise.resolve("user-a"),
          startConnection: (input) => {
            commandIds.push(input.commandId);
            nativeReturnNonces.push(input.nativeReturnNonce);
            attempts += 1;
            if (attempts === 1)
              return Promise.reject(new Error("response lost"));
            return Promise.resolve({
              schemaVersion: 1 as const,
              status: "authorization-required" as const,
              connectionId: input.commandId,
              redirectUrl: "https://connect.example/authorize",
              expiresAt: new Date(0).toISOString(),
            });
          },
        },
        slot: () => () => {},
        inject: () => {
          throw new Error("unexpected client provider injection");
        },
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
    const afterLinkExpiry = await mount();
    await afterLinkExpiry.value.startConnection("composio", "gmail");

    expect(commandIds).toHaveLength(3);
    expect(new Set(commandIds).size).toBe(1);
    expect(nativeReturnNonces[0]).toBeString();
    expect(new Set(nativeReturnNonces).size).toBe(1);
  });

  test("shares one uncertain Connection identity across concurrent tabs", async () => {
    installMemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: { location: { href: "https://app.example/?bot=primary" } },
    });
    const commandIds: string[] = [];
    const mount = async (): Promise<Ref<FrockBotWebData>> => {
      let provided: Ref<FrockBotWebData> | undefined;
      await shellClientPlugin({
        transport: {
          turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
          readAuthenticatedUserId: () => Promise.resolve("user-a"),
          startConnection: (input) => {
            commandIds.push(input.commandId);
            return Promise.reject(new Error("response lost"));
          },
        },
        slot: () => () => {},
        inject: () => {
          throw new Error("unexpected client provider injection");
        },
        provide: (_key, value) => {
          provided = value as Ref<FrockBotWebData>;
          return () => {};
        },
      });
      if (!provided) throw new Error("shell data was not provided");
      return provided;
    };
    const [firstTab, secondTab] = await Promise.all([mount(), mount()]);

    const results = await Promise.allSettled([
      firstTab.value.startConnection("composio", "gmail"),
      secondTab.value.startConnection("composio", "gmail"),
    ]);

    expect(results.map((result) => result.status)).toEqual([
      "rejected",
      "rejected",
    ]);
    expect(commandIds).toHaveLength(2);
    expect(new Set(commandIds).size).toBe(1);
  });

  test("does not reuse desktop authorization identity across users", async () => {
    installMemoryStorage();
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.example/?bot=primary" },
        frockbotDesktop: {},
      },
    });
    const attempts: Array<{
      commandId: string;
      nativeReturnNonce?: string;
    }> = [];
    const mount = async (userId: string): Promise<Ref<FrockBotWebData>> => {
      let provided: Ref<FrockBotWebData> | undefined;
      await shellClientPlugin({
        transport: {
          turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
          readAuthenticatedUserId: () => Promise.resolve(userId),
          startConnection: (input) => {
            attempts.push({
              commandId: input.commandId,
              nativeReturnNonce: input.nativeReturnNonce,
            });
            return Promise.reject(new Error("response lost"));
          },
        },
        slot: () => () => {},
        inject: () => {
          throw new Error("unexpected client provider injection");
        },
        provide: (_key, value) => {
          provided = value as Ref<FrockBotWebData>;
          return () => {};
        },
      });
      if (!provided) throw new Error("shell data was not provided");
      return provided;
    };

    const first = await mount("user-a");
    await expect(
      first.value.startConnection("composio", "gmail"),
    ).rejects.toThrow("response lost");
    const second = await mount("user-b");
    await expect(
      second.value.startConnection("composio", "gmail"),
    ).rejects.toThrow("response lost");

    expect(attempts).toHaveLength(2);
    expect(attempts[1]?.commandId).not.toBe(attempts[0]?.commandId);
    expect(attempts[1]?.nativeReturnNonce).not.toBe(
      attempts[0]?.nativeReturnNonce,
    );
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
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
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
        readAuthenticatedUserId: () => Promise.resolve("user-a"),
        startConnection: (input) => {
          commandIds.push(input.commandId);
          connectionId = input.commandId;
          return Promise.resolve({
            schemaVersion: 1 as const,
            status: "authorization-required" as const,
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
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
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
