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

describe("UserConfiguration Connection routing", () => {
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
