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
  message: "Ready to start",
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
  test("serves the frame its projection named, immutable, and 404s a replaced one", async () => {
    const hash = "a".repeat(64);
    const asked: string[] = [];
    const contribution = createComputerBackendContribution({
      readComputer: () => Promise.resolve(projection),
      readComputerFrame: (_userId, _botId, contentHash) => {
        asked.push(contentHash);
        return Promise.resolve(
          contentHash === hash ? new Uint8Array([137, 80, 78, 71]) : undefined,
        );
      },
      executeComputerCommand: () => {
        throw new Error("must not execute");
      },
    });
    const url = (value: string) =>
      new URL(`https://app.test/api/bots/scout/computer/frame/${value}`);

    const served = await contribution.route(new Request(url(hash)), url(hash), {
      userId: "user-1",
      client: "desktop",
    });
    expect(served?.status).toBe(200);
    expect(served?.headers.get("content-type")).toBe("image/png");
    expect(served?.headers.get("cache-control")).toContain("immutable");
    expect(new Uint8Array(await served!.arrayBuffer())).toEqual(
      new Uint8Array([137, 80, 78, 71]),
    );

    const stale = await contribution.route(
      new Request(url("b".repeat(64))),
      url("b".repeat(64)),
      { userId: "user-1", client: "desktop" },
    );
    expect(stale?.status).toBe(404);

    // Anything but a SHA-256 is not a frame route at all.
    expect(
      await contribution.route(
        new Request(url("not-a-hash")),
        url("not-a-hash"),
        { userId: "user-1", client: "desktop" },
      ),
    ).toBeUndefined();
    expect(asked).toEqual([hash, "b".repeat(64)]);
  });

  test("rejects malformed exact DTOs before the host or storage is touched", async () => {
    let calls = 0;
    const contribution = createComputerBackendContribution({
      readComputerFrame: () => Promise.resolve(undefined),
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
      readComputerFrame: () => Promise.resolve(undefined),
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
      readComputerFrame: () => Promise.resolve(undefined),
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

  test("decodes refreshViewer and returns the authority's replayed receipt", async () => {
    let effects = 0;
    const receipts = new Map<string, ComputerCommandReceiptV1>();
    const contribution = createComputerBackendContribution({
      readComputerFrame: () => Promise.resolve(undefined),
      readComputer: () => Promise.resolve(projection),
      executeComputerCommand: (_userId, _botId, decoded) => {
        const replay = receipts.get(decoded.commandId);
        if (replay) return Promise.resolve(replay);
        effects += 1;
        const receipt: ComputerCommandReceiptV1 = {
          version: 1,
          commandId: decoded.commandId,
          type: decoded.type,
          status: "applied",
          completedAt: "2026-09-02T00:00:00.000Z",
        };
        receipts.set(decoded.commandId, receipt);
        return Promise.resolve(receipt);
      },
    });
    const execute = () =>
      contribution.route(
        request({
          version: 1,
          commandId: "viewer-renew-1",
          botId: "scout",
          type: "refreshViewer",
        }),
        new URL("https://app.test/api/bots/scout/computer/commands"),
        { userId: "user-1", client: "browser" },
      );

    const first = await execute();
    const duplicate = await execute();

    expect(await first?.json()).toEqual(await duplicate?.json());
    expect(effects).toBe(1);
  });
});
