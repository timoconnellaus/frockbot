import { isPublicIdentifier } from "@frockbot/core/configuration";

export interface PushDevice {
  deviceId: string;
  token?: string;
  activeBotId?: string;
  updatedAt: number;
}
export interface PushUpdate {
  botId: string;
  cursor: string;
  kind: "message" | "read";
  title?: string;
  body?: string;
  notify?: boolean;
}
export interface PushRegistration {
  deviceId: string;
  token?: string;
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
      (key) => !["deviceId", "token", "activeBotId", "remove"].includes(key),
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
  if (value.activeBotId !== undefined && !isPublicIdentifier(value.activeBotId))
    throw new Error("Invalid active Bot");
  if (value.remove !== undefined && typeof value.remove !== "boolean")
    throw new Error("Invalid remove flag");
  return value as unknown as PushRegistration;
}

export async function registerPushDevice(
  storage: DurableObjectStorage,
  value: PushRegistration,
  now = Date.now(),
): Promise<void> {
  const key = DEVICE_PREFIX + value.deviceId;
  if (value.remove) {
    await storage.delete(key);
    return;
  }
  const devices = await storage.list<PushDevice>({ prefix: DEVICE_PREFIX });
  for (const [oldKey, device] of devices)
    if (
      now - device.updatedAt >
      (device.token ? 30 * 86400_000 : PRESENCE_MS * 4)
    ) {
      await storage.delete(oldKey);
      devices.delete(oldKey);
    }
  if (!devices.has(key) && devices.size >= 32)
    throw new Error("Too many registered devices");
  // A refreshed token replaces the installation's old token, never adds another recipient.
  await storage.put(key, { ...value, updatedAt: now });
}

export class RetryablePushError extends Error {}

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}
const encoder = new TextEncoder();
function base64url(bytes: Uint8Array): string {
  return btoa(String.fromCharCode(...bytes))
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

export async function sendFcm(
  secret: string,
  token: string,
  data: Record<string, string>,
  notify: boolean,
  request: typeof fetch = fetch,
): Promise<"sent" | "unregistered"> {
  const account = JSON.parse(secret) as ServiceAccount;
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const claims = base64url(
    encoder.encode(
      JSON.stringify({
        iss: account.client_email,
        scope: "https://www.googleapis.com/auth/firebase.messaging",
        aud: "https://oauth2.googleapis.com/token",
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const pem = account.private_key
    .replace(/-----[^-]+-----/g, "")
    .replace(/\s/g, "");
  const key = await crypto.subtle.importKey(
    "pkcs8",
    Uint8Array.from(atob(pem), (c) => c.charCodeAt(0)),
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    key,
    encoder.encode(`${header}.${claims}`),
  );
  const auth = await request("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${claims}.${base64url(new Uint8Array(signature))}`,
    }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => {
    throw new RetryablePushError("Push authorization is unavailable");
  });
  if (!auth.ok)
    throw new RetryablePushError(`Push authorization failed (${auth.status})`);
  const access = (await auth.json()) as { access_token: string };
  const result = await request(
    `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${access.access_token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        message: {
          token,
          data,
          android: { priority: notify ? "HIGH" : "NORMAL", ttl: "86400s" },
        },
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );
  if (result.status === 404) {
    const error = (await result.json()) as {
      error?: { details?: { errorCode?: string }[] };
    };
    if (
      error.error?.details?.some(
        (detail) => detail.errorCode === "UNREGISTERED",
      )
    )
      return "unregistered";
  }
  if (result.status === 429 || result.status >= 500)
    throw new RetryablePushError(
      `Push service rejected the attempt (${result.status})`,
    );
  if (!result.ok) throw new Error(`Push delivery failed (${result.status})`);
  await result.body?.cancel();
  return "sent";
}

/** One external attempt per message/device; an uncertain send is explicit, never blindly replayed. */
export async function deliverPush(
  storage: DurableObjectStorage,
  userId: string,
  update: PushUpdate,
  secret: string | undefined,
  sender = sendFcm,
): Promise<void> {
  const devices = await storage.list<PushDevice>({ prefix: DEVICE_PREFIX });
  const now = Date.now();
  for (const [key, device] of devices) {
    if (
      now - device.updatedAt >
      (device.token ? 30 * 86400_000 : PRESENCE_MS * 4)
    ) {
      await storage.delete(key);
      devices.delete(key);
    }
  }
  if (![...devices.values()].some((device) => device.token)) return;
  if (!secret) throw new Error("Firebase push is not configured");
  const beingRead = [...devices.values()].some(
    (device) =>
      device.activeBotId === update.botId &&
      now - device.updatedAt < PRESENCE_MS,
  );
  // Presence delays delivery; only a durable read receipt can discard an alert.
  // A stale focus lease must never silently lose a message.
  if (beingRead && update.kind === "message" && update.notify === true)
    throw new RetryablePushError(
      "Waiting for the visible message's read receipt",
    );
  for (const [deviceKey, device] of devices) {
    if (!device.token) continue;
    const key = `${DELIVERY_PREFIX}${update.botId}:${update.kind}:${device.deviceId}`;
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
    const notify =
      update.kind === "message" && update.notify === true && !beingRead;
    try {
      const result = await sender(
        secret,
        device.token,
        {
          userId,
          botId: update.botId,
          cursor: update.cursor,
          kind: update.kind,
          title: update.title ?? "",
          body: update.body ?? "",
          notify: String(notify),
        },
        notify,
      );
      if (result === "unregistered")
        await storage.transaction(async (tx) => {
          if ((await tx.get<PushDevice>(deviceKey))?.token === device.token)
            await tx.delete(deviceKey);
        });
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
