import { describe, expect, test } from "bun:test";
import {
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "@frockbot/core/connection";
import type { UserSettingsViewV1 } from "@frockbot/core/configuration";
import { SessionEventLog } from "@frockbot/core/durable";
import { createShellBotBackendContribution } from "@frockbot/app/shell/backend";
import type { StoredRun } from "@frockbot/app/shell/backend-contracts";
import { foundationShellApplicationV1 } from "./runtime.js";

class MemoryStorage {
  readonly values = new Map<string, unknown>();
  readonly listRequests: Array<{
    prefix?: string;
    end?: string;
    reverse?: boolean;
    limit?: number;
  }> = [];
  readonly gets: string[] = [];
  alarmAt: number | undefined;

  get<T>(key: string): Promise<T | undefined> {
    this.gets.push(key);
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
    this.listRequests.push(options);
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

describe("Bot recovery on this application", () => {
  test("executes and reconstructs an Ollama-bound Bot without Foundation fallback", async () => {
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
    const userSettings: UserSettingsViewV1 = {
      schemaVersion: 1,
      revision: 1,
      profile: { name: "User" },
      packages: [
        {
          packageId: "custom-models",
          version: "0.0.1",
          state: "installed",
        },
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
    const leasedRequests: Array<Record<string, unknown>> = [];
    const settledEffects: string[] = [];
    let settlementFailures = 0;
    const rpc = {
      readConfiguration: () => Promise.resolve(structuredClone(userSettings)),
      listBots: () =>
        Promise.resolve({ schemaVersion: 1 as const, revision: 0, bots: [] }),
      leaseModelCredential: (input: unknown) => {
        leasedRequests.push(input as Record<string, unknown>);
        const request = input as { effectId: string };
        return Promise.resolve({
          schemaVersion: 1,
          leaseId: `lease-${leasedRequests.length}`,
          effectId: request.effectId,
          connectionId: "ollama-1",
          credentialGeneration: "generation-1",
          expiresAt: "2099-01-01T00:00:00.000Z",
          envelope,
        });
      },
      settleModelCredential: (input: unknown) => {
        settledEffects.push((input as { effectId: string }).effectId);
        if (settlementFailures > 0) {
          settlementFailures -= 1;
          return Promise.reject(new Error("settlement unavailable"));
        }
        return Promise.resolve();
      },
    };
    const requests: Request[] = [];
    let failRequests = false;
    const outboundFetch = ((input, init) => {
      const request = new Request(input, init);
      requests.push(request);
      if (!request.url.startsWith("https://ollama.com/")) {
        return Promise.reject(new Error("Foundation fallback invoked"));
      }
      if (failRequests) return Promise.reject(new Error("response lost"));
      return Promise.resolve(
        new Response(
          "data: " +
            JSON.stringify({
              choices: [
                {
                  delta: {
                    tool_calls: [
                      {
                        index: 0,
                        id: "send",
                        type: "function",
                        function: {
                          name: "send_to_user",
                          arguments: JSON.stringify({
                            payload: {
                              type: "widget",
                              widget: {
                                prompt: "Ollama reply",
                                options: ["Continue"],
                                allowCustom: true,
                                dismissOnMoveOn: false,
                              },
                            },
                          }),
                        },
                      },
                    ],
                  },
                },
              ],
            }) +
            "\n\n" +
            'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
            "data: [DONE]\n\n",
          {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          },
        ),
      );
    }) as typeof fetch;
    const host = () =>
      createShellBotBackendContribution({
        ...foundationShellApplicationV1,
        state: { storage } as unknown as DurableObjectState,
        env: {
          CREDENTIAL_KEYRING: credentialKeyring,
          USER_CONFIGURATIONS: {
            idFromName: () => "user-configuration-id",
            get: () => rpc,
          },
          MEMORY_FILES: {},
          MEMORY_INDEX: {},
          AI: {},
        } as unknown as Parameters<
          typeof createShellBotBackendContribution
        >[0]["env"],
        outboundFetch,
      });

    const configured = host();
    await configured.materializeSettings(
      { userId: "user-1", botId: "primary" },
      { name: "Ollama Bot" },
    );
    const first = await host().run({
      userId: "user-1",
      botId: "primary",
      runId: "ollama-run-1",
      sessionId: "user-1:primary",
      acceptedAt: "2026-08-30T00:00:00.000Z",
      text: "hello",
    });
    const second = await host().run({
      userId: "user-1",
      botId: "primary",
      runId: "ollama-run-2",
      sessionId: "user-1:primary",
      acceptedAt: "2026-08-30T00:01:00.000Z",
      text: "again",
    });

    expect(first.events).toContainEqual({
      type: "send/to-user",
      payload: {
        type: "widget",
        widget: {
          prompt: "Ollama reply",
          options: ["Continue"],
          allowCustom: true,
          dismissOnMoveOn: false,
        },
      },
    });
    expect(second.events.some((event) => event.type === "send/to-user")).toBe(
      true,
    );
    expect(requests).toHaveLength(2);
    expect(
      await Promise.all(requests.map((request) => request.clone().json())),
    ).toEqual([
      expect.objectContaining({ model: "glm-5.3-flash:cloud" }),
      expect.objectContaining({ model: "glm-5.3-flash:cloud" }),
    ]);
    expect(
      leasedRequests.map((request) => ({
        connectionId: request.connectionId,
        providerModelId: request.providerModelId,
        connectionGeneration: request.connectionGeneration,
      })),
    ).toEqual([
      {
        connectionId: "ollama-1",
        providerModelId: "glm-5.3-flash:cloud",
        connectionGeneration: "generation-1",
      },
      {
        connectionId: "ollama-1",
        providerModelId: "glm-5.3-flash:cloud",
        connectionGeneration: "generation-1",
      },
    ]);
    expect(settledEffects).toHaveLength(2);
    const eventLog = new SessionEventLog(storage);
    for (const runId of ["ollama-run-1", "ollama-run-2"]) {
      const run = await storage.get<
        Omit<StoredRun, "events"> & {
          eventRange: { startSeq: number; endSeq: number };
        }
      >(`run:${runId}`);
      expect(run).not.toHaveProperty("events");
      const events = run
        ? await eventLog.readRange(
            "user-1:primary",
            run.eventRange.startSeq,
            run.eventRange.endSeq,
          )
        : [];
      expect(
        events.find((event) => event.type === "model/request"),
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

    settlementFailures = 1;
    await expect(
      host().run({
        userId: "user-1",
        botId: "primary",
        runId: "ollama-run-settlement",
        sessionId: "user-1:primary",
        acceptedAt: "2026-08-30T00:01:30.000Z",
        text: "settle durably",
      }),
    ).rejects.toThrow("durable outcome settlement pending");
    expect(
      await storage.get<StoredRun>("run:ollama-run-settlement"),
    ).toMatchObject({ status: "running", phase: "executing" });
    expect(await storage.get<string>("active-run")).toBe(
      "ollama-run-settlement",
    );
    expect(requests).toHaveLength(3);
    userSettings.packages[0] = {
      ...userSettings.packages[0]!,
      state: "disabled",
    };

    await host().alarm();

    expect(
      await storage.get<StoredRun>("run:ollama-run-settlement"),
    ).toMatchObject({ status: "completed" });
    expect(await storage.get("active-run")).toBeUndefined();
    expect(requests).toHaveLength(3);
    expect(settledEffects).toHaveLength(4);
    userSettings.packages[0] = {
      ...userSettings.packages[0]!,
      state: "installed",
    };

    failRequests = true;
    // The call resolves: the Turn settled itself, and the caller is handed
    // that settlement rather than a rejection thrown over the top of it.
    await host().run({
      userId: "user-1",
      botId: "primary",
      runId: "ollama-run-uncertain",
      sessionId: "user-1:primary",
      acceptedAt: "2026-08-30T00:02:00.000Z",
      text: "uncertain",
    });
    // Ollama keeps no addressable copy of a completion, so a failure raised
    // before the first stream event is definitive rather than uncertain: the
    // run settles as a failed Turn instead of parking on a retrieval this
    // provider can never perform.
    const uncertain = await storage.get<StoredRun>("run:ollama-run-uncertain");
    expect(uncertain?.status).toBe("failed");
    expect(uncertain?.failure).toContain("response lost");
    expect(await storage.get("active-run")).toBeUndefined();

    // The alarm has nothing left to recover: a settled run stays settled.
    await host().alarm();
    const settled = await storage.get<StoredRun>("run:ollama-run-uncertain");
    expect(settled?.status).toBe("failed");
    expect(settled?.failure).toContain("response lost");
    expect(await storage.get("active-run")).toBeUndefined();
  });
});
