export type ConnectionAuthorizationKind =
  "none" | "api-key" | "ambient-native" | "grant";

export interface CredentialDescriptorV1 {
  schemaVersion: 1;
  configured: boolean;
  source: ConnectionAuthorizationKind;
  writable: boolean;
  generation?: string;
  updatedAt?: string;
}

export interface CredentialEnvelopeV1 {
  schemaVersion: 1;
  algorithm: "AES-GCM";
  keyId: string;
  credentialGeneration: string;
  nonce: string;
  ciphertext: string;
  createdAt: string;
}

export interface CredentialLeaseV1 {
  schemaVersion: 1;
  leaseId: string;
  effectId: string;
  connectionId: string;
  credentialGeneration: string;
  expiresAt: string;
  envelope: CredentialEnvelopeV1;
}

export interface CredentialKeyringV1 {
  schemaVersion: 1;
  currentKeyId: string;
  keys: Record<string, string>;
}

export interface CredentialContextV1 {
  accountId: string;
  connectionId: string;
  packageId: string;
  credentialGeneration: string;
}

function credentialRecord(input: unknown): Record<string, unknown> | undefined {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : undefined;
}

function hasCredentialKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
): boolean {
  return (
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function credentialString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

export function decodeCredentialEnvelopeV1(
  input: unknown,
): CredentialEnvelopeV1 {
  const value = credentialRecord(input);
  if (
    !value ||
    !hasCredentialKeys(value, [
      "schemaVersion",
      "algorithm",
      "keyId",
      "credentialGeneration",
      "nonce",
      "ciphertext",
      "createdAt",
    ]) ||
    value.schemaVersion !== 1 ||
    value.algorithm !== "AES-GCM" ||
    !credentialString(value.keyId) ||
    !credentialString(value.credentialGeneration) ||
    !credentialString(value.nonce) ||
    !credentialString(value.ciphertext) ||
    !credentialString(value.createdAt) ||
    !Number.isFinite(Date.parse(value.createdAt))
  ) {
    throw new Error("Credential envelope is invalid");
  }
  return {
    schemaVersion: 1,
    algorithm: "AES-GCM",
    keyId: value.keyId,
    credentialGeneration: value.credentialGeneration,
    nonce: value.nonce,
    ciphertext: value.ciphertext,
    createdAt: value.createdAt,
  };
}

export function decodeCredentialLeaseV1(input: unknown): CredentialLeaseV1 {
  const value = credentialRecord(input);
  if (
    !value ||
    !hasCredentialKeys(value, [
      "schemaVersion",
      "leaseId",
      "effectId",
      "connectionId",
      "credentialGeneration",
      "expiresAt",
      "envelope",
    ]) ||
    value.schemaVersion !== 1 ||
    !credentialString(value.leaseId) ||
    !credentialString(value.effectId) ||
    !credentialString(value.connectionId) ||
    !credentialString(value.credentialGeneration) ||
    !credentialString(value.expiresAt) ||
    !Number.isFinite(Date.parse(value.expiresAt))
  ) {
    throw new Error("Credential lease is invalid");
  }
  const envelope = decodeCredentialEnvelopeV1(value.envelope);
  if (envelope.credentialGeneration !== value.credentialGeneration) {
    throw new Error("Credential lease is invalid");
  }
  return {
    schemaVersion: 1,
    leaseId: value.leaseId,
    effectId: value.effectId,
    connectionId: value.connectionId,
    credentialGeneration: value.credentialGeneration,
    expiresAt: value.expiresAt,
    envelope,
  };
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("credential key material is not base64url");
  }
  const padded = value.replaceAll("-", "+").replaceAll("_", "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function contextBytes(context: CredentialContextV1): Uint8Array {
  return encoder.encode(
    JSON.stringify([
      context.accountId,
      context.connectionId,
      context.packageId,
      context.credentialGeneration,
    ]),
  );
}

function decodeKeyring(input: string): CredentialKeyringV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new Error("credential keyring is not valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("credential keyring is invalid");
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.schemaVersion !== 1 ||
    typeof value.currentKeyId !== "string" ||
    !value.currentKeyId ||
    !value.keys ||
    typeof value.keys !== "object" ||
    Array.isArray(value.keys)
  ) {
    throw new Error("credential keyring is invalid");
  }
  const entries = Object.entries(value.keys as Record<string, unknown>);
  if (entries.length === 0) throw new Error("credential keyring is empty");
  const keys: Record<string, string> = Object.create(null) as Record<
    string,
    string
  >;
  for (const [keyId, encoded] of entries) {
    if (!keyId || typeof encoded !== "string") {
      throw new Error("credential keyring is invalid");
    }
    const bytes = fromBase64Url(encoded);
    if (bytes.byteLength !== 32) {
      throw new Error(`credential key "${keyId}" must contain 32 bytes`);
    }
    keys[keyId] = encoded;
  }
  if (!Object.hasOwn(keys, value.currentKeyId)) {
    throw new Error("credential keyring current key is unavailable");
  }
  return {
    schemaVersion: 1,
    currentKeyId: value.currentKeyId,
    keys,
  };
}

async function encryptionKey(encoded: string): Promise<CryptoKey> {
  const bytes = fromBase64Url(encoded);
  return crypto.subtle.importKey(
    "raw",
    bytes as Uint8Array<ArrayBuffer>,
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );
}

export function parseCredentialKeyringV1(input: string): CredentialKeyringV1 {
  return decodeKeyring(input);
}

export async function sealCredentialV1(input: {
  keyring: CredentialKeyringV1;
  context: CredentialContextV1;
  plaintext: string;
  createdAt?: string;
  randomBytes?: (length: number) => Uint8Array;
}): Promise<CredentialEnvelopeV1> {
  if (!input.plaintext) throw new Error("credential must not be empty");
  const encodedKey = input.keyring.keys[input.keyring.currentKeyId];
  if (!encodedKey) throw new Error("credential encryption key is unavailable");
  const nonce = input.randomBytes
    ? input.randomBytes(12)
    : crypto.getRandomValues(new Uint8Array(12));
  if (nonce.byteLength !== 12) {
    throw new Error("credential nonce must contain 12 bytes");
  }
  const ciphertext = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: nonce as Uint8Array<ArrayBuffer>,
      additionalData: contextBytes(input.context) as Uint8Array<ArrayBuffer>,
    },
    await encryptionKey(encodedKey),
    encoder.encode(input.plaintext),
  );
  return {
    schemaVersion: 1,
    algorithm: "AES-GCM",
    keyId: input.keyring.currentKeyId,
    credentialGeneration: input.context.credentialGeneration,
    nonce: base64Url(nonce),
    ciphertext: base64Url(new Uint8Array(ciphertext)),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
}

export async function openCredentialV1(input: {
  keyring: CredentialKeyringV1;
  context: CredentialContextV1;
  envelope: CredentialEnvelopeV1;
}): Promise<string> {
  if (
    input.envelope.schemaVersion !== 1 ||
    input.envelope.algorithm !== "AES-GCM" ||
    input.envelope.credentialGeneration !== input.context.credentialGeneration
  ) {
    throw new Error("credential envelope is invalid");
  }
  const encodedKey = input.keyring.keys[input.envelope.keyId];
  if (!encodedKey) {
    throw new Error(
      `credential encryption key "${input.envelope.keyId}" is unavailable`,
    );
  }
  try {
    const plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64Url(input.envelope.nonce) as Uint8Array<ArrayBuffer>,
        additionalData: contextBytes(input.context) as Uint8Array<ArrayBuffer>,
      },
      await encryptionKey(encodedKey),
      fromBase64Url(input.envelope.ciphertext) as Uint8Array<ArrayBuffer>,
    );
    return decoder.decode(plaintext);
  } catch {
    throw new Error("credential envelope authentication failed");
  }
}
