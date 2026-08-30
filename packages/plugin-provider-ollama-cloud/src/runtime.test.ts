import { describe, expect, test } from "bun:test";
import {
  LlmEffectNotStartedError,
  LlmRegistry,
  type NormalizedModelRequest,
} from "@frockbot/agent-core";
import {
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "@frockbot/connection-core";
import { OpenAICompatibleHttpError } from "@frockbot/provider-openai-compatible";
import { Context } from "cordis";
import { createOllamaCloudRuntimePlugin } from "./runtime.js";

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

const request: NormalizedModelRequest = {
  requestId: "effect-1",
  provider: "ollama-cloud",
  model: "glm-5.3-flash:cloud",
  system: "",
  messages: [{ role: "user", content: "hello" }],
  tools: [],
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
    const settled: string[] = [];
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createOllamaCloudRuntimePlugin({
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        credentialKeyring: keyringText,
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

    const events = [];
    for await (const event of root.llm.stream(
      request,
      new AbortController().signal,
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text-delta", text: "hello" },
      { type: "finish", reason: "completed" },
    ]);
    expect(authorizations).toEqual(["Bearer account-secret"]);
    expect(settled).toEqual(["effect-1"]);
    await root.fiber.dispose();
  });

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
    const root = new Context();
    await root.plugin(LlmRegistry);
    await root.plugin(
      createOllamaCloudRuntimePlugin({
        accountId: "account-1",
        connectionId: "connection-1",
        packageId: "provider-ollama-cloud",
        credentialKeyring: keyringText,
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
    await root.fiber.dispose();
  });
});
