import { expect, test } from "bun:test";
import type {
  AssistantMessage,
  Provider,
  StreamOptions,
} from "@earendil-works/pi-ai";
import type {
  LlmProvider,
  LlmStreamEvent,
  NormalizedModelRequest,
} from "@frockbot/core/contracts";
import { providerModelsV1 } from "./models.js";
import { encodeOAuthTokenV1 } from "./oauth-protocol.js";
import { createCatalogProviderFeatureV1 } from "./runtime.js";

test("Kimi subscription transport sends OAuth only as its required header", async () => {
  const model = providerModelsV1("kimi-coding")[0]!;
  let options: StreamOptions | undefined;
  const provider = {
    async *streamSimple(
      _model: unknown,
      _context: unknown,
      received: StreamOptions,
    ) {
      options = received;
      yield {
        type: "done",
        reason: "stop",
        message: {
          role: "assistant",
          api: model.api,
          provider: model.provider,
          model: model.id,
          timestamp: 0,
          stopReason: "stop",
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          content: [{ type: "text", text: "hello" }],
        } satisfies AssistantMessage,
      } as const;
    },
  } as unknown as Provider;
  let registered: LlmProvider | undefined;
  const feature = createCatalogProviderFeatureV1({
    providerId: "kimi-coding",
    accountId: "account-1",
    connectionId: "connection-1",
    provider,
    async leaseCredential(effectId, expectedGeneration) {
      return {
        schemaVersion: 1,
        leaseId: "lease-1",
        effectId,
        connectionId: "connection-1",
        credentialGeneration: expectedGeneration!,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
        envelope: {} as never,
      };
    },
    async settleCredential() {},
  });
  feature({
    llm: {
      register(candidate: LlmProvider) {
        registered = candidate;
        return () => {};
      },
    },
    hooks: { add: () => () => {} },
    credentials: {
      open: async () =>
        encodeOAuthTokenV1({
          access: "kimi-access-secret",
          refresh: "kimi-refresh-secret",
          expires: Date.now() + 300_000,
        }),
    },
  } as never);
  const request: NormalizedModelRequest = {
    requestId: "request-1",
    provider: "kimi-coding",
    model: model.id,
    system: "",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    modelBinding: {
      connectionId: "connection-1",
      connectionGeneration: "generation-1",
    },
  };
  const events: LlmStreamEvent[] = [];
  for await (const event of registered!.stream(
    request,
    new AbortController().signal,
  ))
    events.push(event);

  expect(options?.apiKey).toBeUndefined();
  expect(options?.headers).toMatchObject({
    Authorization: "Bearer kimi-access-secret",
    "Idempotency-Key": "request-1",
  });
  expect(JSON.stringify(options)).not.toContain("kimi-refresh-secret");
  expect(events.at(-1)).toEqual({ type: "finish", reason: "completed" });
});
