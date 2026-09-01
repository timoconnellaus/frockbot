import { describe, expect, it } from "bun:test";
import {
  channelTokenDigestV1,
  channelTokenNonceV1,
  channelTokenSecretV1,
  ChannelTokenError,
  decodeChannelTokenKeyV1,
  mintChannelTokenV1,
  verifyChannelTokenV1,
  type ChannelTokenClaimsV1,
} from "./token.js";
import { ChannelStore } from "./store.js";
import { createMemoryChannelStorageV1 } from "./testing.js";

const KEYRING = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "test-key",
  keys: { "test-key": "A".repeat(43) },
});

const CLAIMS: ChannelTokenClaimsV1 = {
  u: "user-1",
  c: "channel-1",
  k: "connection-1",
  n: "nonce-1",
  v: 1,
};

const SECRET = "channel-token-secret-0123456789abcdef";

describe("the Channel token secret", () => {
  it("is derived from the keyring rather than being the keyring's own key", async () => {
    const secret = await channelTokenSecretV1(KEYRING);
    expect(secret.length).toBeGreaterThan(32);
    expect(secret).not.toContain("A".repeat(43));
    expect(await channelTokenSecretV1(KEYRING)).toBe(secret);
  });

  it("changes when the keyring's current key changes", async () => {
    const rotated = JSON.stringify({
      schemaVersion: 1,
      currentKeyId: "next-key",
      keys: { "next-key": "B".repeat(43) },
    });
    expect(await channelTokenSecretV1(rotated)).not.toBe(
      await channelTokenSecretV1(KEYRING),
    );
  });
});

describe("minting and verifying one Channel's token", () => {
  it("answers with the claims it was minted from", async () => {
    const token = await mintChannelTokenV1(SECRET, CLAIMS);
    expect(await verifyChannelTokenV1(SECRET, token)).toEqual(CLAIMS);
  });

  it("refuses a token whose payload was tampered with", async () => {
    const token = await mintChannelTokenV1(SECRET, CLAIMS);
    const forged = await mintChannelTokenV1(SECRET, {
      ...CLAIMS,
      c: "channel-2",
    });
    const tampered = `${forged.split(".")[0]}.${token.split(".")[1]}`;
    await expect(verifyChannelTokenV1(SECRET, tampered)).rejects.toThrow(
      /unknown/,
    );
  });

  it("refuses a token minted under a different secret", async () => {
    const token = await mintChannelTokenV1("another-secret-0123456789", CLAIMS);
    await expect(verifyChannelTokenV1(SECRET, token)).rejects.toThrow(
      /unknown/,
    );
  });

  it("answers a refusal as a 404, never as a hint that a Channel exists", async () => {
    const error = await verifyChannelTokenV1(SECRET, "not-a-token").catch(
      (thrown: unknown) => thrown,
    );
    expect(error).toBeInstanceOf(ChannelTokenError);
    expect((error as ChannelTokenError).status).toBe(404);
  });

  it("mints a different token for the same Channel on every nonce", async () => {
    const first = await mintChannelTokenV1(SECRET, {
      ...CLAIMS,
      n: channelTokenNonceV1(),
    });
    const second = await mintChannelTokenV1(SECRET, {
      ...CLAIMS,
      n: channelTokenNonceV1(),
    });
    expect(first).not.toBe(second);
  });
});

describe("the durable key record", () => {
  const record = {
    schemaVersion: 1 as const,
    channelId: "channel-1",
    connectionId: "connection-1",
    keyVersion: 1,
    digest: "a".repeat(64),
    createdAt: "2026-09-01T00:00:00.000Z",
  };

  it("decodes a well-formed record and refuses an unknown field", () => {
    expect(decodeChannelTokenKeyV1(record)).toEqual(record);
    expect(() =>
      decodeChannelTokenKeyV1({ ...record, token: "leaked" }),
    ).toThrow(/unknown field/);
  });

  it("refuses a digest that is not a SHA-256 hex digest", () => {
    expect(() =>
      decodeChannelTokenKeyV1({ ...record, digest: "short" }),
    ).toThrow(/digest is invalid/);
  });
});

describe("the Channel that holds a token", () => {
  async function connected() {
    const storage = createMemoryChannelStorageV1();
    const store = new ChannelStore(storage);
    await store.execute(
      {
        schemaVersion: 1,
        commandId: "create-1",
        botId: "bot-a",
        type: "channel/create",
        channelId: "channel-1",
        name: "Telegram",
        members: ["bot-a"],
        kind: "external",
        connectionId: "connection-1",
      },
      { kind: "user" },
    );
    const token = await mintChannelTokenV1(SECRET, CLAIMS);
    await store.putTokenKey({
      schemaVersion: 1,
      channelId: "channel-1",
      connectionId: "connection-1",
      keyVersion: 1,
      digest: await channelTokenDigestV1(token),
      createdAt: new Date().toISOString(),
    });
    return { store, token, storage };
  }

  it("holds the digest of the token it minted, and never the token", async () => {
    const { store, token, storage } = await connected();
    expect(
      await store.holdsTokenDigest(
        "channel-1",
        await channelTokenDigestV1(token),
        1,
      ),
    ).toBe(true);
    expect(JSON.stringify([...storage.map.values()])).not.toContain(token);
  });

  it("refuses a valid token presented at another Channel", async () => {
    const { store, token } = await connected();
    expect(
      await store.holdsTokenDigest(
        "channel-2",
        await channelTokenDigestV1(token),
        1,
      ),
    ).toBe(false);
  });

  it("refuses a token whose key version has moved on", async () => {
    const { store, token } = await connected();
    expect(
      await store.holdsTokenDigest(
        "channel-1",
        await channelTokenDigestV1(token),
        2,
      ),
    ).toBe(false);
  });

  it("refuses a revoked token, and revoking twice is not an error", async () => {
    const { store, token } = await connected();
    await store.revokeTokenKey("channel-1");
    await store.revokeTokenKey("channel-1");
    expect(
      await store.holdsTokenDigest(
        "channel-1",
        await channelTokenDigestV1(token),
        1,
      ),
    ).toBe(false);
  });
});

describe("an external Channel's record and its posts", () => {
  it("records the peer as the sender and still owes its one member the message", async () => {
    const store = new ChannelStore(createMemoryChannelStorageV1());
    await store.execute(
      {
        schemaVersion: 1,
        commandId: "create-1",
        botId: "bot-a",
        type: "channel/create",
        channelId: "channel-1",
        name: "Telegram",
        members: ["bot-a"],
        kind: "external",
        connectionId: "connection-1",
      },
      { kind: "user" },
    );
    const receipt = await store.execute(
      {
        schemaVersion: 1,
        commandId: "post-1",
        botId: "bot-a",
        type: "channel/post",
        channelId: "channel-1",
        messageId: "tg-42",
        text: "hello from Telegram",
        senderPeer: "telegram-9001",
      },
      { kind: "user" },
    );
    expect(receipt.status).toBe("posted");
    if (receipt.status !== "posted") return;
    expect(receipt.channel.kind).toBe("external");
    expect(receipt.channel.connectionId).toBe("connection-1");
    expect(receipt.message.senderPeer).toBe("telegram-9001");
    expect(receipt.message.senderBotId).toBeUndefined();
    // The peer is not a member, so the Bot it addressed is owed the message.
    expect(receipt.recipients).toEqual(["bot-a"]);
  });

  it("still excludes a Bot from its own post in the same Channel", async () => {
    const store = new ChannelStore(createMemoryChannelStorageV1());
    await store.execute(
      {
        schemaVersion: 1,
        commandId: "create-1",
        botId: "bot-a",
        type: "channel/create",
        channelId: "channel-1",
        name: "Telegram",
        members: ["bot-a"],
        kind: "external",
        connectionId: "connection-1",
      },
      { kind: "user" },
    );
    const receipt = await store.execute(
      {
        schemaVersion: 1,
        commandId: "post-2",
        botId: "bot-a",
        type: "channel/post",
        channelId: "channel-1",
        text: "my reply",
      },
      { kind: "user" },
    );
    expect(receipt.status).toBe("posted");
    if (receipt.status !== "posted") return;
    expect(receipt.message.senderBotId).toBe("bot-a");
    expect(receipt.recipients).toEqual([]);
  });
});
