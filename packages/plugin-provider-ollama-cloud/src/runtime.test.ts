import { describe, expect, test } from "bun:test";
import {
  LlmEffectNotStartedError,
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
import { OpenAICompatibleHttpError } from "@frockbot/provider-openai-compatible";
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

  test("requires reconciliation for ambiguous HTTP failures", async () => {
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
        fetch: () => Promise.resolve(new Response("timeout", { status: 408 })),
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

    expect(failure).toBeInstanceOf(OpenAICompatibleHttpError);
    expect(failure).not.toBeInstanceOf(LlmEffectNotStartedError);
    expect(settled).toEqual([]);
    await root.fiber.dispose();
  });
});
