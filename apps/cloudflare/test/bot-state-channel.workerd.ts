import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { decodeBotStateChannelFrameV1 } from "@frockbot/core/protocol";
import { decodeComputerProjectionV1 } from "@frockbot/computer/protocol";
import {
  BotStateChannel,
  BOT_STATE_CHANNEL_INTERNAL_PATH,
  BOT_STATE_CHANNEL_RETENTION,
} from "../src/bot-state-channel.ts";
import { provisionBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";

function bot(identity: { userId: string; botId: string }) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

async function openSocket(
  identity: { userId: string; botId: string },
  cursor?: string,
  epoch?: string,
  drafts = false,
): Promise<WebSocket> {
  const url = new URL(
    BOT_STATE_CHANNEL_INTERNAL_PATH,
    "https://bot-state.internal",
  );
  url.searchParams.set("version", "1");
  if (cursor !== undefined) url.searchParams.set("cursor", cursor);
  if (epoch !== undefined) url.searchParams.set("epoch", epoch);
  if (drafts) url.searchParams.set("drafts", "1");
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

/** Frames up to and including the first `until` accepts. */
function framesUntil(
  socket: WebSocket,
  until: (frame: ReturnType<typeof decodeBotStateChannelFrameV1>) => boolean,
): Promise<ReturnType<typeof decodeBotStateChannelFrameV1>[]> {
  return new Promise((resolve, reject) => {
    const read: ReturnType<typeof decodeBotStateChannelFrameV1>[] = [];
    const timeout = setTimeout(
      () => reject(new Error("socket frames timed out")),
      10_000,
    );
    const listener = (event: MessageEvent) => {
      let frame: ReturnType<typeof decodeBotStateChannelFrameV1>;
      try {
        if (typeof event.data !== "string") throw new Error("non-text frame");
        frame = decodeBotStateChannelFrameV1(event.data);
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
        return;
      }
      read.push(frame);
      if (!until(frame)) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(read);
    };
    socket.addEventListener("message", listener);
  });
}

/** The next `count` frames, read by one listener so none can slip past. */
function frames(
  socket: WebSocket,
  count: number,
): Promise<ReturnType<typeof decodeBotStateChannelFrameV1>[]> {
  return new Promise((resolve, reject) => {
    const read: ReturnType<typeof decodeBotStateChannelFrameV1>[] = [];
    const timeout = setTimeout(
      () => reject(new Error("socket frames timed out")),
      5_000,
    );
    const listener = (event: MessageEvent) => {
      try {
        if (typeof event.data !== "string") throw new Error("non-text frame");
        read.push(decodeBotStateChannelFrameV1(event.data));
      } catch (error) {
        clearTimeout(timeout);
        reject(error);
        return;
      }
      if (read.length < count) return;
      clearTimeout(timeout);
      socket.removeEventListener("message", listener);
      resolve(read);
    };
    socket.addEventListener("message", listener);
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
      type: "state/snapshot",
      reason: "initial",
    });
    expect(await nextFrame(socket)).toMatchObject({ type: "state/ready" });
    await evictDurableObject(stub);

    const pushed = nextFrame(socket);
    expect(await runDurableObjectAlarm(stub)).toBe(true);
    expect(await pushed).toMatchObject({
      type: "state/update",
      kind: "computer",
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

    const socket = await openSocket(identity, "1", "1");
    expect(await nextFrame(socket)).toMatchObject({
      type: "state/update",
      cursor: "2",
      kind: "computer",
    });
    expect(await nextFrame(socket)).toMatchObject({
      type: "state/update",
      cursor: "3",
      kind: "computer",
    });
    expect(await nextFrame(socket)).toEqual({
      schemaVersion: 1,
      type: "state/ready",
      epoch: "1",
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

    const socket = await openSocket(identity, "0", "1");
    expect(await nextFrame(socket)).toMatchObject({
      type: "state/snapshot",
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

  test("a reply draft reaches only the observer that asked, across hibernation", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `state-draft-user-${suffix}`,
      botId: `state-draft-bot-${suffix}`,
    };
    await initialize(identity);
    const stub = bot(identity);
    const drafting = await openSocket(identity, undefined, undefined, true);
    expect(await frames(drafting, 2)).toMatchObject([
      { type: "state/snapshot" },
      { type: "state/ready" },
    ]);
    const installed = await openSocket(identity);
    expect(await frames(installed, 2)).toMatchObject([
      { type: "state/snapshot" },
      { type: "state/ready" },
    ]);
    await evictDurableObject(stub);

    const drafted = frames(drafting, 2);
    const committed = frames(installed, 1);
    await runInDurableObject(stub, async (_instance, state) => {
      const channel = new BotStateChannel(state);
      channel.broadcastDraft({ runId: "run-1", ordinal: 0, parts: ["Hel"] });
      await channel.computerStorage.put("computer:test:after", 1);
    });
    const [draft, update] = await drafted;
    expect(draft).toEqual({
      schemaVersion: 1,
      type: "state/draft",
      runId: "run-1",
      ordinal: 0,
      parts: ["Hel"],
    });
    // The draft appended nothing, so the committed write is the next cursor.
    expect(update).toMatchObject({ type: "state/update", cursor: "1" });
    // The observer that did not ask sees the committed write, and nothing
    // before it: a draft would have failed its decoder.
    expect(await committed).toEqual([
      expect.objectContaining({ type: "state/update", kind: "computer" }),
    ]);
    drafting.close(1000, "done");
    installed.close(1000, "done");
  });
});

describe("a Turn's reply on the state channel", () => {
  test("is drawn as a draft before the message that replaces it lands", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `state-reply-user-${suffix}`,
      botId: `state-reply-bot-${suffix}`,
    };
    await initialize(identity);
    const socket = await openSocket(identity, undefined, undefined, true);
    expect(await frames(socket, 2)).toMatchObject([
      { type: "state/snapshot" },
      { type: "state/ready" },
    ]);

    const runId = `reply-draft-${suffix}`;
    const seen = framesUntil(
      socket,
      (frame) => frame.type === "state/update" && frame.kind === "message",
    );
    await (
      bot(identity) as unknown as { run(command: unknown): Promise<unknown> }
    ).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: toolCallTriggerPrompt([
          "send_to_user",
          {
            disposition: "finish",
            payload: { type: "text", text: "Written while you watch." },
          },
        ]),
      },
    });

    const received = await seen;
    const drafts = received.filter((frame) => frame.type === "state/draft");
    expect(drafts.at(-1)).toEqual({
      schemaVersion: 1,
      type: "state/draft",
      runId,
      ordinal: 0,
      parts: ["Written while you watch."],
    });
    expect(received.at(-1)).toMatchObject({
      type: "state/update",
      kind: "message",
      payload: {
        runId,
        event: {
          ordinal: 0,
          payload: { type: "text", text: "Written while you watch." },
        },
      },
    });
    socket.close(1000, "done");
  });
});
