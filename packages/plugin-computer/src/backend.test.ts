import { describe, expect, test } from "bun:test";
import {
  ComputerBotNotFoundError,
  createComputerBackendContribution,
} from "./backend.js";
import type {
  ComputerCommandReceiptV1,
  ComputerProjectionV1,
} from "./protocol.js";

const projection: ComputerProjectionV1 = {
  version: 1,
  botId: "scout",
  providerLabel: "Fake Computer",
  phase: "idle",
  message: "Persistent Computer available",
  screenshots: [],
};

function request(body: unknown): Request {
  return new Request("https://app.test/api/bots/scout/computer/commands", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

describe("Computer gateway Contribution", () => {
  test("rejects malformed exact DTOs before the host or storage is touched", async () => {
    let calls = 0;
    const contribution = createComputerBackendContribution({
      readComputer: () => Promise.resolve(projection),
      executeComputerCommand: () => {
        calls += 1;
        throw new Error("must not execute");
      },
    });
    const response = await contribution.route(
      request({
        version: 1,
        commandId: "command-1",
        botId: "scout",
        type: "connect",
        unexpected: true,
      }),
      new URL("https://app.test/api/bots/scout/computer/commands"),
      { userId: "user-1", client: "browser" },
    );
    expect(response?.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("answers 404 for a foreign Bot without writing its storage", async () => {
    let writes = 0;
    const contribution = createComputerBackendContribution({
      readComputer: () => {
        throw new ComputerBotNotFoundError("scout");
      },
      executeComputerCommand: () => {
        writes += 1;
        throw new Error("must not execute");
      },
    });
    const response = await contribution.route(
      new Request("https://app.test/api/bots/scout/computer"),
      new URL("https://app.test/api/bots/scout/computer"),
      { userId: "another-user", client: "browser" },
    );
    expect(response?.status).toBe(404);
    expect(writes).toBe(0);
  });

  test("returns the authority's first receipt for a duplicate command replay", async () => {
    const first: ComputerCommandReceiptV1 = {
      version: 1,
      commandId: "command-1",
      type: "connect",
      status: "applied",
      completedAt: "2026-09-02T00:00:00.000Z",
    };
    const receipts = new Map<string, ComputerCommandReceiptV1>();
    let effects = 0;
    const contribution = createComputerBackendContribution({
      readComputer: () => Promise.resolve(projection),
      executeComputerCommand: (_userId, _botId, command) => {
        const stored = receipts.get(command.commandId);
        if (stored) return Promise.resolve(stored);
        effects += 1;
        receipts.set(command.commandId, first);
        return Promise.resolve(first);
      },
    });
    const command = {
      version: 1,
      commandId: "command-1",
      botId: "scout",
      type: "connect",
    };
    const execute = () =>
      contribution.route(
        request(command),
        new URL("https://app.test/api/bots/scout/computer/commands"),
        { userId: "user-1", client: "browser" },
      );
    const one = await execute();
    const two = await execute();
    expect(await one?.json()).toEqual(await two?.json());
    expect(effects).toBe(1);
  });
});
