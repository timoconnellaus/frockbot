import { describe, expect, test } from "bun:test";
import {
  decodePushRegistration,
  deliverPush,
  registerPushDevice,
  RetryablePushError,
  type PushDevice,
  type PushUpdate,
} from "./push.js";
import { base64urlDecodeV1, base64urlEncodeV1 } from "@frockbot/core/crypto";
import {
  decodeWebPushSubscriptionV1,
  generateVapidKeysV1,
  parseVapidKeysV1,
  sendWebPush,
  vapidAuthorizationV1,
} from "./web-push.js";

const encoder = new TextEncoder();

/** A browser's side of a subscription: its key pair and auth secret. */
async function browser(endpoint = "https://fcm.googleapis.com/fcm/send/abc") {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  const auth = crypto.getRandomValues(new Uint8Array(16));
  return {
    pair,
    auth,
    token: JSON.stringify({
      endpoint,
      keys: {
        p256dh: base64urlEncodeV1(publicKey),
        auth: base64urlEncodeV1(auth),
      },
    }),
    publicKey,
  };
}

async function hkdf(
  salt: Uint8Array<ArrayBuffer>,
  ikm: Uint8Array<ArrayBuffer>,
  info: string | Uint8Array<ArrayBuffer>,
  bytes: number,
) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      {
        name: "HKDF",
        hash: "SHA-256",
        salt,
        info: typeof info === "string" ? encoder.encode(info) : info,
      },
      key,
      bytes * 8,
    ),
  );
}

/** RFC 8291 decryption as the browser does it, written from the RFC. */
async function decrypt(
  receiver: Awaited<ReturnType<typeof browser>>,
  body: Uint8Array,
): Promise<string> {
  const salt = body.slice(0, 16);
  const recordSize = new DataView(body.buffer, body.byteOffset).getUint32(16);
  const idLength = body[20]!;
  const senderPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  expect(recordSize).toBe(4096);
  const senderKey = await crypto.subtle.importKey(
    "raw",
    senderPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const shared = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: senderKey },
      receiver.pair.privateKey,
      256,
    ),
  );
  const info = new Uint8Array([
    ...encoder.encode("WebPush: info\0"),
    ...receiver.publicKey,
    ...senderPublic,
  ]);
  const ikm = await hkdf(receiver.auth, shared, info, 32);
  const cek = await hkdf(salt, ikm, "Content-Encoding: aes128gcm\0", 16);
  const nonce = await hkdf(salt, ikm, "Content-Encoding: nonce\0", 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, [
    "decrypt",
  ]);
  const plain = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce },
      key,
      ciphertext,
    ),
  );
  // The last record ends with the 0x02 delimiter and no padding.
  expect(plain.at(-1)).toBe(2);
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe("VAPID keys", () => {
  test("a generated pair round-trips through the secret's shape", async () => {
    const keys = await generateVapidKeysV1("https://bot.example.com");
    expect(parseVapidKeysV1(JSON.stringify(keys))).toEqual(keys);
    expect(base64urlDecodeV1(keys.publicKey)).toHaveLength(65);
    expect(() =>
      parseVapidKeysV1(JSON.stringify({ ...keys, subject: "bot.example" })),
    ).toThrow();
    expect(() =>
      parseVapidKeysV1(JSON.stringify({ ...keys, privateKey: "short" })),
    ).toThrow();
  });

  test("the authorization is an ES256 token for the push service's origin", async () => {
    const keys = await generateVapidKeysV1("https://bot.example.com");
    const now = Date.UTC(2026, 8, 30);
    const header = await vapidAuthorizationV1(
      JSON.stringify(keys),
      "https://web.push.apple.com/QGuQyavXutnMH/abc",
      now,
    );
    const match = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
    expect(match).not.toBeNull();
    const [, head, claims, signature, k] = match!;
    expect(k).toBe(keys.publicKey);
    expect(
      JSON.parse(new TextDecoder().decode(base64urlDecodeV1(head!))),
    ).toEqual({
      typ: "JWT",
      alg: "ES256",
    });
    expect(
      JSON.parse(new TextDecoder().decode(base64urlDecodeV1(claims!))),
    ).toEqual({
      aud: "https://web.push.apple.com",
      exp: now / 1000 + 12 * 3600,
      sub: "https://bot.example.com",
    });
    const verifier = await crypto.subtle.importKey(
      "raw",
      base64urlDecodeV1(keys.publicKey),
      { name: "ECDSA", namedCurve: "P-256" },
      false,
      ["verify"],
    );
    expect(
      await crypto.subtle.verify(
        { name: "ECDSA", hash: "SHA-256" },
        verifier,
        base64urlDecodeV1(signature!),
        encoder.encode(`${head}.${claims}`),
      ),
    ).toBe(true);
  });
});

describe("Web Push subscriptions", () => {
  test("only a known push service and well-formed keys are accepted", async () => {
    const good = await browser();
    expect(decodeWebPushSubscriptionV1(good.token).endpoint).toBe(
      "https://fcm.googleapis.com/fcm/send/abc",
    );
    for (const endpoint of [
      "https://updates.push.services.mozilla.com/wpush/v2/abc",
      "https://web.push.apple.com/abc",
      "https://wns2-par02p.notify.windows.com/w/?token=abc",
    ]) {
      const { token } = await browser(endpoint);
      expect(() => decodeWebPushSubscriptionV1(token)).not.toThrow();
    }
    for (const endpoint of [
      "http://fcm.googleapis.com/fcm/send/abc",
      "https://example.com/push",
      "https://fcm.googleapis.com.evil.example/push",
      "https://evilfcm.googleapis.com/push",
      "https://user@fcm.googleapis.com/push",
      "https://fcm.googleapis.com:8443/push",
    ]) {
      const { token } = await browser(endpoint);
      expect(() => decodeWebPushSubscriptionV1(token)).toThrow();
    }
    const keys = JSON.parse(good.token).keys;
    for (const token of [
      "not json",
      JSON.stringify({ endpoint: "https://fcm.googleapis.com/x" }),
      JSON.stringify({
        endpoint: "https://fcm.googleapis.com/x",
        keys: { ...keys, auth: "AAAA" },
      }),
      JSON.stringify({
        endpoint: "https://fcm.googleapis.com/x",
        keys: { ...keys, p256dh: base64urlEncodeV1(new Uint8Array(65)) },
      }),
    ])
      expect(() => decodeWebPushSubscriptionV1(token)).toThrow();
  });
});

describe("sending Web Push", () => {
  async function send(status: number) {
    const keys = JSON.stringify(
      await generateVapidKeysV1("https://bot.example.com"),
    );
    const receiver = await browser();
    let seen: { url: string; init: RequestInit } | undefined;
    const request = (async (url: string, init: RequestInit) => {
      seen = { url, init };
      return new Response(null, { status });
    }) as unknown as typeof fetch;
    const data = { botId: "primary", cursor: "message-1", body: "Hi" };
    const result = sendWebPush(keys, receiver.token, data, true, request);
    return { result, seen: () => seen!, receiver, data };
  }

  test("a 201 is sent, with the headers the push service needs", async () => {
    const { result, seen, receiver, data } = await send(201);
    expect(await result).toBe("sent");
    const { url, init } = seen();
    expect(url).toBe("https://fcm.googleapis.com/fcm/send/abc");
    const headers = init.headers as Record<string, string>;
    expect(headers["Content-Encoding"]).toBe("aes128gcm");
    expect(headers.TTL).toBe("86400");
    expect(headers.Urgency).toBe("high");
    expect(headers.Authorization).toStartWith("vapid t=");
    expect(
      JSON.parse(await decrypt(receiver, init.body as Uint8Array)),
    ).toEqual(data);
  });

  test("404 and 410 mean the subscription is gone", async () => {
    expect(await (await send(404)).result).toBe("unregistered");
    expect(await (await send(410)).result).toBe("unregistered");
  });

  test("429 and 5xx are retried by key; other refusals are not", async () => {
    await expect((await send(429)).result).rejects.toBeInstanceOf(
      RetryablePushError,
    );
    await expect((await send(503)).result).rejects.toBeInstanceOf(
      RetryablePushError,
    );
    const refused = (await send(403)).result;
    await expect(refused).rejects.toThrow("Web push delivery failed (403)");
    await expect(refused).rejects.not.toBeInstanceOf(RetryablePushError);
  });
});

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  get<T>(key: string) {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }
  put(key: string, value: unknown) {
    this.values.set(key, value);
    return Promise.resolve();
  }
  delete(key: string) {
    return Promise.resolve(this.values.delete(key));
  }
  list<T>(options: { prefix?: string } = {}) {
    return Promise.resolve(
      new Map(
        [...this.values].filter(([key]) =>
          key.startsWith(options.prefix ?? ""),
        ),
      ) as Map<string, T>,
    );
  }
  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>) {
    return callback(this);
  }
}

describe("delivering to a browser", () => {
  const update = (
    kind: "message" | "read",
    notify: boolean,
    cursor = "message-00000000000000000001",
  ): PushUpdate => ({
    botId: "primary",
    cursor,
    kind,
    title: "Primary",
    body: "Hello",
    notify,
  });

  async function registered() {
    const durable = new MemoryStorage() as unknown as DurableObjectStorage;
    const receiver = await browser();
    expect(
      await registerPushDevice(durable, {
        deviceId: "browser-1",
        token: receiver.token,
        platform: "web",
      }),
    ).toBe(true);
    return { durable, receiver };
  }

  const noFcm = async () => {
    throw new Error("a browser is never sent through FCM");
  };
  const noRelay = async () => {
    throw new Error("a browser is never sent through the relay");
  };

  test("a browser is sent only what it must show", async () => {
    const { durable, receiver } = await registered();
    const sent: { subscription: string; notify: boolean }[] = [];
    const web = async (
      subscription: string,
      _data: Record<string, string>,
      notify: boolean,
    ) => {
      sent.push({ subscription, notify });
      return "sent" as const;
    };
    for (const [kind, notify] of [
      ["read", false],
      ["message", false],
    ] as const)
      await deliverPush(
        durable,
        "user-1",
        update(kind, notify),
        undefined,
        noFcm,
        noRelay,
        web,
      );
    expect(sent).toEqual([]);
    await deliverPush(
      durable,
      "user-1",
      update("message", true),
      undefined,
      noFcm,
      noRelay,
      web,
    );
    expect(sent).toEqual([{ subscription: receiver.token, notify: true }]);
  });

  test("a browser is reached with the VAPID keys, never Firebase", async () => {
    const { durable } = await registered();
    // FCM credentials alone leave a browser unreachable, not an FCM send.
    await deliverPush(
      durable,
      "user-1",
      update("message", true),
      "configured",
      noFcm,
      noRelay,
    );
    expect(await durable.list({ prefix: "push:delivery:" })).toEqual(new Map());
  });

  test("a subscription the push service reports gone is forgotten", async () => {
    const { durable } = await registered();
    const keys = JSON.stringify(
      await generateVapidKeysV1("https://bot.example.com"),
    );
    const request = (async () =>
      new Response(null, { status: 410 })) as unknown as typeof fetch;
    await deliverPush(
      durable,
      "user-1",
      update("message", true),
      undefined,
      noFcm,
      noRelay,
      (subscription, data, notify) =>
        sendWebPush(keys, subscription, data, notify, request),
    );
    expect(
      await durable.get<PushDevice>("push:device:browser-1"),
    ).toBeUndefined();
    expect(await durable.list({ prefix: "push:delivery:" })).toEqual(new Map());
  });

  test("a web registration must carry a subscription, not an FCM token", async () => {
    expect(() =>
      decodePushRegistration({
        deviceId: "browser-1",
        token: "token-a-12345678901234567890",
        platform: "web",
      }),
    ).toThrow();
    const receiver = await browser();
    expect(
      decodePushRegistration({
        deviceId: "browser-1",
        token: receiver.token,
        platform: "web",
      }).platform,
    ).toBe("web");
  });
});
