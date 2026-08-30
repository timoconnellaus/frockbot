import { describe, expect, test } from "bun:test";
import {
  decodeCredentialLeaseV1,
  openCredentialV1,
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "./credentials.js";

const key = Uint8Array.from({ length: 32 }, (_, index) => index + 1);
let binary = "";
for (const byte of key) binary += String.fromCharCode(byte);
const encoded = btoa(binary)
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/, "");

const keyring = parseCredentialKeyringV1(
  JSON.stringify({
    schemaVersion: 1,
    currentKeyId: "2026-08",
    keys: { "2026-08": encoded },
  }),
);
const context = {
  accountId: "account-1",
  connectionId: "connection-1",
  packageId: "provider-ollama-cloud",
  credentialGeneration: "generation-1",
};

describe("Connection credential envelopes", () => {
  test("requires the current key to be an own keyring entry", () => {
    expect(() =>
      parseCredentialKeyringV1(
        JSON.stringify({
          schemaVersion: 1,
          currentKeyId: "toString",
          keys: { primary: encoded },
        }),
      ),
    ).toThrow("credential keyring current key is unavailable");
  });

  test("round-trips a secret without placing plaintext in the envelope", async () => {
    const envelope = await sealCredentialV1({
      keyring,
      context,
      plaintext: "ollama-secret",
      createdAt: "2026-08-30T00:00:00.000Z",
      randomBytes: () => new Uint8Array(12).fill(7),
    });

    expect(JSON.stringify(envelope)).not.toContain("ollama-secret");
    expect(await openCredentialV1({ keyring, context, envelope })).toBe(
      "ollama-secret",
    );
  });

  test("authenticates Connection ownership context", async () => {
    const envelope = await sealCredentialV1({
      keyring,
      context,
      plaintext: "ollama-secret",
    });

    await expect(
      openCredentialV1({
        keyring,
        envelope,
        context: { ...context, accountId: "another-account" },
      }),
    ).rejects.toThrow("credential envelope authentication failed");
  });

  test("decodes exact versioned credential leases at RPC seams", async () => {
    const envelope = await sealCredentialV1({
      keyring,
      context,
      plaintext: "ollama-secret",
      createdAt: "2026-08-30T00:00:00.000Z",
    });
    const lease = {
      schemaVersion: 1,
      leaseId: "lease-1",
      effectId: "effect-1",
      connectionId: context.connectionId,
      credentialGeneration: context.credentialGeneration,
      expiresAt: "2026-08-30T01:00:00.000Z",
      envelope,
    } as const;

    expect(decodeCredentialLeaseV1(lease)).toEqual(lease);
    expect(() =>
      decodeCredentialLeaseV1({ ...lease, unexpected: true }),
    ).toThrow("Credential lease is invalid");
    expect(() =>
      decodeCredentialLeaseV1({
        ...lease,
        credentialGeneration: "generation-2",
      }),
    ).toThrow("Credential lease is invalid");
  });

  test("requires a versioned 32-byte keyring", () => {
    expect(() =>
      parseCredentialKeyringV1(
        JSON.stringify({
          schemaVersion: 1,
          currentKeyId: "weak",
          keys: { weak: "c2hvcnQ" },
        }),
      ),
    ).toThrow('credential key "weak" must contain 32 bytes');
  });
});
