import { base64urlDecodeV1, base64urlEncodeV1 } from "@frockbot/core/crypto";

/**
 * Message encryption for Web Push (RFC 8291) in the `aes128gcm` content
 * coding (RFC 8188), one record.
 *
 * The app generates a P-256 key pair and a 16-byte auth secret, keeps the
 * private half on the phone and hands its server the public half. The server
 * seals what an alert says with them, so the push relay and Google carry only
 * ciphertext; the phone opens it before drawing the alert. The Kotlin and
 * Swift openers (`PushSeal.kt`, `PushSeal.swift`) are ports of `openPushV1`.
 */
export interface PushKeyV1 {
  /** The app's public key: an uncompressed P-256 point, base64url. */
  p256dh: string;
  /** The app's 16-byte auth secret, base64url. */
  auth: string;
}

const encoder = new TextEncoder();
const RECORD_SIZE = 4096;
const HEADER_BYTES = 16 + 4 + 1 + 65;

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", buffer(ikm), "HKDF", false, [
    "deriveBits",
  ]);
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "HKDF", hash: "SHA-256", salt: buffer(salt), info: buffer(info) },
      key,
      length * 8,
    ),
  );
}

/** The content key and nonce both sides derive from the shared secret. */
async function contentKeys(
  ecdhSecret: Uint8Array,
  authSecret: Uint8Array,
  receiverPublic: Uint8Array,
  senderPublic: Uint8Array,
  salt: Uint8Array,
): Promise<{ key: CryptoKey; nonce: Uint8Array }> {
  const ikm = await hkdf(
    authSecret,
    ecdhSecret,
    concat(encoder.encode("WebPush: info\0"), receiverPublic, senderPublic),
    32,
  );
  const cek = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: aes128gcm\0"),
    16,
  );
  const nonce = await hkdf(
    salt,
    ikm,
    encoder.encode("Content-Encoding: nonce\0"),
    12,
  );
  const key = await crypto.subtle.importKey(
    "raw",
    buffer(cek),
    "AES-GCM",
    false,
    ["encrypt", "decrypt"],
  );
  return { key, nonce };
}

function publicKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("Invalid push key");
  return crypto.subtle.importKey(
    "raw",
    buffer(raw),
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
}

async function sharedSecret(
  privateKey: CryptoKey,
  peer: Uint8Array,
): Promise<Uint8Array> {
  return new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: await publicKey(peer) },
      privateKey,
      256,
    ),
  );
}

/** Whether a registration's key is one `sealPushV1` can seal to. */
export function isPushKeyV1(value: unknown): value is PushKeyV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const key = value as Record<string, unknown>;
  if (
    Object.keys(key).some((name) => name !== "p256dh" && name !== "auth") ||
    typeof key.p256dh !== "string" ||
    typeof key.auth !== "string"
  )
    return false;
  try {
    const point = base64urlDecodeV1(key.p256dh);
    return (
      point.length === 65 &&
      point[0] === 4 &&
      base64urlDecodeV1(key.auth).length === 16
    );
  } catch {
    return false;
  }
}

/**
 * Seals `plaintext` to `receiver`, answering the base64url `aes128gcm` body.
 * `sender` and `salt` are for the RFC's test vector only.
 */
export async function sealPushV1(
  receiver: PushKeyV1,
  plaintext: string,
  fixed?: { sender: CryptoKeyPair; salt: Uint8Array },
): Promise<string> {
  const receiverPublic = base64urlDecodeV1(receiver.p256dh);
  const authSecret = base64urlDecodeV1(receiver.auth);
  const sender =
    fixed?.sender ??
    ((await crypto.subtle.generateKey(
      { name: "ECDH", namedCurve: "P-256" },
      true,
      ["deriveBits"],
    )) as CryptoKeyPair);
  const salt = fixed?.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const senderPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", sender.publicKey)) as ArrayBuffer,
  );
  const { key, nonce } = await contentKeys(
    await sharedSecret(sender.privateKey, receiverPublic),
    authSecret,
    receiverPublic,
    senderPublic,
    salt,
  );
  // One record, so it is the last one: its padding delimiter is 0x02.
  const record = concat(encoder.encode(plaintext), new Uint8Array([2]));
  if (record.length + 16 + HEADER_BYTES > RECORD_SIZE)
    throw new Error("Push content is too long to seal");
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: buffer(nonce) },
      key,
      buffer(record),
    ),
  );
  const header = new Uint8Array(HEADER_BYTES);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = 65;
  header.set(senderPublic, 21);
  return base64urlEncodeV1(concat(header, ciphertext));
}

/** Opens a body `sealPushV1` wrote, with the receiver's private key. */
export async function openPushV1(
  receiver: { privateKey: CryptoKey; key: PushKeyV1 },
  sealed: string,
): Promise<string> {
  const body = base64urlDecodeV1(sealed);
  if (body.length < HEADER_BYTES + 17 || body[20] !== 65)
    throw new Error("Invalid sealed push");
  const salt = body.slice(0, 16);
  const senderPublic = body.slice(21, HEADER_BYTES);
  const receiverPublic = base64urlDecodeV1(receiver.key.p256dh);
  const { key, nonce } = await contentKeys(
    await sharedSecret(receiver.privateKey, senderPublic),
    base64urlDecodeV1(receiver.key.auth),
    receiverPublic,
    senderPublic,
    salt,
  );
  const record = new Uint8Array(
    await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: buffer(nonce) },
      key,
      buffer(body.slice(HEADER_BYTES)),
    ),
  );
  let end = record.length - 1;
  while (end >= 0 && record[end] === 0) end--;
  if (end < 0 || record[end] !== 2) throw new Error("Invalid sealed push");
  return new TextDecoder("utf-8", { fatal: true }).decode(record.slice(0, end));
}
