import { describe, expect, test } from "bun:test";
import { RetryablePushError } from "@frockbot/core/push";
import {
  consumeV1,
  fcmMessageV1,
  HANDLE_LIFETIME_MS,
  HANDLE_SEND_LIMIT_V1,
  handleObjectV1,
  handleRelayRequestV1,
  MAX_REQUEST_BYTES,
  REGISTER_LIMIT_V1,
  SERVER_SEND_LIMIT_V1,
  type FcmSenderV1,
  type RelayObjectsV1,
  type RelayStorageV1,
} from "./relay.ts";

class Records implements RelayStorageV1 {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;
  get<T>(key: string) {
    return Promise.resolve(structuredClone(this.values.get(key)) as T);
  }
  put(key: string, value: unknown) {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
  deleteAll() {
    this.values.clear();
    this.alarmAt = undefined;
    return Promise.resolve();
  }
  setAlarm(at: number) {
    this.alarmAt = at;
    return Promise.resolve();
  }
}

/** The relay's objects in memory, on a clock the test moves. */
function relay() {
  const clock = { now: 1_800_000_000_000 };
  const records = new Map<string, Records>();
  const named = (name: string) => {
    let found = records.get(name);
    if (!found) records.set(name, (found = new Records()));
    return found;
  };
  const objects: RelayObjectsV1 = {
    handle: (handle) => {
      const storage = named(`handle:${handle}`);
      return {
        register: (registration) =>
          handleObjectV1.register(storage, registration, clock.now),
        rotate: (update) => handleObjectV1.rotate(storage, update, clock.now),
        unregister: () => handleObjectV1.unregister(storage),
        authorizeSend: () => handleObjectV1.authorizeSend(storage, clock.now),
      };
    },
    limiter: (key) => ({
      consume: (limit) =>
        consumeV1(named(`limit:${key}`), "limit", limit, clock.now),
    }),
  };
  const sent: Record<string, unknown>[] = [];
  let answer: Awaited<ReturnType<FcmSenderV1>> | Error = "sent";
  const fcm: FcmSenderV1 = async (message) => {
    sent.push(message);
    if (answer instanceof Error) throw answer;
    return answer;
  };
  const call = (path: string, body: unknown, ip = "203.0.113.7") =>
    handleRelayRequestV1(
      new Request(`https://push.frockbot.test${path}`, {
        method: "POST",
        headers: { "content-type": "application/json", "cf-connecting-ip": ip },
        body: typeof body === "string" ? body : JSON.stringify(body),
      }),
      objects,
      fcm,
      clock.now,
    );
  return {
    clock,
    records,
    sent,
    call,
    answer: (next: typeof answer) => {
      answer = next;
    },
    register: async (
      server = "https://frock.example.org",
      token = "fcm-token-12345678901234567890",
      ip?: string,
    ) => {
      const response = await call(
        "/register",
        { token, platform: "android", server },
        ip,
      );
      expect(response.status).toBe(200);
      return ((await response.json()) as { handle: string }).handle;
    },
  };
}

const data = (overrides: Record<string, string> = {}) => ({
  userId: "user-1",
  botId: "primary",
  cursor: "message-00000000000000000001",
  kind: "message",
  notify: "true",
  sealed: "c2VhbGVk",
  ...overrides,
});

describe("registration", () => {
  test("a token becomes an opaque handle; rotation keeps the handle", async () => {
    const r = relay();
    const handle = await r.register();
    expect(handle).toMatch(/^ph_[A-Za-z0-9_-]{43}$/);
    expect(handle).not.toContain("fcm-token");
    const rotated = await r.call("/register", {
      handle,
      token: "fcm-token-rotated-12345678901234",
      platform: "android",
      server: "https://frock.example.org",
    });
    expect((await rotated.json()) as unknown).toEqual({ handle });
    await r.call("/send", { handle, data: data(), notify: true });
    expect(r.sent[0]).toMatchObject({
      token: "fcm-token-rotated-12345678901234",
    });
  });

  test("a handle that is gone is not revived by a rotation", async () => {
    const r = relay();
    const response = await r.call("/register", {
      handle: `ph_${"x".repeat(43)}`,
      token: "fcm-token-12345678901234567890",
      platform: "ios",
      server: "https://frock.example.org",
    });
    expect(response.status).toBe(404);
  });

  test("refuses what is not a token, a platform or a server origin", async () => {
    const r = relay();
    const base = {
      token: "fcm-token-12345678901234567890",
      platform: "android",
      server: "https://frock.example.org",
    };
    for (const body of [
      { ...base, token: "short" },
      { ...base, token: "has spaces in it 1234567890" },
      { ...base, platform: "macos" },
      { ...base, server: "http://frock.example.org" },
      { ...base, server: "https://frock.example.org/path" },
      { ...base, server: "https://user:pass@frock.example.org" },
      { ...base, extra: true },
    ])
      expect((await r.call("/register", body)).status).toBe(400);
    expect(
      (await r.call("/register", { ...base, server: "http://127.0.0.1:8787" }))
        .status,
    ).toBe(200);
  });
});

describe("rate limits", () => {
  test("fresh registrations are limited per client address", async () => {
    const r = relay();
    for (let i = 0; i < REGISTER_LIMIT_V1.max; i++) await r.register();
    const refused = await r.call("/register", {
      token: "fcm-token-12345678901234567890",
      platform: "android",
      server: "https://frock.example.org",
    });
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    // Another address, and the same one once the window has passed.
    await r.register(undefined, undefined, "198.51.100.1");
    r.clock.now += REGISTER_LIMIT_V1.windowMs;
    await r.register();
  });

  test("sends are limited per handle, without calling FCM", async () => {
    const r = relay();
    const handle = await r.register();
    const other = await r.register();
    for (let i = 0; i < HANDLE_SEND_LIMIT_V1.max; i++)
      expect(
        (await r.call("/send", { handle, data: data(), notify: true })).status,
      ).toBe(200);
    const refused = await r.call("/send", {
      handle,
      data: data(),
      notify: true,
    });
    expect(refused.status).toBe(429);
    expect(r.sent).toHaveLength(HANDLE_SEND_LIMIT_V1.max);
    // Another handle of the same server is not held back by this one.
    expect(
      (await r.call("/send", { handle: other, data: data(), notify: true }))
        .status,
    ).toBe(200);
    r.clock.now += HANDLE_SEND_LIMIT_V1.windowMs;
    expect(
      (await r.call("/send", { handle, data: data(), notify: true })).status,
    ).toBe(200);
  });

  test("sends are limited per sending server, across its handles", async () => {
    const r = relay();
    const server = "https://busy.example.org";
    const handles: string[] = [];
    for (let i = 0; i < 3; i++)
      handles.push(await r.register(server, undefined, `192.0.2.${i}`));
    const quiet = await r.register("https://quiet.example.org");
    const limiter = r.records.get(`limit:server:${server}`) ?? new Records();
    r.records.set(`limit:server:${server}`, limiter);
    await limiter.put("window:limit", {
      start: r.clock.now,
      count: SERVER_SEND_LIMIT_V1.max,
    });
    for (const handle of handles)
      expect(
        (await r.call("/send", { handle, data: data(), notify: true })).status,
      ).toBe(429);
    expect(r.sent).toHaveLength(0);
    expect(
      (await r.call("/send", { handle: quiet, data: data(), notify: true }))
        .status,
    ).toBe(200);
  });
});

describe("revocation", () => {
  test("unregistering deletes the handle, and a send to it is answered gone", async () => {
    const r = relay();
    const handle = await r.register();
    expect((await r.call("/unregister", { handle })).status).toBe(204);
    // Idempotent: a second sign-out finds nothing and says so the same way.
    expect((await r.call("/unregister", { handle })).status).toBe(204);
    const response = await r.call("/send", {
      handle,
      data: data(),
      notify: true,
    });
    expect(response.status).toBe(410);
    expect(r.sent).toHaveLength(0);
  });

  test("a token FCM no longer knows deletes the handle and tells the server", async () => {
    const r = relay();
    const handle = await r.register();
    r.answer("unregistered");
    expect(
      (await r.call("/send", { handle, data: data(), notify: true })).status,
    ).toBe(410);
    r.answer("sent");
    expect(
      (await r.call("/send", { handle, data: data(), notify: true })).status,
    ).toBe(410);
    expect(r.sent).toHaveLength(1);
  });

  test("an unused handle expires; one in use is kept", async () => {
    const storage = new Records();
    const now = 1_800_000_000_000;
    await handleObjectV1.register(
      storage,
      {
        token: "fcm-token-12345678901234567890",
        platform: "android",
        server: "https://frock.example.org",
      },
      now,
    );
    expect(storage.alarmAt).toBe(now + HANDLE_LIFETIME_MS);
    await handleObjectV1.authorizeSend(storage, now + HANDLE_LIFETIME_MS / 2);
    await handleObjectV1.alarm(storage, now + HANDLE_LIFETIME_MS);
    expect(await storage.get("registration")).toBeDefined();
    expect(storage.alarmAt).toBe(now + HANDLE_LIFETIME_MS * 1.5);
    await handleObjectV1.alarm(storage, now + HANDLE_LIFETIME_MS * 1.5);
    expect(storage.values.size).toBe(0);
  });
});

describe("payload bounds", () => {
  test("accepts only the fields the apps read", async () => {
    const r = relay();
    const handle = await r.register();
    for (const body of [
      // Never an alert's words in the clear.
      { handle, data: data({ title: "Primary" }), notify: true },
      { handle, data: data({ body: "Hello" }), notify: true },
      { handle, data: data({ image: "https://x" }), notify: true },
      { handle, data: { ...data(), notify: true }, notify: true },
      { handle, data: data(), notify: true, priority: "high" },
      { handle, data: data({ cursor: "message-1" }), notify: true },
      { handle, data: data({ kind: "delete" }), notify: true },
      { handle, data: data({ groupId: "general" }), notify: true },
      { handle, data: data({ botId: "not valid" }), notify: true },
      { handle, data: data({ notify: "false" }), notify: true },
      { handle, data: data({ sealed: "not base64!" }), notify: true },
      { handle, data: data({ kind: "read" }), notify: true },
      // Sealed words belong to an alert only.
      { handle, data: data({ notify: "false" }), notify: false },
      { handle, data: data(), notify: true, collapse: "has spaces" },
      { handle: "ph_short", data: data(), notify: true },
    ])
      expect((await r.call("/send", body)).status).toBe(400);
    expect(r.sent).toHaveLength(0);
  });

  test("bounds the request and the sealed content", async () => {
    const r = relay();
    const handle = await r.register();
    const huge = await r.call(
      "/send",
      JSON.stringify({ handle, data: data(), notify: true }).padEnd(
        MAX_REQUEST_BYTES + 1,
      ),
    );
    expect(huge.status).toBe(413);
    const sealedTooLong = await r.call("/send", {
      handle,
      data: data({ sealed: "a".repeat(3073) }),
      notify: true,
    });
    expect(sealedTooLong.status).toBe(400);
    expect((await r.call("/send", "{not json")).status).toBe(400);
    expect(r.sent).toHaveLength(0);
  });
});

describe("delivery", () => {
  test("an Android message carries the data as it came, and a read collapses", async () => {
    const r = relay();
    const handle = await r.register();
    await r.call("/send", { handle, data: data(), notify: true });
    const read = data({ kind: "read", notify: "false" });
    delete (read as Record<string, string>).sealed;
    await r.call("/send", {
      handle,
      data: read,
      notify: false,
      collapse: "read:primary",
    });
    expect(r.sent[0]).toEqual({
      token: "fcm-token-12345678901234567890",
      data: data(),
      android: { priority: "HIGH", ttl: "86400s" },
    });
    expect(r.sent[1]).toMatchObject({
      android: { priority: "NORMAL", collapse_key: "read:primary" },
    });
  });

  test("an iPhone is told to draw a placeholder its extension replaces", () => {
    const message = fcmMessageV1(
      { token: "t", platform: "ios" },
      {
        handle: "h",
        data: data({ groupId: "g-0123456789abcdef0123" }),
        notify: true,
      },
      1_800_000_000_000,
    ) as { apns: { payload: { aps: Record<string, unknown> } } };
    expect(message.apns.payload.aps).toEqual({
      alert: { title: "FrockBot", body: "New message" },
      sound: "default",
      "mutable-content": 1,
      "thread-id": "group:g-0123456789abcdef0123",
    });
    const quiet = fcmMessageV1(
      { token: "t", platform: "ios" },
      {
        handle: "h",
        data: data({ kind: "read", notify: "false" }),
        notify: false,
        collapse: "read:primary",
      },
      1_800_000_000_000,
    ) as { apns: { headers: Record<string, string>; payload: unknown } };
    expect(quiet.apns.payload).toEqual({ aps: { "content-available": 1 } });
    expect(quiet.apns.headers["apns-collapse-id"]).toBe("read:primary");
  });

  test("a retryable FCM refusal is 503; an unknowable outcome is 502", async () => {
    const r = relay();
    const handle = await r.register();
    r.answer(new RetryablePushError("Push service rejected the attempt (429)"));
    expect(
      (await r.call("/send", { handle, data: data(), notify: true })).status,
    ).toBe(503);
    r.answer(new TypeError("network connection lost"));
    expect(
      (await r.call("/send", { handle, data: data(), notify: true })).status,
    ).toBe(502);
    // Neither loses the handle.
    r.answer("sent");
    expect(
      (await r.call("/send", { handle, data: data(), notify: true })).status,
    ).toBe(200);
  });

  test("only POST, and only its three doors", async () => {
    const r = relay();
    expect((await r.call("/elsewhere", {})).status).toBe(404);
    const get = await handleRelayRequestV1(
      new Request("https://push.frockbot.test/send"),
      {} as RelayObjectsV1,
      async () => "sent",
    );
    expect(get.status).toBe(405);
  });
});
