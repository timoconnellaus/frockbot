import { BRAND_V1 } from "#brand";
import { isPublicIdentifier } from "@frockbot/core/configuration";
import { withDeadlineV1 } from "@frockbot/core/deadline";
import {
  isPushKeyV1,
  PUSH_DELIVERY_LIFETIME_S,
  PUSH_PLATFORMS_V1,
  RetryablePushError,
  sealPushV1,
  sendFcmMessageV1,
  type PushKeyV1,
  type PushPlatformV1 as AppPushPlatformV1,
} from "@frockbot/core/push";
import { decodeWebPushSubscriptionV1 } from "./web-push.js";

export { RetryablePushError };

/**
 * Which app holds a token: the apps' FCM tokens (`@frockbot/core/push`), or a
 * browser's Web Push subscription, which this deployment reaches itself with
 * its own VAPID keys and never through FCM or the relay.
 */
export type PushPlatformV1 = AppPushPlatformV1 | "web";
const DEVICE_PLATFORMS_V1: readonly PushPlatformV1[] = [
  ...PUSH_PLATFORMS_V1,
  "web",
];

/**
 * Where a deployment with no FCM credentials of its own sends its pushes: the
 * relay that holds the released apps' credentials. `PUSH_RELAY_URL` points a
 * deployment at another one, such as staging's.
 */
export const DEFAULT_PUSH_RELAY_URL = "https://push.frockbot.com";

/**
 * A device reached through the push relay: the relay's opaque handle for the
 * phone's token, and the key the app generated so the alert's text can be
 * sealed to it. The relay and Google carry only ciphertext.
 */
export interface PushRelayAddressV1 extends PushKeyV1 {
  handle: string;
}
const RELAY_HANDLE = /^ph_[A-Za-z0-9_-]{43}$/;

export interface PushDevice {
  deviceId: string;
  token?: string;
  /** Set with the token it describes. */
  platform?: PushPlatformV1;
  /** In place of a token, on a deployment that sends through the relay. */
  relay?: PushRelayAddressV1;
  activeBotId?: string;
  updatedAt: number;
}
export interface PushUpdate {
  botId: string;
  /**
   * A Group Chat message: `botId` is its author, and the group is what the
   * alert opens, what a device reading it defers to, and whose cursor it is.
   */
  groupId?: string;
  cursor: string;
  kind: "message" | "read";
  title?: string;
  body?: string;
  notify?: boolean;
}
interface PushRegistration {
  deviceId: string;
  token?: string;
  platform?: PushPlatformV1;
  relay?: PushRelayAddressV1;
  activeBotId?: string;
  remove?: boolean;
}
const DEVICE_PREFIX = "push:device:";
const DELIVERY_PREFIX = "push:delivery:";
const PRESENCE_MS = 15_000;

export function decodePushRegistration(input: unknown): PushRegistration {
  if (!input || typeof input !== "object" || Array.isArray(input))
    throw new Error("Invalid push registration");
  const value = input as Record<string, unknown>;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "deviceId",
          "token",
          "platform",
          "relay",
          "activeBotId",
          "remove",
        ].includes(key),
    ) ||
    !isPublicIdentifier(value.deviceId)
  )
    throw new Error("Invalid device id");
  if (
    value.token !== undefined &&
    (typeof value.token !== "string" ||
      value.token.length < 20 ||
      value.token.length > 4096)
  )
    throw new Error("Invalid push token");
  // A platform describes a token, so it never arrives without one.
  if (
    value.platform !== undefined &&
    (value.token === undefined ||
      !DEVICE_PLATFORMS_V1.includes(value.platform as PushPlatformV1))
  )
    throw new Error("Invalid push platform");
  if (value.platform === "web")
    decodeWebPushSubscriptionV1(value.token as string);
  // A relay registration is the device's address in place of a token.
  if (value.relay !== undefined) {
    const relay = value.relay as Record<string, unknown> | null;
    if (
      value.token !== undefined ||
      !relay ||
      typeof relay !== "object" ||
      typeof relay.handle !== "string" ||
      !RELAY_HANDLE.test(relay.handle) ||
      !isPushKeyV1({ p256dh: relay.p256dh, auth: relay.auth }) ||
      Object.keys(relay).length !== 3
    )
      throw new Error("Invalid push relay registration");
  }
  if (value.activeBotId !== undefined && !isPublicIdentifier(value.activeBotId))
    throw new Error("Invalid active Bot");
  if (value.remove !== undefined && typeof value.remove !== "boolean")
    throw new Error("Invalid remove flag");
  return value as unknown as PushRegistration;
}

/**
 * Records one registration. Answers whether it gave the Bots an address they
 * could not reach before: a new installation, a refreshed token, or a new
 * relay handle.
 */
export async function registerPushDevice(
  storage: DurableObjectStorage,
  value: PushRegistration,
  now = Date.now(),
): Promise<boolean> {
  const key = DEVICE_PREFIX + value.deviceId;
  if (value.remove) {
    await forgetDevice(storage, key, value.deviceId);
    return false;
  }
  const devices = await storage.list<PushDevice>({ prefix: DEVICE_PREFIX });
  for (const [oldKey, device] of devices)
    if (
      now - device.updatedAt >
      (addressed(device) ? 30 * 86400_000 : PRESENCE_MS * 4)
    ) {
      await forgetDevice(storage, oldKey, device.deviceId);
      devices.delete(oldKey);
    }
  if (!devices.has(key) && devices.size >= 32)
    throw new Error("Too many registered devices");
  // A refreshed address replaces the installation's old one, never adds
  // another recipient: a token or a relay handle, whichever came last. A
  // registration that carries neither is a presence update — the device says
  // which Bot it is reading, from the first frame, before the FCM token has
  // been fetched — so it keeps the address already registered rather than
  // erasing the only one the Bot can reach. Every other field is stated
  // afresh: an omitted `activeBotId` means this device is no longer reading
  // anything, and merging it would suppress its alerts. The platform is the
  // token's, so it is kept or replaced with it.
  const previous = devices.get(key);
  const fresh = value.token !== undefined || value.relay !== undefined;
  const token = fresh ? value.token : previous?.token;
  const platform = fresh ? value.platform : previous?.platform;
  const relay = fresh ? value.relay : previous?.relay;
  await storage.put(key, {
    deviceId: value.deviceId,
    ...(token === undefined ? {} : { token }),
    ...(platform === undefined ? {} : { platform }),
    ...(relay === undefined
      ? {}
      : {
          relay: {
            handle: relay.handle,
            p256dh: relay.p256dh,
            auth: relay.auth,
          },
        }),
    ...(value.activeBotId === undefined
      ? {}
      : { activeBotId: value.activeBotId }),
    updatedAt: now,
  } satisfies PushDevice);
  return (
    (value.token !== undefined && value.token !== previous?.token) ||
    (value.relay !== undefined &&
      value.relay.handle !== previous?.relay?.handle)
  );
}

function addressed(device: PushDevice): boolean {
  return device.token !== undefined || device.relay !== undefined;
}

/**
 * A device and everything written about it. The delivery receipts are keyed by
 * the device id, so they have to go with it: an install that is replaced or
 * expires would otherwise leave one row per Bot and kind behind for ever.
 */
async function forgetDevice(
  storage: DurableObjectStorage,
  key: string,
  deviceId: string,
): Promise<void> {
  await storage.delete(key);
  await forgetDeliveries(storage, deviceId);
}

async function forgetDeliveries(
  storage: DurableObjectStorage,
  deviceId: string,
): Promise<void> {
  const receipts = await storage.list<unknown>({ prefix: DELIVERY_PREFIX });
  for (const receiptKey of receipts.keys())
    if (receiptKey.endsWith(`:${deviceId}`)) await storage.delete(receiptKey);
}

/**
 * What APNs draws on an iPhone. A suspended app cannot draw an alert from
 * data, so a message to be told arrives as the alert itself, threaded per
 * conversation the way Android keeps one notification per Bot. Everything
 * else — a read on another device, a message not to be told — is a background
 * push that wakes the app if iOS allows it, and that iOS may hold back.
 */
function apnsMessage(
  data: Record<string, string>,
  notify: boolean,
): Record<string, unknown> {
  const expiration = String(
    Math.floor(Date.now() / 1000) + PUSH_DELIVERY_LIFETIME_S,
  );
  if (!notify)
    return {
      headers: {
        "apns-priority": "5",
        "apns-push-type": "background",
        "apns-expiration": expiration,
      },
      payload: { aps: { "content-available": 1 } },
    };
  return {
    headers: {
      "apns-priority": "10",
      "apns-push-type": "alert",
      "apns-expiration": expiration,
    },
    payload: {
      aps: {
        alert: {
          title: data.title || BRAND_V1.productName,
          body: data.body || "New message",
        },
        sound: "default",
        "thread-id": data.groupId ? `group:${data.groupId}` : data.botId,
      },
    },
  };
}

export async function sendFcm(
  secret: string,
  target: { token: string; platform?: AppPushPlatformV1 },
  data: Record<string, string>,
  notify: boolean,
  request: typeof fetch = fetch,
): Promise<"sent" | "unregistered"> {
  return sendFcmMessageV1(
    secret,
    {
      token: target.token,
      data,
      android: {
        priority: notify ? "HIGH" : "NORMAL",
        ttl: `${PUSH_DELIVERY_LIFETIME_S}s`,
      },
      ...(target.platform === "ios" ? { apns: apnsMessage(data, notify) } : {}),
    },
    request,
  );
}

/**
 * Sends one update through the push relay. The relay accepts only the fields
 * the apps read, and never an alert's words: those travel sealed to the key
 * the app registered, so the relay and Google see ciphertext.
 */
export async function sendRelay(
  relayUrl: string,
  address: PushRelayAddressV1,
  data: Record<string, string>,
  notify: boolean,
  request: typeof fetch = fetch,
): Promise<"sent" | "unregistered"> {
  const { title, body, ...rest } = data;
  const payload: Record<string, string> = rest;
  if (notify)
    payload.sealed = await sealPushV1(
      address,
      JSON.stringify({ title: title ?? "", body: body ?? "" }),
    );
  const target = data.groupId ? `group:${data.groupId}` : data.botId;
  const deadline = withDeadlineV1(10_000);
  let result: Response;
  try {
    result = await request(new URL("/send", relayUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        handle: address.handle,
        data: payload,
        notify,
        // A newer read replaces an undelivered older one; a message never
        // replaces another, because each is a line in the notification.
        ...(data.kind === "read" ? { collapse: `read:${target}` } : {}),
      }),
      signal: deadline.signal,
    });
  } finally {
    deadline.clear();
  }
  await result.body?.cancel();
  if (result.status === 410) return "unregistered";
  // Only a refusal the relay says was never sent is retried. Anything else,
  // its 502 for an FCM call that may have landed included, is uncertain.
  if (result.status === 429 || result.status === 503)
    throw new RetryablePushError(
      `Push relay rejected the attempt (${result.status})`,
    );
  if (!result.ok) throw new Error(`Push relay refused (${result.status})`);
  return "sent";
}

/** One external attempt per message/device; an uncertain send is explicit, never blindly replayed. */
export async function deliverPush(
  storage: DurableObjectStorage,
  userId: string,
  update: PushUpdate,
  secret: string | undefined,
  sender = sendFcm,
  relay: (
    address: PushRelayAddressV1,
    data: Record<string, string>,
    notify: boolean,
  ) => Promise<"sent" | "unregistered"> = (address, data, notify) =>
    sendRelay(DEFAULT_PUSH_RELAY_URL, address, data, notify),
  /**
   * A browser's own push service, present when the deployment holds its
   * VAPID keys; without them a browser's subscription is unreachable.
   */
  web?: (
    subscription: string,
    data: Record<string, string>,
    notify: boolean,
  ) => Promise<"sent" | "unregistered">,
): Promise<void> {
  const devices = await storage.list<PushDevice>({ prefix: DEVICE_PREFIX });
  const now = Date.now();
  for (const [key, device] of devices) {
    if (
      now - device.updatedAt >
      (addressed(device) ? 30 * 86400_000 : PRESENCE_MS * 4)
    ) {
      await forgetDevice(storage, key, device.deviceId);
      devices.delete(key);
    }
  }
  // A token needs this deployment's own FCM credentials. Without them it is an
  // address nothing here can reach, and the app replaces it with a relay
  // handle once its registration is answered `delivery: "relay"`.
  // A browser subscribes with `userVisibleOnly`, so every push it receives
  // must draw a notification: it is sent only messages it is to be told
  // about, never a read or a quiet message, and clears its own on read.
  const reachable = (device: PushDevice) =>
    device.relay !== undefined ||
    (device.token !== undefined &&
      (device.platform === "web" ? !!web : !!secret));
  if (![...devices.values()].some(reachable)) return;
  const target = update.groupId ?? update.botId;
  const beingRead = [...devices.values()].some(
    (device) =>
      device.activeBotId === target && now - device.updatedAt < PRESENCE_MS,
  );
  // Presence delays delivery; only a durable read receipt can discard an alert.
  // A stale focus lease must never silently lose a message.
  if (beingRead && update.kind === "message" && update.notify === true)
    throw new RetryablePushError(
      "Waiting for the visible message's read receipt",
    );
  const notify =
    update.kind === "message" && update.notify === true && !beingRead;
  for (const [deviceKey, device] of devices) {
    if (!reachable(device) || (device.platform === "web" && !notify)) continue;
    const key = update.groupId
      ? `${DELIVERY_PREFIX}group:${update.groupId}:${update.kind}:${device.deviceId}`
      : `${DELIVERY_PREFIX}${update.botId}:${update.kind}:${device.deviceId}`;
    const claimed = await storage.transaction(async (tx) => {
      const previous = await tx.get<{
        cursor: string;
        status: string;
        at: number;
        retryAt?: number;
      }>(key);
      if (
        previous &&
        previous.cursor >= update.cursor &&
        previous.status === "retry"
      ) {
        if (previous.cursor > update.cursor || (previous.retryAt ?? 0) > now)
          throw new RetryablePushError("Push retry is scheduled");
      } else if (previous && previous.cursor >= update.cursor) {
        if (previous.status === "attempting") {
          await tx.put(key, { ...previous, status: "uncertain" });
          console.error(
            JSON.stringify({
              event: "push-delivery-uncertain",
              botId: update.botId,
              cursor: update.cursor,
            }),
          );
        }
        return false;
      }
      await tx.put(key, {
        cursor: update.cursor,
        status: "attempting",
        at: now,
      });
      return true;
    });
    if (!claimed) continue;
    const data = {
      userId,
      botId: update.botId,
      ...(update.groupId ? { groupId: update.groupId } : {}),
      cursor: update.cursor,
      kind: update.kind,
      title: update.title ?? "",
      body: update.body ?? "",
      notify: String(notify),
    };
    try {
      const result = device.relay
        ? await relay(device.relay, data, notify)
        : device.platform === "web"
          ? await web!(device.token!, data, notify)
          : await sender(
              secret!,
              {
                token: device.token!,
                ...(device.platform ? { platform: device.platform } : {}),
              },
              data,
              notify,
            );
      if (result === "unregistered") {
        // Only the address this attempt used is dropped: a device that
        // re-registered meanwhile keeps its new one.
        const removed = await storage.transaction(async (tx) => {
          const current = await tx.get<PushDevice>(deviceKey);
          if (
            current?.token !== device.token ||
            current?.relay?.handle !== device.relay?.handle
          )
            return false;
          await tx.delete(deviceKey);
          return true;
        });
        if (removed) {
          await forgetDeliveries(storage, device.deviceId);
          continue;
        }
      }
      await finishDelivery(storage, key, update.cursor, result, now);
    } catch (error) {
      if (error instanceof RetryablePushError) {
        await storage.transaction(async (tx) => {
          if ((await tx.get<{ cursor: string }>(key))?.cursor === update.cursor)
            await tx.put(key, {
              cursor: update.cursor,
              status: "retry",
              at: now,
              retryAt: now + 60_000,
            });
        });
        throw error;
      }
      await finishDelivery(storage, key, update.cursor, "uncertain", now);
      console.error(
        JSON.stringify({
          event: "push-delivery-uncertain",
          botId: update.botId,
          cursor: update.cursor,
        }),
      );
    }
  }
}

async function finishDelivery(
  storage: DurableObjectStorage,
  key: string,
  cursor: string,
  status: string,
  at: number,
): Promise<void> {
  await storage.transaction(async (tx) => {
    if ((await tx.get<{ cursor: string }>(key))?.cursor === cursor)
      await tx.put(key, { cursor, status, at });
  });
}
