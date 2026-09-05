import { createClient, createPlugin } from "@frockbot/compose-core";
import { describe, expect, it } from "bun:test";
import {
  agentKey,
  createTool,
  loopPlugin,
  modelKey,
  modelsPlugin,
  promptPlugin,
  scriptedModelPlugin,
  sessionKey,
  sessionPlugin,
  toolsPlugin,
} from "../src";
import { buildAgent, deferred, kindsOf, watchLoop } from "./helpers/agent";
import { anyValidator } from "./helpers/validator";
import type { ModelChunk, ModelProvider } from "../src";

/** A provider that streams two pieces with a gate the test opens by hand. */
const gatedModel = (gate: Promise<void>, onFirst: () => void) =>
  createPlugin({
    name: "gated-model",
    deps: [modelKey],
    setup(instance) {
      const provider: ModelProvider = {
        name: "gated",
        stream: () =>
          (async function* stream(): AsyncGenerator<ModelChunk> {
            yield { kind: "text", text: "A" };
            onFirst();
            await gate;
            yield { kind: "text", text: "B" };
          })(),
      };
      instance.cleanup(instance.context.get(modelKey).register(provider));
    },
  });

describe("E. Model providers", () => {
  it("chunks are appended as they stream and the assistant message is appended when it ends", async () => {
    const gate = deferred();
    const first = deferred();

    const client = createClient({
      plugins: [
        { id: "session", plugin: sessionPlugin },
        { id: "tools", plugin: toolsPlugin },
        { id: "prompt", plugin: promptPlugin },
        { id: "models", plugin: modelsPlugin },
        { id: "model", plugin: gatedModel(gate.promise, first.resolve) },
        { id: "loop", plugin: loopPlugin },
      ],
    });
    await client.settled();
    const agent = client.getContext(agentKey)!;
    const session = client.getContext(sessionKey)!;

    agent.send("stream please");
    await first.promise;

    // Mid-stream: the first chunk is already in the log, the message is not.
    expect(kindsOf(session.snapshot())).toEqual([
      "turn-opened",
      "input",
      "step-opened",
      "chunk",
    ]);

    gate.resolve();
    await agent.idle();
    expect(session.snapshot().at(-3)).toMatchObject({
      kind: "assistant",
      text: "AB",
    });
    await client.destroy();

    // A stream that fails still leaves the complete message behind.
    const failing = await buildAgent({
      script: [{ chunks: ["half"], error: "the stream broke" }],
    });
    failing.agent.send("go");
    await failing.agent.idle();
    expect(
      failing.session.snapshot().find((entry) => entry.kind === "assistant"),
    ).toMatchObject({ text: "half" });
    await failing.client.destroy();

    // And so does a stream that is cancelled.
    const running = deferred();
    const hang = createTool({
      name: "hang",
      description: "Never finishes on its own",
      validator: anyValidator,
      execute: () => {
        running.resolve();
        return new Promise<string>(() => {});
      },
    });
    const cancelled = await buildAgent({
      tools: [hang],
      script: [
        { chunks: ["said this much"], toolCalls: [{ name: "hang", args: {} }] },
      ],
    });
    cancelled.agent.send("go");
    await running.promise;
    await cancelled.agent.cancel();
    expect(
      cancelled.session.snapshot().find((entry) => entry.kind === "assistant"),
    ).toMatchObject({ text: "said this much" });
    await cancelled.client.destroy();
  });

  it("the registry chooses the provider at turn open, and one removed mid-turn ends the step", async () => {
    const released = deferred();
    const running = deferred();
    const wait = createTool({
      name: "wait",
      description: "Hold the turn open between steps",
      validator: anyValidator,
      execute: async () => {
        running.resolve();
        await released.promise;
        return "held";
      },
    });

    const client = createClient({
      plugins: [
        { id: "session", plugin: sessionPlugin },
        { id: "tools", plugin: toolsPlugin, options: { tools: [wait] } },
        { id: "prompt", plugin: promptPlugin },
        { id: "models", plugin: modelsPlugin },
        {
          id: "first",
          plugin: scriptedModelPlugin,
          options: {
            name: "first",
            script: [
              { toolCalls: [{ name: "wait", args: {} }] },
              { chunks: ["still the first provider"] },
            ],
          },
        },
        { id: "loop", plugin: loopPlugin },
      ],
    });
    await client.settled();
    const agent = client.getContext(agentKey)!;
    const session = client.getContext(sessionKey)!;
    const models = client.getContext(modelKey)!;
    const loop = watchLoop(client);

    expect(models.list().map((provider) => provider.name)).toEqual(["first"]);
    expect(models.current()!.name).toBe("first");

    agent.send("go");
    await running.promise;

    // A second provider joins mid-turn. It becomes current at once — the most
    // recently registered one wins — but this turn keeps the one it opened with.
    await client.addPlugin({
      id: "second",
      plugin: scriptedModelPlugin,
      options: {
        name: "second",
        script: [{ chunks: ["answered by the second provider"] }],
      },
    });
    expect(models.list().map((provider) => provider.name)).toEqual([
      "first",
      "second",
    ]);
    expect(models.current()!.name).toBe("second");

    released.resolve();
    await agent.idle();
    expect(session.messages().at(-1)).toEqual({
      role: "assistant",
      content: "still the first provider",
      toolCalls: [],
    });

    // The next turn uses the current provider, with nothing else restarting.
    agent.send("again");
    await agent.idle();
    expect(session.messages().at(-1)).toEqual({
      role: "assistant",
      content: "answered by the second provider",
      toolCalls: [],
    });

    // Selecting by name overrides the default, and takes effect the same way.
    models.select("first");
    expect(models.current()!.name).toBe("first");
    models.select(undefined);
    expect(models.current()!.name).toBe("second");

    loop.stop();
    expect(loop.statuses).toEqual(["active"]);
    await client.destroy();

    // A provider unregistered while its turn is running ends the step with an
    // error, and the turn closes; the next turn uses whatever is current.
    const dropping = deferred();
    const hold = createTool({
      name: "hold",
      description: "Hold the turn open between steps",
      validator: anyValidator,
      execute: async () => {
        dropping.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
        return "held";
      },
    });

    const second = createClient({
      plugins: [
        { id: "session", plugin: sessionPlugin },
        { id: "tools", plugin: toolsPlugin, options: { tools: [hold] } },
        { id: "prompt", plugin: promptPlugin },
        { id: "models", plugin: modelsPlugin },
        {
          id: "doomed",
          plugin: scriptedModelPlugin,
          options: {
            name: "doomed",
            script: [
              { toolCalls: [{ name: "hold", args: {} }] },
              { chunks: ["never reached"] },
            ],
          },
        },
        {
          id: "survivor",
          plugin: scriptedModelPlugin,
          options: {
            name: "survivor",
            script: [{ chunks: ["the next turn carried on"] }],
          },
        },
        { id: "loop", plugin: loopPlugin },
      ],
    });
    await second.settled();
    const secondAgent = second.getContext(agentKey)!;
    const secondSession = second.getContext(sessionKey)!;
    const secondLoop = watchLoop(second);

    // `survivor` registered last, so select the one about to be removed.
    second.getContext(modelKey)!.select("doomed");
    secondAgent.send("go");
    await dropping.promise;
    await second.removePlugin("doomed");
    await secondAgent.idle();

    expect(secondSession.snapshot().at(-3)).toMatchObject({
      kind: "error",
      scope: "model",
      message:
        'the model provider "doomed" was unregistered while the turn was running',
    });
    expect(secondSession.snapshot().at(-1)).toMatchObject({
      kind: "turn-closed",
      reason: "error",
    });

    secondAgent.send("again");
    await secondAgent.idle();
    expect(secondSession.messages().at(-1)).toEqual({
      role: "assistant",
      content: "the next turn carried on",
      toolCalls: [],
    });

    secondLoop.stop();
    expect(secondLoop.statuses).toEqual(["active"]);
    await second.destroy();
  });

  it("the scripted provider replays responses, tool calls and mid-stream failures", async () => {
    const echo = createTool({
      name: "echo",
      description: "Echo",
      validator: anyValidator,
      execute: () => "echoed",
    });

    const { client, agent, session } = await buildAgent({
      tools: [echo],
      script: [
        {
          chunks: ["one", " two"],
          toolCalls: [{ id: "named", name: "echo", args: { a: 1 } }],
        },
        { chunks: ["before the break"], error: "the stream broke" },
      ],
    });

    agent.send("go");
    await agent.idle();

    expect(session.messages()).toEqual([
      { role: "user", content: "go" },
      {
        role: "assistant",
        content: "one two",
        toolCalls: [{ id: "named", name: "echo", args: { a: 1 } }],
      },
      {
        role: "tool",
        callId: "named",
        name: "echo",
        content: "echoed",
        isError: false,
      },
      { role: "assistant", content: "before the break", toolCalls: [] },
    ]);
    expect(
      session.snapshot().filter((entry) => entry.kind === "error"),
    ).toMatchObject([{ scope: "model", message: "the stream broke" }]);

    // Running past the end of the script is a model error, not a silent repeat.
    agent.send("again");
    await agent.idle();
    expect(
      session
        .snapshot()
        .filter((entry) => entry.kind === "error")
        .at(-1),
    ).toMatchObject({
      scope: "model",
      message: expect.stringContaining("no response for request 3"),
    });

    await client.destroy();
  });
});
