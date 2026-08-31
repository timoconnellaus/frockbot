import { describe, expect, test } from "bun:test";
import {
  createCredentialUserBackendContribution,
  type CredentialStorage,
  type CredentialTransaction,
} from "@frockbot/plugin-credentials/user";
import {
  createUserSettingsBackendContribution,
  type UserSettingsStorage,
  type UserSettingsTransaction,
} from "@frockbot/plugin-settings/user";
import manifest from "../frockbot.json" with { type: "json" };
import {
  decodeOllamaApiBaseUrl,
  DEFAULT_OLLAMA_API_BASE_URL,
  OllamaCloudClient,
  type OllamaFetch,
} from "./client.js";
import { ollamaChatBaseUrl } from "./runtime.js";
import {
  createOllamaCloudUserBackendContribution,
  type OllamaUserBackendHost,
} from "./user.js";

class MemoryStorage implements UserSettingsStorage, CredentialStorage {
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
    if (typeof keyOrEntries === "string") {
      this.values.set(keyOrEntries, value);
    } else {
      for (const [key, entry] of Object.entries(keyOrEntries)) {
        this.values.set(key, entry);
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  async transaction<T>(
    callback: (
      storage: UserSettingsTransaction & CredentialTransaction,
    ) => Promise<T>,
  ): Promise<T> {
    const before = new Map(this.values);
    try {
      return await callback(this);
    } catch (error) {
      this.values.clear();
      for (const [key, entry] of before) this.values.set(key, entry);
      throw error;
    }
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(this.alarm ?? null);
  }

  setAlarm(scheduledTime: number | Date): Promise<void> {
    this.alarm = Number(scheduledTime);
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarm = undefined;
    return Promise.resolve();
  }
}

function keyring(): string {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 3);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  const key = btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
  return JSON.stringify({
    schemaVersion: 1,
    currentKeyId: "primary",
    keys: { primary: key },
  });
}

/**
 * A Contribution that builds its own client per Connection, so the URLs under
 * test are the ones the Package composes rather than a host-supplied stub's.
 */
async function fixture(options: { reject?: (url: string) => boolean } = {}) {
  const now = () => Date.parse("2026-08-30T00:00:00.000Z");
  const storage = new MemoryStorage();
  const settings = createUserSettingsBackendContribution({
    storage,
    availablePackages: [
      { packageId: "provider-ollama-cloud", version: "0.0.1" },
    ],
  });
  await settings.executeConfiguration({
    schemaVersion: 1,
    userId: "account-1",
    command: {
      schemaVersion: 1,
      type: "user/install-package",
      commandId: "install-1",
      expectedRevision: 0,
      packageId: "provider-ollama-cloud",
      version: "0.0.1",
    },
  });
  const credentials = createCredentialUserBackendContribution({
    storage,
    keyring: keyring(),
    now,
  });
  const requests: string[] = [];
  const fetch: OllamaFetch = (input) => {
    const url = String(input);
    requests.push(url);
    if (options.reject?.(url)) {
      return Promise.resolve(
        Response.json({ error: "Unauthorized" }, { status: 401 }),
      );
    }
    if (url.endsWith("/api/tags")) {
      return Promise.resolve(
        Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] }),
      );
    }
    if (url.endsWith("/api/chat")) {
      return Promise.resolve(Response.json({ done_reason: "length" }));
    }
    return Promise.resolve(Response.json({ capabilities: ["tools"] }));
  };
  const configs: Array<string | undefined> = [];
  let id = 0;
  const ollama = createOllamaCloudUserBackendContribution({
    storage,
    settings,
    credentials: credentials as unknown as OllamaUserBackendHost["credentials"],
    createClient: (config) => {
      configs.push(config.apiBaseUrl);
      return new OllamaCloudClient({ ...config, fetch });
    },
    now,
    randomId: () => `id-${++id}`,
  });
  return { storage, settings, ollama, requests, configs };
}

const createCommand = (
  commandId: string,
  settings?: Record<string, string>,
) => ({
  schemaVersion: 1 as const,
  type: "connection/create-api-key" as const,
  commandId,
  packageId: "provider-ollama-cloud",
  connectionTypeId: "ollama-cloud-account",
  label: "Work",
  apiKey: "secret",
  ...(settings === undefined ? {} : { settings }),
});

describe("Ollama endpoint contract", () => {
  test("declares the Connection-scoped endpoint setting in its manifest", () => {
    // The endpoint belongs to the Connection, so the Connection Type declares
    // it (manifest v4) rather than the Package. The kernel's own suite proves
    // every first-party manifest decodes; this asserts what this one declares.
    expect(manifest.schemaVersion).toBe(4);
    expect(manifest.configuration.connectionTypes[0]?.settings).toMatchObject([
      { id: "api-base-url", schemaVersion: 1, schema: { type: "string" } },
    ]);
  });

  test("declares the search ceiling as a User-level Package setting", () => {
    // The ceiling belongs to the User, not to one Connection: it is the same
    // answer whichever account the search runs through, so it is Package-level
    // and every Connection of this Package obeys it.
    expect(manifest.configuration.settings).toMatchObject([
      {
        id: "web-search-max-results",
        schemaVersion: 1,
        scopes: ["user"],
        schema: { type: "integer", minimum: 1, maximum: 10 },
      },
    ]);
  });

  test("decodes an endpoint root and refuses an unusable one", () => {
    expect(decodeOllamaApiBaseUrl("https://ollama.com/")).toBe(
      "https://ollama.com",
    );
    expect(decodeOllamaApiBaseUrl("http://127.0.0.1:11434")).toBe(
      "http://127.0.0.1:11434",
    );
    expect(decodeOllamaApiBaseUrl(" https://gpu.example.com/ollama/ ")).toBe(
      "https://gpu.example.com/ollama",
    );

    expect(() => decodeOllamaApiBaseUrl("ollama.com")).toThrow(
      "is not an absolute http or https URL",
    );
    expect(() => decodeOllamaApiBaseUrl("ftp://ollama.com")).toThrow(
      "must use http or https",
    );
    expect(() =>
      decodeOllamaApiBaseUrl("https://user:pass@ollama.com"),
    ).toThrow("must not carry credentials");
    expect(() => decodeOllamaApiBaseUrl("https://ollama.com/?key=1")).toThrow(
      "must not carry a query or fragment",
    );
    expect(() => decodeOllamaApiBaseUrl(11_434)).toThrow(
      "must be an absolute http or https URL",
    );
  });

  test("defaults every seam to https://ollama.com", async () => {
    expect(DEFAULT_OLLAMA_API_BASE_URL).toBe("https://ollama.com");
    expect(ollamaChatBaseUrl()).toBe("https://ollama.com/v1");

    const { ollama, settings, requests, storage } = await fixture();
    const receipt = await ollama.executeConnection(
      "account-1",
      createCommand("connect-default"),
    );
    expect(receipt.status).toBe("applied");
    expect(
      requests.every((url) => url.startsWith("https://ollama.com/api/")),
    ).toBe(true);
    expect(requests).toContain("https://ollama.com/api/tags");
    expect(requests).toContain("https://ollama.com/api/chat");

    const connection = await settings.getConnection(
      "account-1",
      receipt.connectionId,
    );
    expect(connection?.settings).toEqual({});
    expect(
      storage.values.get("ollama-connection-command:connect-default"),
    ).not.toHaveProperty("settings");
  });

  test("routes every provider call for a Connection through its endpoint", async () => {
    const { ollama, settings, requests, configs } = await fixture();
    const receipt = await ollama.executeConnection(
      "account-1",
      createCommand("connect-local", {
        "api-base-url": "http://127.0.0.1:11434/",
      }),
    );
    expect(receipt.status).toBe("applied");

    // Creation: the catalog read and the inference probe both go local.
    expect(requests).toContain("http://127.0.0.1:11434/api/tags");
    expect(requests).toContain("http://127.0.0.1:11434/api/chat");

    // The endpoint survives on the durable Connection, trailing slash stripped.
    const connection = await settings.getConnection(
      "account-1",
      receipt.connectionId,
    );
    expect(connection?.settings).toEqual({
      "api-base-url": "http://127.0.0.1:11434",
    });
    expect(connection?.state).toBe("ready");

    // The periodic catalog refresh reads the same endpoint.
    requests.length = 0;
    await ollama.executeConnection("account-1", {
      schemaVersion: 1,
      type: "connection/refresh-models",
      commandId: "refresh-local",
      connectionId: receipt.connectionId,
    });
    expect(requests).toContain("http://127.0.0.1:11434/api/tags");

    // Exact model resolution reads the same endpoint.
    requests.length = 0;
    if (!connection?.generation) throw new Error("generation is missing");
    await ollama.leaseModelCredential({
      accountId: "account-1",
      connectionId: receipt.connectionId,
      providerModelId: "unlisted-model:cloud",
      effectId: "effect-local",
      connectionGeneration: connection.generation,
    });
    expect(requests).toContain("http://127.0.0.1:11434/api/show");

    // The chat completion root is composed from the same value.
    expect(
      ollamaChatBaseUrl(connection.settings?.["api-base-url"] as string),
    ).toBe("http://127.0.0.1:11434/v1");

    // Not one call reached the Package default.
    expect(configs.every((value) => value === "http://127.0.0.1:11434")).toBe(
      true,
    );
  });

  test("refuses an unusable endpoint visibly and calls no provider", async () => {
    for (const [commandId, bad, reason] of [
      [
        "connect-relative",
        { "api-base-url": "/api" },
        "absolute http or https",
      ],
      [
        "connect-scheme",
        { "api-base-url": "ftp://ollama.com" },
        "http or https",
      ],
      ["connect-key", { region: "au" }, 'setting "region" is not supported'],
    ] as const) {
      const { ollama, settings, requests } = await fixture();
      const receipt = await ollama.executeConnection(
        "account-1",
        createCommand(commandId, bad),
      );

      expect(receipt.status).toBe("failed");
      expect(requests).toHaveLength(0);
      const connection = await settings.getConnection(
        "account-1",
        receipt.connectionId,
      );
      expect(connection?.state).toBe("failed");
      expect(connection?.failure).toContain(reason);
      expect(connection?.authorization?.credential.configured).toBe(false);
    }
  });

  test("keeps the key probe authoritative against a configured endpoint", async () => {
    const { ollama, settings, requests } = await fixture({
      reject: (url) => url.endsWith("/api/chat"),
    });
    const receipt = await ollama.executeConnection(
      "account-1",
      createCommand("connect-bad-key", {
        "api-base-url": "http://127.0.0.1:11434",
      }),
    );

    expect(receipt.status).toBe("failed");
    expect(requests).toContain("http://127.0.0.1:11434/api/chat");
    const connection = await settings.getConnection(
      "account-1",
      receipt.connectionId,
    );
    expect(connection?.state).toBe("failed");
    expect(connection?.failure).toStartWith(
      "Ollama Cloud rejected the key for inference:",
    );
  });

  test("lets a host-supplied client win over per-Connection construction", async () => {
    const seen: string[] = [];
    const base = await fixture();
    const ollama = createOllamaCloudUserBackendContribution({
      storage: base.storage,
      settings: base.settings,
      credentials: createCredentialUserBackendContribution({
        storage: base.storage,
        keyring: keyring(),
        now: () => Date.parse("2026-08-30T00:00:00.000Z"),
      }) as unknown as OllamaUserBackendHost["credentials"],
      client: new OllamaCloudClient({
        apiBaseUrl: "https://stub.example.com",
        fetch: (input) => {
          seen.push(String(input));
          return Promise.resolve(
            String(input).endsWith("/api/tags")
              ? Response.json({ models: [{ model: "glm-5.3-flash:cloud" }] })
              : Response.json({ capabilities: ["tools"] }),
          );
        },
      }),
      createClient: () => {
        throw new Error("createClient must not be consulted");
      },
      now: () => Date.parse("2026-08-30T00:00:00.000Z"),
      randomId: (() => {
        let id = 100;
        return () => `id-${++id}`;
      })(),
    });

    const receipt = await ollama.executeConnection(
      "account-1",
      createCommand("connect-stub", {
        "api-base-url": "http://127.0.0.1:11434",
      }),
    );

    expect(receipt.status).toBe("applied");
    expect(
      seen.every((url) => url.startsWith("https://stub.example.com/")),
    ).toBe(true);
  });
});
