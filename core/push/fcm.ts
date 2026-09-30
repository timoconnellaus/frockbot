import { base64urlEncodeV1 } from "@frockbot/core/crypto";
import { withDeadlineV1 } from "@frockbot/core/deadline";

/**
 * Which app holds an FCM token. An iPhone's token reaches APNs, which draws
 * the alert itself and needs an `apns` block to say what to draw; an Android
 * app draws its own from the data alone.
 */
export type PushPlatformV1 = "android" | "ios";
export const PUSH_PLATFORMS_V1: readonly PushPlatformV1[] = ["android", "ios"];

/** A rejection the push service says is worth trying again later. */
export class RetryablePushError extends Error {}

/** Read signals, like the Android `ttl`, stop being worth delivering after a day. */
export const PUSH_DELIVERY_LIFETIME_S = 86_400;

interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
}
const encoder = new TextEncoder();

/**
 * The minted access token, reused until it is nearly expired.
 *
 * The assertion buys an hour; signing and exchanging one per device per message
 * turned a burst into a run of RSA signings and round trips to Google for no
 * gain. A token that stops being accepted is dropped and re-minted rather than
 * cached into a permanent failure.
 */
const accessTokens = new Map<string, { token: string; expiresAt: number }>();
const ACCESS_TOKEN_MARGIN_MS = 300_000;

async function accessToken(
  account: ServiceAccount,
  request: typeof fetch,
): Promise<string> {
  const cached = accessTokens.get(account.client_email);
  if (cached && cached.expiresAt > Date.now()) return cached.token;
  const now = Math.floor(Date.now() / 1000);
  const header = base64urlEncodeV1(
    encoder.encode(JSON.stringify({ alg: "RS256", typ: "JWT" })),
  );
  const claims = base64urlEncodeV1(
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
  const deadline = withDeadlineV1(10_000);
  let access: { access_token: string; expires_in?: number };
  try {
    const auth = await request("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion: `${header}.${claims}.${base64urlEncodeV1(new Uint8Array(signature))}`,
      }),
      signal: deadline.signal,
    }).catch(() => {
      throw new RetryablePushError("Push authorization is unavailable");
    });
    if (!auth.ok)
      throw new RetryablePushError(
        `Push authorization failed (${auth.status})`,
      );
    access = (await auth.json()) as {
      access_token: string;
      expires_in?: number;
    };
  } finally {
    deadline.clear();
  }
  accessTokens.set(account.client_email, {
    token: access.access_token,
    expiresAt:
      Date.now() +
      Math.max(
        60_000,
        (access.expires_in ?? 3600) * 1000 - ACCESS_TOKEN_MARGIN_MS,
      ),
  });
  return access.access_token;
}

/**
 * Sends one FCM v1 message with the service account in `secret`.
 *
 * `message` is the body's `message` object; `token` is inside it. A token FCM
 * no longer knows answers `unregistered`; a rejection worth retrying throws
 * `RetryablePushError`; any other refusal throws a plain error. A network
 * failure is thrown as it is, because nobody can say whether it was delivered.
 */
export async function sendFcmMessageV1(
  secret: string,
  message: Record<string, unknown>,
  request: typeof fetch = fetch,
): Promise<"sent" | "unregistered"> {
  const account = JSON.parse(secret) as ServiceAccount;
  const bearer = await accessToken(account, request);
  const deadline = withDeadlineV1(10_000);
  let result: Response;
  try {
    result = await request(
      `https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${bearer}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ message }),
        signal: deadline.signal,
      },
    );
  } finally {
    deadline.clear();
  }
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
  if (result.status === 401 || result.status === 403) {
    accessTokens.delete(account.client_email);
    throw new RetryablePushError(
      `Push authorization was rejected (${result.status})`,
    );
  }
  if (result.status === 429 || result.status >= 500)
    throw new RetryablePushError(
      `Push service rejected the attempt (${result.status})`,
    );
  if (!result.ok) throw new Error(`Push delivery failed (${result.status})`);
  await result.body?.cancel();
  return "sent";
}
