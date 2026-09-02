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

  test("rejects removed per-Package authority commands", () => {
    const meta = {
      schemaVersion: 1,
      commandId: "operation-1",
      expectedRevision: 2,
      botId: "primary",
    } as const;
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        type: "bot/replace-capability",
        model: {
          assignmentId: "mail",
          packageId: "mail",
          capabilityId: "send",
          connectionId: "mail-1",
        },
      }),
    ).toThrow(ConfigurationDecodeError);
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        type: "bot/unassign-capability",
        assignmentId: "mail",
      }),
    ).toThrow(ConfigurationDecodeError);
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

  test("decodes model selection and explicit unbinding as settings", () => {
    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "bot/select-model",
        commandId: "bind-model",
        botId: "primary",
        expectedRevision: 2,
        model: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
        },
      }),
    ).toMatchObject({
      type: "bot/select-model",
      model: { providerModelId: "glm-5.3-flash:cloud" },
    });
    expect(
      decodeConfigurationCommandV1({
        schemaVersion: 1,
        type: "bot/unbind-model",
        commandId: "unbind-model",
        botId: "primary",
        expectedRevision: 3,
      }),
    ).toMatchObject({ type: "bot/unbind-model" });
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

  test("requires a source for new-Bot defaults and forbids an empty automatic choice", () => {
    const command = {
      schemaVersion: 1,
      type: "user/set-new-bot-model",
      commandId: "choose-default",
      expectedRevision: 0,
    } as const;
    expect(() =>
      decodeConfigurationCommandV1({
        ...command,
        model: { connectionId: "connection-1", providerModelId: "model-1" },
      }),
    ).toThrow("invalid fields");
    expect(() =>
      decodeConfigurationCommandV1({ ...command, source: "provider" }),
    ).toThrow("source must be user or auto");
    expect(() =>
      decodeConfigurationCommandV1({ ...command, source: "auto" }),
    ).toThrow("must name a model");
    expect(
      decodeConfigurationCommandV1({ ...command, source: "user" }),
    ).toMatchObject({ source: "user", model: undefined });
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
        source: "user",
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
        model: {
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

  test("rejects hidden and symbol fields across Bot settings seams", () => {
    const command = {
      schemaVersion: 1,
      type: "bot/select-model",
      commandId: "command-1",
      expectedRevision: 0,
      botId: "primary",
      model: { connectionId: "model-1", providerModelId: "provider-model-1" },
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
    };
    const rpc = {
      schemaVersion: 1,
      userId: "user-1",
      botId: "primary",
      command,
    };
    for (const [decode, candidate] of [
      [decodeConfigurationCommandV1, command],
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
    const hiddenModel = { ...command.model };
    Object.defineProperty(hiddenModel, "hidden", { value: true });
    expect(() =>
      decodeConfigurationCommandV1({ ...command, model: hiddenModel }),
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
    expect(initialized.notifications).toEqual({ enabled: true });
  });

  const bot = {
    schemaVersion: 1 as const,
    botId: "primary",
    revision: 4,
    profile: { name: "Primary" },
    notifications: { enabled: false },
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
    expect(
      resolveBotModelBindingV1({
        model: {
          connectionId: "ollama-work",
          providerModelId: "glm-5.3-flash:cloud",
        },
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
        user,
        packages: modelPackages,
      }).state,
    ).toBe("requires-resolution");
    expect(
      resolveBotModelBindingV1({
        model: {
          connectionId: "missing",
          providerModelId: "glm-5.3-flash:cloud",
        },
        user,
        packages: modelPackages,
      }),
    ).toMatchObject({
      state: "unavailable",
      failure: "Connection is unavailable",
    });
  });

  test("projects only the Bot model setting into its execution plan", () => {
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
    expect(resolveBotExecutionPlanV1({ bot, user, packages })).toEqual({
      schemaVersion: 1,
      botId: "primary",
      revision: 4,
      model: undefined,
    });
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

  test("projects Catalog provenance, change origin, and an audit summary", () => {
    const view = decodeCompositionGenerationViewV1({
      ...authoredGenerationView,
      summary: "Added parcel tracking",
      origin: {
        kind: "bot-catalog",
        action: "install",
        packageId: "parcel-tracking",
        catalogId: "parcel-tracking",
        botId: "alpha",
        runId: "run-2",
        sessionId: "alice:alpha",
        turnId: "turn-2",
      },
      members: [
        authoredGenerationView.members[0],
        {
          packageId: "parcel-tracking",
          version: "0.0.1",
          contentHash: "c".repeat(64),
          provenance: {
            kind: "catalog",
            catalogId: "parcel-tracking",
            catalogGeneration: "catalog-1",
          },
        },
      ],
    });

    expect(view.summary).toBe("Added parcel tracking");
    expect(view.origin).toMatchObject({
      kind: "bot-catalog",
      action: "install",
    });
    expect(view.members[1]?.provenance).toEqual({
      kind: "catalog",
      catalogId: "parcel-tracking",
      catalogGeneration: "catalog-1",
    });
    expect(() =>
      decodeCompositionGenerationViewV1({
        ...authoredGenerationView,
        summary: "Added\nparcel tracking",
      }),
    ).toThrow("must be one trimmed line");
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
      ...(newBotModelTemplate
        ? { newBotModelTemplate, newBotModelTemplateSource: "auto" as const }
        : {}),
    };
  }
  test("follows the User default when the Bot has no model of its own", () => {
    const effective = resolveEffectiveBotModelV1({
      bot: {},
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
        bot: {},
        user: user(),
        packages: modelPackages,
      }),
    ).toEqual({ source: "none" });
  });

  test("resolves the default directly through the User's ready Connection", () => {
    const effective = resolveEffectiveBotModelV1({
      bot: {},
      user: user({
        connectionId: "ollama-work",
        providerModelId: "llama-3:cloud",
      }),
      packages: modelPackages,
    });
    expect(effective.source).toBe("default");
    expect(effective.binding).toMatchObject({ state: "ready" });
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
        contentHash: "a".repeat(64),
        values: { region: "au" },
      }),
    ).toEqual({
      ...meta,
      type: "user/install-package",
      packageId: "mcp-weather",
      version: "0.0.1",
      catalogId: "mcp-weather",
      catalogGeneration: "gen-one",
      contentHash: "a".repeat(64),
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
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        type: "user/install-package",
        packageId: "clock",
        version: "0.0.1",
        contentHash: "a".repeat(64),
      }),
    ).toThrow("install contentHash requires a Catalog entry");
    expect(() =>
      decodeConfigurationCommandV1({
        ...meta,
        type: "user/install-package",
        packageId: "mcp-weather",
        version: "0.0.1",
        catalogId: "mcp-weather",
        catalogGeneration: "gen-one",
        contentHash: "not-a-hash",
      }),
    ).toThrow("contentHash is invalid");
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
