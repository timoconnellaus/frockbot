/** Small, platform-neutral cryptographic and stable-hash primitives.
 *
 * The helpers here deliberately stop at bytes and encodings. Token claims,
 * signing-key policy, and failure messages remain owned by their domains.
 */

const UTF8 = new TextEncoder();

/** SHA-256 rendered as lower-case hexadecimal for UTF-8 text. */
export function sha256HexV1(text: string): Promise<string> {
  return sha256HexBytesV1(UTF8.encode(text));
}

/** SHA-256 rendered as lower-case hexadecimal for raw bytes. */
export async function sha256HexBytesV1(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    bytes.slice().buffer as ArrayBuffer,
  );
  return bytesToHexV1(new Uint8Array(digest));
}

/** Explicit alias for callers that want the text/bytes distinction at the call site. */
export const sha256HexTextV1 = sha256HexV1;

/** Render bytes as lower-case hexadecimal. */
export function bytesToHexV1(bytes: Uint8Array | ArrayBufferLike): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let result = "";
  for (const byte of view) result += byte.toString(16).padStart(2, "0");
  return result;
}

/** Encode bytes as canonical, unpadded base64url. */
export function base64urlEncodeV1(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/**
 * Decode canonical, unpadded base64url.
 *
 * Padding, the standard-base64 alphabet, impossible lengths, non-zero
 * trailing bits, and other non-canonical spellings are refused rather than
 * silently normalised. An empty string is the canonical encoding of no bytes.
 */
export function base64urlDecodeV1(value: string): Uint8Array {
  if (
    typeof value !== "string" ||
    !/^[A-Za-z0-9_-]*$/.test(value) ||
    value.length % 4 === 1
  ) {
    throw new Error("invalid base64url");
  }
  const standard = value.replaceAll("-", "+").replaceAll("_", "/");
  const padded = standard + "=".repeat((4 - (standard.length % 4)) % 4);
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    throw new Error("invalid base64url");
  }
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  if (base64urlEncodeV1(bytes) !== value) {
    throw new Error("invalid base64url");
  }
  return bytes;
}

/** Compare UTF-8 strings without returning early on differing contents. */
export function constantTimeEqualsV1(left: string, right: string): boolean {
  const a = UTF8.encode(left);
  const b = UTF8.encode(right);
  let mismatch = a.length ^ b.length;
  const span = Math.max(a.length, b.length);
  for (let index = 0; index < span; index += 1) {
    mismatch |= (a[index] ?? 0) ^ (b[index] ?? 0);
  }
  return mismatch === 0;
}

/** Stable, non-cryptographic FNV-1a over a string's UTF-8 bytes. */
export function fnv1a32Utf8V1(value: string): number {
  let hash = 0x811c9dc5;
  for (const byte of UTF8.encode(value)) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash;
}
