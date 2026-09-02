import { describe, expect, test } from "bun:test";
import type {
  LlmStreamEvent,
  NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  createIsolateCapabilityHost,
  isolateBindingDigestV1,
  isolateModelEventStreamV1,
  ISOLATE_MODEL_FAILURE_MESSAGE,
  ISOLATE_MODEL_REQUEST_PREFIX,
  matchingModelCapabilityV1,
  type IsolateCapabilityV1,
  type IsolateModelBindingV1,
  type IsolateModelRequestRecordV1,
} from "./backend-isolate.ts";

const CAPABILITY: IsolateCapabilityV1 = {
  packageId: "provider-ollama-cloud",
  capabilityId: "ollama-cloud-models",
  kind: "model",
  connectionId: "connection-1",
};

const BINDING: IsolateModelBindingV1 = {
  packageId: "provider-ollama-cloud",
  capabilityId: "ollama-cloud-models",
  connectionId: "connection-1",
  provider: "ollama-cloud",
  providerModelId: "glm-5.3-flash:cloud",
  connectionGeneration: "generation-1",
};

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
    get: <T>(key: string) => Promise.resolve(values.get(key) as T | undefined),
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
    binding?: IsolateModelBindingV1 | null;
    capabilities?: IsolateCapabilityV1[];
    unavailableModelBinding?: {
      provider?: string;
      providerModelId: string;
    };
    stream?: (request: NormalizedModelRequest) => AsyncIterable<LlmStreamEvent>;
  } = {},
) {
  const storage = memoryStorage();
  const forwarded: NormalizedModelRequest[] = [];
  let minted = 0;
  const binding = options.binding === undefined ? BINDING : options.binding;
  return {
    storage,
    forwarded,
    host: createIsolateCapabilityHost({
      storage,
      botId: "bot-1",
      packageId: "bot-authored",
      generationId: "generation-1",
      capabilities: options.capabilities ?? [CAPABILITY],
      ...(binding
        ? {
            modelBinding: binding,
            modelPath: {
              stream: (value: NormalizedModelRequest) => {
                forwarded.push(structuredClone(value));
                return (
                  options.stream?.(value) ??
                  (async function* () {
                    yield {
                      type: "text-delta",
                      text: "hi",
                    } as LlmStreamEvent;
                  })()
                );
              },
            },
          }
        : {}),
      ...(options.unavailableModelBinding
        ? { unavailableModelBinding: options.unavailableModelBinding }
        : {}),
      newId: () => `minted-${(minted += 1)}`,
      now: () => new Date("2026-08-31T00:00:00.000Z"),
    }),
  };
}

describe("an isolate model request is bound to its enabled Capability", () => {
  test("matches only the exact authoritative provider and model", () => {
    expect(matchingModelCapabilityV1([CAPABILITY], BINDING, request())).toEqual(
      CAPABILITY,
    );
    expect(
      matchingModelCapabilityV1(
        [CAPABILITY],
        BINDING,
        request({ provider: "foundation" }),
      ),
    ).toBeUndefined();
    expect(
      matchingModelCapabilityV1(
        [CAPABILITY],
        BINDING,
        request({ model: "some-other-model" }),
      ),
    ).toBeUndefined();
    // No authoritative binding at all: an enabled Capability on its own authorizes
    // nothing.
    expect(
      matchingModelCapabilityV1([CAPABILITY], undefined, request()),
    ).toBeUndefined();
  });

  test("ignores a Bot-supplied model binding", () => {
    expect(
      matchingModelCapabilityV1(
        [CAPABILITY],
        BINDING,
        request({
          provider: "foundation",
          model: "deterministic-v1",
          modelBinding: { connectionId: "connection-1" },
        }),
      ),
    ).toBeUndefined();
  });

  test("a request outside the effective binding is unavailable", async () => {
    const subject = host();
    const outcome = await subject.host.invokeModel(
      request({ provider: "foundation", model: "deterministic-v1" }),
    );

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "the model is unavailable",
    });
    expect(await subject.host.recordedModelRequests()).toHaveLength(0);
    expect(subject.forwarded).toHaveLength(0);
  });

  test("a request with no durable model binding is unavailable", async () => {
    const subject = host({ binding: null, capabilities: [] });

    const outcome = await subject.host.invokeModel(request());

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "the model is unavailable",
    });
    expect(await subject.host.recordedModelRequests()).toHaveLength(0);
    expect(subject.forwarded).toHaveLength(0);
  });

  test("a held model binding with an unavailable Connection is unavailable", async () => {
    const subject = host({
      binding: null,
      capabilities: [],
      unavailableModelBinding: {
        provider: BINDING.provider,
        providerModelId: BINDING.providerModelId,
      },
    });

    const outcome = await subject.host.invokeModel(request());

    expect(outcome).toMatchObject({ status: "unavailable" });
    expect(await subject.host.recordedModelRequests()).toHaveLength(0);
    expect(subject.forwarded).toHaveLength(0);
  });

  test("an unavailable binding does not cover another provider", async () => {
    const subject = host({
      binding: null,
      capabilities: [],
      unavailableModelBinding: {
        provider: BINDING.provider,
        providerModelId: BINDING.providerModelId,
      },
    });

    const outcome = await subject.host.invokeModel(
      request({ provider: "foundation" }),
    );

    expect(outcome).toEqual({
      status: "unavailable",
      reason: "the model is unavailable",
    });
  });

  test("forwards the authority's binding, never the Bot's", async () => {
    const subject = host();
    await subject.host.invokeModel(
      request({
        modelBinding: {
          connectionId: "another-users-connection",
          connectionGeneration: "forged",
        },
      }),
    );

    expect(subject.forwarded[0]?.modelBinding).toEqual({
      connectionId: "connection-1",
      connectionGeneration: "generation-1",
    });
  });
});

describe("User-enabled isolate bindings", () => {
  test("list projects the complete enabled set", async () => {
    const subject = host();

    await expect(subject.host.list()).resolves.toEqual([
      { capabilityId: "ollama-cloud-models", kind: "model" },
    ]);
  });

  test("identity, generation, and the enabled set are binding digest inputs", async () => {
    const first = await isolateBindingDigestV1({
      userId: "user-1",
      botId: "bot-1",
      generationId: "generation-1",
      capabilities: [CAPABILITY],
    });
    const same = await isolateBindingDigestV1({
      userId: "user-1",
      botId: "bot-1",
      generationId: "generation-1",
      capabilities: [structuredClone(CAPABILITY)],
    });
    const otherUser = await isolateBindingDigestV1({
      userId: "user-2",
      botId: "bot-1",
      generationId: "generation-1",
      capabilities: [CAPABILITY],
    });
    const otherBot = await isolateBindingDigestV1({
      userId: "user-1",
      botId: "bot-2",
      generationId: "generation-1",
      capabilities: [CAPABILITY],
    });
    const otherGeneration = await isolateBindingDigestV1({
      userId: "user-1",
      botId: "bot-1",
      generationId: "generation-2",
      capabilities: [CAPABILITY],
    });
    const widened = await isolateBindingDigestV1({
      userId: "user-1",
      botId: "bot-1",
      generationId: "generation-1",
      capabilities: [
        CAPABILITY,
        {
          packageId: "clock",
          capabilityId: "clock",
          kind: "tool",
        },
      ],
    });

    expect(same).toBe(first);
    expect(otherUser).not.toBe(first);
    expect(otherBot).not.toBe(first);
    expect(otherGeneration).not.toBe(first);
    expect(widened).not.toBe(first);
  });

  test("ordering does not change the digest", async () => {
    const clock: IsolateCapabilityV1 = {
      packageId: "clock",
      capabilityId: "clock",
      kind: "tool",
    };

    await expect(
      isolateBindingDigestV1({
        userId: "user-1",
        botId: "bot-1",
        generationId: "generation-1",
        capabilities: [CAPABILITY, clock],
      }),
    ).resolves.toBe(
      await isolateBindingDigestV1({
        userId: "user-1",
        botId: "bot-1",
        generationId: "generation-1",
        capabilities: [clock, CAPABILITY],
      }),
    );
  });
});

describe("the isolate model request record", () => {
  test("two invocations reusing one Bot request id produce two records", async () => {
    const subject = host();

    await subject.host.invokeModel(request());
    await subject.host.invokeModel(request());

    const recorded = await subject.host.recordedModelRequests();
    expect(recorded).toHaveLength(2);
    expect(recorded.map((entry) => entry.requestId)).toEqual([
      "request-1",
      "request-1",
    ]);
    expect(new Set(recorded.map((entry) => entry.recordId)).size).toBe(2);
    expect(
      [...subject.storage.values.keys()].filter((key) =>
        key.startsWith(ISOLATE_MODEL_REQUEST_PREFIX),
      ),
    ).toHaveLength(2);
  });

  test("refuses an unbounded Bot request id", async () => {
    const subject = host();
    await expect(
      subject.host.invokeModel(request({ requestId: "r".repeat(257) })),
    ).rejects.toThrow("requestId is not bounded");
  });

  test("records the request that was forwarded", async () => {
    const subject = host();
    await subject.host.invokeModel(request());
    const recorded = (await subject.host.recordedModelRequests())[0] as
      IsolateModelRequestRecordV1 | undefined;
    expect(recorded?.request.modelBinding).toEqual({
      connectionId: "connection-1",
      connectionGeneration: "generation-1",
    });
    expect(recorded?.capabilityId).toBe("ollama-cloud-models");
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
