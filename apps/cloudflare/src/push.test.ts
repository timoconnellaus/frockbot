import { describe, expect, test } from "bun:test";
import {
  decodePushRegistration,
  deliverPush,
  registerPushDevice,
  RetryablePushError,
  sendFcm,
  sendRelay,
  type PushDevice,
  type PushRelayAddressV1,
  type PushUpdate,
} from "./push.js";
import { base64urlEncodeV1 } from "@frockbot/core/crypto";
import { openPushV1 } from "@frockbot/core/push";

class MemoryStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, value);
    else
      for (const [entry, stored] of Object.entries(key))
        this.values.set(entry, stored);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: { prefix?: string } = {}): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()].filter(([key]) =>
          key.startsWith(options.prefix ?? ""),
        ),
      ) as Map<string, T>,
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const TOKEN_A = "token-a-12345678901234567890";
const TOKEN_B = "token-b-12345678901234567890";
const SECRET = "configured";
const message = (cursor = "message-00000000000000000001"): PushUpdate => ({
  botId: "primary",
  cursor,
  kind: "message",
  title: "Primary",
  body: "Hello",
  notify: true,
});

function storage(): DurableObjectStorage {
  return new MemoryStorage() as unknown as DurableObjectStorage;
}

describe("push device registry", () => {
  test("strictly decodes registrations before they reach the user registry", () => {
    expect(
      decodePushRegistration({
        deviceId: "phone-1",
        token: TOKEN_A,
        activeBotId: "primary",
      }),
    ).toEqual({ deviceId: "phone-1", token: TOKEN_A, activeBotId: "primary" });
    expect(
      decodePushRegistration({
        deviceId: "iphone-1",
        token: TOKEN_A,
        platform: "ios",
      }),
    ).toEqual({ deviceId: "iphone-1", token: TOKEN_A, platform: "ios" });
    for (const invalid of [
      {},
      { deviceId: "phone-1", token: "short" },
      { deviceId: "phone-1", activeBotId: "not valid" },
      { deviceId: "phone-1", remove: "yes" },
      { deviceId: "phone-1", token: TOKEN_A, authority: "other-user" },
      { deviceId: "phone-1", token: TOKEN_A, platform: "macos" },
      // A platform describes a token; a presence update carries neither.
      { deviceId: "phone-1", platform: "ios" },
    ])
      expect(() => decodePushRegistration(invalid)).toThrow();
  });

  test("the platform is the token's: kept by a presence update, replaced with the token", async () => {
    const durable = storage();
    const now = Date.now();
    expect(
      await registerPushDevice(
        durable,
        { deviceId: "iphone-1", token: TOKEN_A, platform: "ios" },
        now - 2_000,
      ),
    ).toBe(true);
    expect(
      await registerPushDevice(
        durable,
        { deviceId: "iphone-1", activeBotId: "primary" },
        now - 1_000,
      ),
    ).toBe(false);
    expect(await durable.get<PushDevice>("push:device:iphone-1")).toEqual({
      deviceId: "iphone-1",
      token: TOKEN_A,
      platform: "ios",
      activeBotId: "primary",
      updatedAt: now - 1_000,
    });
    expect(
      await registerPushDevice(
        durable,
        { deviceId: "iphone-1", token: TOKEN_B },
        now,
      ),
    ).toBe(true);
    expect(await durable.get<PushDevice>("push:device:iphone-1")).toEqual({
      deviceId: "iphone-1",
      token: TOKEN_B,
      updatedAt: now,
    });
  });

  test("delivery names each token's platform", async () => {
    const durable = storage();
    const now = Date.now();
    await registerPushDevice(
      durable,
      { deviceId: "iphone-1", token: TOKEN_A, platform: "ios" },
      now,
    );
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_B, platform: "android" },
      now,
    );
    const targets: Array<{ token: string; platform?: string }> = [];
    await deliverPush(
      durable,
      "user-1",
      message(),
      SECRET,
      async (_secret, target) => {
        targets.push(target);
        return "sent";
      },
    );
    expect(targets).toEqual([
      { token: TOKEN_A, platform: "ios" },
      { token: TOKEN_B, platform: "android" },
    ]);
  });

  test("token refresh replaces one installation and removal deletes it", async () => {
    const durable = storage();
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      100,
    );
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_B, activeBotId: "primary" },
      200,
    );

    expect(await durable.list({ prefix: "push:device:" })).toEqual(
      new Map([
        [
          "push:device:phone-1",
          {
            deviceId: "phone-1",
            token: TOKEN_B,
            activeBotId: "primary",
            updatedAt: 200,
          },
        ],
      ]),
    );
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", remove: true },
      300,
    );
    expect(await durable.list({ prefix: "push:device:" })).toEqual(new Map());
  });

  test("a presence update keeps the token and still lets go of the Bot", async () => {
    // The app registers its token once, then says which Bot it is reading from
    // the first frame of every launch — before the FCM token has been fetched
    // back. That tokenless registration used to erase the only address the Bot
    // could reach, and the alerts raised in that window were dropped outright.
    const durable = storage();
    const now = Date.now();
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A, activeBotId: "primary" },
      now - 1_000,
    );
    await registerPushDevice(durable, { deviceId: "phone-1" }, now);

    expect(await durable.get<PushDevice>("push:device:phone-1")).toEqual({
      deviceId: "phone-1",
      token: TOKEN_A,
      updatedAt: now,
    });
    const sends: string[] = [];
    await deliverPush(
      durable,
      "user-1",
      message(),
      SECRET,
      async (_secret, { token }) => {
        sends.push(token);
        return "sent";
      },
    );

    // Reachable, and no longer reading the Bot, so the alert is not held back.
    expect(sends).toEqual([TOKEN_A]);
  });
});

describe("push dispatch", () => {
  test("no token recipients makes an unconfigured deployment a clean no-op", async () => {
    const durable = storage();
    await registerPushDevice(
      durable,
      {
        deviceId: "browser-presence",
        activeBotId: "primary",
      },
      Date.now(),
    );
    let sends = 0;

    await expect(
      deliverPush(durable, "user-1", message(), undefined, async () => {
        sends += 1;
        return "sent";
      }),
    ).resolves.toBeUndefined();

    expect(sends).toBe(0);
    expect(await durable.list({ prefix: "push:delivery:" })).toEqual(new Map());
  });

  test("one focused device defers the alert, then an expired lease delivers it", async () => {
    const durable = storage();
    const now = Date.now();
    await registerPushDevice(
      durable,
      { deviceId: "desktop-1", activeBotId: "primary" },
      now,
    );
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      now,
    );
    const sends: Array<{
      token: string;
      notify: boolean;
      data: Record<string, string>;
    }> = [];

    const sender = async (
      _secret: string,
      { token }: { token: string },
      data: Record<string, string>,
      notify: boolean,
    ) => {
      sends.push({ token, notify, data });
      return "sent" as const;
    };

    await expect(
      deliverPush(durable, "user-1", message(), SECRET, sender),
    ).rejects.toBeInstanceOf(RetryablePushError);
    expect(sends).toEqual([]);
    await durable.put("push:device:desktop-1", {
      deviceId: "desktop-1",
      activeBotId: "primary",
      updatedAt: now - 15_001,
    });
    await deliverPush(durable, "user-1", message(), SECRET, sender);

    expect(sends).toEqual([
      {
        token: TOKEN_A,
        notify: true,
        data: expect.objectContaining({ notify: "true" }),
      },
    ]);
  });

  test("expired presence and focus on another Bot do not suppress an alert", async () => {
    const durable = storage();
    const now = Date.now();
    await registerPushDevice(
      durable,
      { deviceId: "old-view", activeBotId: "primary" },
      now - 15_001,
    );
    await registerPushDevice(
      durable,
      { deviceId: "other-view", activeBotId: "other" },
      now,
    );
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      now,
    );
    const notified: boolean[] = [];

    await deliverPush(
      durable,
      "user-1",
      message(),
      SECRET,
      async (_secret, _token, _data, notify) => {
        notified.push(notify);
        return "sent";
      },
    );

    expect(notified).toEqual([true]);
  });

  test("a Group Chat alert opens the group, defers to it, and keeps its own cursor", async () => {
    const durable = storage();
    const now = Date.now();
    const GROUP = "g-0123456789abcdef0123";
    await registerPushDevice(
      durable,
      { deviceId: "desktop-1", activeBotId: GROUP },
      now,
    );
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      now,
    );
    const sends: Array<Record<string, string>> = [];
    const sender = async (
      _secret: string,
      _target: { token: string },
      data: Record<string, string>,
    ) => {
      sends.push(data);
      return "sent" as const;
    };
    const grouped = { ...message(), groupId: GROUP };

    // The group is open on the desktop: the alert waits, as it would for a
    // Bot's own chat.
    await expect(
      deliverPush(durable, "user-1", grouped, SECRET, sender),
    ).rejects.toBeInstanceOf(RetryablePushError);
    await durable.put("push:device:desktop-1", {
      deviceId: "desktop-1",
      activeBotId: GROUP,
      updatedAt: now - 15_001,
    });
    await deliverPush(durable, "user-1", grouped, SECRET, sender);
    // The author's own chat has a cursor of its own, which a group alert
    // never advances.
    await deliverPush(durable, "user-1", message(), SECRET, sender);

    expect(sends).toEqual([
      expect.objectContaining({ botId: "primary", groupId: GROUP }),
      expect.not.objectContaining({ groupId: expect.anything() }),
    ]);
    expect([
      ...(await durable.list({ prefix: "push:delivery:" })).keys(),
    ]).toEqual([
      `push:delivery:group:${GROUP}:message:phone-1`,
      "push:delivery:primary:message:phone-1",
    ]);
  });

  test("a duplicate dispatch does not send a message/device delivery twice", async () => {
    const durable = storage();
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      Date.now(),
    );
    let sends = 0;
    const sender = async () => {
      sends += 1;
      return "sent" as const;
    };

    await deliverPush(durable, "user-1", message(), SECRET, sender);
    await deliverPush(durable, "user-1", message(), SECRET, sender);

    expect(sends).toBe(1);
  });

  test("an uncertain external send is recorded and never blindly repeated", async () => {
    const durable = storage();
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      Date.now(),
    );
    let attempts = 0;
    const sender = async (): Promise<"sent"> => {
      attempts += 1;
      throw new Error("connection lost after send");
    };

    await deliverPush(durable, "user-1", message(), SECRET, sender);
    await deliverPush(durable, "user-1", message(), SECRET, sender);

    expect(attempts).toBe(1);
    expect(
      await durable.get("push:delivery:primary:message:phone-1"),
    ).toMatchObject({
      cursor: "message-00000000000000000001",
      status: "uncertain",
    });
  });

  test("an older concurrent send cannot overwrite the newer delivery receipt", async () => {
    const durable = storage();
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      Date.now(),
    );
    let releaseOld!: () => void;
    const oldBlocked = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const sender = async (
      _secret: string,
      _target: { token: string },
      data: Record<string, string>,
    ) => {
      if (data.cursor.endsWith("01")) await oldBlocked;
      return "sent" as const;
    };

    const old = deliverPush(durable, "user-1", message(), SECRET, sender);
    await Promise.resolve();
    await deliverPush(
      durable,
      "user-1",
      message("message-00000000000000000002"),
      SECRET,
      sender,
    );
    releaseOld();
    await old;

    expect(
      await durable.get("push:delivery:primary:message:phone-1"),
    ).toMatchObject({ cursor: "message-00000000000000000002", status: "sent" });
  });

  test("an unregistered token removes the installation after the claimed attempt", async () => {
    const durable = storage();
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      Date.now(),
    );
    await deliverPush(
      durable,
      "user-1",
      message(),
      SECRET,
      async () => "unregistered",
    );
    expect(await durable.get("push:device:phone-1")).toBeUndefined();
  });
});

/** A service account whose key this runtime can actually sign with. */
async function serviceAccount(email: string): Promise<string> {
  const pair = (await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  return JSON.stringify({
    project_id: "frock-bot",
    client_email: email,
    private_key: `-----BEGIN PRIVATE KEY-----\n${btoa(String.fromCharCode(...pkcs8))}\n-----END PRIVATE KEY-----\n`,
  });
}

describe("Firebase access tokens", () => {
  test("a burst mints one access token and reuses it for every send", async () => {
    const secret = await serviceAccount("burst@frock-bot.iam.example");
    const calls: string[] = [];
    const request = (async (url: string) => {
      calls.push(String(url));
      return String(url).includes("oauth2")
        ? new Response(
            JSON.stringify({ access_token: "ya29.first", expires_in: 3600 }),
            { status: 200 },
          )
        : new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(await sendFcm(secret, { token: TOKEN_A }, {}, true, request)).toBe(
        "sent",
      );
    }

    expect(calls.filter((url) => url.includes("oauth2"))).toHaveLength(1);
    expect(
      calls.filter((url) => url.includes("fcm.googleapis.com")),
    ).toHaveLength(3);
  });

  test("a token Firebase stops accepting is re-minted, not cached into failure", async () => {
    const secret = await serviceAccount("expired@frock-bot.iam.example");
    const minted: string[] = [];
    let accepted = false;
    const request = (async (url: string) => {
      if (String(url).includes("oauth2")) {
        minted.push(`ya29.${minted.length}`);
        return new Response(
          JSON.stringify({
            access_token: minted.at(-1),
            expires_in: 3600,
          }),
          { status: 200 },
        );
      }
      if (!accepted) {
        accepted = true;
        return new Response("{}", { status: 401 });
      }
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;

    await expect(
      sendFcm(secret, { token: TOKEN_A }, {}, true, request),
    ).rejects.toBeInstanceOf(RetryablePushError);
    expect(await sendFcm(secret, { token: TOKEN_A }, {}, true, request)).toBe(
      "sent",
    );

    expect(minted).toHaveLength(2);
  });
});

describe("Firebase messages", () => {
  async function sent(
    target: { token: string; platform?: "android" | "ios" },
    data: Record<string, string>,
    notify: boolean,
  ): Promise<Record<string, unknown>> {
    const secret = await serviceAccount(
      `${target.platform ?? "none"}-${notify}@frock-bot.iam.example`,
    );
    let body: { message: Record<string, unknown> } | undefined;
    const request = (async (url: string, init?: RequestInit) => {
      if (String(url).includes("oauth2"))
        return new Response(
          JSON.stringify({ access_token: "ya29.message", expires_in: 3600 }),
          { status: 200 },
        );
      body = JSON.parse(String(init?.body));
      return new Response(null, { status: 200 });
    }) as unknown as typeof fetch;
    expect(await sendFcm(secret, target, data, notify, request)).toBe("sent");
    return body!.message;
  }
  const data = {
    userId: "user-1",
    botId: "primary",
    cursor: "message-00000000000000000001",
    kind: "message",
    title: "Primary",
    body: "Hello",
    notify: "true",
  };

  test("an Android token gets the data message and nothing for APNs", async () => {
    const message = await sent(
      { token: TOKEN_A, platform: "android" },
      data,
      true,
    );
    expect(message.data).toEqual(data);
    expect(message.android).toEqual({ priority: "HIGH", ttl: "86400s" });
    expect(message.apns).toBeUndefined();
    expect((await sent({ token: TOKEN_A }, data, true)).apns).toBeUndefined();
  });

  test("an iPhone token is told what to draw, threaded by conversation", async () => {
    const alert = await sent({ token: TOKEN_A, platform: "ios" }, data, true);
    expect(alert.data).toEqual(data);
    expect(alert.apns).toMatchObject({
      headers: { "apns-priority": "10", "apns-push-type": "alert" },
      payload: {
        aps: {
          alert: { title: "Primary", body: "Hello" },
          sound: "default",
          "thread-id": "primary",
        },
      },
    });
    const expiration = Number(
      (alert.apns as { headers: Record<string, string> }).headers[
        "apns-expiration"
      ],
    );
    expect(expiration - Date.now() / 1000).toBeGreaterThan(86_000);
    const group = await sent(
      { token: TOKEN_A, platform: "ios" },
      { ...data, groupId: "g-0123456789abcdef0123", title: "", body: "" },
      true,
    );
    expect(group.apns).toMatchObject({
      payload: {
        aps: {
          alert: { title: "FrockBot", body: "New message" },
          "thread-id": "group:g-0123456789abcdef0123",
        },
      },
    });
  });

  test("an iPhone told nothing is sent a background push, never an alert", async () => {
    const quiet = await sent(
      { token: TOKEN_A, platform: "ios" },
      { ...data, kind: "read", notify: "false" },
      false,
    );
    expect(quiet.apns).toMatchObject({
      headers: { "apns-priority": "5", "apns-push-type": "background" },
      payload: { aps: { "content-available": 1 } },
    });
    expect(JSON.stringify(quiet.apns)).not.toContain("alert");
  });
});

describe("device records", () => {
  test("a removed installation takes its delivery receipts with it", async () => {
    const durable = storage();
    const now = Date.now();
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      now,
    );
    await deliverPush(durable, "user-1", message(), SECRET, async () => "sent");
    expect([
      ...(await durable.list({ prefix: "push:delivery:" })).keys(),
    ]).toEqual(["push:delivery:primary:message:phone-1"]);

    await registerPushDevice(
      durable,
      { deviceId: "phone-1", remove: true },
      now,
    );

    expect(await durable.list({ prefix: "push:delivery:" })).toEqual(new Map());
  });

  test("an expired installation leaves no delivery receipts behind", async () => {
    const durable = storage();
    const now = Date.now();
    await registerPushDevice(
      durable,
      { deviceId: "old-phone", token: TOKEN_A },
      now,
    );
    await deliverPush(durable, "user-1", message(), SECRET, async () => "sent");
    await durable.put("push:device:old-phone", {
      deviceId: "old-phone",
      token: TOKEN_A,
      updatedAt: now - 31 * 86400_000,
    });
    await registerPushDevice(
      durable,
      { deviceId: "new-phone", token: TOKEN_B },
      now,
    );

    expect([
      ...(await durable.list({ prefix: "push:delivery:" })).keys(),
    ]).toEqual([]);
    expect([
      ...(await durable.list({ prefix: "push:device:" })).keys(),
    ]).toEqual(["push:device:new-phone"]);
  });

  test("an unregistered token clears the installation's receipts too", async () => {
    const durable = storage();
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A },
      Date.now(),
    );

    await deliverPush(
      durable,
      "user-1",
      message(),
      SECRET,
      async () => "unregistered",
    );

    expect(await durable.list({ prefix: "push:delivery:" })).toEqual(new Map());
  });
});

/** A relay address with a key the test can open what was sealed to it. */
async function relayAddress(seed = "a") {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const address: PushRelayAddressV1 = {
    handle: `ph_${seed.repeat(43)}`,
    p256dh: base64urlEncodeV1(
      new Uint8Array(await crypto.subtle.exportKey("raw", pair.publicKey)),
    ),
    auth: base64urlEncodeV1(crypto.getRandomValues(new Uint8Array(16))),
  };
  return { address, privateKey: pair.privateKey };
}

describe("push relay", () => {
  test("a relay registration is an address in place of a token", async () => {
    const { address } = await relayAddress();
    expect(
      decodePushRegistration({ deviceId: "phone-1", relay: address }),
    ).toEqual({ deviceId: "phone-1", relay: address });
    for (const relay of [
      { ...address, handle: "ph_short" },
      { ...address, p256dh: address.auth },
      { ...address, auth: address.p256dh },
      { ...address, extra: "x" },
      { handle: address.handle },
      "ph_" + "a".repeat(43),
    ])
      expect(() =>
        decodePushRegistration({ deviceId: "phone-1", relay }),
      ).toThrow();
    // An installation has one address, never both.
    expect(() =>
      decodePushRegistration({
        deviceId: "phone-1",
        token: TOKEN_A,
        relay: address,
      }),
    ).toThrow();
  });

  test("a relay handle replaces a token, and a presence update keeps it", async () => {
    const durable = storage();
    const { address } = await relayAddress();
    const now = Date.now();
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", token: TOKEN_A, platform: "ios" },
      now,
    );
    expect(
      await registerPushDevice(
        durable,
        { deviceId: "phone-1", relay: address },
        now,
      ),
    ).toBe(true);
    await registerPushDevice(
      durable,
      { deviceId: "phone-1", activeBotId: "primary" },
      now,
    );
    expect(await durable.get<PushDevice>("push:device:phone-1")).toEqual({
      deviceId: "phone-1",
      relay: address,
      activeBotId: "primary",
      updatedAt: now,
    });
    // The same handle again gives the Bots nothing new.
    expect(
      await registerPushDevice(
        durable,
        { deviceId: "phone-1", relay: address },
        now,
      ),
    ).toBe(false);
  });

  test("a deployment with no FCM credentials reaches relay devices and skips tokens", async () => {
    const durable = storage();
    const { address, privateKey } = await relayAddress();
    await registerPushDevice(durable, {
      deviceId: "old-phone",
      token: TOKEN_A,
    });
    await registerPushDevice(durable, { deviceId: "phone-1", relay: address });
    const relayed: Array<{ handle: string; data: Record<string, string> }> = [];
    const fcm = async () => {
      throw new Error("no FCM credentials here");
    };
    await deliverPush(
      durable,
      "user-1",
      message(),
      undefined,
      fcm,
      async (target, data, notify) => {
        const sent = await sendRelay(
          "https://relay.test",
          target,
          data,
          notify,
          (async (_url: unknown, init?: RequestInit) => {
            relayed.push(JSON.parse(String(init?.body)));
            return new Response("{}", { status: 200 });
          }) as unknown as typeof fetch,
        );
        return sent;
      },
    );
    expect(relayed).toHaveLength(1);
    const [sent] = relayed as [
      { handle: string; data: Record<string, string>; notify: boolean },
    ];
    expect(sent.handle).toBe(address.handle);
    expect(sent.notify).toBe(true);
    // The words travel sealed, never as fields the relay could read.
    expect(Object.keys(sent.data).sort()).toEqual([
      "botId",
      "cursor",
      "kind",
      "notify",
      "sealed",
      "userId",
    ]);
    expect(JSON.stringify(sent)).not.toContain("Hello");
    expect(
      JSON.parse(
        await openPushV1({ privateKey, key: address }, sent.data.sealed!),
      ),
    ).toEqual({ title: "Primary", body: "Hello" });
  });

  test("a read goes unsealed and collapses per conversation", async () => {
    const { address } = await relayAddress();
    let sent: Record<string, unknown> | undefined;
    await sendRelay(
      "https://relay.test",
      address,
      {
        userId: "user-1",
        botId: "primary",
        cursor: "message-00000000000000000001",
        kind: "read",
        title: "",
        body: "",
        notify: "false",
      },
      false,
      (async (_url: unknown, init?: RequestInit) => {
        sent = JSON.parse(String(init?.body));
        return new Response("{}");
      }) as unknown as typeof fetch,
    );
    expect(sent).toEqual({
      handle: address.handle,
      data: {
        userId: "user-1",
        botId: "primary",
        cursor: "message-00000000000000000001",
        kind: "read",
        notify: "false",
      },
      notify: false,
      collapse: "read:primary",
    });
  });

  test("the relay's answers map to the delivery rules", async () => {
    const { address } = await relayAddress();
    const send = (status: number) =>
      sendRelay(
        "https://relay.test",
        address,
        { botId: "primary", kind: "message", notify: "false" },
        false,
        (async () => new Response("{}", { status })) as unknown as typeof fetch,
      );
    expect(await send(200)).toBe("sent");
    expect(await send(410)).toBe("unregistered");
    await expect(send(429)).rejects.toBeInstanceOf(RetryablePushError);
    await expect(send(503)).rejects.toBeInstanceOf(RetryablePushError);
    await expect(send(502)).rejects.not.toBeInstanceOf(RetryablePushError);
    const refused = send(400);
    await expect(refused).rejects.toThrow(/refused/);
    await expect(refused).rejects.not.toBeInstanceOf(RetryablePushError);
  });

  test("a handle the relay revoked drops the device, but not a newer handle", async () => {
    const durable = storage();
    const first = await relayAddress("a");
    const second = await relayAddress("b");
    await registerPushDevice(durable, {
      deviceId: "phone-1",
      relay: first.address,
    });
    await deliverPush(
      durable,
      "user-1",
      message(),
      undefined,
      sendFcm,
      async () => {
        // The app re-registered while this attempt was in flight.
        await registerPushDevice(durable, {
          deviceId: "phone-1",
          relay: second.address,
        });
        return "unregistered";
      },
    );
    expect(
      (await durable.get<PushDevice>("push:device:phone-1"))?.relay?.handle,
    ).toBe(second.address.handle);
    await deliverPush(
      durable,
      "user-1",
      message("message-00000000000000000002"),
      undefined,
      sendFcm,
      async () => "unregistered",
    );
    expect(await durable.get("push:device:phone-1")).toBeUndefined();
  });

  test("a relay rejection is retried later and an ambiguous one is never repeated", async () => {
    const durable = storage();
    const { address } = await relayAddress();
    await registerPushDevice(durable, { deviceId: "phone-1", relay: address });
    let attempts = 0;
    await expect(
      deliverPush(
        durable,
        "user-1",
        message(),
        undefined,
        sendFcm,
        async () => {
          attempts += 1;
          throw new RetryablePushError("Push relay rejected the attempt (429)");
        },
      ),
    ).rejects.toBeInstanceOf(RetryablePushError);
    expect(
      await durable.get("push:delivery:primary:message:phone-1"),
    ).toMatchObject({ status: "retry" });

    const other = storage();
    await registerPushDevice(other, { deviceId: "phone-1", relay: address });
    const ambiguous = async () => {
      attempts += 1;
      throw new TypeError("network connection lost");
    };
    await deliverPush(
      other,
      "user-1",
      message(),
      undefined,
      sendFcm,
      ambiguous,
    );
    await deliverPush(
      other,
      "user-1",
      message(),
      undefined,
      sendFcm,
      ambiguous,
    );
    expect(attempts).toBe(2);
    expect(
      await other.get("push:delivery:primary:message:phone-1"),
    ).toMatchObject({ status: "uncertain" });
  });
});
