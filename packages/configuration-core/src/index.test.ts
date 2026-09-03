import { describe, expect, test } from "bun:test";
import {
  ConfigurationDecodeError,
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
  decodeBotIdV1,
  decodeBotSettingsViewV1,
  decodeCompositionCommandReceiptV1,
  decodeCompositionGenerationListViewV1,
  decodeCompositionGenerationViewV1,
  decodeRevertCompositionCommandV1,
  decodeConfigurationCommandV1,
  decodeConfigurationQueryV1,
  decodeOperationReceiptV1,
  decodeRevokeConnectionCommandV1,
  decodeStartConnectionCommandV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
  decodeUserSettingsViewV1,
  initializeBotSettingsV1,
  migrateStoredBotSettingsV1,
  migrateStoredUserSettingsV1,
  modelBindingFailureV1,
  resolveBotExecutionPlanV1,
  resolveBotModelBindingV1,
  resolveEffectiveBotModelV1,
  type ExecutionPackageDefinition,
  type ModelBindingV1,
} from "./index.js";
import {
  isApplicationDeploymentHash,
  isConnectionIdentifier,
  isPublicIdentifier,
  isRpcIdentifier,
} from "./identifiers.js";

describe("stored configuration migrations", () => {
  test("migrates the pre-account-wide User record without honouring removed features", () => {
    // Literal durable shape from eb0283edcce5daea976a21a9f6a6414bedc6e2bc,
    // the first parent of PR #134's merge commit.
    const stored = {
      schemaVersion: 1,
      revision: 7,
      profile: { name: "Existing User" },
      packages: [
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed" as const,
          values: { "web-search-max-results": 5 },
        },
      ],
      connections: [
        {
          connectionId: "ollama-1",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Work",
          state: "ready" as const,
          safeMetadata: {
            region: "au",
            dependentAssignments: [
              {
                botId: "bot-1",
                generation: "assignment-1",
                packageId: "provider-ollama-cloud",
                capabilityId: "ollama-cloud-models",
                claimOrder: 7,
                status: "acknowledged",
              },
            ],
          },
        },
      ],
      newBotModelTemplate: {
        connectionId: "ollama-1",
        providerModelId: "glm-5.3-flash:cloud",
      },
      newBotModelTemplateSource: "user",
    };

    expect(
      decodeUserSettingsViewV1(migrateStoredUserSettingsV1(stored)),
    ).toEqual({
      schemaVersion: 1,
      revision: 7,
      profile: { name: "Existing User" },
      packages: stored.packages,
      connections: [
        {
          ...stored.connections[0],
          safeMetadata: { region: "au" },
        },
      ],
    });
    expect(stored.connections[0]?.safeMetadata).toHaveProperty(
      "dependentAssignments",
    );
  });

  test("retires Catalog-orphaned platform state and disables inconsistent dependents", () => {
    const stored = {
      schemaVersion: 1,
      revision: 12,
      profile: { name: "Legacy User" },
      packages: [
        {
          packageId: "retired-provider",
          version: "0.0.1",
          state: "installed" as const,
        },
        {
          packageId: "current-provider",
          version: "0.0.1",
          state: "installed" as const,
        },
      ],
      connections: [
        {
          connectionId: "retired-connection",
          packageId: "retired-provider",
          connectionTypeId: "retired-account",
          displayName: "Retired",
          state: "ready" as const,
          safeMetadata: {},
        },
        {
          connectionId: "current-connection",
          packageId: "current-provider",
          connectionTypeId: "current-account",
          displayName: "Current",
          state: "ready" as const,
          safeMetadata: {},
        },
      ],
      platformModel: {
        connectionId: "retired-connection",
        providerModelId: "retired-model",
      },
    };
    const migrated = decodeUserSettingsViewV1(
      migrateStoredUserSettingsV1(stored, [
        {
          packageId: "current-provider",
          version: "0.0.1",
          dependencies: { "model-choice": ">=0.0.1" },
        },
        { packageId: "model-choice", version: "0.0.1" },
      ]),
    );

    expect(migrated.packages).toEqual([
      {
        packageId: "current-provider",
        version: "0.0.1",
        state: "disabled",
      },
    ]);
    expect(migrated.connections).toEqual([stored.connections[1]]);
    expect(migrated.platformModel).toBeUndefined();
    expect(stored.packages).toHaveLength(2);
    expect(stored.connections).toHaveLength(2);
    expect(stored.platformModel).toBeDefined();
  });

  test("the read-time repair scope touches only platform-owned rows", () => {
    // A User who disables Web keeps Ollama Cloud installed even though its
    // manifest names Web as a dependency: repair is not migration, and a
    // deployment that omits a Package must not retire durable rows either.
    const stored = {
      schemaVersion: 1,
      revision: 40,
      profile: { name: "Current User" },
      packages: [
        { packageId: "web", version: "0.0.1", state: "disabled" as const },
        {
          packageId: "provider",
          version: "0.0.1",
          state: "installed" as const,
        },
        {
          packageId: "omitted-today",
          version: "0.0.1",
          state: "installed" as const,
        },
        { packageId: "shell", version: "0.0.1", state: "disabled" as const },
      ],
      connections: [
        {
          connectionId: "provider-connection",
          packageId: "provider",
          connectionTypeId: "provider-account",
          displayName: "Provider",
          state: "ready" as const,
          safeMetadata: {},
        },
      ],
      platformModel: {
        connectionId: "gone-connection",
        providerModelId: "gone-model",
      },
    };
    const packages = [
      { packageId: "web", version: "0.0.1" },
      {
        packageId: "provider",
        version: "0.0.1",
        dependencies: { web: ">=0.0.1" },
      },
      { packageId: "shell", version: "0.0.1", platformOwned: true },
      { packageId: "ui-theme", version: "0.0.1", platformOwned: true },
    ];

    const repaired = decodeUserSettingsViewV1(
      migrateStoredUserSettingsV1(stored, packages, "repair"),
    );
    expect(repaired.packages).toEqual([
      { packageId: "web", version: "0.0.1", state: "disabled" },
      { packageId: "provider", version: "0.0.1", state: "installed" },
      { packageId: "omitted-today", version: "0.0.1", state: "installed" },
      {
        packageId: "shell",
        version: "0.0.1",
        state: "installed",
        provenance: "first-party",
      },
      {
        packageId: "ui-theme",
        version: "0.0.1",
        state: "installed",
        provenance: "first-party",
      },
    ]);
    // The platform model is the provider bootstrap's to re-seed, not the
    // repair's to clear: clearing it on a read would race that bootstrap.
    expect(repaired.platformModel).toEqual(stored.platformModel);

    const migrated = decodeUserSettingsViewV1(
      migrateStoredUserSettingsV1(stored, packages, "migrate"),
    );
    expect(migrated.packages.map((pkg) => [pkg.packageId, pkg.state])).toEqual([
      ["web", "disabled"],
      ["provider", "disabled"],
      ["shell", "installed"],
      ["ui-theme", "installed"],
    ]);
    expect(migrated.platformModel).toBeUndefined();
  });

  test("keeps version mismatches and malformed platform bindings visible", () => {
    const versionMismatch = {
      schemaVersion: 1,
      revision: 0,
      profile: { name: "Existing User" },
      packages: [
        {
          packageId: "provider",
          version: "0.0.1",
          state: "installed" as const,
        },
      ],
      connections: [],
    };
    expect(
      migrateStoredUserSettingsV1(versionMismatch, [
        { packageId: "provider", version: "0.0.2" },
      ]),
    ).toBe(versionMismatch);

    const remoteCatalogInstall = {
      ...versionMismatch,
      packages: [
        {
          packageId: "remote-provider",
          version: "1.2.3",
          state: "installed" as const,
          provenance: "catalog" as const,
          catalogId: "remote-provider",
          catalogGeneration: "generation-1",
        },
      ],
      connections: [
        {
          connectionId: "remote-connection",
          packageId: "remote-provider",
          connectionTypeId: "remote-account",
          displayName: "Remote",
          state: "ready" as const,
          safeMetadata: {},
        },
      ],
    };
    expect(
      migrateStoredUserSettingsV1(remoteCatalogInstall, [
        { packageId: "provider", version: "0.0.2" },
      ]),
    ).toBe(remoteCatalogInstall);

    const malformedPlatform = {
      ...versionMismatch,
      platformModel: {
        connectionId: "provider-connection",
        providerModelId: "model",
        unknown: true,
      },
    };
    expect(() =>
      decodeUserSettingsViewV1(
        migrateStoredUserSettingsV1(malformedPlatform, [
          { packageId: "provider", version: "0.0.1" },
        ]),
      ),
    ).toThrow(ConfigurationDecodeError);
  });

  test("keeps unknown User, Package, and Connection fields strict", () => {
    const current = {
      schemaVersion: 1,
      revision: 0,
      profile: { name: "Existing User" },
      packages: [],
      connections: [],
    };
    for (const stored of [
      { ...current, unknown: true },
      {
        ...current,
        packages: [
          {
            packageId: "settings",
            version: "0.0.1",
            state: "installed",
            unknown: true,
          },
        ],
      },
      {
        ...current,
        connections: [
          {
            connectionId: "connection-1",
            packageId: "provider-ollama-cloud",
            connectionTypeId: "ollama-cloud-account",
            displayName: "Work",
            state: "ready",
            safeMetadata: {},
            unknown: true,
          },
        ],
      },
    ]) {
      expect(() =>
        decodeUserSettingsViewV1(migrateStoredUserSettingsV1(stored)),
      ).toThrow(ConfigurationDecodeError);
    }
    expect(migrateStoredUserSettingsV1(current)).toBe(current);
  });

  test("migrates the pre-account-wide Bot record to an empty Package value bag", () => {
    // Literal durable shape from eb0283edcce5daea976a21a9f6a6414bedc6e2bc,
    // the first parent of PR #134's merge commit.
    const stored = {
      schemaVersion: 1,
      botId: "primary",
      revision: 4,
      profile: { name: "Primary" },
      notifications: { enabled: true },
      assignments: [
        {
          assignmentId: "ollama-model",
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: "ollama-1",
          state: "enabled",
        },
      ],
      assignmentOperations: [
        {
          commandId: "replace-model",
          kind: "replacing",
          assignmentId: "ollama-model",
          state: "retrying",
          target: {
            assignmentId: "ollama-model",
            packageId: "provider-ollama-cloud",
            capabilityId: "ollama-cloud-models",
            connectionId: "ollama-1",
          },
        },
      ],
      model: {
        connectionId: "ollama-1",
        providerModelId: "glm-5.3-flash:cloud",
      },
    };

    expect(decodeBotSettingsViewV1(migrateStoredBotSettingsV1(stored))).toEqual(
      {
        schemaVersion: 1,
        botId: "primary",
        revision: 4,
        profile: { name: "Primary" },
        notifications: { enabled: true },
        packageValues: {},
      },
    );
  });

  test("keeps unknown Bot fields strict and current records unchanged", () => {
    const current = initializeBotSettingsV1("primary");
    expect(migrateStoredBotSettingsV1(current)).toBe(current);
    const { packageValues: _packageValues, ...withoutPackageValues } = current;
    expect(
      decodeBotSettingsViewV1(
        migrateStoredBotSettingsV1({
          ...withoutPackageValues,
          modelAssignment: {
            connectionId: "ollama-1",
            providerModelId: "glm-5.3-flash:cloud",
          },
        }),
      ),
    ).toEqual(current);
    expect(() =>
      decodeBotSettingsViewV1(
        migrateStoredBotSettingsV1({
          ...current,
          assignments: [],
          unknown: true,
        }),
      ),
    ).toThrow(ConfigurationDecodeError);
  });
});

describe("shared public identifier policy", () => {
  test("accepts the bounded cross-runtime identifier grammar", () => {
    expect(isPublicIdentifier("Bot_1.release-candidate")).toBe(true);
    expect(isPublicIdentifier("a".repeat(128))).toBe(true);

    for (const candidate of [
      "",
      "-leading-hyphen",
      "slash/value",
      "a".repeat(129),
      1,
    ]) {
      expect(isPublicIdentifier(candidate)).toBe(false);
    }
  });

  test("defines bounded RPC identifiers and deployment hashes", () => {
    expect(isRpcIdentifier("user:person@example.com")).toBe(true);
    expect(isRpcIdentifier("bad/value")).toBe(false);
    expect(isRpcIdentifier("r".repeat(129))).toBe(false);
    expect(isApplicationDeploymentHash("sha256:abc-123")).toBe(true);
    expect(isApplicationDeploymentHash("bad@hash")).toBe(false);
    expect(isApplicationDeploymentHash("h".repeat(257))).toBe(false);
  });

  test("excludes object-prototype names from Connection identifiers", () => {
    expect(isConnectionIdentifier("connection-1")).toBe(true);
    expect(isConnectionIdentifier("__proto__")).toBe(false);
    expect(isConnectionIdentifier("constructor")).toBe(false);
    expect(isConnectionIdentifier("slash/value")).toBe(false);
  });
});

describe("configuration DTO seam", () => {
  test("uses one bounded Bot identifier grammar across hosted seams", () => {
    expect(decodeBotIdV1("bot-1.alpha_beta")).toBe("bot-1.alpha_beta");
    for (const value of ["bad:bot", "bad@bot", "b".repeat(129)])
      expect(() => decodeBotIdV1(value)).toThrow("botId is invalid");
  });

  test("decodes a versioned Bot profile command", () => {
    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "bot/update-profile",
        commandId: "command-1",
        botId: "primary",
        expectedRevision: 3,
        profile: {
          name: "Housework",
          label: "Research, marketing, admin",
          description: "Keeps the household organized.",
        },
      }),
    ).toEqual({
      schemaVersion: 1,
      type: "bot/update-profile",
      commandId: "command-1",
      botId: "primary",
      expectedRevision: 3,
      profile: {
        name: "Housework",
        label: "Research, marketing, admin",
        description: "Keeps the household organized.",
      },
    });
  });

  test("decodes exact Bot-scoped Package setting commands", () => {
    const meta = {
      schemaVersion: 1,
      commandId: "operation-1",
      expectedRevision: 2,
      botId: "primary",
    } as const;
    expect(
      decodeConfigurationCommandV1({
        ...meta,
        type: "bot/set-package-settings",
        packageId: "custom-models",
        values: {
          model: {
            connectionId: "ollama-work",
            providerModelId: "glm-5.3-flash:cloud",
          },
        },
      }),
    ).toMatchObject({
      type: "bot/set-package-settings",
      packageId: "custom-models",
      values: { model: { connectionId: "ollama-work" } },
    });
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        type: "bot/set-package-settings",
        packageId: "custom-models",
        values: {},
      }),
    ).toThrow("values names no setting");
    expect(
      decodeConfigurationCommandV1({
        ...meta,
        type: "bot/set-package-settings",
        packageId: "custom-models",
        unset: ["model"],
      }),
    ).toMatchObject({ unset: ["model"] });
    for (const invalid of [
      { ...meta, type: "bot/set-package-settings", packageId: "custom-models" },
      {
        ...meta,
        type: "bot/set-package-settings",
        packageId: "custom-models",
        unset: [],
      },
      {
        ...meta,
        type: "bot/set-package-settings",
        packageId: "custom-models",
        unset: ["model", "model"],
      },
      {
        ...meta,
        type: "bot/set-package-settings",
        packageId: "custom-models",
        values: {
          model: { connectionId: "ollama-work", providerModelId: "m" },
        },
        unset: ["model"],
      },
    ]) {
      expect(() => decodeConfigurationCommandV1(invalid)).toThrow(
        ConfigurationDecodeError,
      );
    }
  });

  test("accepts provider model IDs through the catalog limit", () => {
    const providerModelId = "m".repeat(256);

    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "user/set-platform-model",
        commandId: "command-model",
        expectedRevision: 3,
        model: { connectionId: "connection-1", providerModelId },
      }),
    ).toMatchObject({ model: { providerModelId } });
  });

  test("decodes the provider-bootstrap platform model command", () => {
    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "user/set-platform-model",
        commandId: "bootstrap-model",
        expectedRevision: 2,
        model: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
        },
      }),
    ).toMatchObject({
      type: "user/set-platform-model",
      model: { providerModelId: "glm-5.3-flash:cloud" },
    });
    expect(() =>
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "user/set-platform-model",
        commandId: "bootstrap-model",
        expectedRevision: 3,
        model: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
          extra: true,
        },
      }),
    ).toThrow(ConfigurationDecodeError);
  });

  test("rejects unversioned, malformed, and unknown commands", () => {
    for (const value of [
      { type: "bot/update-profile" },
      {
        schemaVersion: 1,
        type: "bot/update-profile",
        commandId: "command-1",
        botId: "../primary",
        expectedRevision: 0,
        profile: { name: "Primary" },
      },
      { schemaVersion: 1, type: "bot/delete-everything" },
    ]) {
      expect(() => decodeConfigurationCommandV1(value)).toThrow(
        ConfigurationDecodeError,
      );
    }
  });

  test("rejects unknown fields throughout configuration commands", () => {
    const meta = {
      schemaVersion: 1,
      commandId: "command-1",
      expectedRevision: 0,
    } as const;
    for (const value of [
      {
        ...meta,
        type: "user/update-profile",
        profile: { name: "Alice", extra: true },
      },
      {
        ...meta,
        type: "user/set-platform-model",
        model: {
          connectionId: "provider-1",
          providerModelId: "model-1",
          extra: true,
        },
      },
      {
        ...meta,
        type: "bot/update-notifications",
        botId: "primary",
        notifications: { enabled: true, extra: true },
      },
      {
        ...meta,
        type: "bot/set-package-settings",
        botId: "primary",
        packageId: "custom-models",
        values: { model: "fast" },
        extra: true,
      },
      {
        ...meta,
        type: "bot/update-profile",
        botId: "primary",
        profile: { name: "Primary" },
        extra: true,
      },
    ]) {
      expect(() => decodeConfigurationCommandV1(value)).toThrow(
        ConfigurationDecodeError,
      );
    }
  });

  test("decodes only explicit User and Bot queries", () => {
    expect(
      decodeConfigurationQueryV1({
        schemaVersion: 1,
        type: "bot/get",
        botId: "primary",
      }),
    ).toEqual({ schemaVersion: 1, type: "bot/get", botId: "primary" });
    for (const value of [
      { schemaVersion: 1, type: "all/get" },
      { schemaVersion: 1, type: "user/get", extra: true },
      { schemaVersion: 1, type: "bot/get", botId: "primary", extra: true },
    ]) {
      expect(() => decodeConfigurationQueryV1(value)).toThrow(
        ConfigurationDecodeError,
      );
    }
  });

  test("strictly decodes versioned Connection commands", () => {
    expect(
      decodeStartConnectionCommandV1({
        schemaVersion: 1,
        type: "connection/start",
        commandId: "connection-1",
        connectionTypeId: "gmail",
        alias: "Work",
      }),
    ).toEqual({
      schemaVersion: 1,
      type: "connection/start",
      commandId: "connection-1",
      connectionTypeId: "gmail",
      alias: "Work",
    });
    expect(
      decodeRevokeConnectionCommandV1({
        schemaVersion: 1,
        type: "connection/revoke",
      }),
    ).toEqual({ schemaVersion: 1, type: "connection/revoke" });
    for (const value of [
      {
        schemaVersion: 2,
        type: "connection/start",
        commandId: "connection-1",
        connectionTypeId: "gmail",
      },
      {
        schemaVersion: 1,
        type: "connection/start",
        commandId: "connection-1",
        connectionTypeId: "gmail",
        extra: true,
      },
      { schemaVersion: 1, type: "connection/revoke", extra: true },
    ]) {
      expect(() =>
        value.type === "connection/revoke"
          ? decodeRevokeConnectionCommandV1(value)
          : decodeStartConnectionCommandV1(value),
      ).toThrow(ConfigurationDecodeError);
    }
  });

  test("rejects hidden and symbol fields across Package-setting seams", () => {
    const command = {
      schemaVersion: 1,
      type: "bot/set-package-settings",
      commandId: "command-1",
      expectedRevision: 0,
      botId: "primary",
      packageId: "custom-models",
      values: {
        model: {
          connectionId: "mail-1",
          providerModelId: "model-1",
        },
      },
    };
    const receipt = {
      schemaVersion: 1,
      commandId: "command-1",
      revision: 0,
      status: "pending",
    };
    const view = {
      schemaVersion: 1,
      botId: "primary",
      revision: 0,
      profile: { name: "Primary" },
      notifications: { enabled: false },
      packageValues: {
        "custom-models": {
          model: {
            connectionId: "mail-1",
            providerModelId: "model-1",
          },
        },
      },
    };
    const rpc = {
      schemaVersion: 1,
      userId: "user-1",
      botId: "primary",
      command,
    };
    for (const [decode, candidate] of [
      [decodeConfigurationCommandV1, command],
      [decodeOperationReceiptV1, receipt],
      [decodeBotSettingsViewV1, view],
      [decodeBotConfigurationExecuteRpcV1, rpc],
    ] as const) {
      const hidden = { ...candidate } as Record<PropertyKey, unknown>;
      Object.defineProperty(hidden, "hidden", { value: true });
      expect(() => decode(hidden)).toThrow(ConfigurationDecodeError);
      const symbol = { ...candidate, [Symbol("extra")]: true };
      expect(() => decode(symbol)).toThrow(ConfigurationDecodeError);
    }
    const hiddenValues = { ...command.values };
    Object.defineProperty(hiddenValues, "hidden", { value: true });
    expect(() =>
      decodeConfigurationCommandV1({ ...command, values: hiddenValues }),
    ).toThrow(ConfigurationDecodeError);
    const symbolModel = {
      ...command.values.model,
      [Symbol("extra")]: true,
    };
    expect(() =>
      decodeBotSettingsViewV1({
        ...view,
        packageValues: {
          "custom-models": { model: symbolModel },
        },
      }),
    ).toThrow(ConfigurationDecodeError);
    const pollutedValues = Object.create({ inherited: true });
    pollutedValues.model = command.values.model;
    expect(() =>
      decodeConfigurationCommandV1({ ...command, values: pollutedValues }),
    ).toThrow(ConfigurationDecodeError);
  });

  test("rejects unknown configuration RPC envelope fields", () => {
    for (const decode of [
      () =>
        decodeUserConfigurationReadRpcV1({
          schemaVersion: 1,
          userId: "user-1",
          extra: true,
        }),
      () =>
        decodeUserConfigurationExecuteRpcV1({
          schemaVersion: 1,
          userId: "user-1",
          command: {
            schemaVersion: 1,
            type: "user/update-profile",
            commandId: "profile-1",
            expectedRevision: 0,
            profile: { name: "Alice" },
          },
          extra: true,
        }),
      () =>
        decodeBotConfigurationReadRpcV1({
          schemaVersion: 1,
          userId: "user-1",
          botId: "primary",
          extra: true,
        }),
      () =>
        decodeBotConfigurationExecuteRpcV1({
          schemaVersion: 1,
          userId: "user-1",
          botId: "primary",
          command: {
            schemaVersion: 1,
            type: "bot/update-profile",
            commandId: "profile-1",
            botId: "primary",
            expectedRevision: 0,
            profile: { name: "Primary" },
          },
          extra: true,
        }),
    ]) {
      expect(decode).toThrow(ConfigurationDecodeError);
    }
  });

  test("decodes configuration RPC authority before commands", () => {
    expect(
      decodeUserConfigurationExecuteRpcV1({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/update-profile",
          commandId: "profile-1",
          expectedRevision: 0,
          profile: { name: "Alice" },
        },
      }),
    ).toMatchObject({
      userId: "user-1",
      command: { profile: { name: "Alice" } },
    });
    expect(() =>
      decodeUserConfigurationExecuteRpcV1({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "user/update-profile",
          commandId: "profile-1",
          expectedRevision: 0,
          profile: { name: 42 },
        },
      }),
    ).toThrow(ConfigurationDecodeError);
    expect(() =>
      decodeBotConfigurationExecuteRpcV1({
        schemaVersion: 1,
        userId: "user-1",
        botId: "primary",
        command: {
          schemaVersion: 1,
          type: "bot/update-profile",
          commandId: "profile-1",
          botId: "other",
          expectedRevision: 0,
          profile: { name: "Other" },
        },
      }),
    ).toThrow("does not match its authority");
  });

  test("decodes server projections and rejects malformed nested values", () => {
    expect(
      decodeOperationReceiptV1({
        schemaVersion: 1,
        commandId: "command-1",
        revision: 2,
        status: "applied",
      }),
    ).toEqual({
      schemaVersion: 1,
      commandId: "command-1",
      revision: 2,
      status: "applied",
    });
    expect(
      decodeOperationReceiptV1({
        schemaVersion: 1,
        commandId: "command-2",
        revision: 2,
        status: "rejected",
        failure: "Capability requires a Connection",
      }),
    ).toEqual({
      schemaVersion: 1,
      commandId: "command-2",
      revision: 2,
      status: "rejected",
      failure: "Capability requires a Connection",
    });
    expect(() =>
      decodeUserSettingsViewV1({
        schemaVersion: 1,
        revision: 1,
        profile: { name: "User" },
        packages: [],
        connections: [
          {
            connectionId: "gmail",
            packageId: "composio",
            connectionTypeId: "gmail",
            displayName: "Gmail",
            state: "ready",
            safeMetadata: { unsafe: undefined },
          },
        ],
      }),
    ).toThrow(ConfigurationDecodeError);
    expect(() =>
      decodeUserSettingsViewV1({
        schemaVersion: 1,
        revision: 0,
        profile: { name: "User" },
        packages: [],
        connections: Array.from({ length: 101 }, (_, index) => ({
          connectionId: `connection-${index}`,
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: `Connection ${index}`,
          state: "ready",
          safeMetadata: {},
        })),
      }),
    ).toThrow(ConfigurationDecodeError);
    // Values read over Durable Object RPC carry a `Symbol.dispose` own key;
    // symbol keys are not fields and must not fail the exact-field check.
    const disposableView = {
      schemaVersion: 1,
      revision: 0,
      profile: { name: "User" },
      packages: [],
      connections: [],
      [Symbol.dispose]: () => undefined,
    };
    expect(decodeUserSettingsViewV1(disposableView)).toEqual({
      schemaVersion: 1,
      revision: 0,
      profile: { name: "User" },
      packages: [],
      connections: [],
    });
    for (const value of [
      {
        schemaVersion: 1,
        revision: 0,
        profile: { name: "User" },
        packages: [],
        connections: [],
        extra: true,
      },
      {
        schemaVersion: 1,
        revision: 0,
        profile: { name: "User", extra: true },
        packages: [],
        connections: [],
      },
      {
        schemaVersion: 1,
        revision: 0,
        profile: { name: "User" },
        packages: [
          {
            packageId: "composio",
            version: "0.0.1",
            state: "installed",
            extra: true,
          },
        ],
        connections: [],
      },
      {
        schemaVersion: 1,
        commandId: "command-1",
        revision: 1,
        status: "applied",
        failure: "must not be accepted",
      },
    ]) {
      expect(() =>
        "commandId" in value
          ? decodeOperationReceiptV1(value)
          : decodeUserSettingsViewV1(value),
      ).toThrow(ConfigurationDecodeError);
    }
  });
});

describe("Bot execution-plan authority", () => {
  test("initializes Bot settings without seeding a model choice", () => {
    const initialized = initializeBotSettingsV1("primary");
    expect(initialized.packageValues).toEqual({});
    expect(initialized.notifications).toEqual({ enabled: true });
  });

  const bot = {
    schemaVersion: 1 as const,
    botId: "primary",
    revision: 4,
    profile: { name: "Primary" },
    notifications: { enabled: false },
    packageValues: {},
  };
  const packages: ExecutionPackageDefinition[] = [
    {
      packageId: "composio",
      version: "0.0.1",
      settings: [],
      capabilities: [
        { id: "clock", kind: "tool", connectionTypes: [] },
        { id: "gmail-tools", kind: "tool", connectionTypes: ["gmail"] },
      ],
      connectionTypes: [{ id: "gmail", capabilities: ["gmail-tools"] }],
    },
  ];

  const modelPackages: ExecutionPackageDefinition[] = [
    {
      packageId: "provider-ollama-cloud",
      version: "0.0.1",
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
          capabilities: ["ollama-cloud-models"],
        },
      ],
    },
  ];

  function modelUser() {
    return {
      schemaVersion: 1 as const,
      revision: 1,
      profile: { name: "User" },
      packages: [
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed" as const,
        },
      ],
      connections: [
        {
          connectionId: "ollama-work",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Work",
          state: "ready" as const,
          providerType: "ollama-cloud",
          modelCatalog: {
            schemaVersion: 1 as const,
            generation: "catalog-1",
            state: "fresh" as const,
            models: [
              {
                providerModelId: "glm-5.3-flash:cloud",
                displayName: "GLM 5.3 Flash",
                capabilities: {
                  tools: true,
                  vision: false,
                  reasoning: true,
                },
                source: "discovered" as const,
              },
            ],
          },
          safeMetadata: {},
        },
      ],
    };
  }

  test("resolves a model through User enablement and its ready Connection", () => {
    const user = modelUser();
    const model = {
      connectionId: "ollama-work",
      providerModelId: "glm-5.3-flash:cloud",
    };
    expect(
      resolveBotModelBindingV1({ model, user, packages: modelPackages }),
    ).toMatchObject({
      state: "ready",
      providerType: "ollama-cloud",
      packageId: "provider-ollama-cloud",
    });
    expect(
      resolveBotModelBindingV1({
        model: { ...model, providerModelId: "new-model:cloud" },
        user,
        packages: modelPackages,
      }).state,
    ).toBe("requires-resolution");
  });

  test("disabling the Package or revoking the Connection fails every Bot closed", () => {
    const model = {
      connectionId: "ollama-work",
      providerModelId: "glm-5.3-flash:cloud",
    };
    const user = {
      ...modelUser(),
      packages: [{ ...modelUser().packages[0]!, state: "disabled" as const }],
    };
    expect(
      modelBindingFailureV1({ model, user, packages: modelPackages }),
    ).toContain('Package "provider-ollama-cloud" is not installed and enabled');
    expect(
      resolveBotModelBindingV1({ model, user, packages: modelPackages }),
    ).toMatchObject({
      state: "unavailable",
      failure: expect.stringContaining("enable it"),
    });

    const revoked = {
      ...modelUser(),
      connections: [
        { ...modelUser().connections[0]!, state: "revoked" as const },
      ],
    };
    for (const _botId of ["bot-one", "bot-two"]) {
      expect(
        resolveBotModelBindingV1({
          model,
          user: revoked,
          packages: modelPackages,
        }),
      ).toMatchObject({
        state: "unavailable",
        failure: expect.stringContaining("reconnect it"),
      });
    }
  });

  test("projects the enabled User capability set in stable identity order", () => {
    const user = {
      schemaVersion: 1 as const,
      revision: 2,
      profile: { name: "User" },
      packages: [
        {
          packageId: "composio",
          version: "0.0.1",
          state: "installed" as const,
        },
      ],
      connections: [
        {
          connectionId: "gmail-z",
          packageId: "composio",
          connectionTypeId: "gmail",
          displayName: "Gmail Z",
          state: "ready" as const,
          safeMetadata: {},
        },
        {
          connectionId: "gmail-a",
          packageId: "composio",
          connectionTypeId: "gmail",
          displayName: "Gmail A",
          state: "ready" as const,
          safeMetadata: {},
        },
      ],
    };
    expect(
      resolveBotExecutionPlanV1({ bot, user, packages }).capabilities,
    ).toEqual([
      {
        packageId: "composio",
        capabilityId: "clock",
        kind: "tool",
      },
      {
        packageId: "composio",
        capabilityId: "gmail-tools",
        kind: "tool",
        connectionId: "gmail-a",
      },
      {
        packageId: "composio",
        capabilityId: "gmail-tools",
        kind: "tool",
        connectionId: "gmail-z",
      },
    ]);
    expect(
      resolveBotExecutionPlanV1({
        bot,
        user: {
          ...user,
          packages: [{ ...user.packages[0]!, state: "disabled" }],
        },
        packages,
      }).capabilities,
    ).toEqual([]);
    expect(
      resolveBotExecutionPlanV1({
        bot,
        user: {
          ...user,
          connections: user.connections.map((connection) => ({
            ...connection,
            state: "revoked" as const,
          })),
        },
        packages,
      }).capabilities,
    ).toEqual([
      {
        packageId: "composio",
        capabilityId: "clock",
        kind: "tool",
      },
    ]);
  });
});

const BOOTSTRAP_GENERATION = "2026-08-31T00:00:00.000Z:0123456789abcdef";
const AUTHORED_GENERATION = "2026-09-01T00:00:00.000Z:fedcba9876543210";

const authoredGenerationView = {
  schemaVersion: 1,
  botId: "alpha",
  generationId: AUTHORED_GENERATION,
  createdAt: "2026-09-01T00:00:00.000Z",
  status: "active",
  isCurrent: true,
  failures: [],
  parentGenerationId: BOOTSTRAP_GENERATION,
  origin: {
    kind: "bot-authored",
    runId: "run-1",
    sessionId: "alice:alpha",
    turnId: "turn-1",
  },
  members: [
    {
      packageId: "shell",
      version: "0.0.1",
      provenance: { kind: "first-party" },
    },
    {
      packageId: "greeter",
      version: "0.0.1",
      contentHash: "b".repeat(64),
      source: "export default {}",
      provenance: {
        kind: "bot",
        botId: "alpha",
        sessionId: "alice:alpha",
        turnId: "turn-1",
        runId: "run-1",
        authoredAt: "2026-09-01T00:00:00.000Z",
      },
    },
  ],
};

describe("Composition generation views", () => {
  test("decodes a generation with Bot provenance and artifact identity", () => {
    const view = decodeCompositionGenerationViewV1(authoredGenerationView);
    expect(view.members[1]?.contentHash).toBe("b".repeat(64));
    expect(view.members[1]?.provenance).toEqual({
      kind: "bot",
      botId: "alpha",
      sessionId: "alice:alpha",
      turnId: "turn-1",
      runId: "run-1",
      authoredAt: "2026-09-01T00:00:00.000Z",
    });
    expect(view.isCurrent).toBe(true);
    expect(view.parentGenerationId).toBe(BOOTSTRAP_GENERATION);
  });

  test("refuses fields the redacted view does not declare", () => {
    for (const invalid of [
      { ...authoredGenerationView, artifactSetHash: "a".repeat(64) },
      { ...authoredGenerationView, status: "unknown" },
      { ...authoredGenerationView, isCurrent: "yes" },
      {
        ...authoredGenerationView,
        members: [
          {
            packageId: "greeter",
            version: "0.0.1",
            provenance: { kind: "first-party" },
            bytes: "AAAA",
          },
        ],
      },
      {
        ...authoredGenerationView,
        members: [
          {
            packageId: "greeter",
            version: "0.0.1",
            provenance: { kind: "first-party" },
            contentHash: "not-a-hash",
          },
        ],
      },
      {
        ...authoredGenerationView,
        members: [
          authoredGenerationView.members[0],
          authoredGenerationView.members[0],
        ],
      },
    ]) {
      expect(() => decodeCompositionGenerationViewV1(invalid)).toThrow(
        ConfigurationDecodeError,
      );
    }
  });

  test("decodes a list and refuses a generation belonging to another Bot", () => {
    const list = decodeCompositionGenerationListViewV1({
      schemaVersion: 1,
      botId: "alpha",
      currentGenerationId: AUTHORED_GENERATION,
      generations: [authoredGenerationView],
      cursor: "composition:index:x",
    });
    expect(list.generations).toHaveLength(1);
    expect(list.cursor).toBe("composition:index:x");
    expect(() =>
      decodeCompositionGenerationListViewV1({
        schemaVersion: 1,
        botId: "beta",
        currentGenerationId: AUTHORED_GENERATION,
        generations: [authoredGenerationView],
      }),
    ).toThrow(ConfigurationDecodeError);
  });

  test("decodes revert commands and their receipts", () => {
    const command = {
      schemaVersion: 1,
      type: "composition/revert",
      commandId: "composition-revert-1",
      botId: "alpha",
      toGenerationId: BOOTSTRAP_GENERATION,
      expectedGenerationId: AUTHORED_GENERATION,
    } as const;
    expect(decodeRevertCompositionCommandV1(command)).toEqual(command);
    expect(() =>
      decodeRevertCompositionCommandV1({
        ...command,
        expectedGenerationId: BOOTSTRAP_GENERATION,
      }),
    ).toThrow(ConfigurationDecodeError);

    expect(
      decodeCompositionCommandReceiptV1({
        schemaVersion: 1,
        commandId: "composition-revert-1",
        status: "applied",
        generationId: "2026-09-02T00:00:00.000Z:0123456789abcdef",
        currentGenerationId: AUTHORED_GENERATION,
      }).status,
    ).toBe("applied");
    expect(
      decodeCompositionCommandReceiptV1({
        schemaVersion: 1,
        commandId: "composition-revert-1",
        status: "rejected",
        failure: "composition generation is newer",
        currentGenerationId: AUTHORED_GENERATION,
      }).status,
    ).toBe("rejected");
    expect(() =>
      decodeCompositionCommandReceiptV1({
        schemaVersion: 1,
        commandId: "composition-revert-1",
        status: "applied",
        currentGenerationId: AUTHORED_GENERATION,
      }),
    ).toThrow(ConfigurationDecodeError);
  });
});

describe("effective Bot model resolution", () => {
  const platformModel: ModelBindingV1 = {
    connectionId: "ollama-work",
    providerModelId: "glm-5.3-flash:cloud",
  };
  const accountModel: ModelBindingV1 = {
    connectionId: "ollama-work",
    providerModelId: "llama-3:cloud",
  };
  const modelSchema = {
    type: "object" as const,
    properties: {
      connectionId: { type: "string" as const },
      providerModelId: { type: "string" as const },
    },
    required: ["connectionId", "providerModelId"],
    additionalProperties: false,
  };
  const modelPackages: ExecutionPackageDefinition[] = [
    {
      packageId: "provider-ollama-cloud",
      version: "0.0.1",
      settings: [],
      capabilities: [
        {
          id: "ollama-cloud-models",
          kind: "model" as const,
          connectionTypes: ["ollama-cloud-account"],
        },
      ],
      connectionTypes: [
        { id: "ollama-cloud-account", capabilities: ["ollama-cloud-models"] },
      ],
    },
    {
      packageId: "custom-models",
      version: "0.0.1",
      settings: [
        {
          id: "model",
          schemaVersion: 1,
          scopes: ["user", "bot"],
          role: "model",
          schema: modelSchema,
        },
      ],
      capabilities: [],
      connectionTypes: [],
    },
  ];
  function user(): Parameters<typeof resolveEffectiveBotModelV1>[0]["user"] {
    return {
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
          modelCatalog: {
            schemaVersion: 1,
            generation: "catalog-1",
            state: "fresh",
            models: [
              {
                providerModelId: "glm-5.3-flash:cloud",
                displayName: "GLM 5.3 Flash",
                capabilities: { tools: true, vision: false, reasoning: true },
                source: "discovered",
              },
              {
                providerModelId: "llama-3:cloud",
                displayName: "Llama 3",
                capabilities: { tools: true, vision: false, reasoning: false },
                source: "discovered",
              },
            ],
          },
          safeMetadata: {},
        },
      ],
      platformModel,
    };
  }

  test("uses the platform model when the Bot and User configured nothing", () => {
    const effective = resolveEffectiveBotModelV1({
      bot: { packageValues: {} },
      user: user(),
      packages: modelPackages,
    });
    expect(effective.source).toBe("platform");
    expect(effective.model).toEqual(platformModel);
    expect(effective.binding?.state).toBe("ready");
  });

  test("prefers an enabled Package's User value, then its Bot value", () => {
    const configured = {
      ...user(),
      packages: [
        ...user().packages,
        {
          packageId: "custom-models",
          version: "0.0.1",
          state: "installed" as const,
          values: { model: accountModel },
        },
      ],
    };
    const account = resolveEffectiveBotModelV1({
      bot: { packageValues: {} },
      user: configured,
      packages: modelPackages,
    });
    expect(account.source).toBe("account");
    expect(account.model).toEqual(accountModel);

    const bot = resolveEffectiveBotModelV1({
      bot: { packageValues: { "custom-models": { model: platformModel } } },
      user: configured,
      packages: modelPackages,
    });
    expect(bot.source).toBe("bot");
    expect(bot.model).toEqual(platformModel);
    expect(bot.binding?.state).toBe("ready");
  });

  test("ignores disabled Package values without deleting them", () => {
    const disabled = decodeUserSettingsViewV1({
      ...user(),
      packages: [
        ...user().packages,
        {
          packageId: "custom-models",
          version: "0.0.1",
          state: "disabled" as const,
          values: { model: accountModel },
        },
      ],
    });
    const bot = decodeBotSettingsViewV1({
      schemaVersion: 1,
      botId: "primary",
      revision: 1,
      profile: { name: "Primary" },
      notifications: { enabled: true },
      packageValues: { "custom-models": { model: accountModel } },
    });
    expect(
      resolveEffectiveBotModelV1({
        bot,
        user: disabled,
        packages: modelPackages,
      }),
    ).toMatchObject({ source: "platform", model: platformModel });
    expect(disabled.packages.at(-1)?.values).toEqual({ model: accountModel });
    expect(bot.packageValues).toEqual({
      "custom-models": { model: accountModel },
    });
  });

  test("fails closed when two enabled Packages declare one scope's role", () => {
    const competing: ExecutionPackageDefinition = {
      ...modelPackages[1]!,
      packageId: "other-models",
    };
    const effective = resolveEffectiveBotModelV1({
      bot: { packageValues: {} },
      user: {
        ...user(),
        packages: [
          ...user().packages,
          {
            packageId: "custom-models",
            version: "0.0.1",
            state: "installed",
          },
          {
            packageId: "other-models",
            version: "0.0.1",
            state: "installed",
          },
        ],
      },
      packages: [...modelPackages, competing],
    });
    expect(effective.source).toBe("bot");
    expect(effective.binding).toMatchObject({
      state: "unavailable",
      failure: expect.stringContaining('"custom-models" and "other-models"'),
    });
    expect(effective.model).toBeUndefined();
  });

  test("reports none only when no Package or platform model supplies one", () => {
    const withoutPlatform = user();
    delete withoutPlatform.platformModel;
    expect(
      resolveEffectiveBotModelV1({
        bot: { packageValues: {} },
        user: withoutPlatform,
        packages: modelPackages,
      }),
    ).toEqual({ source: "none" });
  });
});

describe("Catalog installs and uninstall", () => {
  const meta = {
    schemaVersion: 1 as const,
    commandId: "install-1",
    expectedRevision: 0,
  };

  test("decodes a Catalog install with its generation and values", () => {
    expect(
      decodeConfigurationCommandV1({
        ...meta,
        type: "user/install-package",
        packageId: "mcp-weather",
        version: "0.0.1",
        catalogId: "mcp-weather",
        catalogGeneration: "gen-one",
        values: { region: "au" },
      }),
    ).toEqual({
      ...meta,
      type: "user/install-package",
      packageId: "mcp-weather",
      version: "0.0.1",
      catalogId: "mcp-weather",
      catalogGeneration: "gen-one",
      values: { region: "au" },
    });
  });

  test("keeps the compiled-in install exactly as it was", () => {
    expect(
      decodeConfigurationCommandV1({
        ...meta,
        type: "user/install-package",
        packageId: "clock",
        version: "0.0.1",
      }),
    ).toEqual({
      ...meta,
      type: "user/install-package",
      packageId: "clock",
      version: "0.0.1",
    });
  });

  test("decodes optional install enablement and rejects a non-boolean", () => {
    expect(
      decodeConfigurationCommandV1({
        ...meta,
        type: "user/install-package",
        packageId: "custom-models",
        version: "0.0.1",
        enabled: false,
      }),
    ).toMatchObject({ enabled: false });
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        type: "user/install-package",
        packageId: "custom-models",
        version: "0.0.1",
        enabled: "false",
      }),
    ).toThrow("enabled is invalid");
  });

  test("refuses half a Catalog install", () => {
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        type: "user/install-package",
        packageId: "mcp-weather",
        version: "0.0.1",
        catalogId: "mcp-weather",
      }),
    ).toThrow("requires both catalogId and catalogGeneration");
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        type: "user/install-package",
        packageId: "clock",
        version: "0.0.1",
        values: { region: "au" },
      }),
    ).toThrow("install values require a Catalog entry");
  });

  test("refuses install values that are not bounded JSON", () => {
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        type: "user/install-package",
        packageId: "mcp-weather",
        version: "0.0.1",
        catalogId: "mcp-weather",
        catalogGeneration: "gen-one",
        values: { region: "x".repeat(20_000) },
      }),
    ).toThrow("values is too large");
  });

  test("decodes uninstall and refuses an unknown field on it", () => {
    expect(
      decodeConfigurationCommandV1({
        ...meta,
        commandId: "uninstall-1",
        type: "user/uninstall-package",
        packageId: "mcp-weather",
      }),
    ).toEqual({
      ...meta,
      commandId: "uninstall-1",
      type: "user/uninstall-package",
      packageId: "mcp-weather",
    });
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        commandId: "uninstall-1",
        type: "user/uninstall-package",
        packageId: "mcp-weather",
        cascade: true,
      }),
    ).toThrow(ConfigurationDecodeError);
  });

  test("the User settings view accepts an absent Catalog pin and a whole one", () => {
    const base = {
      schemaVersion: 1 as const,
      revision: 3,
      profile: { name: "Tim" },
      packages: [],
      connections: [],
    };
    expect(decodeUserSettingsViewV1(base)).not.toHaveProperty(
      "catalogGeneration",
    );
    expect(
      decodeUserSettingsViewV1({
        ...base,
        catalogGeneration: "gen-one",
        catalogIndexHash: "a".repeat(64),
      }),
    ).toMatchObject({ catalogGeneration: "gen-one" });
    // Half a pin is corrupt durable state, not a pin.
    expect(() =>
      decodeUserSettingsViewV1({ ...base, catalogGeneration: "gen-one" }),
    ).toThrow(ConfigurationDecodeError);
  });

  test("an installation carries its Catalog provenance through the codec", () => {
    const installation = {
      packageId: "mcp-weather",
      version: "0.0.1",
      state: "installed" as const,
      catalogId: "mcp-weather",
      catalogGeneration: "gen-one",
      provenance: "catalog" as const,
      values: { region: "au" },
    };
    expect(
      decodeUserSettingsViewV1({
        schemaVersion: 1,
        revision: 1,
        profile: { name: "Tim" },
        packages: [installation],
        connections: [],
      }).packages,
    ).toEqual([installation]);
    expect(() =>
      decodeUserSettingsViewV1({
        schemaVersion: 1,
        revision: 1,
        profile: { name: "Tim" },
        packages: [{ ...installation, provenance: "bot" }],
        connections: [],
      }),
    ).toThrow("provenance is invalid");
  });
});
