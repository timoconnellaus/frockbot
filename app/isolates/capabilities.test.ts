import { describe, expect, test } from "bun:test";
import type {
  IsolateConnectionV1,
  LlmStreamEvent,
  NormalizedModelRequest,
} from "@frockbot/core/contracts";
import {
  createIsolateCapabilityHost,
  pluginEgressAdmitsV1,
  pluginEgressPolicyV1,
  pluginWorkerBindingDigestV1,
  isolateModelEventStreamV1,
  ISOLATE_MODEL_FAILURE_MESSAGE,
  ISOLATE_MODEL_REQUEST_PREFIX,
  matchingModelBindingV1,
  type IsolateModelBindingV1,
  type IsolateModelRequestRecordV1,
} from "./capabilities.ts";

const CONNECTIONS: IsolateConnectionV1[] = [
  {
    connectionId: "connection-1",
    packageId: "provider-ollama-cloud",
    connectionTypeId: "ollama-cloud-account",
    displayName: "Work",
    generation: "generation-1",
    safeMetadata: { region: "au" },
  },
];

const BINDING: IsolateModelBindingV1 = {
  connectionId: "connection-1",
  packageId: "provider-ollama-cloud",
  provider: "ollama-cloud",
  providerModelId: "glm-5.3-flash:cloud",
  connectionGeneration: "generation-1",
};

const IDENTITY = { userId: "user-1", botId: "bot-1" } as const;

function request(
  overrides: Partial<NormalizedModelRequest> = {},
): NormalizedModelRequest {
  return {
    requestId: "request-1",
    provider: "ollama-cloud",
    model: "glm-5.3-flash:cloud",
    system: "",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    modelBinding: {
      connectionId: BINDING.connectionId,
      connectionGeneration: BINDING.connectionGeneration,
    },
    ...overrides,
  };
}

function memoryStorage() {
  const values = new Map<string, unknown>();
  return {
    values,
    put: (key: string, value: unknown) => {
      values.set(key, structuredClone(value));
      return Promise.resolve();
    },
    list: <T>(options: { prefix: string }) =>
      Promise.resolve(
        new Map(
          [...values.entries()].filter(([key]) =>
            key.startsWith(options.prefix),
          ) as [string, T][],
        ),
      ),
  };
}

function host(
  options: {
    packageId?: string;
    binding?: IsolateModelBindingV1;
    withoutModel?: boolean;
    stream?: (request: NormalizedModelRequest) => AsyncIterable<LlmStreamEvent>;
  } = {},
) {
  const storage = memoryStorage();
  const forwarded: NormalizedModelRequest[] = [];
  let minted = 0;
  return {
    storage,
    forwarded,
    host: createIsolateCapabilityHost({
      storage,
      botId: "bot-1",
      packageId: options.packageId ?? "bot-authored",
      generationId: "composition-1",
      connections: CONNECTIONS,
      ...(!options.withoutModel
        ? { modelBinding: options.binding ?? BINDING }
        : {}),
      ...(!options.withoutModel
        ? {
            modelPath: {
              stream: (value: NormalizedModelRequest) => {
                forwarded.push(structuredClone(value));
                return (
                  options.stream?.(value) ??
                  (async function* () {
                    yield { type: "text-delta", text: "hi" } as LlmStreamEvent;
                  })()
                );
              },
            },
          }
        : {}),
      memory: true,
      workspace: true,
      newId: () => `minted-${(minted += 1)}`,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    }),
  };
}

describe("per-Bot isolate authority", () => {
  test("two Packages of one Bot see the same Connections and capabilities", async () => {
    const left = await host({ packageId: "package-left" }).host.list();
    const right = await host({ packageId: "package-right" }).host.list();
    expect(left).toEqual(right);
    expect(left).toMatchObject({
      status: "available",
      connections: [
        { connectionId: "connection-1", generation: "generation-1" },
      ],
      tools: true,
      memory: true,
      workspace: true,
      schedule: true,
    });
  });

  test("matches only the Bot's configured provider and model", () => {
    expect(matchingModelBindingV1(BINDING, request())).toEqual(BINDING);
    expect(
      matchingModelBindingV1(BINDING, request({ provider: "foundation" })),
    ).toBeUndefined();
    expect(
      matchingModelBindingV1(BINDING, request({ model: "other" })),
    ).toBeUndefined();
    expect(
      matchingModelBindingV1(
        BINDING,
        request({
          modelBinding: {
            connectionId: BINDING.connectionId,
            connectionGeneration: "generation-2",
          },
        }),
      ),
    ).toBeUndefined();
    expect(matchingModelBindingV1(undefined, request())).toBeUndefined();
  });

  test("a Bot with no configured model gets unavailable, never a pending decision", async () => {
    const subject = host({ withoutModel: true });
    await expect(subject.host.invokeModel(request())).resolves.toEqual({
      status: "unavailable",
      reason: "this Bot has no configured model",
    });
    expect(await subject.host.recordedModelRequests()).toHaveLength(0);
    expect(subject.forwarded).toHaveLength(0);
  });

  test("a request that does not match the configured model is unavailable", async () => {
    const subject = host();
    await expect(
      subject.host.invokeModel(
        request({ provider: "foundation", model: "deterministic-v1" }),
      ),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "the request does not match this Bot's configured model",
    });
    expect(await subject.host.recordedModelRequests()).toHaveLength(0);
  });

  test("refuses a model binding outside the admitted snapshot", async () => {
    const subject = host();
    await expect(
      subject.host.invokeModel(
        request({
          modelBinding: {
            connectionId: "forged-connection",
            connectionGeneration: "forged-generation",
          },
        }),
      ),
    ).resolves.toEqual({
      status: "unavailable",
      reason: "the request does not match this Bot's configured model",
    });
    expect(subject.forwarded).toHaveLength(0);
  });
});

describe("the Plugin worker's binding digest", () => {
  test("names the User and the egress policy, and nothing per Turn or Bot", async () => {
    const base = await pluginWorkerBindingDigestV1({
      userId: "user-1",
      egress: { hosts: ["api.example.com"], open: false },
    });
    expect(base).toMatch(/^[0-9a-f]{64}$/);
    expect(
      await pluginWorkerBindingDigestV1({
        userId: "user-1",
        egress: { hosts: ["api.example.com"], open: false },
      }),
    ).toBe(base);
    expect(
      await pluginWorkerBindingDigestV1({
        userId: "user-2",
        egress: { hosts: ["api.example.com"], open: false },
      }),
    ).not.toBe(base);
    expect(
      await pluginWorkerBindingDigestV1({
        userId: "user-1",
        egress: { hosts: ["other.example.com"], open: false },
      }),
    ).not.toBe(base);
    expect(
      await pluginWorkerBindingDigestV1({
        userId: "user-1",
        egress: undefined,
      }),
    ).not.toBe(base);
    expect(
      await pluginWorkerBindingDigestV1({
        userId: "user-1",
        egress: { hosts: [], open: true },
      }),
    ).not.toBe(base);
  });

  test("is insensitive to the order hosts were listed in", async () => {
    expect(
      await pluginWorkerBindingDigestV1({
        userId: "user-1",
        egress: { hosts: ["b.example.com", "a.example.com"], open: false },
      }),
    ).toBe(
      await pluginWorkerBindingDigestV1({
        userId: "user-1",
        egress: { hosts: ["a.example.com", "b.example.com"], open: false },
      }),
    );
  });
});

describe("the egress policy of one Bot's enabled Plugins", () => {
  test("is the union of declared hosts, or open if any asked for it, or nothing", () => {
    expect(pluginEgressPolicyV1([{}, {}])).toBeUndefined();
    expect(
      pluginEgressPolicyV1([
        { network: { hosts: ["b.example.com"] } },
        {},
        { network: { hosts: ["a.example.com", "b.example.com"] } },
      ]),
    ).toEqual({ hosts: ["a.example.com", "b.example.com"], open: false });
    expect(
      pluginEgressPolicyV1([
        { network: { hosts: ["a.example.com"] } },
        { network: { open: true } },
      ]),
    ).toEqual({ hosts: [], open: true });
  });
});

describe("the isolate model request record", () => {
  test("two invocations reusing one request id produce two records", async () => {
    const subject = host();
    await subject.host.invokeModel(request());
    await subject.host.invokeModel(request());
    const recorded = await subject.host.recordedModelRequests();
    expect(recorded).toHaveLength(2);
    expect(new Set(recorded.map((entry) => entry.recordId)).size).toBe(2);
    expect(
      [...subject.storage.values.keys()].filter((key) =>
        key.startsWith(ISOLATE_MODEL_REQUEST_PREFIX),
      ),
    ).toHaveLength(2);
  });

  test("refuses an unbounded request id", async () => {
    await expect(
      host().host.invokeModel(request({ requestId: "r".repeat(257) })),
    ).rejects.toThrow("requestId is not bounded");
  });

  test("records the request that was forwarded and attributes the Package", async () => {
    const subject = host({ packageId: "bot-authored" });
    await subject.host.invokeModel(request());
    const recorded = (await subject.host.recordedModelRequests())[0] as
      IsolateModelRequestRecordV1 | undefined;
    expect(recorded?.packageId).toBe("bot-authored");
    expect(recorded?.request.modelBinding).toEqual({
      connectionId: "connection-1",
      connectionGeneration: "generation-1",
    });
  });
});

describe("provider errors crossing into Bot code", () => {
  test("are normalized before the isolate can read them", async () => {
    const stream = isolateModelEventStreamV1(
      (async function* (): AsyncIterable<LlmStreamEvent> {
        yield { type: "text-delta", text: "partial" };
        throw new Error(
          "ollama.com refused key sk-live-123 for account acct-9",
        );
      })(),
    );
    const reader = stream.getReader();
    await reader.read();
    const failure = await reader.read().then(
      () => undefined,
      (error: unknown) => (error instanceof Error ? error.message : ""),
    );
    expect(failure).toBe(ISOLATE_MODEL_FAILURE_MESSAGE);
    expect(failure).not.toContain("sk-live-123");
    expect(failure).not.toContain("ollama.com");
  });
});

describe("what the egress loopback admits", () => {
  const policy = {
    hosts: ["api.example.com", "*.weather.example"],
    open: false,
  };

  test("a declared host over https, and a wildcard's subdomains", () => {
    expect(pluginEgressAdmitsV1(policy, "https://api.example.com/v1")).toEqual({
      admitted: true,
      host: "api.example.com",
    });
    expect(
      pluginEgressAdmitsV1(policy, "https://API.Example.com/v1?x=1"),
    ).toEqual({ admitted: true, host: "api.example.com" });
    expect(
      pluginEgressAdmitsV1(policy, "https://au.weather.example/today"),
    ).toMatchObject({ admitted: true });
  });

  test("refuses an undeclared host, the bare wildcard domain, http and junk", () => {
    expect(
      pluginEgressAdmitsV1(policy, "https://other.example.com/"),
    ).toMatchObject({
      admitted: false,
      reason: expect.stringMatching(/not declared by any enabled plugin/),
    });
    expect(
      pluginEgressAdmitsV1(policy, "https://weather.example/"),
    ).toMatchObject({ admitted: false });
    expect(
      pluginEgressAdmitsV1(policy, "http://api.example.com/"),
    ).toMatchObject({
      admitted: false,
      reason: expect.stringMatching(/https only/),
    });
    expect(pluginEgressAdmitsV1(policy, "not a url")).toMatchObject({
      admitted: false,
      reason: expect.stringMatching(/invalid/),
    });
  });

  test("open access admits any https host and still refuses http", () => {
    const open = { hosts: [], open: true };
    expect(
      pluginEgressAdmitsV1(open, "https://anything.invalid/"),
    ).toMatchObject({ admitted: true });
    expect(
      pluginEgressAdmitsV1(open, "http://anything.invalid/"),
    ).toMatchObject({ admitted: false });
  });
});
