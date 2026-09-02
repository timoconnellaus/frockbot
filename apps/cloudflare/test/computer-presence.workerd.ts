// The deployed Bot Durable Object Computer path against the real host wire.
// Unit tests prove each record and transition; this proves that composition,
// RPC, the provider-neutral adapter and the Computer-host binding meet.
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, test } from "vitest";
import {
  decodeComputerCommandReceiptV1,
  decodeComputerProjectionV1,
} from "@frockbot/plugin-computer/protocol";
import { provisionBot } from "./provision-bot.ts";

const HOST = "http://computer-host.internal";

beforeAll(async () => {
  const response = await env.COMPUTER_HOST.fetch(
    new Request(`${HOST}/__fake/reset`, { method: "POST" }),
  );
  expect(response.status).toBe(200);
});

describe("hosted Computer presence", () => {
  test("connects to a viewer and records a human-control lease end to end", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `computer-user-${suffix}`,
      botId: `computer-bot-${suffix}`,
    };
    await provisionBot(identity);
    const computer = env.BOT_STATES.getByName(
      `${identity.userId}:${identity.botId}`,
    );

    const connected = decodeComputerCommandReceiptV1(
      await computer.executeComputerPresenceCommand({
        schemaVersion: 1,
        ...identity,
        command: {
          version: 1,
          commandId: `connect-${suffix}`,
          botId: identity.botId,
          type: "connect",
        },
      }),
    );
    expect(connected.status).toBe("applied");
    const ready = decodeComputerProjectionV1(
      await computer.readComputerPresence({ schemaVersion: 1, ...identity }),
    );
    expect(ready).toMatchObject({
      phase: "ready",
      viewerSession: {
        version: 1,
        id: "fake-viewer-token",
        url: "https://fake-sprite.example/vnc.html#autoconnect=1",
      },
    });

    const taken = decodeComputerCommandReceiptV1(
      await computer.executeComputerPresenceCommand({
        schemaVersion: 1,
        ...identity,
        command: {
          version: 1,
          commandId: `take-${suffix}`,
          botId: identity.botId,
          type: "takeControl",
        },
      }),
    );
    expect(taken.status).toBe("applied");
    const controlled = decodeComputerProjectionV1(
      await computer.readComputerPresence({ schemaVersion: 1, ...identity }),
    );
    expect(controlled.phase).toBe("human-control");
    expect(controlled.controlLease).toMatchObject({
      version: 1,
      ownerId: expect.any(String),
      acquiredAt: expect.any(String),
      expiresAt: expect.any(String),
    });
  });
});
