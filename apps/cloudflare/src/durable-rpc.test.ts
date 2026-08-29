import { describe, expect, test } from "bun:test";
import {
  decodeBotRunRpcV1,
  decodeStartConnectionRpcV1,
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
