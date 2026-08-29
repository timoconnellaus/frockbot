import { describe, expect, test } from "bun:test";
import {
  capabilityAssignmentFailureV1,
  ConfigurationDecodeError,
  decodeBotConfigurationExecuteRpcV1,
  decodeConnectionDependencyRequirementV1,
  decodeConfigurationCommandV1,
  decodeConfigurationQueryV1,
  decodeOperationReceiptV1,
  decodeRevokeConnectionCommandV1,
  decodeStartConnectionCommandV1,
  decodeUserConfigurationExecuteRpcV1,
  decodeUserSettingsViewV1,
  initializeBotSettingsV1,
  resolveBotExecutionPlanV1,
} from "./index.js";

describe("configuration DTO seam", () => {
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

  test("decodes only explicit User and Bot queries", () => {
    expect(
      decodeConfigurationQueryV1({
        schemaVersion: 1,
        type: "bot/get",
        botId: "primary",
      }),
    ).toEqual({ schemaVersion: 1, type: "bot/get", botId: "primary" });
    expect(() =>
      decodeConfigurationQueryV1({ schemaVersion: 1, type: "all/get" }),
    ).toThrow(ConfigurationDecodeError);
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
    expect(() =>
      decodeConnectionDependencyRequirementV1({
        schemaVersion: 1,
        packageId: "composio",
        packageVersion: "0.0.1",
        capabilityId: "gmail-tools",
        connectionTypeIds: [],
      }),
    ).toThrow(ConfigurationDecodeError);
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
