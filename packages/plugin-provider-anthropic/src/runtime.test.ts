import { describe, expect, test } from "bun:test";
import {
  ModelProviderFailureError,
  type NormalizedModelRequest,
} from "@frockbot/kernel-contracts";
import {
  parseCredentialKeyringV1,
  sealCredentialV1,
} from "@frockbot/connection-core";
import { CredentialLeaseRuntime } from "@frockbot/plugin-credentials/user";
import {
  type AgentRuntimeHarness,
  createAgentRuntimeHarness,
} from "@frockbot/plugin-testkit";
import { anthropicPromptV1, createAnthropicFeature } from "./runtime.js";

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
  provider: "anthropic",
  model: "claude-sonnet-4-5",
  system: "Be useful.",
  messages: [{ role: "user", content: "What time is it?" }],
  tools: [
    {
      name: "current_time",
      description: "Return the time.",
      inputSchema: { type: "object", properties: {} },
    },
  ],
  modelBinding: {
    connectionId: "connection-1",
    connectionGeneration: "generation-1",
  },
};

function anthropicSse(events: [string, unknown][]): string {
  return events
    .map(([type, data]) => `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`)
    .join("");
}

const textAnswer = anthropicSse([
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg-1",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        usage: { input_tokens: 11, output_tokens: 0 },
      },
    },
  ],
  [
    "content_block_start",
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    },
  ],
  [
    "content_block_delta",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: "It is noon." },
    },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn" },
      usage: { output_tokens: 4 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
]);

const toolAnswer = anthropicSse([
  [
    "message_start",
    {
      type: "message_start",
      message: {
        id: "msg-2",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-5",
        content: [],
        usage: { input_tokens: 9, output_tokens: 0 },
      },
    },
  ],
  [
    "content_block_start",
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "tool_use", id: "call-1", name: "current_time" },
    },
  ],
  [
    "content_block_delta",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '{"zone":' },
    },
  ],
  [
    "content_block_delta",
    {
      type: "content_block_delta",
      index: 0,
      delta: { type: "input_json_delta", partial_json: '"UTC"}' },
    },
  ],
  ["content_block_stop", { type: "content_block_stop", index: 0 }],
  [
    "message_delta",
    {
      type: "message_delta",
      delta: { stop_reason: "tool_use" },
      usage: { output_tokens: 6 },
    },
  ],
  ["message_stop", { type: "message_stop" }],
]);

async function mountedProvider(
  respond: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
  seen: { authorization?: string; body?: unknown } = {},
): Promise<AgentRuntimeHarness> {
  const keyringText = serializedKeyring();
  const envelope = await sealCredentialV1({
    keyring: parseCredentialKeyringV1(keyringText),
    context: {
      accountId: "account-1",
      connectionId: "connection-1",
      packageId: "provider-anthropic",
      credentialGeneration: "generation-1",
    },
    plaintext: "anthropic-secret",
  });
  const root = createAgentRuntimeHarness();
  root.credentials = new CredentialLeaseRuntime({
    readSecret: () => keyringText,
  });
  await root.mount(
    createAnthropicFeature({
      accountId: "account-1",
      connectionId: "connection-1",
      packageId: "provider-anthropic",
      now: () => Date.parse("2026-09-06T00:00:00.000Z"),
      leaseCredential: (effectId: string) =>
        Promise.resolve({
          schemaVersion: 1,
          leaseId: "lease-1",
          effectId,
          connectionId: "connection-1",
          credentialGeneration: "generation-1",
          expiresAt: "2026-09-06T01:00:00.000Z",
          envelope,
        }),
      settleCredential: () => Promise.resolve(),
      fetch: (input, init) => {
        const outbound = new Request(input, init);
        seen.authorization = outbound.headers.get("x-api-key") ?? "";
        seen.body = init?.body ? JSON.parse(String(init.body)) : undefined;
        return respond(input, init);
      },
    }),
  );
  return root;
}

async function collect(
  root: AgentRuntimeHarness,
  input = request,
): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of root.llm.stream(
    input,
    new AbortController().signal,
  )) {
    events.push(event);
  }
  return events;
}

describe("Anthropic runtime Contribution", () => {
  test("streams text and reports usage on the Connection's credential", async () => {
    const seen: { authorization?: string; body?: unknown } = {};
    const root = await mountedProvider(
      () =>
        Promise.resolve(
          new Response(textAnswer, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      seen,
    );

    const events = await collect(root);

    expect(seen.authorization).toBe("anthropic-secret");
    expect(events).toEqual([
      { type: "text-delta", text: "It is noon." },
      { type: "usage", usage: { inputTokens: 11, outputTokens: 4 } },
      { type: "finish", reason: "completed" },
    ]);
    await root.dispose();
  });

  test("emits a tool call only after the stream terminates", async () => {
    const root = await mountedProvider(() =>
      Promise.resolve(
        new Response(toolAnswer, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );

    const events = await collect(root);

    expect(events.at(-2)).toEqual({
      type: "tool-call",
      call: { id: "call-1", name: "current_time", input: { zone: "UTC" } },
    });
    expect(events.at(-1)).toEqual({ type: "finish", reason: "tool-calls" });
    await root.dispose();
  });

  test("says so when a schema becomes prompt guidance", async () => {
    const seen: { authorization?: string; body?: unknown } = {};
    const root = await mountedProvider(
      () =>
        Promise.resolve(
          new Response(textAnswer, {
            status: 200,
            headers: { "content-type": "text/event-stream" },
          }),
        ),
      seen,
    );

    const events = await collect(root, {
      ...request,
      responseFormat: {
        type: "json_schema",
        name: "answer",
        schema: { type: "object", additionalProperties: true },
      },
    });

    expect(events[0]).toMatchObject({
      type: "response-format-note",
      note: { code: "structured-output-downgraded", effective: "prompt" },
    });
    expect(
      JSON.stringify((seen.body as { system?: unknown }).system),
    ).toContain("Return only JSON matching this schema");
    await root.dispose();
  });

  test("classifies a rate limit as transient and carries its Retry-After", async () => {
    const root = await mountedProvider(() =>
      Promise.resolve(
        Response.json(
          {
            type: "error",
            error: { type: "rate_limit_error", message: "slow" },
          },
          { status: 429, headers: { "retry-after": "3" } },
        ),
      ),
    );

    const failure = await collect(root).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ModelProviderFailureError);
    expect((failure as ModelProviderFailureError).classification).toBe(
      "transient",
    );
    expect((failure as ModelProviderFailureError).retryAfterMs).toBe(3_000);
    await root.dispose();
  });

  test("refuses a request carrying another Connection's authority", async () => {
    const root = await mountedProvider(() =>
      Promise.reject(new Error("must not be reached")),
    );

    const failure = await collect(root, {
      ...request,
      modelBinding: {
        connectionId: "connection-2",
        connectionGeneration: "generation-1",
      },
    }).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ModelProviderFailureError);
    expect((failure as ModelProviderFailureError).classification).toBe(
      "permanent",
    );
    await root.dispose();
  });
});

describe("the prompt handed to the model", () => {
  test("carries an assistant tool call and the result that answered it", () => {
    const prompt = anthropicPromptV1({
      ...request,
      messages: [
        { role: "user", content: "What time is it?" },
        {
          role: "assistant",
          content: "",
          toolCalls: [
            { id: "call-1", name: "current_time", input: { zone: "UTC" } },
          ],
        },
        {
          role: "tool",
          callId: "call-1",
          name: "current_time",
          content: "noon",
          isError: false,
        },
      ],
    });

    expect(prompt[0]).toEqual({ role: "system", content: "Be useful." });
    expect(prompt[2]).toEqual({
      role: "assistant",
      content: [
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "current_time",
          input: '{"zone":"UTC"}',
        },
      ],
    });
    expect(prompt[3]).toMatchObject({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          output: { type: "text", value: "noon" },
        },
      ],
    });
  });
});
