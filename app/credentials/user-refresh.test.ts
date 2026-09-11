import { describe, expect, test } from "bun:test";
import {
  createCredentialUserBackendContribution,
  type CredentialStorage,
  type CredentialTransaction,
} from "./user.js";

class MemoryStorage implements CredentialStorage {
  readonly values = new Map<string, unknown>();

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

const authority = {
  accountId: "account-1",
  connectionId: "connection-1",
  packageId: "provider-openai-codex",
  generation: "generation-1",
};

function contribution() {
  const storage = new MemoryStorage();
  return {
    storage,
    credentials: createCredentialUserBackendContribution({
      storage,
      keyring: serializedKeyring,
      now: () => Date.parse("2026-09-09T00:00:00.000Z"),
    }),
  };
}

async function activate(
  credentials: ReturnType<typeof createCredentialUserBackendContribution>,
  secret: string,
  generation = authority.generation,
): Promise<void> {
  await credentials.stageApiKey({
    ...authority,
    generation,
    apiKey: secret,
  });
  await credentials.activate({ ...authority, generation });
}

async function activeSecret(
  credentials: ReturnType<typeof createCredentialUserBackendContribution>,
  generation: string,
  effectId: string,
): Promise<string> {
  const lease = await credentials.lease({
    ...authority,
    expectedGeneration: generation,
    effectId,
    expiresAt: "2026-09-09T01:00:00.000Z",
  });
  return credentials.openLease({
    accountId: authority.accountId,
    packageId: authority.packageId,
    lease,
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("active credential refresh", () => {
  test("serializes concurrent refreshes and stores only one rotated secret", async () => {
    const { credentials } = contribution();
    await activate(credentials, "expired-secret");
    const gate = deferred<string>();
    const started = deferred<void>();
    let refreshes = 0;
    const refresh = async () => {
      refreshes += 1;
      started.resolve();
      return gate.promise;
    };
    const input = {
      ...authority,
      needsRefresh: (secret: string) => secret === "expired-secret",
      refresh,
    };

    const first = credentials.refreshActiveSecret(input);
    const second = credentials.refreshActiveSecret(input);
    await started.promise;
    expect(refreshes).toBe(1);

    gate.resolve("fresh-secret");
    await Promise.all([first, second]);

    expect(refreshes).toBe(1);
    await expect(
      activeSecret(credentials, authority.generation, "effect-after-refresh"),
    ).resolves.toBe("fresh-secret");
  });

  test("leaves durable intent after an interrupted refresh and never retries it", async () => {
    const { storage, credentials } = contribution();
    await activate(credentials, "expired-secret");
    let refreshes = 0;
    const input = {
      ...authority,
      needsRefresh: () => true,
      refresh: async () => {
        refreshes += 1;
        throw new Error("connection dropped after token rotation");
      },
    };

    await expect(credentials.refreshActiveSecret(input)).rejects.toThrow(
      "connection dropped after token rotation",
    );
    expect(
      storage.values.get("credential-refresh:connection-1:generation-1"),
    ).toBe(true);

    await expect(credentials.refreshActiveSecret(input)).rejects.toThrow(
      "OAuth refresh was interrupted; sign in again",
    );
    expect(refreshes).toBe(1);
  });

  test("cannot overwrite a credential that rotated while refresh was in flight", async () => {
    const { storage, credentials } = contribution();
    await activate(credentials, "generation-one-secret");
    const gate = deferred<string>();
    const started = deferred<void>();
    const refreshing = credentials.refreshActiveSecret({
      ...authority,
      needsRefresh: () => true,
      refresh: async () => {
        started.resolve();
        return gate.promise;
      },
    });
    await started.promise;

    await activate(credentials, "generation-two-secret", "generation-2");
    gate.resolve("stale-refreshed-secret");

    await expect(refreshing).rejects.toThrow(
      "OAuth connection was disconnected",
    );
    expect(storage.values.has("credential:connection-1:generation-1")).toBe(
      false,
    );
    await expect(
      activeSecret(credentials, "generation-2", "effect-after-rotation"),
    ).resolves.toBe("generation-two-secret");
  });

  test("cannot restore a credential disconnected while refresh was in flight", async () => {
    const { storage, credentials } = contribution();
    await activate(credentials, "connected-secret");
    const gate = deferred<string>();
    const started = deferred<void>();
    const refreshing = credentials.refreshActiveSecret({
      ...authority,
      needsRefresh: () => true,
      refresh: async () => {
        started.resolve();
        return gate.promise;
      },
    });
    await started.promise;

    await credentials.disconnect(authority.connectionId);
    gate.resolve("stale-refreshed-secret");

    await expect(refreshing).rejects.toThrow(
      "OAuth connection was disconnected",
    );
    expect(storage.values.has("credential-active:connection-1")).toBe(false);
    expect(storage.values.has("credential:connection-1:generation-1")).toBe(
      false,
    );
    await expect(
      activeSecret(
        credentials,
        authority.generation,
        "effect-after-disconnect",
      ),
    ).rejects.toThrow("Connection credential is unavailable");
  });
});
