/**
 * The signed `state` a redirect-based Connection carries through an external
 * authorization server and back.
 *
 * This is the *only* identity a callback has. A `publicRoute` runs before the
 * gateway has authenticated anyone — an authorization server redirects the
 * User's browser to it with whatever query it likes — so the User the callback
 * acts as is read from this token's verified payload and from nowhere else.
 * Query parameters are data; the HMAC is the authority.
 *
 * It began inside `plugin-composio`. Two Packages now mint one, so it lives in
 * `connection-core` where both can reach it. The wire format is byte-for-byte
 * what Composio emitted, so a state minted before this move still verifies
 * after it: `base64url(JSON payload).base64url(HMAC-SHA-256)`.
 */

/** A public identifier, as `@frockbot/configuration-core` defines one. */
const PUBLIC_IDENTIFIER_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && PUBLIC_IDENTIFIER_PATTERN.test(value);
}

export interface AuthorizationState {
  schemaVersion: 1;
  authorizationStateId: string;
  userId: string;
  connectionId: string;
  returnTarget: "browser" | "desktop";
  expiresAt: number;
  nativeReturnNonce?: string;
}

const MINIMUM_AUTHORIZATION_STATE_SECRET_LENGTH = 32;
const MINIMUM_AUTHORIZATION_STATE_SECRET_UNIQUE_CHARACTERS = 8;
const FORBIDDEN_AUTHORIZATION_STATE_SECRETS = new Set([
  "replace-with-an-independent-random-secret",
]);

function isRepeatedAuthorizationStateSecret(secret: string): boolean {
  for (
    let patternLength = 1;
    patternLength <= Math.min(16, Math.floor(secret.length / 2));
    patternLength += 1
  ) {
    if (
      secret.length % patternLength === 0 &&
      secret ===
        secret.slice(0, patternLength).repeat(secret.length / patternLength)
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Whether a configured secret is strong enough to sign a callback identity
 * with. A short, repeated, or placeholder secret is refused at configuration
 * time rather than trusted at callback time.
 */
export function isStrongAuthorizationStateSecretV1(secret: string): boolean {
  return (
    secret.length >= MINIMUM_AUTHORIZATION_STATE_SECRET_LENGTH &&
    new Set(secret).size >=
      MINIMUM_AUTHORIZATION_STATE_SECRET_UNIQUE_CHARACTERS &&
    !FORBIDDEN_AUTHORIZATION_STATE_SECRETS.has(secret) &&
    !isRepeatedAuthorizationStateSecret(secret)
  );
}

export function base64UrlEncodeV1(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

export function base64UrlDecodeV1(value: string): Uint8Array {
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function stateKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function encodeAuthorizationState(
  state: AuthorizationState,
  secret: string,
): Promise<string> {
  const payload = new TextEncoder().encode(JSON.stringify(state));
  const signature = new Uint8Array(
    await crypto.subtle.sign("HMAC", await stateKey(secret), payload),
  );
  return `${base64UrlEncodeV1(payload)}.${base64UrlEncodeV1(signature)}`;
}

export async function decodeAuthorizationState(
  value: string,
  secret: string,
  now: number = Date.now(),
): Promise<AuthorizationState> {
  const [payloadPart, signaturePart, extra] = value.split(".");
  if (!payloadPart || !signaturePart || extra !== undefined) {
    throw new Error("Connection authorization state is invalid");
  }
  const payload = base64UrlDecodeV1(payloadPart);
  const signature = base64UrlDecodeV1(signaturePart);
  if (
    !(await crypto.subtle.verify(
      "HMAC",
      await stateKey(secret),
      new Uint8Array(signature).buffer,
      new Uint8Array(payload).buffer,
    ))
  ) {
    throw new Error("Connection authorization state is invalid");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new Error("Connection authorization state is invalid");
  }
  if (!decoded || typeof decoded !== "object") {
    throw new Error("Connection authorization state is invalid");
  }
  const state = decoded as Partial<AuthorizationState>;
  if (
    state.schemaVersion !== 1 ||
    !isIdentifier(state.authorizationStateId) ||
    !isIdentifier(state.userId) ||
    !isIdentifier(state.connectionId) ||
    (state.returnTarget !== "browser" && state.returnTarget !== "desktop") ||
    !Number.isSafeInteger(state.expiresAt) ||
    (state.expiresAt as number) <= now ||
    (state.nativeReturnNonce !== undefined &&
      !isIdentifier(state.nativeReturnNonce))
  ) {
    throw new Error("Connection authorization state is invalid or expired");
  }
  return state as AuthorizationState;
}
