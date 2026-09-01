// The Channel authority, against an in-memory storage seam.
//
// Four claims, and they are the whole of what N1 promises about the record:
// a command applies once; a post writes its deliveries in the same breath as
// the message; the sender is never a recipient; and the three bounds — hop,
// quota, membership — refuse with something that can be read back.
import { describe, expect, test } from "bun:test";
import {
  CHANNEL_HOP_MAX,
  CHANNEL_RATE_LIMIT,
  pairChannelIdV1,
} from "./records.js";
import { ChannelStore } from "./store.js";
import { createMemoryChannelStorageV1 as memoryStorage } from "./testing.js";
import { channelDeliveryPrefixV1 } from "./storage-keys.js";
import type { ChannelCommandV1 } from "./shared.js";

const WRITER = {
  kind: "bot" as const,
  botId: "alpha",
  sessionId: "session-1",
  turnId: "turn-1",
};

function create(
  commandId: string,
  members: string[],
  botId = "alpha",
): ChannelCommandV1 {
  return {
    schemaVersion: 1,
    type: "channel/create",
    commandId,
    botId,
    channelId: "room",
    name: "The room",
    members,
  };
}

function post(
  commandId: string,
  text: string,
  options: { botId?: string; hop?: number } = {},
): ChannelCommandV1 {
  return {
    schemaVersion: 1,
    type: "channel/post",
    commandId,
    botId: options.botId ?? "alpha",
    channelId: "room",
    text,
    ...(options.hop === undefined ? {} : { hop: options.hop }),
  };
}

describe("ChannelStore command receipts", () => {
  test("replays a repeated command id and refuses a reused one", async () => {
    const store = new ChannelStore(memoryStorage());
    const first = await store.execute(
      create("cmd-1", ["alpha", "beta"]),
      WRITER,
    );
    const replay = await store.execute(
      create("cmd-1", ["alpha", "beta"]),
      WRITER,
    );
    expect(replay).toEqual(first);

    await expect(
      store.execute(create("cmd-1", ["alpha", "gamma"]), WRITER),
    ).rejects.toThrow(/was reused for a different command/);
  });

  test("a post writes the message and one delivery per recipient at once", async () => {
    const storage = memoryStorage();
    const store = new ChannelStore(storage);
    await store.execute(create("cmd-1", ["alpha", "beta", "gamma"]), WRITER);
    const receipt = await store.execute(post("cmd-2", "hello"), WRITER);
    expect(receipt).toMatchObject({
      status: "posted",
      // The sender is never a recipient of its own post.
      recipients: ["beta", "gamma"],
    });
    if (receipt.status !== "posted") throw new Error("expected a post");

    const deliveries = await store.deliveries(receipt.message.messageId);
    expect(deliveries.map((delivery) => delivery.botId)).toEqual([
      "beta",
      "gamma",
    ]);
    expect(deliveries.every((delivery) => delivery.state === "pending")).toBe(
      true,
    );
    // Both records are in storage, which is what "the same transaction" buys.
    expect(
      [...storage.map.keys()].filter((key) =>
        key.startsWith(channelDeliveryPrefixV1(receipt.message.messageId)),
      ),
    ).toHaveLength(2);
  });

  test("seq is assigned by the store, and messages keep their order", async () => {
    const store = new ChannelStore(memoryStorage());
    await store.execute(create("cmd-1", ["alpha", "beta"]), WRITER);
    await store.execute(post("cmd-2", "one"), WRITER);
    await store.execute(post("cmd-3", "two"), WRITER);
    const thread = await store.thread("room");
    expect(
      thread.messages.map((message) => [message.seq, message.text]),
    ).toEqual([
      [0, "one"],
      [1, "two"],
    ]);
  });

  test("a delivery is marked once, and keeps the run it first named", async () => {
    const store = new ChannelStore(memoryStorage());
    await store.execute(create("cmd-1", ["alpha", "beta"]), WRITER);
    const receipt = await store.execute(post("cmd-2", "hello"), WRITER);
    if (receipt.status !== "posted") throw new Error("expected a post");
    await store.markAdmitted(receipt.message.messageId, "beta", "run-1");
    await store.markAdmitted(receipt.message.messageId, "beta", "run-2");
    expect(await store.deliveries(receipt.message.messageId)).toEqual([
      {
        schemaVersion: 1,
        channelId: "room",
        messageId: receipt.message.messageId,
        botId: "beta",
        state: "admitted",
        runId: "run-1",
      },
    ]);
  });
});

describe("ChannelStore membership rules", () => {
  test("a Channel holds 1 to 6 Bots", async () => {
    const store = new ChannelStore(memoryStorage());
    await expect(store.execute(create("cmd-1", []), WRITER)).rejects.toThrow(
      /at least 1 Bot/,
    );
    await expect(
      store.execute(
        create("cmd-2", ["a", "b", "c", "d", "e", "f", "g"]),
        WRITER,
      ),
    ).rejects.toThrow(/at most 6 Bots/);
  });

  test("only a member may update, and a Channel is never emptied", async () => {
    const store = new ChannelStore(memoryStorage());
    await store.execute(create("cmd-1", ["alpha", "beta"]), WRITER);

    expect(
      await store.execute(
        {
          schemaVersion: 1,
          type: "channel/update",
          commandId: "cmd-2",
          botId: "outsider",
          channelId: "room",
          addMemberIds: ["gamma"],
        },
        WRITER,
      ),
    ).toMatchObject({ status: "refused", refusal: "not-a-member" });

    expect(
      await store.execute(
        {
          schemaVersion: 1,
          type: "channel/update",
          commandId: "cmd-3",
          botId: "alpha",
          channelId: "room",
          removeMemberIds: ["alpha", "beta"],
        },
        WRITER,
      ),
    ).toMatchObject({ status: "refused", refusal: "membership" });
  });

  test("a member update records a new revision and the new membership", async () => {
    const store = new ChannelStore(memoryStorage());
    await store.execute(create("cmd-1", ["alpha", "beta"]), WRITER);
    const receipt = await store.execute(
      {
        schemaVersion: 1,
        type: "channel/update",
        commandId: "cmd-2",
        botId: "alpha",
        channelId: "room",
        addMemberIds: ["gamma"],
        removeMemberIds: ["beta"],
      },
      WRITER,
    );
    expect(receipt).toMatchObject({
      status: "applied",
      channel: { members: ["alpha", "gamma"], revision: 2 },
    });
  });

  test("a disconnected Channel keeps its history and takes no message", async () => {
    const store = new ChannelStore(memoryStorage());
    await store.execute(create("cmd-1", ["alpha", "beta"]), WRITER);
    await store.execute(post("cmd-2", "before"), WRITER);
    await store.execute(
      {
        schemaVersion: 1,
        type: "channel/disconnect",
        commandId: "cmd-3",
        botId: "alpha",
        channelId: "room",
      },
      WRITER,
    );
    expect(await store.execute(post("cmd-4", "after"), WRITER)).toMatchObject({
      status: "refused",
      refusal: "inactive",
    });
    expect((await store.thread("room")).messages).toHaveLength(1);
  });
});

describe("ChannelStore loop and cost bounds", () => {
  test(`a post beyond ${CHANNEL_HOP_MAX} hops is refused, and is recorded`, async () => {
    const store = new ChannelStore(memoryStorage());
    await store.execute(create("cmd-1", ["alpha", "beta"]), WRITER);
    expect(
      await store.execute(
        post("cmd-2", "still fine", { hop: CHANNEL_HOP_MAX }),
        WRITER,
      ),
    ).toMatchObject({ status: "posted" });
    const refused = await store.execute(
      post("cmd-3", "too far", { hop: CHANNEL_HOP_MAX + 1 }),
      WRITER,
    );
    expect(refused).toMatchObject({ status: "refused", refusal: "hop" });
    // The refusal is durable: the same command id answers the same way.
    expect(
      await store.execute(
        post("cmd-3", "too far", { hop: CHANNEL_HOP_MAX + 1 }),
        WRITER,
      ),
    ).toEqual(refused);
    expect((await store.thread("room")).messages).toHaveLength(1);
  });

  test("the token bucket refuses past its rate and reopens in the next window", async () => {
    let now = Date.UTC(2026, 8, 1);
    const store = new ChannelStore(memoryStorage(), {
      now: () => new Date(now),
    });
    await store.execute(create("cmd-1", ["alpha", "beta"]), WRITER);
    for (let index = 0; index < CHANNEL_RATE_LIMIT; index += 1) {
      expect(
        await store.execute(post(`fill-${index}`, `message ${index}`), WRITER),
      ).toMatchObject({ status: "posted" });
    }
    expect(
      await store.execute(post("over", "one too many"), WRITER),
    ).toMatchObject({ status: "refused", refusal: "quota" });

    now += 60_001;
    expect(
      await store.execute(post("next-window", "a minute later"), WRITER),
    ).toMatchObject({ status: "posted" });
  });

  test("a reaction is idempotent on (message, bot, emoji) and wakes nobody", async () => {
    const storage = memoryStorage();
    const store = new ChannelStore(storage);
    await store.execute(create("cmd-1", ["alpha", "beta"]), WRITER);
    const posted = await store.execute(post("cmd-2", "hello"), WRITER);
    if (posted.status !== "posted") throw new Error("expected a post");
    const before = [...storage.map.keys()].filter((key) =>
      key.startsWith("channel-delivery:"),
    ).length;

    const react = (commandId: string): ChannelCommandV1 => ({
      schemaVersion: 1,
      type: "channel/react",
      commandId,
      botId: "beta",
      channelId: "room",
      messageId: posted.message.messageId,
      emoji: "👍",
    });
    expect(await store.execute(react("r-1"), WRITER)).toMatchObject({
      status: "reacted",
      added: true,
    });
    expect(await store.execute(react("r-2"), WRITER)).toMatchObject({
      status: "reacted",
      added: false,
    });
    const thread = await store.thread("room");
    expect(thread.messages[0]?.reactions).toEqual([
      { emoji: "👍", botId: "beta", at: expect.any(String) },
    ]);
    // No delivery was written, so nothing can cascade from a tapback.
    expect(
      [...storage.map.keys()].filter((key) =>
        key.startsWith("channel-delivery:"),
      ),
    ).toHaveLength(before);
  });

  test("an unknown Channel and an unknown message refuse rather than throw", async () => {
    const store = new ChannelStore(memoryStorage());
    expect(await store.execute(post("cmd-1", "hello"), WRITER)).toMatchObject({
      status: "refused",
      refusal: "unknown-channel",
    });
    await store.execute(create("cmd-2", ["alpha"]), WRITER);
    expect(
      await store.execute(
        {
          schemaVersion: 1,
          type: "channel/react",
          commandId: "cmd-3",
          botId: "alpha",
          channelId: "room",
          messageId: "nope",
          emoji: "👍",
        },
        WRITER,
      ),
    ).toMatchObject({ status: "refused", refusal: "unknown-message" });
  });
});

describe("the implicit pair Channel", () => {
  test("both directions name the same room", () => {
    expect(pairChannelIdV1("alpha", "beta")).toBe(
      pairChannelIdV1("beta", "alpha"),
    );
  });

  test("a Bot has no pair Channel with itself", () => {
    expect(() => pairChannelIdV1("alpha", "alpha")).toThrow(/with itself/);
  });

  test("creating one twice is creating it once", async () => {
    const store = new ChannelStore(memoryStorage());
    const channelId = pairChannelIdV1("alpha", "beta");
    const open = (commandId: string): ChannelCommandV1 => ({
      schemaVersion: 1,
      type: "channel/create",
      commandId,
      botId: "alpha",
      channelId,
      name: "alpha and beta",
      members: ["alpha", "beta"],
    });
    const first = await store.execute(open("open-1"), WRITER);
    const second = await store.execute(open("open-2"), WRITER);
    expect(second).toMatchObject({ status: "applied" });
    if (first.status !== "applied" || second.status !== "applied") {
      throw new Error("expected both to apply");
    }
    expect(second.channel).toEqual(first.channel);
    expect((await store.list("alpha")).channels).toHaveLength(1);
  });
});
