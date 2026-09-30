/**
 * Standard Web Push: a browser's own push service, reached with the
 * deployment's VAPID key pair (RFC 8292) and a payload encrypted to the
 * subscription (RFC 8291, `aes128gcm`). No Firebase and no relay, so a
 * self-hosted deployment alerts its browsers with keys it minted itself.
 */
import { base64urlDecodeV1, base64urlEncodeV1 } from "@frockbot/core/crypto";
import { withDeadlineV1 } from "@frockbot/core/deadline";
import {
  isPushKeyV1,
  PUSH_DELIVERY_LIFETIME_S,
  RetryablePushError,
  sealPushV1,
  type PushKeyV1,
} from "@frockbot/core/push";

/**
 * The deployment's key pair, as the `WEB_PUSH_VAPID_KEYS` secret holds it.
 * `subject` is the contact a push service may use about this sender, the
 * deployment's own origin; Apple refuses a token without one.
 */
export interface WebPushVapidKeysV1 {
  readonly subject: string;
  /** The uncompressed P-256 point, base64url: what a browser subscribes with. */
  readonly publicKey: string;
  /** The private scalar `d`, base64url. */
  readonly privateKey: string;
}

/** What `PushSubscription.toJSON()` gives, stored as the device's token. */
export interface WebPushSubscriptionV1 {
  readonly endpoint: string;
  readonly keys: PushKeyV1;
}

/**
 * The push services the browsers FrockBot supports subscribe with. The server
 * POSTs to whatever endpoint a registration names, so it names only these:
 * Chrome and Edge on Chromium (FCM's web endpoint), Firefox (Mozilla's
 * autopush), Safari and home-screen iPhone apps (Apple), legacy Edge (WNS).
 */
const PUSH_SERVICE_HOSTS_V1 = [
  "fcm.googleapis.com",
  "push.services.mozilla.com",
  "push.apple.com",
  "notify.windows.com",
];

export function parseVapidKeysV1(secret: string): WebPushVapidKeysV1 {
  const value = JSON.parse(secret) as Partial<WebPushVapidKeysV1>;
  if (
    typeof value.subject !== "string" ||
    !/^(https:\/\/|mailto:)/.test(value.subject) ||
    typeof value.publicKey !== "string" ||
    base64urlDecodeV1(value.publicKey).length !== 65 ||
    typeof value.privateKey !== "string" ||
    base64urlDecodeV1(value.privateKey).length !== 32
  )
    throw new Error("WEB_PUSH_VAPID_KEYS is not a VAPID key pair");
  return {
    subject: value.subject,
    publicKey: value.publicKey,
    privateKey: value.privateKey,
  };
}

/** A fresh key pair for `subject`, in the secret's shape. */
export async function generateVapidKeysV1(
  subject: string,
): Promise<WebPushVapidKeysV1> {
  const pair = (await crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  )) as CryptoKeyPair;
  const jwk = (await crypto.subtle.exportKey(
    "jwk",
    pair.privateKey,
  )) as JsonWebKey;
  const publicKey = new Uint8Array(
    (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer,
  );
  return {
    subject,
    publicKey: base64urlEncodeV1(publicKey),
    privateKey: jwk.d!,
  };
}

/**
 * The secret parsed and its signing key imported once per isolate, not once
 * per browser per message.
 */
const signers = new Map<
  string,
  Promise<{ keys: WebPushVapidKeysV1; signingKey: CryptoKey }>
>();

function signerOf(secret: string) {
  let signer = signers.get(secret);
  if (!signer) {
    signer = (async () => {
      const keys = parseVapidKeysV1(secret);
      const publicKey = base64urlDecodeV1(keys.publicKey);
      const signingKey = await crypto.subtle.importKey(
        "jwk",
        {
          kty: "EC",
          crv: "P-256",
          x: base64urlEncodeV1(publicKey.slice(1, 33)),
          y: base64urlEncodeV1(publicKey.slice(33, 65)),
          d: keys.privateKey,
        },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
      );
      return { keys, signingKey };
    })();
    // A malformed secret is not cached into a permanent failure.
    signer.catch(() => signers.delete(secret));
    signers.set(secret, signer);
  }
  return signer;
}

/**
 * A subscription a browser handed over, checked before it is stored: the
 * endpoint is one the server will POST to, and the keys are ones
 * `sealPushV1` can seal to.
 */
export function decodeWebPushSubscriptionV1(
  token: string,
): WebPushSubscriptionV1 {
  let value: unknown;
  try {
    value = JSON.parse(token);
  } catch {
    throw new Error("Invalid web push subscription");
  }
  const subscription = value as Partial<WebPushSubscriptionV1> | null;
  if (
    !subscription ||
    typeof subscription !== "object" ||
    typeof subscription.endpoint !== "string" ||
    !subscription.keys
  )
    throw new Error("Invalid web push subscription");
  let endpoint: URL;
  try {
    endpoint = new URL(subscription.endpoint);
  } catch {
    throw new Error("Invalid web push endpoint");
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username ||
    endpoint.password ||
    endpoint.port ||
    !PUSH_SERVICE_HOSTS_V1.some(
      (host) =>
        endpoint.hostname === host || endpoint.hostname.endsWith(`.${host}`),
    )
  )
    throw new Error("Invalid web push endpoint");
  const { p256dh, auth } = subscription.keys;
  if (!isPushKeyV1({ p256dh, auth })) throw new Error("Invalid web push keys");
  return {
    endpoint: subscription.endpoint,
    keys: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
  };
}

const encoder = new TextEncoder();

/**
 * The `Authorization` header for one push service: an ES256 JWT naming that
 * service's origin, signed with the deployment's key, and the public key it
 * verifies against.
 */
export async function vapidAuthorizationV1(
  secret: string,
  endpoint: string,
  now = Date.now(),
): Promise<string> {
  const { keys, signingKey } = await signerOf(secret);
  const header = base64urlEncodeV1(
    encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })),
  );
  const claims = base64urlEncodeV1(
    encoder.encode(
      JSON.stringify({
        aud: new URL(endpoint).origin,
        // Services refuse more than a day; twelve hours leaves room for skew.
        exp: Math.floor(now / 1000) + 12 * 3600,
        sub: keys.subject,
      }),
    ),
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign(
      { name: "ECDSA", hash: "SHA-256" },
      signingKey,
      encoder.encode(`${header}.${claims}`),
    ),
  );
  return `vapid t=${header}.${claims}.${base64urlEncodeV1(signature)}, k=${keys.publicKey}`;
}

/**
 * One push to one browser. A 404 or 410 is the push service saying the
 * subscription is gone, and the caller forgets it; a 429 or 5xx is retried by
 * the same delivery key; anything else is a definite refusal.
 */
export async function sendWebPush(
  secret: string,
  token: string,
  data: Record<string, string>,
  notify: boolean,
  request: typeof fetch = fetch,
): Promise<"sent" | "unregistered"> {
  const subscription = decodeWebPushSubscriptionV1(token);
  // The same RFC 8291 sealing the relay's apps open: a browser's
  // subscription keys are exactly such a key.
  const [sealed, authorization] = await Promise.all([
    sealPushV1(subscription.keys, JSON.stringify(data)),
    vapidAuthorizationV1(secret, subscription.endpoint),
  ]);
  const body = base64urlDecodeV1(sealed);
  const deadline = withDeadlineV1(10_000);
  let result: Response;
  try {
    result = await request(subscription.endpoint, {
      method: "POST",
      headers: {
        Authorization: authorization,
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: String(PUSH_DELIVERY_LIFETIME_S),
        Urgency: notify ? "high" : "normal",
      },
      body,
      signal: deadline.signal,
    });
  } finally {
    deadline.clear();
  }
  await result.body?.cancel();
  if (result.status === 404 || result.status === 410) return "unregistered";
  if (result.status === 429 || result.status >= 500)
    throw new RetryablePushError(
      `Web push service rejected the attempt (${result.status})`,
    );
  if (!result.ok)
    throw new Error(`Web push delivery failed (${result.status})`);
  return "sent";
}
