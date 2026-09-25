// In-memory storage and a keyring for the secrets suites.
import type {
  CredentialStorage,
  CredentialTransaction,
} from "@frockbot/app/credentials/user";

export class MemorySecretStorage implements CredentialStorage {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T);
  }

  put<T>(key: string, value: T): Promise<void>;
  put(entries: Record<string, unknown>): Promise<void>;
  put<T>(
    keyOrEntries: string | Record<string, unknown>,
    value?: T,
  ): Promise<void> {
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, structuredClone(value));
    } else {
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        this.values.set(key, structuredClone(entry));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: { prefix: string }): Promise<Map<string, T>> {
    return Promise.resolve(
      new Map(
        [...this.values.entries()]
          .filter(([key]) => key.startsWith(options.prefix))
          .sort(([left], [right]) => left.localeCompare(right))
          .map(([key, value]) => [key, structuredClone(value) as T]),
      ),
    );
  }

  transaction<T>(
    callback: (storage: CredentialTransaction) => Promise<T>,
  ): Promise<T> {
    return callback(this);
  }

  /** Everything held, as the bytes a reader of this storage would see. */
  dump(): string {
    return JSON.stringify([...this.values.entries()]);
  }
}

const keyBytes = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
let binary = "";
for (const byte of keyBytes) binary += String.fromCharCode(byte);

export const TEST_SECRETS_KEYRING = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "primary",
  keys: {
    primary: btoa(binary)
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, ""),
  },
});
