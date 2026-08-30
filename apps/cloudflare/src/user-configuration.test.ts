import { describe, expect, mock, test } from "bun:test";

mock.module("cloudflare:workers", () => ({
  DurableObject: class<Env> {
    readonly ctx: DurableObjectState;
    readonly env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { UserConfiguration } = await import("./user-configuration.js");

class MemoryStorage {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, value);
    else
      for (const [entry, stored] of Object.entries(key))
        this.values.set(entry, stored);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  getAlarm(): Promise<number | null> {
    return Promise.resolve(null);
  }

  setAlarm(): Promise<void> {
    return Promise.resolve();
  }
}

const credentialKeyring =
  '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}';

describe("UserConfiguration Connection routing", () => {
  test("mounts declared User Contributions through the application registry", async () => {
    const configuration = new UserConfiguration(
      { storage: new MemoryStorage() } as unknown as DurableObjectState,
      { CREDENTIAL_KEYRING: credentialKeyring },
    );

    await expect(
      configuration.readConfiguration({
        schemaVersion: 1,
        userId: "user-1",
      }),
    ).resolves.toMatchObject({
      schemaVersion: 1,
      revision: 0,
      packages: expect.any(Array),
      connections: [],
    });
  });
  test("replays a retained command after its Connection projection is compacted", async () => {
    const executed: unknown[] = [];
    const contribution = {
      packageId: "provider-ollama-cloud",
      lookupConnectionCommand: (_accountId: string, commandId: string) =>
        Promise.resolve(
          commandId === "disconnect-1"
            ? {
                schemaVersion: 1,
                commandId,
                connectionId: "connection-revoked",
                status: "applied",
              }
            : undefined,
        ),
      executeConnection: (_accountId: string, command: unknown) => {
        executed.push(command);
        return Promise.resolve({
          schemaVersion: 1,
          commandId: "disconnect-1",
          connectionId: "connection-revoked",
          status: "applied",
        });
      },
    };
    const configuration = new UserConfiguration(
      { storage: {} } as DurableObjectState,
      {},
    );
    Reflect.set(
      configuration,
      "mounted",
      Promise.resolve({
        settings: {
          getConnection: () => Promise.resolve(undefined),
        },
        credentials: {},
        connections: new Map([[contribution.packageId, contribution]]),
        flock: {},
        dispose: () => Promise.resolve(),
      }),
    );

    await expect(
      configuration.executeConnection({
        schemaVersion: 1,
        userId: "user-1",
        command: {
          schemaVersion: 1,
          type: "connection/disconnect",
          commandId: "disconnect-1",
          connectionId: "connection-revoked",
          revokeUpstream: false,
        },
      }),
    ).resolves.toMatchObject({ status: "applied" });
    expect(executed).toHaveLength(1);
  });
});
