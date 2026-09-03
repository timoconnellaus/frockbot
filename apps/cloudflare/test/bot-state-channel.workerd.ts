import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { decodeBotStateChannelFrameV1 } from "@frockbot/protocol";
import { decodeComputerProjectionV1 } from "@frockbot/plugin-computer/protocol";
import {
  BotStateChannel,
  BOT_STATE_CHANNEL_INTERNAL_PATH,
  BOT_STATE_CHANNEL_RETENTION,
} from "../src/bot-state-channel.ts";
import { provisionBot } from "./provision-bot.ts";

function bot(identity: { userId: string; botId: string }) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

async function openSocket(
  identity: { userId: string; botId: string },
  cursor?: string,
): Promise<WebSocket> {
  const url = new URL(
    BOT_STATE_CHANNEL_INTERNAL_PATH,
    "https://bot-state.internal",
  );
  url.searchParams.set("version", "1");
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  const response = await bot(identity).fetch(
    new Request(url, {
      headers: {
        upgrade: "websocket",
        "x-frockbot-user-id": identity.userId,
        "x-frockbot-bot-id": identity.botId,
      },
    }),
  );
  expect(response.status).toBe(101);
  const socket = response.webSocket;
  if (!socket) throw new Error("upgrade returned no WebSocket");
  socket.accept();
  return socket;
}

function nextFrame(
  socket: WebSocket,
): Promise<ReturnType<typeof decodeBotStateChannelFrameV1>> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(new Error("socket frame timed out")),
      5_000,
    );
    socket.addEventListener(
      "message",
      (event) => {
        clearTimeout(timeout);
        try {
          if (typeof event.data !== "string") throw new Error("non-text frame");
          resolve(decodeBotStateChannelFrameV1(event.data));
        } catch (error) {
          reject(error);
        }
      },
      { once: true },
    );
  });
}

async function initialize(identity: { userId: string; botId: string }) {
  await provisionBot(identity);
  // Materializes the Bot's durable identity before the internal fetch seam.
  await bot(identity).readComputerPresence({ schemaVersion: 1, ...identity });
}

describe("hibernatable Bot-state channel", () => {
  test("survives eviction and delivers scheduled Computer progress after revival", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `state-socket-user-${suffix}`,
      botId: `state-socket-bot-${suffix}`,
    };
    await initialize(identity);
    const stub = bot(identity);
    const accepted = await stub.executeComputerPresenceCommand({
      schemaVersion: 1,
      ...identity,
      command: {
        version: 1,
        commandId: `connect-${suffix}`,
        botId: identity.botId,
        type: "connect",
      },
    });
    expect(accepted).toMatchObject({ version: 2, status: "accepted" });

    const socket = await openSocket(identity);
    expect(await nextFrame(socket)).toMatchObject({
      type: "state/reset",
      reason: "initial",
    });
    expect(await nextFrame(socket)).toMatchObject({ type: "state/ready" });
    await evictDurableObject(stub);

    const pushed = nextFrame(socket);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await pushed).toMatchObject({
      type: "state/event",
      topic: "computer",
    });
    expect(
      decodeComputerProjectionV1(
        await stub.readComputerPresence({ schemaVersion: 1, ...identity }),
      ).phase,
    ).toBe("ready");
    socket.close(1000, "done");
  });

  test("resume sends exactly the events after the presented cursor", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `state-resume-user-${suffix}`,
      botId: `state-resume-bot-${suffix}`,
    };
    await initialize(identity);
    const stub = bot(identity);
    await runInDurableObject(stub, async (_instance, state) => {
      const channel = new BotStateChannel(state);
      await channel.computerStorage.put("computer:test:one", 1);
      await channel.computerStorage.put("computer:test:two", 2);
      await channel.computerStorage.put("computer:test:three", 3);
    });

    const socket = await openSocket(identity, "1");
    expect(await nextFrame(socket)).toMatchObject({
      type: "state/event",
      cursor: "2",
    });
    expect(await nextFrame(socket)).toMatchObject({
      type: "state/event",
      cursor: "3",
    });
    expect(await nextFrame(socket)).toEqual({
      schemaVersion: 1,
      type: "state/ready",
      cursor: "3",
    });
    socket.close(1000, "done");
  });

  test("a cursor older than the retained tail receives an explicit reset", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `state-gap-user-${suffix}`,
      botId: `state-gap-bot-${suffix}`,
    };
    await initialize(identity);
    const stub = bot(identity);
    await runInDurableObject(stub, async (_instance, state) => {
      const channel = new BotStateChannel(state);
      for (let index = 0; index <= BOT_STATE_CHANNEL_RETENTION; index += 1) {
        await channel.computerStorage.put(`computer:test:${index}`, index);
      }
    });

    const socket = await openSocket(identity, "0");
    expect(await nextFrame(socket)).toEqual({
      schemaVersion: 1,
      type: "state/reset",
      cursor: String(BOT_STATE_CHANNEL_RETENTION + 1),
      reason: "gap",
    });
    expect(await nextFrame(socket)).toMatchObject({ type: "state/ready" });
    socket.close(1000, "done");
  });

  test("dropping the observer does not cancel scheduled connect work", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `state-drop-user-${suffix}`,
      botId: `state-drop-bot-${suffix}`,
    };
    await initialize(identity);
    const stub = bot(identity);
    await stub.executeComputerPresenceCommand({
      schemaVersion: 1,
      ...identity,
      command: {
        version: 1,
        commandId: `connect-${suffix}`,
        botId: identity.botId,
        type: "connect",
      },
    });
    const socket = await openSocket(identity);
    const completion = runDurableObjectAlarm(stub);
    socket.close(1000, "observer detached");

    expect(await completion).toBe(true);
    expect(
      decodeComputerProjectionV1(
        await stub.readComputerPresence({ schemaVersion: 1, ...identity }),
      ).phase,
    ).toBe("ready");
  });
});
