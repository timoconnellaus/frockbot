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
  expectedGeneration: "generation-1",
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

    storage.values.set("credential-lease-queue", {
      schemaVersion: 1,
      headPage: 0,
      tailPage: 0,
      scanPage: null,
      scanMinimum: null,
      nextAlarm: null,
      unexpected: true,
    });
    await expect(credentials.nextLeaseExpiry()).rejects.toThrow(
      "Stored credential lease queue is invalid",
    );
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
      expectedGeneration: "generation-2",
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

  test("expires leases until a delayed durable outcome settles", async () => {
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

    await credentials.settle({ ...authority, effectId: "effect-expired" });

    await expect(
      credentials.lease({
        ...authority,
        effectId: "effect-expired",
        expiresAt: "2026-08-30T02:00:00.000Z",
      }),
    ).resolves.toMatchObject({ effectId: "effect-expired" });
  });

  test("bounds expired lease tombstones", async () => {
    let now = Date.parse("2026-08-30T00:00:00.000Z");
    const { storage, credentials } = contribution(
      new MemoryStorage(),
      () => now,
    );
    await credentials.stageApiKey({
      ...authority,
      generation: "generation-1",
      apiKey: "secret",
    });
    await credentials.activate({ ...authority, generation: "generation-1" });
    for (let index = 0; index < 64; index += 1) {
      await credentials.lease({
        ...authority,
        effectId: `effect-${index}`,
        expiresAt: "2026-08-30T01:00:00.000Z",
      });
    }
    await expect(
      credentials.lease({
        ...authority,
        effectId: "effect-over-capacity",
        expiresAt: "2026-08-30T01:00:00.000Z",
      }),
    ).rejects.toThrow("Credential lease capacity requires rotation");

    const otherAuthority = {
      ...authority,
      connectionId: "connection-2",
      expectedGeneration: "other-generation",
    };
    await credentials.stageApiKey({
      ...otherAuthority,
      generation: "other-generation",
      apiKey: "other-secret",
    });
    await credentials.activate({
      ...otherAuthority,
      generation: "other-generation",
    });
    await expect(
      credentials.lease({
        ...otherAuthority,
        effectId: "other-connection-effect",
        expiresAt: "2026-08-30T01:00:00.000Z",
      }),
    ).resolves.toMatchObject({ connectionId: "connection-2" });

    now = Date.parse("2026-08-30T01:00:00.000Z");
    await credentials.expireLeases();

    expect(
      [...storage.values.keys()].filter((key) =>
        key.startsWith("credential-lease-expired:effect-"),
      ),
    ).toHaveLength(64);
    expect(storage.values.has("credential-lease:other-connection-effect")).toBe(
      true,
    );
    expect(storage.alarm).toBe(now);
    await credentials.expireLeases();
    expect(storage.values.has("credential-lease:other-connection-effect")).toBe(
      false,
    );
    await expect(
      credentials.lease({
        ...authority,
        effectId: "effect-0",
        expiresAt: "2026-08-30T02:00:00.000Z",
      }),
    ).rejects.toThrow("Credential lease expired");

    await credentials.stageApiKey({
      ...authority,
      generation: "generation-2",
      apiKey: "replacement",
    });
    await credentials.activate({ ...authority, generation: "generation-2" });
    expect(
      [...storage.values.keys()].filter((key) =>
        key.startsWith("credential-lease-expired:effect-"),
      ),
    ).toHaveLength(0);
    expect(
      storage.values.has("credential-lease-expired:other-connection-effect"),
    ).toBe(true);
    await expect(
      credentials.lease({
        ...authority,
        effectId: "effect-0",
        expiresAt: "2026-08-30T02:00:00.000Z",
      }),
    ).rejects.toThrow("Connection credential is unavailable");
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
    await expect(
      credentials.settle({
        ...authority,
        connectionId: "connection-2",
        effectId: "effect-1",
      }),
    ).rejects.toThrow("Credential lease authority does not match");
    await expect(
      credentials.replayLease({
        ...authority,
        effectId: "effect-1",
      }),
    ).resolves.toEqual(admitted);
    await credentials.settle({ ...authority, effectId: "effect-1" });
  });
});
