import { describe, expect, test } from "bun:test";
import {
  LlmEffectNotStartedError,
  MODEL_FIRST_BYTE_DEADLINE_MS_V1,
  MODEL_FIRST_BYTE_DEADLINE_REASON_V1,
  MODEL_IDLE_DEADLINE_MS_V1,
  MODEL_IDLE_DEADLINE_REASON_V1,
  ModelRequestDeadlineError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { type Agent } from "@frockbot/kernel-agent-loop/agent";
import { LlmRegistry } from "@frockbot/plugin-models";
import {
  openCredentialV1,
  parseCredentialKeyringV1,
  sealCredentialV1,
  type CredentialLeaseV1,
} from "@frockbot/connection-core";
import { Context, Service } from "cordis";
import {
  createOllamaCloudRuntimePlugin,
  ollamaChatBaseUrl,
} from "./runtime.js";

function serializedKeyring(): string {
  const bytes = Uint8Array.from({ length: 32 }, (_, index) => index + 11);
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

class TestCredentialLeaseRuntime extends Service {
  private readonly keyring;

  constructor(
    ctx: Context,
    serializedKeyring: string,
    private readonly onOpen: () => void = () => undefined,
  ) {
    super(ctx, "credentialLease");
    this.keyring = parseCredentialKeyringV1(serializedKeyring);
  }

  open(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string> {
    this.onOpen();
    return openCredentialV1({
      keyring: this.keyring,
      context: {
        accountId: input.accountId,
        connectionId: input.connectionId,
        packageId: input.packageId,
        credentialGeneration: input.lease.credentialGeneration,
      },
      envelope: input.lease.envelope,
    });
  }
}

async function mountCredentialRuntime(
  root: Context,
  keyring = serializedKeyring(),
  onOpen?: () => void,
): Promise<void> {
  await root.plugin((ctx) => {
    new TestCredentialLeaseRuntime(ctx, keyring, onOpen);
  });
}

const request: NormalizedModelRequest = {
  requestId: "effect-1",
  provider: "ollama-cloud",
  model: "glm-5.3-flash:cloud",
  system: "",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
  modelBinding: {
    connectionId: "connection-1",
    connectionGeneration: "generation-1",
  },
};

describe("Ollama Cloud runtime Contribution", () => {
  test("resolves one credential generation per effect inside the provider", async () => {
    const keyringText = serializedKeyring();
    const envelope = await sealCredentialV1({
      keyring: parseCredentialKeyringV1(keyringText),
      context: {
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        credentialGeneration: "generation-1",
      },
      plaintext: "account-secret",
    });
    const authorizations: string[] = [];
    const leasedGenerations: Array<string | undefined> = [];
    const settled: string[] = [];
    const root = new Context();
    await root.plugin(LlmRegistry);
    await mountCredentialRuntime(root, keyringText);
    await root.plugin(
      createOllamaCloudRuntimePlugin({
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        now: () => Date.parse("2026-08-30T00:00:00.000Z"),
        leaseCredential: (effectId, expectedGeneration) => {
          leasedGenerations.push(expectedGeneration);
          return Promise.resolve({
            schemaVersion: 1,
            leaseId: "lease-1",
            effectId,
            connectionId: "connection-1",
            credentialGeneration: "generation-1",
            expiresAt: "2026-08-30T01:00:00.000Z",
            envelope,
          });
        },
        settleCredential: (effectId) => {
          settled.push(effectId);
          return Promise.reject(new Error("settlement unavailable"));
        },
        fetch: (input, init) => {
          const outbound = new Request(input, init);
          authorizations.push(outbound.headers.get("authorization") ?? "");
          return Promise.resolve(
            new Response(
              'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                "data: [DONE]\n\n",
              {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              },
            ),
          );
        },
      }),
    );

    const signal = new AbortController().signal;
    const authorizedRequest = await root.waterfall(
      "agent/request",
      {} as Agent,
      request,
      signal,
      () => Promise.resolve(request),
    );
    expect(leasedGenerations).toEqual([]);
    const events = [];
    for await (const event of root.llm.stream(authorizedRequest, signal)) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "hello" },
      { type: "finish", reason: "completed" },
    ]);
    expect(authorizations).toEqual(["Bearer account-secret"]);
    expect(leasedGenerations).toEqual(["generation-1"]);
    expect(settled).toEqual([]);
    await expect(
      root.serial(
        "agent/model-outcome-committed",
        {} as Agent,
        request.requestId,
        "completed",
      ),
    ).rejects.toThrow("settlement unavailable");
    expect(settled).toEqual(["effect-1"]);
    for await (const event of root.llm.stream(authorizedRequest, signal)) {
      void event;
    }
    expect(leasedGenerations).toEqual(["generation-1", "generation-1"]);
    await root.fiber.dispose();
  });

  test.each([
    { effectId: "different-effect", connectionId: "connection-1" },
    { effectId: "effect-1", connectionId: "connection-2" },
  ])(
    "rejects a lease outside the request authority tuple",
    async ({ effectId, connectionId }) => {
      const keyringText = serializedKeyring();
      const envelope = await sealCredentialV1({
        keyring: parseCredentialKeyringV1(keyringText),
        context: {
          accountId: "account-1",
          connectionId: "connection-1",
          packageId: "provider-ollama-cloud",
          credentialGeneration: "generation-1",
        },
        plaintext: "account-secret",
      });
      let openCount = 0;
      const settled: string[] = [];
      const root = new Context();
      await root.plugin(LlmRegistry);
      await mountCredentialRuntime(root, keyringText, () => {
        openCount += 1;
      });
      await root.plugin(
        createOllamaCloudRuntimePlugin({
          accountId: "account-1",
          connectionId: "connection-1",
          packageId: "provider-ollama-cloud",
          now: () => Date.parse("2026-08-30T00:00:00.000Z"),
          leaseCredential: () =>
            Promise.resolve({
              schemaVersion: 1,
              leaseId: "lease-1",
              effectId,
              connectionId,
              credentialGeneration: "generation-1",
              expiresAt: "2026-08-30T01:00:00.000Z",
              envelope,
            }),
          settleCredential: (settledEffectId) => {
            settled.push(settledEffectId);
            return Promise.resolve();
          },
        }),
      );

      let failure: unknown;
      try {
        for await (const event of root.llm.stream(
          request,
          new AbortController().signal,
        )) {
          void event;
        }
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(LlmEffectNotStartedError);
      expect(openCount).toBe(0);
      expect(settled).toEqual(["effect-1"]);
      await root.fiber.dispose();
    },
  );

  test("sends the chat completion to the Connection's endpoint", async () => {
    const keyringText = serializedKeyring();
    const envelope = await sealCredentialV1({
      keyring: parseCredentialKeyringV1(keyringText),
      context: {
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        credentialGeneration: "generation-1",
      },
      plaintext: "account-secret",
    });

    // Unset endpoint keeps the Package default; a Connection setting moves it.
    for (const [apiBaseUrl, expected] of [
      [undefined, "https://ollama.com/v1/chat/completions"],
      ["http://127.0.0.1:11434", "http://127.0.0.1:11434/v1/chat/completions"],
    ] as const) {
      const urls: string[] = [];
      const root = new Context();
      await root.plugin(LlmRegistry);
      await mountCredentialRuntime(root, keyringText);
      await root.plugin(
        createOllamaCloudRuntimePlugin({
          accountId: "account-1",
          connectionId: "connection-1",
          packageId: "provider-ollama-cloud",
          now: () => Date.parse("2026-08-30T00:00:00.000Z"),
          chatBaseUrl: ollamaChatBaseUrl(apiBaseUrl),
          leaseCredential: (effectId) =>
            Promise.resolve({
              schemaVersion: 1,
              leaseId: "lease-1",
              effectId,
              connectionId: "connection-1",
              credentialGeneration: "generation-1",
              expiresAt: "2026-08-30T01:00:00.000Z",
              envelope,
            }),
          settleCredential: () => Promise.resolve(),
          fetch: (input) => {
            urls.push(String(input));
            return Promise.resolve(
              new Response(
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                  "data: [DONE]\n\n",
                {
                  status: 200,
                  headers: { "content-type": "text/event-stream" },
                },
              ),
            );
          },
        }),
      );

      const signal = new AbortController().signal;
      for await (const event of root.llm.stream(request, signal)) void event;
      expect(urls).toEqual([expected]);
    }

    // An unusable endpoint never reaches a request: it is refused at the seam.
    expect(() => ollamaChatBaseUrl("/v1")).toThrow(
      "is not an absolute http or https URL",
    );
    expect(() => ollamaChatBaseUrl("localhost:11434")).toThrow(
      "must use http or https",
    );
  });

  test("rejects a request bound to another Connection before leasing", async () => {
    let leaseCount = 0;
    const root = new Context();
    await root.plugin(LlmRegistry);
    await mountCredentialRuntime(root);
    await root.plugin(
      createOllamaCloudRuntimePlugin({
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        leaseCredential: () => {
          leaseCount += 1;
          return Promise.reject(new Error("must not lease"));
        },
        settleCredential: () => Promise.resolve(),
      }),
    );

    const mismatchedRequest = {
      ...request,
      modelBinding: {
        ...request.modelBinding,
        connectionId: "connection-2",
      },
    };
    let failure: unknown;
    try {
      for await (const event of root.llm.stream(
        mismatchedRequest,
        new AbortController().signal,
      )) {
        void event;
      }
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(LlmEffectNotStartedError);
    expect(leaseCount).toBe(0);
    await root.fiber.dispose();
  });

  test("settles a durable outcome after provider reconstruction", async () => {
    const settled: string[] = [];
    const root = new Context();
    await root.plugin(LlmRegistry);
    await mountCredentialRuntime(root);
    await root.plugin(
      createOllamaCloudRuntimePlugin({
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        leaseCredential: () => Promise.reject(new Error("not used")),
        settleCredential: (effectId) => {
          settled.push(effectId);
          return Promise.resolve();
        },
      }),
    );

    await root.serial(
      "agent/model-outcome-committed",
      {} as Agent,
      "durable-effect",
      "completed",
    );

    expect(settled).toEqual(["durable-effect"]);
    await root.fiber.dispose();
  });

  test.each([401, 403, 404])(
    "settles definitive HTTP %i rejections after durable no-effect outcome",
    async (status) => {
      const keyringText = serializedKeyring();
      const envelope = await sealCredentialV1({
        keyring: parseCredentialKeyringV1(keyringText),
        context: {
          accountId: "account-1",
          connectionId: "connection-1",
          packageId: "provider-ollama-cloud",
          credentialGeneration: "generation-1",
        },
        plaintext: "account-secret",
      });
      const settled: string[] = [];
      const root = new Context();
      await root.plugin(LlmRegistry);
      await mountCredentialRuntime(root, keyringText);
      await root.plugin(
        createOllamaCloudRuntimePlugin({
          accountId: "account-1",
          connectionId: "connection-1",
          packageId: "provider-ollama-cloud",
          now: () => Date.parse("2026-08-30T00:00:00.000Z"),
          leaseCredential: (effectId) =>
            Promise.resolve({
              schemaVersion: 1,
              leaseId: "lease-1",
              effectId,
              connectionId: "connection-1",
              credentialGeneration: "generation-1",
              expiresAt: "2026-08-30T01:00:00.000Z",
              envelope,
            }),
          settleCredential: (effectId) => {
            settled.push(effectId);
            return Promise.resolve();
          },
          fetch: () =>
            Promise.resolve(new Response("definitive rejection", { status })),
        }),
      );

      let failure: unknown;
      try {
        for await (const event of root.llm.stream(
          request,
          new AbortController().signal,
        )) {
          void event;
        }
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(LlmEffectNotStartedError);
      expect(settled).toEqual([]);
      await root.serial(
        "agent/model-outcome-committed",
        {} as Agent,
        request.requestId,
        "not-started",
      );
      expect(settled).toEqual(["effect-1"]);
      await root.fiber.dispose();
    },
  );

  test.each([408, 429, 500, 502])(
    "settles pre-stream HTTP %i as not started rather than parking the Turn",
    async (status) => {
      const keyringText = serializedKeyring();
      const envelope = await sealCredentialV1({
        keyring: parseCredentialKeyringV1(keyringText),
        context: {
          accountId: "account-1",
          connectionId: "connection-1",
          packageId: "provider-ollama-cloud",
          credentialGeneration: "generation-1",
        },
        plaintext: "account-secret",
      });
      const settled: string[] = [];
      const root = new Context();
      await root.plugin(LlmRegistry);
      await mountCredentialRuntime(root, keyringText);
      await root.plugin(
        createOllamaCloudRuntimePlugin({
          accountId: "account-1",
          connectionId: "connection-1",
          packageId: "provider-ollama-cloud",
          now: () => Date.parse("2026-08-30T00:00:00.000Z"),
          leaseCredential: (effectId) =>
            Promise.resolve({
              schemaVersion: 1,
              leaseId: "lease-1",
              effectId,
              connectionId: "connection-1",
              credentialGeneration: "generation-1",
              expiresAt: "2026-08-30T01:00:00.000Z",
              envelope,
            }),
          settleCredential: (effectId) => {
            settled.push(effectId);
            return Promise.resolve();
          },
          fetch: () => Promise.resolve(new Response("transient", { status })),
        }),
      );

      let failure: unknown;
      try {
        for await (const _ of root.llm.stream(
          request,
          new AbortController().signal,
        )) {
          void _;
        }
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(LlmEffectNotStartedError);
      expect(settled).toEqual([]);
      await root.fiber.dispose();
    },
  );

  test("reports an interrupted response as not retrievable so the run settles", async () => {
    const root = new Context();
    await root.plugin(LlmRegistry);
    await mountCredentialRuntime(root, serializedKeyring());
    await root.plugin(
      createOllamaCloudRuntimePlugin({
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        now: () => Date.parse("2026-08-30T00:00:00.000Z"),
        leaseCredential: () => Promise.reject(new Error("unused")),
        settleCredential: () => Promise.resolve(),
        fetch: () => Promise.reject(new Error("unused")),
      }),
    );

    const outcome = await root.llm.reconcile(
      request,
      new AbortController().signal,
    );

    expect(outcome.status).toBe("not-retrievable");
    await root.fiber.dispose();
  });
});

/** A clock the test advances by hand, so a deadline costs no real seconds. */
function manualClock() {
  const pending = new Map<number, { run: () => void; due: number }>();
  let next = 1;
  let now = 0;
  return {
    schedule(run: () => void, milliseconds: number): () => void {
      const id = next++;
      pending.set(id, { run, due: now + milliseconds });
      return () => pending.delete(id);
    },
    advance(milliseconds: number): void {
      now += milliseconds;
      for (const [id, timer] of [...pending]) {
        if (timer.due <= now) {
          pending.delete(id);
          timer.run();
        }
      }
    },
    get armed(): number {
      return pending.size;
    },
  };
}

/** Let the stream's own pump run: the clock is manual, the event loop is not. */
async function settle(): Promise<void> {
  for (let tick = 0; tick < 10; tick += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

/** An endpoint body the test feeds one chunk at a time. */
function pushableSse(): {
  body: ReadableStream<Uint8Array>;
  push: (text: string) => void;
} {
  let enqueue: ((text: string) => void) | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      enqueue = (text) => controller.enqueue(new TextEncoder().encode(text));
    },
  });
  return { body, push: (text) => enqueue?.(text) };
}

/** Mount the Package against `fetch`, with its deadlines on a manual clock. */
async function mountWithClock(
  root: Context,
  clock: ReturnType<typeof manualClock>,
  fetch: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>,
): Promise<void> {
  const keyringText = serializedKeyring();
  const envelope = await sealCredentialV1({
    keyring: parseCredentialKeyringV1(keyringText),
    context: {
      accountId: "account-1",
      connectionId: "connection-1",
      packageId: "provider-ollama-cloud",
      credentialGeneration: "generation-1",
    },
    plaintext: "account-secret",
  });
  await root.plugin(LlmRegistry);
  await mountCredentialRuntime(root, keyringText);
  await root.plugin(
    createOllamaCloudRuntimePlugin({
      accountId: "account-1",
      connectionId: "connection-1",
      packageId: "provider-ollama-cloud",
      now: () => Date.parse("2026-08-30T00:00:00.000Z"),
      leaseCredential: (effectId) =>
        Promise.resolve({
          schemaVersion: 1,
          leaseId: "lease-1",
          effectId,
          connectionId: "connection-1",
          credentialGeneration: "generation-1",
          expiresAt: "2026-08-30T01:00:00.000Z",
          envelope,
        }),
      settleCredential: () => Promise.resolve(),
      fetch,
      deadlines: { schedule: clock.schedule },
    }),
  );
}

// A Stop must end one request and nothing else. The provider is registered once
// and serves every Turn, and it keeps a per-request credential map, so a
// cancelled request that tore down anything shared would take the next Turn
// with it.
describe("Ollama Cloud request isolation", () => {
  test("leaves the next request working after one is cancelled", async () => {
    const clock = manualClock();
    const { body } = pushableSse();
    let calls = 0;
    const root = new Context();
    await mountWithClock(root, clock, () => {
      calls += 1;
      return Promise.resolve(
        calls === 1
          ? new Response(body, { status: 200 })
          : new Response(
              'data: {"choices":[{"delta":{"content":"second"},"finish_reason":"stop"}]}\n\n' +
                "data: [DONE]\n\n",
              { status: 200 },
            ),
      );
    });

    const cancelled = new AbortController();
    const abandoned = (async () => {
      for await (const event of root.llm.stream(request, cancelled.signal)) {
        void event;
      }
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();
    cancelled.abort(new Error("Turn cancelled"));
    expect((await abandoned) as Error).toBeInstanceOf(Error);

    const events: unknown[] = [];
    for await (const event of root.llm.stream(
      { ...request, requestId: "effect-2" },
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "second" },
      { type: "finish", reason: "completed" },
    ]);
    await root.fiber.dispose();
  });
});

// An endpoint that accepts the request and then says nothing used to be bounded
// only by the fifteen-minute Turn deadline: an empty bubble for a quarter of an
// hour, saying nothing about why.
describe("Ollama Cloud deadlines", () => {
  test("fails the step when the endpoint produces no first byte", async () => {
    const clock = manualClock();
    const root = new Context();
    await mountWithClock(
      root,
      clock,
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );

    const outcome = (async () => {
      for await (const event of root.llm.stream(
        request,
        new AbortController().signal,
      )) {
        void event;
      }
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    await settle();
    clock.advance(MODEL_FIRST_BYTE_DEADLINE_MS_V1);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(ModelRequestDeadlineError);
    expect((failure as ModelRequestDeadlineError).phase).toBe("first-byte");
    expect((failure as Error).message).toBe(
      MODEL_FIRST_BYTE_DEADLINE_REASON_V1,
    );
    await root.fiber.dispose();
  });

  test("fails the step when the endpoint starts an answer and then stalls", async () => {
    const clock = manualClock();
    const { body, push } = pushableSse();
    const root = new Context();
    await mountWithClock(root, clock, () =>
      Promise.resolve(new Response(body, { status: 200 })),
    );

    const events: unknown[] = [];
    // The outcome is watched from the moment the stream starts: a failure this
    // test only looked at later would be an unobserved rejection first.
    const outcome = (async () => {
      for await (const event of root.llm.stream(
        request,
        new AbortController().signal,
      )) {
        events.push(event);
      }
    })().then(
      () => undefined,
      (error: unknown) => error,
    );
    push('data: {"choices":[{"delta":{"content":"Half a "}}]}\n\n');
    await settle();
    // The answer has started, so the clock now running is the idle one — well
    // short of the first-byte allowance this never reaches.
    clock.advance(MODEL_IDLE_DEADLINE_MS_V1);

    const failure = await outcome;
    expect(failure).toBeInstanceOf(ModelRequestDeadlineError);
    expect((failure as ModelRequestDeadlineError).phase).toBe("idle");
    expect((failure as Error).message).toBe(MODEL_IDLE_DEADLINE_REASON_V1);
    expect(events).toEqual([{ type: "text-delta", text: "Half a " }]);
    await root.fiber.dispose();
  });

  test("lets a stream that keeps producing chunks finish, leaving no timer armed", async () => {
    const clock = manualClock();
    const { body, push } = pushableSse();
    const root = new Context();
    await mountWithClock(root, clock, () =>
      Promise.resolve(new Response(body, { status: 200 })),
    );

    const events: unknown[] = [];
    const consume = (async () => {
      for await (const event of root.llm.stream(
        request,
        new AbortController().signal,
      )) {
        events.push(event);
      }
    })();
    for (const chunk of ["one", "two", "three"]) {
      push(`data: {"choices":[{"delta":{"content":"${chunk}"}}]}\n\n`);
      await settle();
      // Each chunk lands inside the idle allowance, so the clock rearms rather
      // than firing.
      clock.advance(MODEL_IDLE_DEADLINE_MS_V1 - 1);
      await settle();
    }
    push(
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
    await settle();
    await consume;

    expect(events).toEqual([
      { type: "text-delta", text: "one" },
      { type: "text-delta", text: "two" },
      { type: "text-delta", text: "three" },
      { type: "finish", reason: "completed" },
    ]);
    // A live timer in a Worker isolate holds the request open long after
    // anybody is listening for it.
    expect(clock.armed).toBe(0);
    await root.fiber.dispose();
  });
});
