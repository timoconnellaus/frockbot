import { describe, expect, test } from "bun:test";
import type {
  ConnectionCommandReceiptV1,
  ConnectionCommandV1,
} from "@frockbot/connection-core";
import { createSettingsBackendContribution } from "./backend.js";

function host(receiptOverride?: unknown) {
  const executed: ConnectionCommandV1[] = [];
  const receipts = new Map<string, ConnectionCommandReceiptV1>();
  return {
    executed,
    contribution: createSettingsBackendContribution({
      executeConnection: (_userId, command) => {
        executed.push(command);
        if (receiptOverride !== undefined) {
          return Promise.resolve(receiptOverride as ConnectionCommandReceiptV1);
        }
        const receipt = {
          schemaVersion: 1,
          commandId: command.commandId,
          connectionId:
            "connectionId" in command
              ? command.connectionId
              : "connection-test",
          status: "applied",
        } satisfies ConnectionCommandReceiptV1;
        receipts.set(command.commandId, receipt);
        return Promise.resolve(receipt);
      },
      lookupConnectionCommand: (_userId, _packageId, commandId) =>
        Promise.resolve(receipts.get(commandId)),
    }),
  };
}

function route(
  contribution: ReturnType<typeof createSettingsBackendContribution>,
  path: string,
  init?: RequestInit & { userId?: string },
) {
  const url = new URL(`https://frockbot.test${path}`);
  return contribution.route(new Request(url, init), url, {
    userId: init?.userId ?? "alice",
    client: "browser",
  });
}

const createCommand = JSON.stringify({
  schemaVersion: 1,
  type: "connection/create-api-key",
  commandId: "ollama-connect-1",
  packageId: "provider-ollama-cloud",
  connectionTypeId: "ollama-cloud-account",
  label: "Work",
  apiKey: "write-only-secret",
});

describe("Settings Connection gateway Contribution", () => {
  test("owns only the provider-neutral Connection routes", async () => {
    const { contribution } = host();
    expect(await route(contribution, "/api/settings")).toBeUndefined();
    expect(await route(contribution, "/api/bots")).toBeUndefined();
    expect(
      await route(contribution, "/api/connections", { userId: "" }),
    ).toBeUndefined();
    expect((await route(contribution, "/api/connections"))?.status).toBe(405);
    expect(
      (
        await route(contribution, "/api/connection-commands", {
          method: "POST",
        })
      )?.status,
    ).toBe(405);
  });

  test("admits a Connection command and its receipt lookup", async () => {
    const { contribution, executed } = host();
    const response = await route(contribution, "/api/connections", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: createCommand,
    });
    expect(response?.status).toBe(200);
    expect((await response?.json()) as unknown).toEqual({
      schemaVersion: 1,
      commandId: "ollama-connect-1",
      connectionId: "connection-test",
      status: "applied",
    });
    expect(executed).toHaveLength(1);

    const lookup = await route(
      contribution,
      "/api/connection-commands?packageId=provider-ollama-cloud&commandId=ollama-connect-1",
    );
    expect((await lookup?.json()) as unknown).toEqual({
      schemaVersion: 1,
      commandId: "ollama-connect-1",
      connectionId: "connection-test",
      status: "applied",
    });

    const missing = await route(
      contribution,
      "/api/connection-commands?packageId=provider-ollama-cloud&commandId=absent-1",
    );
    expect((await missing?.json()) as unknown).toBeNull();
  });

  test("rejects invalid command IDs and lookup queries", async () => {
    const { contribution, executed } = host();
    expect(
      (
        await route(contribution, "/api/connections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            schemaVersion: 1,
            type: "connection/refresh-models",
            commandId: "lost response",
            connectionId: "connection-test",
          }),
        })
      )?.status,
    ).toBe(400);
    expect(executed).toHaveLength(0);
    for (const query of [
      "?packageId=provider-ollama-cloud",
      "?packageId=provider-ollama-cloud&commandId=connect-1&extra=true",
      "?packageId=provider-ollama-cloud&packageId=other&commandId=connect-1",
      "?packageId=bad%2Fpackage&commandId=connect-1",
      "?packageId=provider-ollama-cloud&commandId=lost%20response",
    ]) {
      expect(
        (await route(contribution, `/api/connection-commands${query}`))?.status,
      ).toBe(400);
    }
  });

  test("rejects malformed receipts returned by the User authority", async () => {
    const { contribution } = host({
      schemaVersion: 1,
      commandId: "ollama-connect-malformed",
      connectionId: "connection-test",
      status: "applied",
      credential: "must-not-cross-the-seam",
    });

    expect(
      (
        await route(contribution, "/api/connections", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: createCommand,
        })
      )?.status,
    ).toBe(400);
  });
});
