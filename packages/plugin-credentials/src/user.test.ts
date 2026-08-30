import { describe, expect, test } from "bun:test";
import {
  openCredentialV1,
  parseCredentialKeyringV1,
} from "@frockbot/connection-core";
import {
  createCredentialUserBackendContribution,
  type CredentialStorage,
  type CredentialTransaction,
} from "./user.js";

class MemoryStorage implements CredentialStorage {
  readonly values = new Map<string, unknown>();
  alarm?: number;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") this.values.set(keyOrEntries, value);
    else
      for (const [key, entry] of Object.entries(keyOrEntries))
        this.values.set(key, entry);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  transaction<T>(
    callback: (storage: CredentialTransaction) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm ?? null);
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = Number(scheduledTime);
    return Promise.resolve();
  }
}

const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 7);
let binary = "";
for (const byte of bytes) binary += String.fromCharCode(byte);
const encodedKey = btoa(binary)
  .replaceAll("+", "-")
  .replaceAll("/", "_")
  .replace(/=+$/, "");
const serializedKeyring = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "primary",
  keys: { primary: encodedKey },
});

function contribution(
  storage = new MemoryStorage(),
  now: () => number = () => Date.parse("2026-08-30T00:00:00.000Z"),
) {
  return {
    storage,
    credentials: createCredentialUserBackendContribution({
      storage,
      keyring: serializedKeyring,
      now,
    }),
  };
}

const authority = {
  accountId: "account-1",
  connectionId: "connection-1",
  packageId: "provider-ollama-cloud",
};

describe("Credential User Contribution", () => {
  test("rejects malformed durable credential generations and leases", async () => {
    const { storage, credentials } = contribution();
    await credentials.stageApiKey({
      ...authority,
      generation: "generation-1",
      apiKey: "secret",
    });
    const generationKey = "credential:connection-1:generation-1";
    storage.values.set(generationKey, {
      ...(storage.values.get(generationKey) as Record<string, unknown>),
      unexpected: true,
    });

    await expect(
      credentials.readStagedApiKey({
        ...authority,
        generation: "generation-1",
      }),
    ).rejects.toThrow("Stored credential generation is invalid");

    storage.values.delete(generationKey);
    await credentials.stageApiKey({
      ...authority,
      generation: "generation-1",
      apiKey: "secret",
    });
    await credentials.activate({ ...authority, generation: "generation-1" });
    const lease = await credentials.lease({
      ...authority,
      effectId: "effect-1",
      expiresAt: "2026-08-30T01:00:00.000Z",
    });
    const leaseKey = "credential-lease:effect-1";
    storage.values.set(leaseKey, {
      ...(storage.values.get(leaseKey) as Record<string, unknown>),
      settled: "no",
    });

    await expect(
      credentials.openLease({
        accountId: authority.accountId,
        packageId: authority.packageId,
        lease,
      }),
    ).rejects.toThrow("Stored credential lease is invalid");
  });

  test("deletes an unleased credential generation during rotation", async () => {
    const { storage, credentials } = contribution();
    await credentials.stageApiKey({
      ...authority,
      generation: "generation-1",
      apiKey: "old-key",
    });
    await credentials.activate({ ...authority, generation: "generation-1" });
    await credentials.stageApiKey({
      ...authority,
      generation: "generation-2",
      apiKey: "new-key",
    });
    await credentials.activate({ ...authority, generation: "generation-2" });

    expect(storage.values.has("credential:connection-1:generation-1")).toBe(
      false,
    );
    expect(storage.values.has("credential:connection-1:generation-2")).toBe(
      true,
    );
  });

  test("rotates atomically while admitted effects retain the old generation", async () => {
    const { storage, credentials } = contribution();
    await credentials.stageApiKey({
      ...authority,
      generation: "generation-1",
      apiKey: "old-key",
    });
    await credentials.activate({ ...authority, generation: "generation-1" });
    const oldLease = await credentials.lease({
      ...authority,
      effectId: "effect-1",
      expiresAt: "2026-08-30T01:00:00.000Z",
    });

    await credentials.stageApiKey({
      ...authority,
      generation: "generation-2",
      apiKey: "new-key",
    });
    await credentials.activate({ ...authority, generation: "generation-2" });
    const newLease = await credentials.lease({
      ...authority,
      effectId: "effect-2",
      expiresAt: "2026-08-30T01:00:00.000Z",
    });

    expect(oldLease.credentialGeneration).toBe("generation-1");
    expect(newLease.credentialGeneration).toBe("generation-2");
    expect(storage.values.has("credential:connection-1:generation-1")).toBe(
      true,
    );
    const keyring = parseCredentialKeyringV1(serializedKeyring);
    expect(
      await openCredentialV1({
        keyring,
        context: {
          ...authority,
          credentialGeneration: oldLease.credentialGeneration,
        },
        envelope: oldLease.envelope,
      }),
    ).toBe("old-key");
  });

  test("replays the same effect lease and rejects cross-Connection reuse", async () => {
    const { credentials } = contribution();
    await credentials.stageApiKey({
      ...authority,
      generation: "generation-1",
      apiKey: "secret",
    });
    await credentials.activate({ ...authority, generation: "generation-1" });
    const first = await credentials.lease({
      ...authority,
      effectId: "effect-1",
      expiresAt: "2026-08-30T01:00:00.000Z",
    });
    const replay = await credentials.lease({
      ...authority,
      effectId: "effect-1",
      expiresAt: "2026-08-30T02:00:00.000Z",
    });
    expect(replay).toEqual(first);
    await expect(
      credentials.lease({
        ...authority,
        connectionId: "connection-2",
        effectId: "effect-1",
        expiresAt: "2026-08-30T02:00:00.000Z",
      }),
    ).rejects.toThrow("Credential lease effect id was reused");
  });

  test("expires durable leases and blocks replay or decryption", async () => {
    let now = Date.parse("2026-08-30T00:00:00.000Z");
    const { credentials } = contribution(undefined, () => now);
    await credentials.stageApiKey({
      ...authority,
      generation: "generation-1",
      apiKey: "secret",
    });
    await credentials.activate({ ...authority, generation: "generation-1" });
    const lease = await credentials.lease({
      ...authority,
      effectId: "effect-expired",
      expiresAt: "2026-08-30T01:00:00.000Z",
    });

    now = Date.parse("2026-08-30T01:00:00.000Z");
    await expect(
      credentials.openLease({
        accountId: authority.accountId,
        packageId: authority.packageId,
        lease,
      }),
    ).rejects.toThrow("Credential lease expired");
    await expect(
      credentials.lease({
        ...authority,
        effectId: "effect-expired",
        expiresAt: "2026-08-30T02:00:00.000Z",
      }),
    ).rejects.toThrow("Credential lease expired");
  });

  test("disconnect blocks new leases while preserving an admitted lease", async () => {
    const { credentials } = contribution();
    await credentials.stageApiKey({
      ...authority,
      generation: "generation-1",
      apiKey: "secret",
    });
    await credentials.activate({ ...authority, generation: "generation-1" });
    const admitted = await credentials.lease({
      ...authority,
      effectId: "effect-1",
      expiresAt: "2026-08-30T01:00:00.000Z",
    });

    await credentials.disconnect(authority.connectionId);

    expect(
      await credentials.lease({
        ...authority,
        effectId: "effect-1",
        expiresAt: "2026-08-30T01:00:00.000Z",
      }),
    ).toEqual(admitted);
    await expect(
      credentials.lease({
        ...authority,
        effectId: "effect-2",
        expiresAt: "2026-08-30T01:00:00.000Z",
      }),
    ).rejects.toThrow("Connection credential is unavailable");
    await credentials.settle("effect-1");
  });
});
