import { plugin } from "bun";
import { afterEach, describe, expect, test } from "bun:test";
import type { ClientRun } from "@frockbot/client-core";
import {
  initializeBotSettingsV1,
  type UserSettingsViewV1,
} from "@frockbot/configuration-core";

// Bun has no single-file-component loader, so every Vue module the client
// graph reaches stands in as an empty component; these tests exercise the
// projection and command functions, not the rendered shell.
plugin({
  name: "shell-client-vue-test-loader",
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, () => ({
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
    // The artifact the gateway loaded and the plan it compiled are hashed
    // separately, so a hosted manifest always carries two different digests.
    expect(
      decodePluginCatalog({
        ...emptyManifest,
        deployment: { userId: "user-1", applicationHash: "sha256-of-bytes" },
        applicationHash: "sha256-of-plan",
      }),
    ).toEqual([]);
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
    // A Package without configuration arrives without the key.
    expect(
      decodePluginCatalog({
        ...emptyManifest,
        packages: [
          {
            id: "ui-theme",
            displayName: "Theme",
            version: "0.0.1",
            contributions: ["client"],
          },
        ],
      }),
    ).toEqual([]);
    // A tool Package a User enables with no credential at all:
    // one Capability, no Connection Type. It stays in the catalog, because
    // needing no Connection is not the same as offering nothing.
    expect(
      decodePluginCatalog({
        ...emptyManifest,
        packages: [
          {
            id: "web",
            displayName: "Web",
            version: "0.0.1",
            contributions: ["runtime"],
            configuration: {
              settings: [],
              connectionTypes: [],
              capabilities: [
                { id: "web-fetch", kind: "tool", connectionTypes: [] },
              ],
            },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        packageId: "web",
        capabilities: [{ id: "web-fetch", kind: "tool", connectionTypes: [] }],
        connectionTypes: [],
      }),
    ]);
    // A settings-only Package still has User-visible enablement: turning it on
    // is what makes its otherwise-inert controls available.
    expect(
      decodePluginCatalog({
        ...emptyManifest,
        packages: [
          {
            id: "custom-models",
            displayName: "Custom models",
            version: "0.0.1",
            contributions: ["client"],
            configuration: {
              settings: [
                {
                  id: "account-model",
                  schemaVersion: 1,
                  scopes: ["user"],
                  role: "model",
                  schema: {
                    type: "object",
                    properties: {
                      connectionId: { type: "string" },
                      providerModelId: { type: "string" },
                    },
                    required: ["connectionId", "providerModelId"],
                    additionalProperties: false,
                  },
                },
              ],
              connectionTypes: [],
              capabilities: [],
            },
          },
        ],
      }),
    ).toEqual([
      expect.objectContaining({
        packageId: "custom-models",
        capabilities: [],
        connectionTypes: [],
        settings: [
          expect.objectContaining({
            id: "account-model",
            scopes: ["user"],
            role: "model",
          }),
        ],
      }),
    ]);
    // The same Package with a turn-type admission ceiling: manifest v4 is what
    // the catalog wraps the served configuration as, so the field decodes.
    expect(
      decodePluginCatalog({
        ...emptyManifest,
        packages: [
          {
            id: "web",
            displayName: "Web",
            version: "0.0.1",
            contributions: ["runtime"],
            configuration: {
              settings: [],
              connectionTypes: [],
              capabilities: [
                {
                  id: "web-fetch",
                  kind: "tool",
                  connectionTypes: [],
                  admission: { turnTypes: ["chat", "automation"] },
                },
              ],
            },
          },
        ],
      }),
    ).toHaveLength(1);
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

  test("loads sandboxed Package UI and transports only declared iframe tools", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.example/" },
        history: { replaceState: () => undefined },
      },
    });
    const contribution = {
      packageId: "weather-page",
      displayName: "Sydney Weather",
      provenance: "Bot-authored" as const,
      artifact: {
        contentHash: "a".repeat(64),
        size: 1,
        mediaType: "text/html" as const,
        bundlerVersion: "frockbot-inline-html@1",
      },
      mounts: [{ slot: "frockbot.bot-settings-sections", order: 20 }],
      declaredTools: ["weather_lookup"],
    };
    const requests: Array<{
      path: string;
      method?: string;
      body?: string;
    }> = [];
    const slots: string[] = [];
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: (query) => {
          if (query.type !== "bot/get")
            throw new Error("unexpected User query");
          return Promise.resolve(initializeBotSettingsV1(query.botId));
        },
        hostedRequest: (path, method, body) => {
          requests.push({ path, method, body });
          if (path.endsWith("/package-ui")) {
            return Promise.resolve({
              schemaVersion: 1,
              botId: "primary",
              generationId: "generation-ui",
              artifactOrigin: "https://ui.app.example",
              contributions: [contribution],
            });
          }
          if (path.endsWith("/package-ui/tools")) {
            return Promise.resolve({
              schemaVersion: 1,
              runId: "run-iframe-tool",
              text: "Sydney Weather",
              events: [],
            });
          }
          return Promise.resolve({});
        },
      },
      slot: (registration) => {
        slots.push(registration.slot);
        return () => {};
      },
      inject: () => {
        throw new Error("unexpected client provider injection");
      },
      provide: (_key, value) => {
        provided = value as Ref<FrockBotWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.userSettings = {
      schemaVersion: 1,
      revision: 1,
      profile: { name: "User" },
      packages: [],
      connections: [],
    };

    await provided.value.selectBot("primary");

    expect(slots).toContain("frockbot.bot-settings-sections");
    expect(requests.filter(({ path }) => path.endsWith("/package-ui"))).toEqual(
      [
        {
          path: "/api/bots/primary/package-ui",
          method: undefined,
          body: undefined,
        },
      ],
    );
    expect(provided.value.packageUi?.contributions).toEqual([contribution]);

    expect(
      await provided.value.callPackageUiTool(contribution, "weather_lookup", {
        city: "Sydney",
      }),
    ).toEqual({ content: "Sydney Weather", isError: false });
    const toolRequest = requests.find(({ path }) =>
      path.endsWith("/package-ui/tools"),
    );
    expect(toolRequest?.method).toBe("POST");
    expect(JSON.parse(toolRequest?.body ?? "null")).toEqual({
      schemaVersion: 1,
      commandId: expect.any(String),
      generationId: "generation-ui",
      packageId: "weather-page",
      name: "weather_lookup",
      input: { city: "Sydney" },
    });

    const requestCount = requests.length;
    await expect(
      provided.value.callPackageUiTool(contribution, "package_author", {}),
    ).rejects.toThrow("did not declare");
    expect(requests).toHaveLength(requestCount);
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

  test.each([
    {
      source: "bot" as const,
      botValues: {
        "custom-models": {
          model: {
            connectionId: "model-connection",
            providerModelId: "model-id",
          },
        },
      },
      accountValues: undefined,
      platformModel: undefined,
      expectedLabel: "Model name · Model provider · Bot override",
      expectedProjection: "bot",
      ready: true,
    },
    {
      source: "account" as const,
      botValues: {},
      accountValues: {
        model: {
          connectionId: "model-connection",
          providerModelId: "model-id",
        },
      },
      platformModel: undefined,
      expectedLabel: "Model name · Model provider · Account model",
      expectedProjection: "default",
      ready: true,
    },
    {
      source: "platform" as const,
      botValues: {},
      accountValues: undefined,
      platformModel: {
        connectionId: "model-connection",
        providerModelId: "model-id",
      },
      expectedLabel: "Model name · Model provider",
      expectedProjection: "default",
      ready: true,
    },
    {
      source: "none" as const,
      botValues: {},
      accountValues: undefined,
      platformModel: undefined,
      expectedLabel: "Model unavailable",
      expectedProjection: "none",
      ready: false,
    },
  ])(
    "labels the $source effective model",
    async ({
      botValues,
      accountValues,
      platformModel,
      expectedLabel,
      expectedProjection,
      ready,
    }) => {
      let provided: Ref<FrockBotWebData> | undefined;
      const bot = {
        ...initializeBotSettingsV1("model-bot"),
        packageValues: structuredClone(botValues) as Record<
          string,
          Record<string, unknown>
        >,
      };
      const user: UserSettingsViewV1 = {
        schemaVersion: 1,
        revision: 1,
        profile: { name: "User" },
        packages: [
          {
            packageId: "custom-models",
            version: "0.0.1",
            state: "installed",
            ...(accountValues ? { values: accountValues } : {}),
          },
          {
            packageId: "model-provider",
            version: "0.0.1",
            state: "installed",
          },
        ],
        connections: [
          {
            connectionId: "model-connection",
            packageId: "model-provider",
            connectionTypeId: "model-account",
            displayName: "Work",
            state: "ready",
            providerType: "model-provider",
            safeMetadata: {},
            modelCatalog: {
              schemaVersion: 1,
              generation: "catalog-1",
              state: "fresh",
              models: [
                {
                  providerModelId: "model-id",
                  displayName: "Model name",
                  capabilities: {
                    tools: true,
                    vision: false,
                    reasoning: false,
                  },
                  source: "discovered",
                },
              ],
            },
          },
        ],
        ...(platformModel ? { platformModel } : {}),
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
          packageId: "custom-models",
          displayName: "Custom models",
          version: "0.0.1",
          capabilities: [],
          connectionTypes: [],
          settings: [
            {
              id: "model",
              schemaVersion: 1,
              scopes: ["user", "bot"],
              role: "model",
              schema: {
                type: "object",
                properties: {
                  connectionId: { type: "string" },
                  providerModelId: { type: "string" },
                },
                required: ["connectionId", "providerModelId"],
                additionalProperties: false,
              },
            },
          ],
        },
        {
          packageId: "model-provider",
          displayName: "Model provider",
          version: "0.0.1",
          capabilities: [
            {
              id: "models",
              kind: "model",
              connectionTypes: ["model-account"],
            },
          ],
          connectionTypes: [
            {
              id: "model-account",
              displayName: "Model account",
              allowMultiple: false,
              authorizationKind: "api-key",
              capabilities: ["models"],
            },
          ],
          settings: [],
        },
      ];

      await provided.value.loadBotSettings();

      expect(provided.value.modelLabel).toBe(expectedLabel);
      expect(provided.value.modelReady).toBe(ready);
      expect(provided.value.modelSource).toBe(expectedProjection);
    },
  );

  test("saves Bot-scoped Package settings through the generic command", async () => {
    type PackageSettingsWebData = FrockBotWebData & {
      saveBotPackageSettings(
        packageId: string,
        values: Record<string, unknown>,
      ): Promise<void>;
    };
    let provided: Ref<PackageSettingsWebData> | undefined;
    const commands: unknown[] = [];
    const bot = initializeBotSettingsV1("package-bot");
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: () => Promise.resolve(bot),
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
        provided = value as Ref<PackageSettingsWebData>;
        return () => {};
      },
    });
    if (!provided) throw new Error("shell data was not provided");
    provided.value.activeBotId = bot.botId;
    provided.value.botSettings = bot;

    await provided.value.saveBotPackageSettings("custom-models", {
      model: {
        connectionId: "model-connection",
        providerModelId: "model-id",
      },
    });

    expect(commands).toMatchObject([
      {
        type: "bot/set-package-settings",
        botId: "package-bot",
        packageId: "custom-models",
        expectedRevision: 0,
        values: {
          model: {
            connectionId: "model-connection",
            providerModelId: "model-id",
          },
        },
      },
    ]);
  });

  test("shows the backend reason when Package enablement is refused", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    const failure =
      'Enable dependency "custom-models" before enabling "provider-ollama-cloud"';
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        executeConfiguration: (command) =>
          Promise.resolve({
            schemaVersion: 1,
            commandId: command.commandId,
            revision: command.expectedRevision,
            status: "rejected",
            failure,
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
    provided.value.userSettings = {
      schemaVersion: 1,
      revision: 2,
      profile: { name: "User" },
      packages: [
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "disabled",
        },
      ],
      connections: [],
    };

    await expect(
      provided.value.setPackageEnabled("provider-ollama-cloud", true),
    ).rejects.toThrow(failure);
    expect(provided.value.settingsError).toBe(failure);
  });

  test("shows the backend reason when adding a Package is refused", async () => {
    let provided: Ref<FrockBotWebData> | undefined;
    const failure =
      'Package "custom-models" requires Package "settings" to be installed and enabled; enable "settings" first';
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        executeConfiguration: (command) =>
          Promise.resolve({
            schemaVersion: 1,
            commandId: command.commandId,
            revision: command.expectedRevision,
            status: "rejected",
            failure,
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
    provided.value.userSettings = {
      schemaVersion: 1,
      revision: 2,
      profile: { name: "User" },
      packages: [],
      connections: [],
    };

    await expect(
      provided.value.installPackage("custom-models", "0.0.1"),
    ).rejects.toThrow(failure);
    expect(provided.value.settingsError).toBe(failure);
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
        sends: [],
      },
      {
        id: "local-assistant",
        runId: "run-1",
        role: "assistant",
        text: "Request stopped locally.",
        status: "aborted",
        tools: [],
        sends: [],
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
          responseText: "Finished successfully.",
        },
      ],
    );

    expect(messages).toHaveLength(2);
    expect(messages[1]).toMatchObject({
      role: "assistant",
      text: "Finished successfully.",
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
  test("keeps two optimistic Turns in admission order through projection and reload", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.example/?bot=primary" },
        history: { replaceState: () => undefined },
      },
    });
    const runs: ClientRun[] = [];
    let provided: Ref<FrockBotWebData> | undefined;
    await shellClientPlugin({
      transport: {
        turn: (_botId, input) => {
          const ordinal = runs.length + 1;
          const runId = `run-${ordinal}`;
          const responseText = `answer-${ordinal}`;
          runs.push({
            runId,
            admittedAt: `2026-09-01T00:0${ordinal}:00.000Z`,
            input,
            events: [],
            status: "completed",
            responseText,
          });
          return Promise.resolve({ runId, text: responseText, events: [] });
        },
        readConfiguration: (query) =>
          Promise.resolve(
            query.type === "bot/get"
              ? initializeBotSettingsV1(query.botId)
              : {
                  schemaVersion: 1 as const,
                  revision: 0,
                  profile: { name: "Test User" },
                  packages: [],
                  connections: [],
                },
          ),
        listRuns: () => Promise.resolve(runs),
        listNotifications: () => Promise.resolve([]),
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
    const shell = provided.value;

    const renderedMessages = () =>
      shell.messages
        .map((message, index) => ({ message, index }))
        .sort((left, right) => {
          const byTime = (left.message.at ?? "").localeCompare(
            right.message.at ?? "",
          );
          return byTime || left.index - right.index;
        })
        .map(({ message }) => ({
          id: message.id,
          role: message.role,
          text: message.text,
          at: message.at,
        }));
    const expected: ReturnType<typeof renderedMessages> = [
      {
        id: "run-1:user",
        role: "user",
        text: "question-1",
        at: "2026-09-01T00:01:00.000Z",
      },
      {
        id: "run-1:assistant",
        role: "assistant",
        text: "answer-1",
        at: "2026-09-01T00:01:00.000Z",
      },
      {
        id: "run-2:user",
        role: "user",
        text: "question-2",
        at: "2026-09-01T00:02:00.000Z",
      },
      {
        id: "run-2:assistant",
        role: "assistant",
        text: "answer-2",
        at: "2026-09-01T00:02:00.000Z",
      },
    ];

    await shell.selectBot("primary");
    const firstSend = shell.sendPrompt("question-1");
    const [optimisticUser, optimisticAssistant] = shell.messages.slice(-2);
    expect(optimisticUser).toMatchObject({
      id: `${optimisticUser?.runId}:user`,
      role: "user",
      text: "question-1",
    });
    expect(optimisticAssistant).toMatchObject({
      id: `${optimisticAssistant?.runId}:assistant`,
      role: "assistant",
      text: "",
    });
    expect(optimisticUser?.at).toBeDefined();
    expect(optimisticAssistant?.at).toBe(optimisticUser?.at);
    await firstSend;
    await shell.sendPrompt("question-2");
    expect(renderedMessages()).toEqual(expected);

    // Bot selection follows the same clear-and-project path as a reload.
    await shell.selectBot("primary");
    expect(renderedMessages()).toEqual(expected);
  });

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
          sends: [],
        },
        {
          id: "local-assistant",
          runId: "run-1",
          role: "assistant",
          text: "Request stopped locally.",
          status: "aborted",
          tools: [],
          sends: [],
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
    // A running Turn is shown by the animated avatar, never by a banner.
    expect(state.activeRun).toBeUndefined();
    expect(state.messages).toHaveLength(2);
    expect(state.messages[1]).toMatchObject({ text: "", status: "streaming" });
  });

  test("projects dispatched subagents as chips, and skips one it cannot draw", () => {
    const state: Pick<
      FrockBotWebData,
      "messages" | "activeRunId" | "activeRun"
    > = { messages: [] };

    projectDurableRuns(
      state,
      [],
      [
        {
          runId: "run-task",
          input: "Read the notes",
          status: "completed",
          responseText: "",
          events: [
            {
              type: "task/dispatched",
              taskId: "tk-1",
              taskType: "executor",
              description: "Read the release notes",
              model: "provider-ollama-cloud/glm-5.3-flash:cloud",
              background: true,
            },
            // A chip a client older than the Bot would receive half-formed. It
            // is skipped, never drawn with a field it does not have.
            { type: "task/dispatched", taskId: "tk-2" },
          ],
        },
      ],
    );

    expect(state.messages[1]?.tasks).toEqual([
      {
        taskId: "tk-1",
        taskType: "executor",
        description: "Read the release notes",
        model: "provider-ollama-cloud/glm-5.3-flash:cloud",
        background: true,
      },
    ]);
  });

  test("projects sends, and says so rather than throwing on one it cannot draw", () => {
    const state: Pick<
      FrockBotWebData,
      "messages" | "activeRunId" | "activeRun"
    > = { messages: [] };

    projectDurableRuns(
      state,
      [],
      [
        {
          runId: "run-send",
          input: "Book it",
          status: "completed",
          responseText: "",
          events: [
            { type: "send/to-user", payload: { type: "text", text: "On it." } },
            {
              type: "send/to-user",
              payload: {
                type: "widget",
                widget: { prompt: "Which day?", options: ["Tue"] },
              },
            },
            // A payload shape this bundle does not know, exactly as a client
            // older than the Bot would receive one.
            { type: "send/to-user", payload: { type: "hologram" } },
          ],
        },
      ],
    );

    expect(state.messages[1]?.sends).toEqual([
      { kind: "payload", payload: { type: "text", text: "On it." } },
      {
        kind: "payload",
        payload: {
          type: "widget",
          widget: { prompt: "Which day?", options: ["Tue"] },
        },
      },
      { kind: "unsupported" },
    ]);
  });

  test("streams running text without a banner and clears busy state", () => {
    const state: Pick<
      FrockBotWebData,
      "messages" | "activeRunId" | "activeRun"
    > = { messages: [] };

    projectDurableRuns(
      state,
      [],
      [{ runId: "run-2", input: "Explain", events: [], status: "running" }],
    );
    expect(state.activeRunId).toBe("run-2");
    expect(state.activeRun).toBeUndefined();
    expect(state.messages[1]).toMatchObject({ text: "", status: "streaming" });

    projectDurableRuns(
      state,
      [],
      [
        {
          runId: "run-2",
          input: "Explain",
          events: [],
          status: "running",
          responseText: "Because",
        },
      ],
    );
    expect(state.activeRunId).toBe("run-2");
    expect(state.messages[1]).toMatchObject({
      text: "Because",
      status: "streaming",
    });

    projectDurableRuns(
      state,
      [],
      [
        {
          runId: "run-2",
          input: "Explain",
          events: [],
          status: "completed",
          responseText: "Because it is.",
        },
      ],
    );
    expect(state.activeRunId).toBeUndefined();
    expect(state.activeRun).toBeUndefined();
    expect(state.messages[1]).toMatchObject({
      text: "Because it is.",
      status: "completed",
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
        readConfiguration: (query) =>
          Promise.resolve(
            query.type === "bot/get"
              ? initializeBotSettingsV1("default")
              : {
                  schemaVersion: 1 as const,
                  revision: 0,
                  profile: { name: "User" },
                  packages: [],
                  connections: [],
                },
          ),
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

describe("Bot selection", () => {
  test("re-selecting the active Bot leaves the conversation alone", async () => {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: {
        location: { href: "https://app.example/" },
        history: { replaceState: () => {} },
      },
    });
    let provided: Ref<FrockBotWebData> | undefined;
    let configurationReads = 0;
    let stops = 0;
    await shellClientPlugin({
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
        readConfiguration: (query) => {
          configurationReads += 1;
          return Promise.resolve(
            query.type === "bot/get"
              ? initializeBotSettingsV1(query.botId)
              : {
                  schemaVersion: 1 as const,
                  revision: 0,
                  profile: { name: "Test User" },
                  packages: [],
                  connections: [],
                },
          );
        },
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

    await provided.value.selectBot("default");
    provided.value.messages.push({
      id: "run-1:assistant",
      runId: "run-1",
      role: "assistant",
      text: "Still streaming",
      status: "streaming",
      tools: [],
      sends: [],
    });
    provided.value.activeRunId = "run-1";
    const readsBeforeReselect = configurationReads;

    await provided.value.selectBot("default");

    expect(configurationReads).toBe(readsBeforeReselect);
    expect(provided.value.messages).toHaveLength(1);
    expect(provided.value.messages[0]?.text).toBe("Still streaming");
    expect(provided.value.activeRunId).toBe("run-1");
    expect(stops).toBe(0);
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
        readConfiguration: (query) =>
          Promise.resolve(
            query.type === "bot/get"
              ? initializeBotSettingsV1("default")
              : {
                  schemaVersion: 1 as const,
                  revision: 0,
                  profile: { name: "User" },
                  packages: [],
                  connections: [],
                },
          ),
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
      message: "Stop requested; finishing up.",
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
        readConfiguration: (query) =>
          Promise.resolve(
            query.type === "bot/get"
              ? initializeBotSettingsV1("other")
              : {
                  schemaVersion: 1 as const,
                  revision: 0,
                  profile: { name: "User" },
                  packages: [],
                  connections: [],
                },
          ),
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
            ...(lookups === 2 ? {} : { responseText: "Done successfully" }),
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
      text: "Done successfully",
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
