import { describe, expect, test } from "bun:test";
import {
  decodeRevertCompositionCommandV1,
  MAX_COMPOSITION_GENERATION_PAGE_V1,
} from "@frockbot/configuration-core";
import {
  decodeBotAgentRunRpcV1,
  decodeBotRunRpcV1,
  decodeRpcEnvelopeV1,
  decodeStartConnectionRpcV1,
  rpcBotId,
  rpcDecoded,
  rpcIdentifier,
  rpcInteger,
  rpcObject,
  rpcString,
} from "./durable-rpc.js";

describe("Durable Object RPC boundaries", () => {
  test("rejects malformed Connection starts before durable admission", () => {
    const admitted: unknown[] = [];
    const admit = (input: unknown) => {
      const request = decodeStartConnectionRpcV1(input);
      admitted.push(request);
    };

    for (const request of [
      ["user-1", { connectionId: "gmail-1" }],
      {
        schemaVersion: 2,
        userId: "user-1",
        connection: {
          connectionId: "gmail-1",
          packageId: "composio",
          connectionTypeId: "gmail",
          displayName: "Gmail",
        },
      },
      {
        schemaVersion: 1,
        userId: "user-1",
        connection: {
          connectionId: 1,
          packageId: "composio",
          connectionTypeId: "gmail",
          displayName: "Gmail",
        },
      },
      {
        schemaVersion: 1,
        userId: "user-1",
        connection: {
          connectionId: "gmail-1",
          packageId: "composio",
          connectionTypeId: "gmail",
          displayName: "Gmail",
          state: "ready",
        },
      },
    ]) {
      expect(() => admit(request)).toThrow();
      expect(admitted).toHaveLength(0);
    }

    admit({
      schemaVersion: 1,
      userId: "user-1",
      connection: {
        connectionId: "gmail-1",
        packageId: "composio",
        connectionTypeId: "gmail",
        displayName: "Gmail",
        safeMetadata: { providerAlias: "gmail-1" },
      },
    });
    expect(admitted).toEqual([
      {
        schemaVersion: 1,
        userId: "user-1",
        connection: {
          connectionId: "gmail-1",
          packageId: "composio",
          connectionTypeId: "gmail",
          displayName: "Gmail",
          safeMetadata: { providerAlias: "gmail-1" },
        },
      },
    ]);
  });

  test("accepts the canonical RPC identifier grammar", () => {
    expect(
      decodeStartConnectionRpcV1({
        schemaVersion: 1,
        userId: "person@example.com",
        connection: {
          connectionId: "gmail-1",
          packageId: "composio",
          connectionTypeId: "gmail",
          displayName: "Gmail",
        },
      }).userId,
    ).toBe("person@example.com");
  });

  test("accepts the maximum composed User and Bot session identifier", () => {
    const userId = "u".repeat(128);
    const botId = "b".repeat(128);
    expect(
      decodeBotRunRpcV1({
        schemaVersion: 1,
        userId,
        botId,
        command: {
          runId: "run-1",
          sessionId: `${userId}:${botId}`,
          acceptedAt: "2026-08-29T00:00:00.000Z",
          text: "hello",
        },
      }).command.sessionId,
    ).toHaveLength(257);
  });

  test("refuses a turn type or origin carried over the Bot run RPC", () => {
    // Only an in-Durable-Object producer may admit a Turn as anything but
    // chat, so the RPC that crosses from the gateway accepts neither field.
    const command = {
      runId: "run-1",
      sessionId: "user-1:bot-1",
      acceptedAt: "2026-08-29T00:00:00.000Z",
      text: "hello",
    } as const;

    for (const extra of [
      { turnType: "automation" },
      { turnType: "chat" },
      {
        origin: {
          kind: "routine",
          routineId: "r",
          fireId: "f",
          trigger: "cron",
        },
      },
    ]) {
      expect(() =>
        decodeBotRunRpcV1({
          schemaVersion: 1,
          userId: "user-1",
          botId: "bot-1",
          command: { ...command, ...extra },
        }),
      ).toThrow(/RPC request.command/);
    }
  });

  test("admits agent provenance only through the internal agent RPC", () => {
    const request = {
      schemaVersion: 1,
      userId: "user-1",
      botId: "researcher",
      command: {
        runId: "agent-run-1",
        sessionId: "user-1:researcher",
        acceptedAt: "2026-09-04T00:00:00.000Z",
        text: "What changed?",
        source: {
          kind: "bot",
          fromBotId: "general",
          fromBotName: "General",
          messageId: "agent-run-1",
        },
      },
    } as const;
    expect(decodeBotAgentRunRpcV1(request)).toEqual(request);
    expect(
      decodeBotAgentRunRpcV1({
        ...request,
        command: {
          ...request.command,
          source: { kind: "voice", messageId: "voice-ask-1" },
        },
      }),
    ).toEqual({
      ...request,
      command: {
        ...request.command,
        source: { kind: "voice", messageId: "voice-ask-1" },
      },
    });
    expect(() =>
      decodeBotAgentRunRpcV1({
        ...request,
        command: {
          ...request.command,
          source: { ...request.command.source, extra: true },
        },
      }),
    ).toThrow(/command.source is invalid/);
  });

  test("rejects version-skewed Bot runs before Agent admission", () => {
    const admitted: unknown[] = [];
    const admit = (input: unknown) => admitted.push(decodeBotRunRpcV1(input));
    const command = {
      runId: "run-1",
      sessionId: "user-1:bot-1",
      acceptedAt: "2026-08-29T00:00:00.000Z",
      text: "hello",
    };

    expect(() =>
      admit({
        schemaVersion: 2,
        userId: "user-1",
        botId: "bot-1",
        command,
      }),
    ).toThrow("RPC request is invalid");
    expect(() =>
      admit({
        schemaVersion: 1,
        userId: "user-1",
        botId: "bot-1",
        command: { ...command, internal: true },
      }),
    ).toThrow("RPC request.command is invalid");
    expect(() =>
      admit({
        schemaVersion: 1,
        userId: "user-1",
        botId: "bot-1",
        command: { ...command, runId: "run:1" },
      }),
    ).toThrow("runId is invalid");
    expect(() =>
      admit({
        schemaVersion: 1,
        userId: "user-1",
        botId: "bot-1",
        command: { ...command, acceptedAt: "not-a-timestamp" },
      }),
    ).toThrow("acceptedAt is invalid");
    expect(() =>
      admit({
        schemaVersion: 1,
        userId: "user-1",
        botId: "bot-1",
        command: { ...command, text: "🧪".repeat(8_001) },
      }),
    ).toThrow("text is invalid");
    expect(admitted).toHaveLength(0);

    admit({
      schemaVersion: 1,
      userId: "user-1",
      botId: "bot-1",
      command,
    });
    expect(admitted).toEqual([
      {
        schemaVersion: 1,
        userId: "user-1",
        botId: "bot-1",
        command,
      },
    ]);
  });
});

const BOOTSTRAP_GENERATION = "2026-08-31T00:00:00.000Z:0123456789abcdef";
const AUTHORED_GENERATION = "2026-09-01T00:00:00.000Z:fedcba9876543210";

function decodeCompositionListRpc(input: unknown) {
  return decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    query: rpcObject(
      {
        limit: rpcInteger({
          minimum: 1,
          maximum: MAX_COMPOSITION_GENERATION_PAGE_V1,
        }),
      },
      { cursor: rpcString(512) },
    ),
  });
}

function decodeCompositionRevertRpc(input: unknown) {
  return decodeRpcEnvelopeV1(input, {
    userId: rpcIdentifier,
    botId: rpcBotId,
    command: rpcDecoded(decodeRevertCompositionCommandV1),
  });
}

describe("Composition Durable Object RPC boundaries", () => {
  test("bounds the generation list page and its cursor", () => {
    expect(
      decodeCompositionListRpc({
        schemaVersion: 1,
        userId: "user-1",
        botId: "alpha",
        query: { limit: 10, cursor: "composition:index:x" },
      }),
    ).toEqual({
      schemaVersion: 1,
      userId: "user-1",
      botId: "alpha",
      query: { limit: 10, cursor: "composition:index:x" },
    });

    for (const query of [
      { limit: 0 },
      { limit: MAX_COMPOSITION_GENERATION_PAGE_V1 + 1 },
      { limit: 1.5 },
      { limit: "10" },
      { limit: 10, cursor: "" },
      { limit: 10, page: 2 },
      {},
    ]) {
      expect(() =>
        decodeCompositionListRpc({
          schemaVersion: 1,
          userId: "user-1",
          botId: "alpha",
          query,
        }),
      ).toThrow();
    }
  });

  test("admits a revert command only with a distinct optimistic target", () => {
    const command = {
      schemaVersion: 1,
      type: "composition/revert",
      commandId: "composition-revert-1",
      botId: "alpha",
      toGenerationId: BOOTSTRAP_GENERATION,
      expectedGenerationId: AUTHORED_GENERATION,
    };
    expect(
      decodeCompositionRevertRpc({
        schemaVersion: 1,
        userId: "user-1",
        botId: "alpha",
        command,
      }),
    ).toEqual({
      schemaVersion: 1,
      userId: "user-1",
      botId: "alpha",
      command,
    });

    for (const invalid of [
      { ...command, expectedGenerationId: BOOTSTRAP_GENERATION },
      { ...command, type: "composition/apply" },
      { ...command, commandId: "lost response" },
      { ...command, toGenerationId: "bad/generation" },
      { ...command, botId: "bad@bot" },
      { ...command, extra: true },
    ]) {
      expect(() =>
        decodeCompositionRevertRpc({
          schemaVersion: 1,
          userId: "user-1",
          botId: "alpha",
          command: invalid,
        }),
      ).toThrow();
    }
  });
});
