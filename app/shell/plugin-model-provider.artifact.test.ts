/**
 * The whole Plugin provider path, short of workerd (ADR 0032).
 *
 * `apps/cloudflare/test/provider-plugin.workerd.ts` is the real end-to-end
 * proof; it needs a workerd runtime, which a sandbox that refuses to bind a
 * loopback port cannot start. This file runs the same three shipped pieces
 * against each other in-process: the kernel's generated wrapper (compiled
 * from the source the worker embeds, with only `cloudflare:workers` shimmed),
 * the DeepSeek artifact as the build produced it, and the host adapter. What
 * it adds over either half alone is the seam between them: the invocation the
 * wrapper decodes, the `ctx.modelTransport` call it builds, and the NDJSON
 * the adapter reads back.
 */
import { describe, expect, test } from "bun:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  PLUGIN_WORKER_MAIN_MODULE,
  pluginWorkerIndexSourceV1,
  pluginWorkerModulePathV1,
} from "@frockbot/frock-compose";
import {
  ModelOutcomeUncertainErrorV1,
  type NormalizedModelRequest,
  type PluginModelInvocationV1,
  type PluginWorkerModelResultV1,
} from "@frockbot/core/contracts";
import { SEEDED_PLUGIN_ARTIFACTS_V1 } from "@frockbot/app/plugins/seeded/artifacts.generated";
import { pluginModelProviderV1 } from "./plugin-model-provider.ts";
import type {
  ModelDispatchHandleV1,
  ModelDispatchRefusalV1,
} from "@frockbot/app/isolates/model-dispatch";

const artifact = SEEDED_PLUGIN_ARTIFACTS_V1.find(
  (entry) => entry.pluginId === "deepseek",
)!;

/** One SSE frame, as the provider writes them. */
function frame(payload: unknown, finish: string | null = null): string {
  return `data: ${JSON.stringify({
    choices: [{ delta: payload, finish_reason: finish }],
  })}\n\n`;
}

const ANSWER =
  frame({ content: "Hello " }) +
  frame({ content: "from the artifact." }, "stop") +
  `data: ${JSON.stringify({
    choices: [],
    usage: { prompt_tokens: 9, completion_tokens: 4 },
  })}\n\n` +
  "data: [DONE]\n\n";

interface TransportCall {
  scope: Record<string, unknown>;
  request: { schemaVersion: number; transportId: string; body: string };
}

/**
 * The Plugin worker, mounted the way the host mounts it: the generated index
 * over the built artifact, with `cloudflare:workers` shimmed.
 */
async function mountWorker(
  answer: string,
  calls: TransportCall[],
): Promise<{
  streamModel(
    invocation: PluginModelInvocationV1,
  ): Promise<PluginWorkerModelResultV1>;
}> {
  const directory = join(
    process.env.TMPDIR ?? "/tmp",
    `frockbot-deepseek-worker-${artifact.contentHash.slice(0, 16)}`,
  );
  await mkdir(join(directory, "plugins"), { recursive: true });
  await writeFile(
    join(directory, pluginWorkerModulePathV1("deepseek")),
    artifact.module,
  );
  // The one platform import the wrapper makes, replaced by a shim: the index
  // is otherwise the shipped text, and the artifact is the shipped bytes.
  const index = pluginWorkerIndexSourceV1(["deepseek"]).replace(
    'import { WorkerEntrypoint } from "cloudflare:workers";',
    "class WorkerEntrypoint { constructor(ctx, env) { this.ctx = ctx; this.env = env; } }",
  );
  await writeFile(join(directory, PLUGIN_WORKER_MAIN_MODULE), index);
  const { default: Entrypoint } = (await import(
    join(directory, PLUGIN_WORKER_MAIN_MODULE)
  )) as {
    default: new (
      ctx: unknown,
      env: unknown,
    ) => {
      streamModel(
        invocation: PluginModelInvocationV1,
      ): Promise<PluginWorkerModelResultV1>;
    };
  };
  const worker = new Entrypoint(
    {},
    {
      IDENTITY: {
        userId: "user-1",
        plugins: [{ pluginId: "deepseek", grants: [], consumes: [] }],
      },
      CAPABILITIES: {
        modelTransport: async (
          scope: Record<string, unknown>,
          request: { schemaVersion: number; transportId: string; body: string },
        ) => {
          calls.push({ scope, request });
          return {
            status: "streaming",
            httpStatus: 200,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new TextEncoder().encode(answer));
                controller.close();
              },
            }),
          };
        },
      },
    },
  );
  return worker;
}

const SCOPE = {
  botId: "bot-1",
  runId: "run-1",
  sessionId: "session-1",
  turnId: "run-1",
  generationId: "generation-1",
};

function request(): NormalizedModelRequest {
  return {
    requestId: "request-1",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    system: "You are a Bot.",
    messages: [{ role: "user", content: "hello" }],
    tools: [],
    modelBinding: {
      connectionId: "connection-1",
      connectionGeneration: "generation-1",
    },
  };
}

function dispatch(
  options: {
    spent?: boolean;
    refusal?: ModelDispatchRefusalV1;
  } = {},
): ModelDispatchHandleV1 {
  return {
    transportId: "ticket-1",
    finish: () => {},
    spent: () => options.spent === true,
    refusal: () => options.refusal,
  };
}

async function run(
  answer: string,
  options: { spent?: boolean; refusal?: ModelDispatchRefusalV1 } = {},
): Promise<{
  events: Record<string, unknown>[];
  error?: Error;
  calls: TransportCall[];
}> {
  const calls: TransportCall[] = [];
  const worker = await mountWorker(answer, calls);
  const provider = pluginModelProviderV1({
    pluginId: "deepseek",
    binding: {
      provider: "deepseek",
      model: "deepseek-v4-pro",
      connectionId: "connection-1",
      connectionGeneration: "generation-1",
    },
    streamModel: (invocation) => worker.streamModel(invocation),
    begin: () => dispatch(options),
    scope: SCOPE,
  });
  const events: Record<string, unknown>[] = [];
  try {
    for await (const event of provider.stream(
      request(),
      new AbortController().signal,
    )) {
      events.push(event as unknown as Record<string, unknown>);
    }
    return { events, calls };
  } catch (error) {
    return { events, error: error as Error, calls };
  }
}

describe("the artifact behind the wrapper, answering a Wave's request", () => {
  test("streams text, usage and one terminal back to the host", async () => {
    const outcome = await run(ANSWER);
    expect(outcome.error).toBeUndefined();
    expect(outcome.events).toEqual([
      { type: "text-delta", text: "Hello " },
      { type: "text-delta", text: "from the artifact." },
      {
        type: "provider-state",
        state: {
          provider: "deepseek",
          model: "deepseek-v4-pro",
          connectionId: "connection-1",
          connectionGeneration: "generation-1",
          content: '{"role":"assistant","content":"Hello from the artifact."}',
        },
      },
      { type: "usage", usage: { inputTokens: 9, outputTokens: 4 } },
      { type: "finish", reason: "completed" },
    ]);
  });

  test("the Plugin composes a body and the host is the one that sends it", async () => {
    const outcome = await run(ANSWER);
    expect(outcome.calls).toHaveLength(1);
    const [call] = outcome.calls;
    // The ticket and the scope come from the host; the body is the Plugin's.
    expect(call!.request.transportId).toBe("ticket-1");
    expect(call!.scope).toMatchObject({ botId: "bot-1", runId: "run-1" });
    const body = JSON.parse(call!.request.body) as Record<string, unknown>;
    expect(body).toMatchObject({ model: "deepseek-v4-pro", stream: true });
    expect(body.messages).toEqual([
      { role: "system", content: "You are a Bot." },
      { role: "user", content: "hello" },
    ]);
  });

  test("a truncated answer fails the call rather than completing it", async () => {
    const outcome = await run(frame({ content: "half a sen" }), {
      spent: true,
    });
    expect(outcome.error).toBeInstanceOf(ModelOutcomeUncertainErrorV1);
    expect(outcome.events.some((event) => event.type === "finish")).toBe(false);
    // The Plugin said nothing about it, so the call is the host's to settle:
    // no second dispatch, and the words that arrived are already delivered.
    expect(outcome.events).toContainEqual({
      type: "text-delta",
      text: "half a sen",
    });
  });

  test("a provider that refuses is the provider's failure to state", async () => {
    const outcome = await run("", { spent: true });
    expect(outcome.error).toBeDefined();
    expect(outcome.events.some((event) => event.type === "finish")).toBe(false);
  });
});
