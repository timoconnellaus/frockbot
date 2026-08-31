import { describe, expect, test } from "bun:test";
import {
  capabilityAssignmentFailureV1,
  ConfigurationDecodeError,
  decodeBotConfigurationExecuteRpcV1,
  decodeBotConfigurationReadRpcV1,
  decodeBotIdV1,
  decodeCompositionCommandReceiptV1,
  decodeCompositionGenerationListViewV1,
  decodeCompositionGenerationViewV1,
  decodeRevertCompositionCommandV1,
  decodeConnectionDependencyRequirementV1,
  decodeConfigurationCommandV1,
  decodeConfigurationQueryV1,
  decodeOperationReceiptV1,
  decodeRevokeConnectionCommandV1,
  decodeStartConnectionCommandV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserConfigurationReadRpcV1,
  decodeUserSettingsViewV1,
  initializeBotSettingsV1,
  resolveBotExecutionPlanV1,
  resolveBotModelBindingV1,
  resolveEffectiveBotModelV1,
  type ModelAssignment,
} from "./index.js";
import {
  isApplicationDeploymentHash,
  isConnectionIdentifier,
  isPublicIdentifier,
  isRpcIdentifier,
} from "./identifiers.js";

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

  test("accepts provider model IDs through the catalog limit", () => {
    const providerModelId = "m".repeat(256);

    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "bot/select-model",
        commandId: "command-model",
        botId: "primary",
        expectedRevision: 3,
        model: { connectionId: "connection-1", providerModelId },
      }),
    ).toMatchObject({ model: { providerModelId } });
  });

  test("decodes atomic model binding and explicit unbinding commands", () => {
    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "bot/assign-capability",
        commandId: "bind-model",
        botId: "primary",
        expectedRevision: 2,
        assignment: {
          assignmentId: "ollama-model",
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          connectionId: "ollama-work",
        },
        model: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
        },
      }),
    ).toMatchObject({
      type: "bot/assign-capability",
      assignment: { connectionId: "ollama-work" },
      model: { providerModelId: "glm-5.3-flash:cloud" },
    });
    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "bot/unbind-model",
        commandId: "unbind-model",
        botId: "primary",
        expectedRevision: 3,
        assignmentId: "ollama-model",
      }),
    ).toMatchObject({ type: "bot/unbind-model", assignmentId: "ollama-model" });
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
        type: "user/set-new-bot-model",
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
        type: "bot/assign-capability",
        botId: "primary",
        assignment: {
          assignmentId: "gmail",
          packageId: "composio",
          capabilityId: "gmail-tools",
          extra: true,
        },
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

  test("decodes versioned Connection dependency requirements", () => {
    expect(
      decodeConnectionDependencyRequirementV1({
        schemaVersion: 1,
        packageId: "composio",
        packageVersion: "0.0.1",
        capabilityId: "gmail-tools",
        connectionTypeIds: ["gmail"],
      }),
    ).toEqual({
      schemaVersion: 1,
      packageId: "composio",
      packageVersion: "0.0.1",
      capabilityId: "gmail-tools",
      connectionTypeIds: ["gmail"],
    });
    for (const value of [
      {
        schemaVersion: 1,
        packageId: "composio",
        packageVersion: "0.0.1",
        capabilityId: "gmail-tools",
        connectionTypeIds: [],
      },
      {
        schemaVersion: 1,
        packageId: "composio",
        packageVersion: "0.0.1",
        capabilityId: "gmail-tools",
        connectionTypeIds: ["gmail"],
        extra: true,
      },
    ]) {
      expect(() => decodeConnectionDependencyRequirementV1(value)).toThrow(
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
  test("copies the User model template only when Bot settings initialize", () => {
    const template = {
      connectionId: "provider-1",
      providerModelId: "model-1",
    };
    const initialized = initializeBotSettingsV1("primary", template);
    template.providerModelId = "model-2";
    expect(initialized.model).toEqual({
      connectionId: "provider-1",
      providerModelId: "model-1",
    });
  });

  const bot = {
    schemaVersion: 1 as const,
    botId: "primary",
    revision: 4,
    profile: { name: "Primary" },
    notifications: { enabled: false },
    assignments: [
      {
        assignmentId: "gmail-assignment",
        packageId: "composio",
        capabilityId: "gmail-tools",
        connectionId: "gmail-connection",
        state: "enabled" as const,
      },
    ],
  };
  const packages = [
    {
      packageId: "composio",
      version: "0.0.1",
      capabilities: [{ id: "gmail-tools", connectionTypes: ["gmail"] }],
      connectionTypes: [{ id: "gmail", capabilities: ["gmail-tools"] }],
    },
  ];

  test("resolves a Bot model through its explicit ready Connection", () => {
    const user = {
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
    const modelPackages = [
      {
        packageId: "provider-ollama-cloud",
        version: "0.0.1",
        capabilities: [
          {
            id: "ollama-cloud-models",
            kind: "model" as const,
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
    const assignments = [
      {
        assignmentId: "ollama-model",
        packageId: "provider-ollama-cloud",
        capabilityId: "ollama-cloud-models",
        connectionId: "ollama-work",
        state: "enabled" as const,
      },
    ];

    expect(
      resolveBotModelBindingV1({
        model: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
        },
        assignments,
        user,
        packages: modelPackages,
      }),
    ).toMatchObject({
      state: "ready",
      providerType: "ollama-cloud",
      packageId: "provider-ollama-cloud",
    });
    expect(
      resolveBotModelBindingV1({
        model: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
        },
        assignments,
        user,
        packages: modelPackages.map((pkg) => ({ ...pkg, version: "0.0.2" })),
      }).state,
    ).toBe("unavailable");
    expect(
      resolveBotModelBindingV1({
        model: {
          connectionId: "ollama-work",
          providerModelId: "new-model:cloud",
        },
        assignments,
        user,
        packages: modelPackages,
      }).state,
    ).toBe("requires-resolution");
    expect(
      resolveBotModelBindingV1({
        model: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
        },
        assignments: [],
        user,
        packages: modelPackages,
      }),
    ).toMatchObject({
      state: "unavailable",
      failure: "Bot is not assigned the Connection model capability",
    });
  });

  test("requires an enabled installation, declared capability, and ready typed Connection", () => {
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
          connectionId: "gmail-connection",
          packageId: "composio",
          connectionTypeId: "gmail",
          displayName: "Gmail",
          state: "ready" as const,
          safeMetadata: {},
        },
      ],
    };
    expect(
      resolveBotExecutionPlanV1({ bot, user, packages }).assignments[0]?.state,
    ).toBe("enabled");
    expect(
      resolveBotExecutionPlanV1({
        bot: {
          ...bot,
          assignments: [{ ...bot.assignments[0]!, capabilityId: "anything" }],
        },
        user,
        packages,
      }).assignments[0]?.state,
    ).toBe("unavailable");
    expect(
      capabilityAssignmentFailureV1({
        assignment: { ...bot.assignments[0]!, connectionId: undefined },
        user,
        packages,
      }),
    ).toContain("requires a Connection");
    expect(
      capabilityAssignmentFailureV1({
        assignment: { ...bot.assignments[0]!, capabilityId: "anything" },
        user,
        packages,
      }),
    ).toContain("is not declared");
    expect(
      resolveBotExecutionPlanV1({
        bot,
        user: {
          ...user,
          packages: [{ ...user.packages[0]!, state: "disabled" }],
        },
        packages,
      }).assignments[0]?.state,
    ).toBe("unavailable");
    expect(
      resolveBotExecutionPlanV1({
        bot,
        user: {
          ...user,
          connections: [
            { ...user.connections[0]!, connectionTypeId: "calendar" },
          ],
        },
        packages,
      }).assignments[0]?.state,
    ).toBe("unavailable");
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
  const modelPackages = [
    {
      packageId: "provider-ollama-cloud",
      version: "0.0.1",
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
  ];
  function user(
    newBotModelTemplate?: ModelAssignment,
  ): Parameters<typeof resolveEffectiveBotModelV1>[0]["user"] {
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
      ...(newBotModelTemplate ? { newBotModelTemplate } : {}),
    };
  }
  const assignments = [
    {
      assignmentId: "ollama-model",
      packageId: "provider-ollama-cloud",
      capabilityId: "ollama-cloud-models",
      connectionId: "ollama-work",
      state: "enabled" as const,
    },
  ];

  test("follows the User default when the Bot has no model of its own", () => {
    const effective = resolveEffectiveBotModelV1({
      bot: { assignments },
      user: user({
        connectionId: "ollama-work",
        providerModelId: "llama-3:cloud",
      }),
      packages: modelPackages,
    });
    expect(effective.source).toBe("default");
    expect(effective.model).toEqual({
      connectionId: "ollama-work",
      providerModelId: "llama-3:cloud",
    });
    expect(effective.binding?.state).toBe("ready");
  });

  test("prefers the Bot override over the User default", () => {
    const effective = resolveEffectiveBotModelV1({
      bot: {
        model: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
        },
        assignments,
      },
      user: user({
        connectionId: "ollama-work",
        providerModelId: "llama-3:cloud",
      }),
      packages: modelPackages,
    });
    expect(effective.source).toBe("bot");
    expect(effective.model?.providerModelId).toBe("glm-5.3-flash:cloud");
    expect(effective.binding?.state).toBe("ready");
  });

  test("reports no model when neither the Bot nor the User names one", () => {
    expect(
      resolveEffectiveBotModelV1({
        bot: { assignments },
        user: user(),
        packages: modelPackages,
      }),
    ).toEqual({ source: "none" });
  });

  test("keeps the default fail-closed until the Bot claims the Assignment", () => {
    const effective = resolveEffectiveBotModelV1({
      bot: { assignments: [] },
      user: user({
        connectionId: "ollama-work",
        providerModelId: "llama-3:cloud",
      }),
      packages: modelPackages,
    });
    expect(effective.source).toBe("default");
    expect(effective.binding).toMatchObject({
      state: "unavailable",
      failure: "Bot is not assigned the Connection model capability",
    });
  });
});
