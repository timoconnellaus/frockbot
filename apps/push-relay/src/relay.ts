import { isPublicIdentifier } from "@frockbot/core/configuration";
import { base64urlEncodeV1 } from "@frockbot/core/crypto";
import {
  PUSH_DELIVERY_LIFETIME_S,
  PUSH_PLATFORMS_V1,
  RetryablePushError,
  type PushPlatformV1,
} from "@frockbot/core/push";

/**
 * The push relay: any FrockBot server sends here, and only here are the
 * released apps' FCM credentials held.
 *
 * A phone registers its FCM token and gets back an opaque handle, which it
 * gives its own server in place of the token. The server sends
 * `{ handle, data, notify, collapse }`; the relay looks the token up and
 * calls FCM. What an alert says never passes through: it is sealed to a key
 * only the app holds (`@frockbot/core/push`), and the relay accepts only the
 * fields the apps read, so a plaintext title or body is refused.
 */

/** What one handle stands for. */
export interface RelayRegistrationV1 {
  token: string;
  platform: PushPlatformV1;
  /** The origin of the server the app registered this handle for. */
  server: string;
  touchedAt: number;
}

export interface RateLimitV1 {
  max: number;
  windowMs: number;
}

/** Per handle: a burst of replies and the reads that follow them. */
export const HANDLE_SEND_LIMIT_V1: RateLimitV1 = { max: 60, windowMs: 60_000 };
/**
 * Per sending server, keyed by the origin its apps registered for rather than
 * by the sender's address: servers on Workers share Cloudflare's egress.
 */
export const SERVER_SEND_LIMIT_V1: RateLimitV1 = {
  max: 3_000,
  windowMs: 60_000,
};
/** Fresh registrations per client address. */
export const REGISTER_LIMIT_V1: RateLimitV1 = { max: 30, windowMs: 3_600_000 };
/** A handle nobody has registered or sent to for this long is forgotten. */
export const HANDLE_LIFETIME_MS = 90 * 86_400_000;

export const MAX_REQUEST_BYTES = 4096;
const MAX_SEALED_CHARS = 3072;

const HANDLE = /^ph_[A-Za-z0-9_-]{43}$/;
const TOKEN = /^[A-Za-z0-9:_-]{20,4096}$/;
const CURSOR = /^message-[0-9]{20}$/;
const GROUP = /^g-[0-9a-f]{20}$/;
const COLLAPSE = /^[A-Za-z0-9:._-]{1,64}$/;
const BASE64URL = /^[A-Za-z0-9_-]+$/;

/** The data fields the apps read; nothing else is forwarded. */
const DATA_FIELDS = new Set([
  "userId",
  "botId",
  "groupId",
  "cursor",
  "kind",
  "notify",
  "sealed",
]);

export class RelayRequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** A storage the relay's objects keep their few records in. */
export interface RelayStorageV1 {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  deleteAll(): Promise<void>;
  setAlarm(at: number): Promise<void>;
}

/** Counts one use against a fixed window. */
export async function consumeV1(
  storage: RelayStorageV1,
  name: string,
  limit: RateLimitV1,
  now: number,
): Promise<{ ok: true } | { ok: false; retryAfterS: number }> {
  const key = `window:${name}`;
  const window = await storage.get<{ start: number; count: number }>(key);
  const current =
    window && now - window.start < limit.windowMs
      ? window
      : { start: now, count: 0 };
  if (current.count >= limit.max)
    return {
      ok: false,
      retryAfterS: Math.max(
        1,
        Math.ceil((current.start + limit.windowMs - now) / 1000),
      ),
    };
  await storage.put(key, { start: current.start, count: current.count + 1 });
  return { ok: true };
}

export function newHandleV1(): string {
  return `ph_${base64urlEncodeV1(crypto.getRandomValues(new Uint8Array(32)))}`;
}

/** Everything one handle's object does. */
export const handleObjectV1 = {
  async register(
    storage: RelayStorageV1,
    registration: Omit<RelayRegistrationV1, "touchedAt">,
    now: number,
  ): Promise<void> {
    await storage.put("registration", { ...registration, touchedAt: now });
    await storage.setAlarm(now + HANDLE_LIFETIME_MS);
  },

  /** A rotated token under the same handle; false when it is gone. */
  async rotate(
    storage: RelayStorageV1,
    update: { token: string; platform: PushPlatformV1 },
    now: number,
  ): Promise<boolean> {
    const current = await storage.get<RelayRegistrationV1>("registration");
    if (!current) return false;
    await storage.put("registration", {
      ...current,
      ...update,
      touchedAt: now,
    });
    await storage.setAlarm(now + HANDLE_LIFETIME_MS);
    return true;
  },

  async unregister(storage: RelayStorageV1): Promise<void> {
    await storage.deleteAll();
  },

  /**
   * The registration a send may use, counted against the handle's limit; or
   * `gone`, or how long to wait.
   */
  async authorizeSend(
    storage: RelayStorageV1,
    now: number,
  ): Promise<
    | { status: "ok"; registration: RelayRegistrationV1 }
    | { status: "gone" }
    | { status: "limited"; retryAfterS: number }
  > {
    const registration = await storage.get<RelayRegistrationV1>("registration");
    if (!registration) return { status: "gone" };
    const used = await consumeV1(storage, "send", HANDLE_SEND_LIMIT_V1, now);
    if (!used.ok) return { status: "limited", retryAfterS: used.retryAfterS };
    await storage.put("registration", { ...registration, touchedAt: now });
    return { status: "ok", registration };
  },

  /** Forgets a handle left unused; one still in use is looked at again later. */
  async alarm(storage: RelayStorageV1, now: number): Promise<void> {
    const registration = await storage.get<RelayRegistrationV1>("registration");
    if (!registration) return storage.deleteAll();
    const expires = registration.touchedAt + HANDLE_LIFETIME_MS;
    if (expires <= now) return storage.deleteAll();
    await storage.setAlarm(expires);
  },
};

/** The object a request reaches for one handle, or one rate-limit key. */
export interface RelayObjectsV1 {
  handle(handle: string): {
    register(
      registration: Omit<RelayRegistrationV1, "touchedAt">,
    ): Promise<void>;
    rotate(update: {
      token: string;
      platform: PushPlatformV1;
    }): Promise<boolean>;
    unregister(): Promise<void>;
    authorizeSend(): ReturnType<typeof handleObjectV1.authorizeSend>;
  };
  limiter(key: string): {
    consume(limit: RateLimitV1): ReturnType<typeof consumeV1>;
  };
}

export type FcmSenderV1 = (
  message: Record<string, unknown>,
) => Promise<"sent" | "unregistered">;

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new RelayRequestError(400, "Expected a JSON object");
  return value as Record<string, unknown>;
}

function only(value: Record<string, unknown>, fields: readonly string[]) {
  const unknown = Object.keys(value).find((key) => !fields.includes(key));
  if (unknown !== undefined)
    throw new RelayRequestError(400, `Unexpected field ${unknown}`);
}

async function readJson(request: Request): Promise<Record<string, unknown>> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_REQUEST_BYTES)
    throw new RelayRequestError(413, "Request is too large");
  const text = await request.text();
  if (new TextEncoder().encode(text).length > MAX_REQUEST_BYTES)
    throw new RelayRequestError(413, "Request is too large");
  try {
    return object(JSON.parse(text));
  } catch (error) {
    if (error instanceof RelayRequestError) throw error;
    throw new RelayRequestError(400, "Invalid JSON");
  }
}

function handleOf(value: unknown): string {
  if (typeof value !== "string" || !HANDLE.test(value))
    throw new RelayRequestError(400, "Invalid handle");
  return value;
}

/** The origin a handle's sends are counted against. */
export function serverOriginV1(value: unknown): string {
  if (typeof value !== "string" || value.length > 256)
    throw new RelayRequestError(400, "Invalid server");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RelayRequestError(400, "Invalid server");
  }
  const local =
    url.protocol === "http:" &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.origin !== value.replace(/\/$/, "")
  )
    throw new RelayRequestError(400, "Invalid server");
  return url.origin;
}

export interface SendRequestV1 {
  handle: string;
  data: Record<string, string>;
  notify: boolean;
  collapse?: string;
}

/** The one shape a server may send: the fields the apps read, bounded. */
export function decodeSendV1(input: Record<string, unknown>): SendRequestV1 {
  only(input, ["handle", "data", "notify", "collapse"]);
  const handle = handleOf(input.handle);
  if (typeof input.notify !== "boolean")
    throw new RelayRequestError(400, "Invalid notify");
  if (
    input.collapse !== undefined &&
    (typeof input.collapse !== "string" || !COLLAPSE.test(input.collapse))
  )
    throw new RelayRequestError(400, "Invalid collapse key");
  const data = object(input.data);
  for (const [key, value] of Object.entries(data)) {
    if (!DATA_FIELDS.has(key))
      throw new RelayRequestError(400, `Unexpected data field ${key}`);
    if (typeof value !== "string")
      throw new RelayRequestError(400, `Invalid data field ${key}`);
  }
  const fields = data as Record<string, string>;
  if (
    !isPublicIdentifier(fields.userId) ||
    !isPublicIdentifier(fields.botId) ||
    (fields.groupId !== undefined && !GROUP.test(fields.groupId)) ||
    fields.cursor === undefined ||
    !CURSOR.test(fields.cursor) ||
    (fields.kind !== "message" && fields.kind !== "read") ||
    fields.notify !== String(input.notify) ||
    (input.notify && fields.kind !== "message")
  )
    throw new RelayRequestError(400, "Invalid data");
  if (
    fields.sealed !== undefined &&
    (!input.notify ||
      fields.sealed.length > MAX_SEALED_CHARS ||
      !BASE64URL.test(fields.sealed))
  )
    throw new RelayRequestError(400, "Invalid sealed content");
  return {
    handle,
    data: fields,
    notify: input.notify,
    ...(input.collapse === undefined
      ? {}
      : { collapse: input.collapse as string }),
  };
}

/**
 * The FCM message for one send. An iPhone draws the alert itself, so it is
 * told to draw a placeholder and to let the app's Notification Service
 * Extension replace it with what it opens from `sealed`.
 */
export function fcmMessageV1(
  registration: Pick<RelayRegistrationV1, "token" | "platform">,
  send: SendRequestV1,
  now: number,
): Record<string, unknown> {
  const expiration = String(Math.floor(now / 1000) + PUSH_DELIVERY_LIFETIME_S);
  const collapse = send.collapse ? { "apns-collapse-id": send.collapse } : {};
  return {
    token: registration.token,
    data: send.data,
    android: {
      priority: send.notify ? "HIGH" : "NORMAL",
      ttl: `${PUSH_DELIVERY_LIFETIME_S}s`,
      ...(send.collapse ? { collapse_key: send.collapse } : {}),
    },
    ...(registration.platform === "ios"
      ? {
          apns: send.notify
            ? {
                headers: {
                  "apns-priority": "10",
                  "apns-push-type": "alert",
                  "apns-expiration": expiration,
                  ...collapse,
                },
                payload: {
                  aps: {
                    alert: { title: "FrockBot", body: "New message" },
                    sound: "default",
                    "mutable-content": 1,
                    "thread-id": send.data.groupId
                      ? `group:${send.data.groupId}`
                      : send.data.botId,
                  },
                },
              }
            : {
                headers: {
                  "apns-priority": "5",
                  "apns-push-type": "background",
                  "apns-expiration": expiration,
                  ...collapse,
                },
                payload: { aps: { "content-available": 1 } },
              },
        }
      : {}),
  };
}

function json(body: unknown, status = 200, headers: HeadersInit = {}) {
  return Response.json(body, {
    status,
    headers: { "cache-control": "no-store", ...headers },
  });
}

function limited(retryAfterS: number): Response {
  return json({ error: "Rate limited" }, 429, {
    "retry-after": String(retryAfterS),
  });
}

/**
 * The relay's three doors.
 *
 * `/send` answers what the server's delivery rules need to tell apart:
 * 200 sent; 410 the handle is gone, so the server drops the device; 429 and
 * 503 a refusal worth retrying; and 502 an outcome nobody can know, which the
 * server records as uncertain and never repeats.
 */
export async function handleRelayRequestV1(
  request: Request,
  objects: RelayObjectsV1,
  sendFcm: FcmSenderV1,
  now = Date.now(),
): Promise<Response> {
  const url = new URL(request.url);
  if (request.method !== "POST")
    return json({ error: "Method not allowed" }, 405);
  try {
    if (url.pathname === "/register") {
      const body = await readJson(request);
      only(body, ["token", "platform", "server", "handle"]);
      if (typeof body.token !== "string" || !TOKEN.test(body.token))
        throw new RelayRequestError(400, "Invalid token");
      if (!PUSH_PLATFORMS_V1.includes(body.platform as PushPlatformV1))
        throw new RelayRequestError(400, "Invalid platform");
      const platform = body.platform as PushPlatformV1;
      const server = serverOriginV1(body.server);
      if (body.handle !== undefined) {
        // A rotated token keeps its handle, so the server needs telling
        // nothing. A handle that is gone is registered afresh by the app.
        const handle = handleOf(body.handle);
        return (await objects
          .handle(handle)
          .rotate({ token: body.token, platform }))
          ? json({ handle })
          : json({ error: "Unknown handle" }, 404);
      }
      const address = request.headers.get("cf-connecting-ip") ?? "unknown";
      const used = await objects
        .limiter(`register:${address}`)
        .consume(REGISTER_LIMIT_V1);
      if (!used.ok) return limited(used.retryAfterS);
      const handle = newHandleV1();
      await objects
        .handle(handle)
        .register({ token: body.token, platform, server });
      return json({ handle });
    }
    if (url.pathname === "/unregister") {
      const body = await readJson(request);
      only(body, ["handle"]);
      await objects.handle(handleOf(body.handle)).unregister();
      return new Response(null, { status: 204 });
    }
    if (url.pathname === "/send") {
      const send = decodeSendV1(await readJson(request));
      const handle = objects.handle(send.handle);
      const authorized = await handle.authorizeSend();
      if (authorized.status === "gone")
        return json({ status: "unregistered" }, 410);
      if (authorized.status === "limited")
        return limited(authorized.retryAfterS);
      const server = await objects
        .limiter(`server:${authorized.registration.server}`)
        .consume(SERVER_SEND_LIMIT_V1);
      if (!server.ok) return limited(server.retryAfterS);
      let result: "sent" | "unregistered";
      try {
        result = await sendFcm(
          fcmMessageV1(authorized.registration, send, now),
        );
      } catch (error) {
        if (error instanceof RetryablePushError)
          return json({ error: "Push service unavailable" }, 503);
        console.error(
          JSON.stringify({
            event: "push-relay-uncertain",
            error: String(error),
          }),
        );
        return json({ status: "uncertain" }, 502);
      }
      if (result === "unregistered") {
        await handle.unregister();
        return json({ status: "unregistered" }, 410);
      }
      return json({ status: "sent" });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    if (error instanceof RelayRequestError)
      return json({ error: error.message }, error.status);
    throw error;
  }
}
