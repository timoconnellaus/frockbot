import { describe, expect, mock, test } from "bun:test";
import {
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "@frockbot/connection-core";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import type { StoredRun } from "@frockbot/plugin-shell/backend-contracts";
import { randomSheepRecipeV1 } from "@frockbot/plugin-flock/shared";
import { compileFoundationApplication } from "@frockbot/application-foundation/runtime";
import type { BotStateEnv } from "./bot-state.js";

// `mock.module` is process-global and the first registration in a suite run
// fixes the module's shape, so this stub has to satisfy every consumer the run
// loads — not only this file's. `@cloudflare/containers` imports both names.
mock.module("cloudflare:workers", () => ({
  DurableObject: class<Env> {
    readonly ctx: DurableObjectState;
    readonly env: Env;

    constructor(ctx: DurableObjectState, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
  WorkerEntrypoint: class<Env> {
    readonly ctx: unknown;
    readonly env: Env;

    constructor(ctx: unknown, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

const { BotState } = await import("./bot-state.js");

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  alarmAt: number | undefined;

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(this.values.get(key) as T | undefined);
  }

  put(key: string | Record<string, unknown>, value?: unknown): Promise<void> {
    if (typeof key === "string") this.values.set(key, structuredClone(value));
    else {
      for (const [entry, item] of Object.entries(key)) {
        this.values.set(entry, structuredClone(item));
      }
    }
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    return Promise.resolve(this.values.delete(key));
  }

  list<T>(options: {
    prefix?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }): Promise<Map<string, T>> {
    const entries = [...this.values.entries()]
      .filter(
        ([key]) =>
          key.startsWith(options.prefix ?? "") &&
          (options.end === undefined || key < options.end),
      )
      .sort(([left], [right]) => left.localeCompare(right));
    if (options.reverse) entries.reverse();
    return Promise.resolve(
      new Map(entries.slice(0, options.limit) as Array<[string, T]>),
    );
  }

  transaction<T>(callback: (storage: MemoryStorage) => Promise<T>): Promise<T> {
    return callback(this);
  }

  setAlarm(scheduledTime: number): Promise<void> {
    this.alarmAt = scheduledTime;
    return Promise.resolve();
  }

  deleteAlarm(): Promise<void> {
    this.alarmAt = undefined;
    return Promise.resolve();
  }
}

function memoryFiles() {
  return {
    get: () => Promise.resolve(null),
    put: () => Promise.resolve(),
    delete: () => Promise.resolve(),
    list: () =>
      Promise.resolve({ objects: [], truncated: false, delimitedPrefixes: [] }),
  };
}

function memoryIndex() {
  return {
    upsert: () => Promise.resolve({ count: 0 }),
    query: () => Promise.resolve({ matches: [], count: 0 }),
    deleteByIds: () => Promise.resolve(),
  };
}

/*
 * The application as a host with no Worker Loader can mount it.
 *
 * This suite runs under `bun test`, where there is no `BOT_PACKAGES` binding
 * and no `BotCapabilities` loopback, so an artifact-backed member — the
 * Applets Package, ADR 0022 decision 8 — has nowhere to load from and the
 * Composition fails verification closed, which is correct and is not what
 * this test is about. workerd's suites mount the real thing.
 */
async function compileWithoutIsolateMembers(): ReturnType<
  typeof compileFoundationApplication
> {
  const application = await compileFoundationApplication();
  return {
    ...application,
    packages: application.packages.filter((pkg) => pkg.artifact === undefined),
  };
}

describe("BotState Ollama execution", () => {
  test("executes and reconstructs the public Durable Object runtime", async () => {
    const storage = new MemoryStorage();
    const credentialKeyring =
      '{"schemaVersion":1,"currentKeyId":"primary","keys":{"primary":"MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY"}}';
    const envelope = await sealCredentialV1({
      keyring: parseCredentialKeyringV1(credentialKeyring),
      context: {
        accountId: "user-1",
        connectionId: "ollama-1",
        packageId: "provider-ollama-cloud",
        credentialGeneration: "generation-1",
      },
      plaintext: "ollama-secret",
    });
    const user: UserSettingsViewV1 = {
      schemaVersion: 1,
      revision: 1,
      profile: { name: "User" },
      packages: [
        {
          packageId: "provider-ollama-cloud",
          version: "0.0.1",
          state: "installed",
        },
      ],
      connections: [
        {
          connectionId: "ollama-1",
          packageId: "provider-ollama-cloud",
          connectionTypeId: "ollama-cloud-account",
          displayName: "Work",
          state: "ready",
          providerType: "ollama-cloud",
          generation: "generation-1",
          safeMetadata: {},
          modelCatalog: {
            schemaVersion: 1,
            generation: "catalog-1",
            state: "fresh",
            models: [
              {
                providerModelId: "glm-5.3-flash:cloud",
                displayName: "GLM",
                capabilities: {
                  tools: true,
                  vision: false,
                  reasoning: false,
                },
                source: "discovered",
              },
            ],
          },
        },
      ],
      platformModel: {
        connectionId: "ollama-1",
        providerModelId: "glm-5.3-flash:cloud",
      },
    };
    const leases: Array<Record<string, unknown>> = [];
    const settlements: Array<Record<string, unknown>> = [];
    const rpc = {
      getBotRegistration: () =>
        Promise.resolve({
          schemaVersion: 1 as const,
          botId: "primary",
          registeredAt: "2026-08-30T00:00:00.000Z",
          initialName: "Ollama Bot",
          sheep: randomSheepRecipeV1(() => 0),
        }),
      readConfiguration: () => Promise.resolve(structuredClone(user)),
      listBots: () =>
        Promise.resolve({ schemaVersion: 1 as const, revision: 0, bots: [] }),
      getConnection: () =>
        Promise.resolve(structuredClone(user.connections[0])),
      leaseModelCredential: (input: unknown) => {
        leases.push(input as Record<string, unknown>);
        const effectId = (input as { effectId: string }).effectId;
        return Promise.resolve({
          schemaVersion: 1 as const,
          leaseId: `lease-${leases.length}`,
          effectId,
          connectionId: "ollama-1",
          credentialGeneration: "generation-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          envelope,
        });
      },
      settleModelCredential: (input: unknown) => {
        settlements.push(input as Record<string, unknown>);
        return Promise.resolve();
      },
    };
    const requests: Request[] = [];
    const outboundFetch = ((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (!request.url.startsWith("https://ollama.com/")) {
        return Promise.reject(new Error("Foundation fallback invoked"));
      }
      return Promise.resolve(
        new Response(
          'data: {"choices":[{"delta":{"content":"Ollama reply"}}]}\n\n' +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      );
    }) as typeof fetch;
    const env = {
      CREDENTIAL_KEYRING: credentialKeyring,
      USER_CONFIGURATIONS: {
        idFromName: () => "user-configuration-id",
        get: () => ({
          ...rpc,
          // The Memory half of the User Durable Object: the shared-root
          // generation ledger and Project membership. This Bot writes no
          // shared root in the test, so only the read paths are exercised.
          listMemoryProjects: () => Promise.resolve([]),
          currentWorkspaceGeneration: () => Promise.resolve(undefined),
          listWorkspaceConflicts: () => Promise.resolve([]),
        }),
      },
      MEMORY_FILES: memoryFiles(),
      MEMORY_INDEX: memoryIndex(),
      AI: {
        run: () => Promise.resolve({ data: [Array(768).fill(0)] }),
      },
    } as unknown as BotStateEnv;
    const state = () =>
      new BotState({ storage } as unknown as DurableObjectState, env, {
        outboundFetch,
        compileApplication: compileWithoutIsolateMembers,
      });

    const firstState = state();
    const first = await firstState.run({
      schemaVersion: 1,
      userId: "user-1",
      botId: "primary",
      command: {
        runId: "ollama-do-run-1",
        sessionId: "user-1:primary",
        acceptedAt: "2026-08-30T00:01:00.000Z",
        text: "hello",
      },
    });
    const second = await state().run({
      schemaVersion: 1,
      userId: "user-1",
      botId: "primary",
      command: {
        runId: "ollama-do-run-2",
        sessionId: "user-1:primary",
        acceptedAt: "2026-08-30T00:02:00.000Z",
        text: "again",
      },
    });

    expect(first.text).toBe("Ollama reply");
    expect(second.text).toBe("Ollama reply");
    expect(requests).toHaveLength(2);
    expect(leases).toHaveLength(2);
    expect(settlements).toHaveLength(2);
    expect(settlements).toEqual(
      settlements.map((settlement) =>
        expect.objectContaining({
          schemaVersion: 1,
          userId: "user-1",
          connectionId: "ollama-1",
          packageId: "provider-ollama-cloud",
          effectId: settlement.effectId,
        }),
      ),
    );
    for (const runId of ["ollama-do-run-1", "ollama-do-run-2"]) {
      const run = await storage.get<StoredRun>(`run:${runId}`);
      expect(
        run?.events.find((event) => event.type === "model/request"),
      ).toMatchObject({
        request: {
          provider: "ollama-cloud",
          model: "glm-5.3-flash:cloud",
          modelBinding: {
            connectionId: "ollama-1",
            connectionGeneration: "generation-1",
          },
        },
      });
    }
  });
});
