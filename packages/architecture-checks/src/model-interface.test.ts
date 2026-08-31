// Constitution — Architecture checks: "two provider Packages satisfy the model
// interface with no kernel diff." Both providers are mounted into the *same*
// kernel `ModelInvocation` surface, by identical kernel code, and both stream
// through it. Nothing kernel-side changes between the two mounts; the only
// difference is which Package was plugged in.
import { describe, expect, test } from "bun:test";
import {
  openCredentialV1,
  parseCredentialKeyringV1,
  sealCredentialV1,
  type CredentialLeaseV1,
} from "@frockbot/connection-core";
import type {
  LlmStreamEvent,
  ModelInvocation,
  NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import { LlmRegistry } from "@frockbot/plugin-models";
import foundationProviderPlugin from "@frockbot/plugin-provider-foundation/runtime";
import { createOllamaCloudRuntimePlugin } from "@frockbot/plugin-provider-ollama-cloud/runtime";
import { Context, Service, type Plugin } from "cordis";

const KEYRING = JSON.stringify({
  schemaVersion: 1,
  currentKeyId: "primary",
  keys: { primary: "MDEyMzQ1Njc4OWFiY2RlZjAxMjM0NTY3ODlhYmNkZWY" },
});

class TestCredentialLease extends Service {
  constructor(ctx: Context) {
    super(ctx, "credentialLease");
  }

  open(input: {
    accountId: string;
    connectionId: string;
    packageId: string;
    lease: CredentialLeaseV1;
  }): Promise<string> {
    return openCredentialV1({
      keyring: parseCredentialKeyringV1(KEYRING),
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

/**
 * The kernel half, written once. It mounts the kernel's `ModelInvocation`
 * implementation, plugs in whatever provider Package it is handed, and streams.
 * A second provider must require no edit here — that is the check.
 */
async function streamThroughTheKernel(
  providerPlugin: Plugin.Function,
  request: NormalizedModelRequest,
  extra?: Plugin.Function,
): Promise<{ events: LlmStreamEvent[]; invocation: ModelInvocation }> {
  const root = new Context();
  await root.plugin(LlmRegistry);
  if (extra) await root.plugin(extra);
  await root.plugin(providerPlugin);
  const invocation: ModelInvocation = root.llm;
  const events: LlmStreamEvent[] = [];
  for await (const event of invocation.stream(
    request,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  await root.fiber.dispose();
  return { events, invocation };
}

const message = { role: "user" as const, content: "hello" };

describe("model interface", () => {
  test("two provider Packages satisfy the model interface with no kernel diff", async () => {
    const foundation = await streamThroughTheKernel(foundationProviderPlugin, {
      requestId: "foundation-1",
      provider: "foundation",
      model: "deterministic-v1",
      system: "",
      messages: [message],
      tools: [],
    });

    const envelope = await sealCredentialV1({
      keyring: parseCredentialKeyringV1(KEYRING),
      context: {
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        credentialGeneration: "generation-1",
      },
      plaintext: "account-secret",
    });
    const credentialLease: Plugin.Function = (ctx) => {
      new TestCredentialLease(ctx);
    };
    const ollama = await streamThroughTheKernel(
      createOllamaCloudRuntimePlugin({
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        leaseCredential: (effectId) =>
          Promise.resolve({
            schemaVersion: 1,
            leaseId: "lease-1",
            effectId,
            connectionId: "connection-1",
            credentialGeneration: "generation-1",
            expiresAt: "2099-01-01T00:00:00.000Z",
            envelope,
          }),
        settleCredential: () => Promise.resolve(),
        fetch: () =>
          Promise.resolve(
            new Response(
              'data: {"choices":[{"delta":{"content":"hello"}}]}\n\n' +
                'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
                "data: [DONE]\n\n",
              {
                status: 200,
                headers: { "content-type": "text/event-stream" },
              },
            ),
          ),
      }),
      {
        requestId: "ollama-1",
        provider: "ollama-cloud",
        model: "glm-5.3-flash:cloud",
        system: "",
        messages: [message],
        tools: [],
        modelBinding: {
          connectionId: "connection-1",
          connectionGeneration: "generation-1",
        },
      },
      credentialLease,
    );

    // Both answer the same kernel interface with the same event vocabulary.
    expect(foundation.events.at(-1)).toEqual({
      type: "finish",
      reason: "completed",
    });
    expect(ollama.events.at(-1)).toEqual({
      type: "finish",
      reason: "completed",
    });
    expect(
      foundation.events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("Cordis runtime: hello");
    expect(
      ollama.events
        .filter((event) => event.type === "text-delta")
        .map((event) => event.text)
        .join(""),
    ).toBe("hello");
    for (const invocation of [foundation.invocation, ollama.invocation]) {
      expect(typeof invocation.stream).toBe("function");
      expect(typeof invocation.reconcile).toBe("function");
    }
  });
});
