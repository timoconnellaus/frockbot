import { createClient } from "@frockbot/compose-core";
import { describe, expect, it, mock } from "bun:test";
import {
  agentKey,
  createTool,
  loopPlugin,
  modelsPlugin,
  promptKey,
  promptPlugin,
  promptSectionPlugin,
  requestAction,
  scriptedModelPlugin,
  sessionKey,
  sessionPlugin,
  toolsKey,
  toolsPlugin,
  toolsetPlugin,
} from "../src";
import { buildAgent, deferred, watchLoop } from "./helpers/agent";
import { lookupPlugin, lookupTool } from "./helpers/other-package";
import { anyValidator } from "./helpers/validator";

describe("A. Everything is a plugin", () => {
  it("every part of the agent is a plugin that can be removed and replaced mid-conversation", async () => {
    for (const plugin of [
      sessionPlugin,
      toolsPlugin,
      promptPlugin,
      modelsPlugin,
      scriptedModelPlugin,
      loopPlugin,
    ]) {
      expect(plugin.type).toBe("compose/plugin");
    }

    const running = deferred();
    const released = deferred();
    const wait = createTool({
      name: "wait",
      description: "Hold the turn open",
      validator: anyValidator,
      execute: async () => {
        running.resolve();
        await released.promise;
        return "held";
      },
    });
    const extra = createTool({
      name: "extra",
      description: "Added while a conversation is open",
      validator: anyValidator,
      execute: () => "extra ran",
    });

    const { client, agent, session } = await buildAgent({
      tools: [wait],
      sections: [{ name: "base", text: "Before." }],
      script: [
        { toolCalls: [{ name: "wait", args: {} }] },
        { chunks: ["turn one is done"] },
        { toolCalls: [{ name: "extra", args: {} }] },
        { chunks: ["turn two is done"] },
      ],
    });
    const requests: Array<{ system: string; tools: Array<string> }> = [];
    client.use(requestAction, ({ input, next }) => {
      requests.push({
        system: input.system,
        tools: input.tools.map((tool) => tool.name),
      });
      return next(input);
    });
    const loop = watchLoop(client);

    agent.send("go");
    await running.promise;

    // Contributions added while the turn is running: neither disturbs the loop.
    await client.addPlugin({
      id: "extra-tools",
      plugin: toolsetPlugin,
      options: { tools: [extra] },
    });
    await client.addPlugin({
      id: "extra-prompt",
      plugin: promptSectionPlugin,
      options: { sections: [{ name: "added", text: "Added." }] },
    });

    released.resolve();
    await agent.idle();

    // Turn one ran against the world it opened with; turn two picks the rest up.
    agent.send("again");
    await agent.idle();
    expect(requests).toEqual([
      { system: "Before.", tools: ["wait"] },
      { system: "Before.", tools: ["wait"] },
      { system: "Before.\n\nAdded.", tools: ["wait", "extra"] },
      { system: "Before.\n\nAdded.", tools: ["wait", "extra"] },
    ]);
    expect(session.snapshot().at(-1)).toMatchObject({
      kind: "turn-closed",
      reason: "complete",
    });
    // Adding contributions never restarted the loop.
    loop.stop();
    expect(loop.statuses).toEqual(["active"]);

    // Removing an entry takes its contribution away again.
    await client.removePlugin("extra-tools");
    await client.removePlugin("extra-prompt");
    expect(
      client
        .getContext(toolsKey)!
        .list()
        .map((tool) => tool.name),
    ).toEqual(["wait"]);
    expect(client.getContext(promptKey)!.assemble()).toBe("Before.");

    // A registry itself can be reconfigured. Because the loop depends on the
    // key, that does restart the loop — with a fresh agent handle.
    const before = client.getContext(agentKey);
    await client.setOptions("prompt", {
      sections: [{ name: "base", text: "After." }],
    });
    expect(client.getContext(agentKey)).not.toBe(before);
    expect(client.getContext(promptKey)!.assemble()).toBe("After.");
    expect(client.inspect().every((entry) => entry.status === "active")).toBe(
      true,
    );

    // And every part can be removed outright, leaving nothing behind.
    await client.setPluginList([]);
    expect(client.inspect()).toEqual([]);
    expect(client.getContext(agentKey)).toBeUndefined();
    expect(client.getContext(sessionKey)).toBeUndefined();

    await client.destroy();
  });

  it("a consumer declares the keys it needs and never imports a provider", async () => {
    // `lookupPlugin` is written as if it lived in another package: it declares
    // `toolsKey` as a dep and imports no provider at all.
    expect(lookupPlugin.deps).toEqual([toolsKey]);
    expect(lookupPlugin.provides).toEqual([]);

    const client = createClient({
      plugins: [
        { id: "session", plugin: sessionPlugin },
        { id: "tools", plugin: toolsPlugin },
        { id: "prompt", plugin: promptPlugin },
        { id: "models", plugin: modelsPlugin },
        {
          id: "model",
          plugin: scriptedModelPlugin,
          options: {
            script: [
              { toolCalls: [{ name: "lookup", args: { query: "cats" } }] },
              { chunks: ["four"] },
            ],
          },
        },
        { id: "loop", plugin: loopPlugin },
        { id: "consumer", plugin: lookupPlugin },
      ],
    });
    await client.settled();
    expect(client.getContext(toolsKey)!.get("lookup")).toBe(lookupTool);

    const agent = client.getContext(agentKey)!;
    agent.send("find cats");
    await agent.idle();
    expect(client.getContext(sessionKey)!.messages().at(-2)).toMatchObject({
      role: "tool",
      name: "lookup",
      content: '{"found":4}',
    });

    // Unloading the consumer takes its tool with it.
    await client.removePlugin("consumer");
    expect(client.getContext(toolsKey)!.list()).toEqual([]);

    await client.destroy();
  });

  it("a conversation runs on the package's plugins and a scripted model, with no network", async () => {
    const fetchSpy = mock();
    const original = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const { client, agent, session } = await buildAgent({
        tools: [lookupTool],
        sections: [{ name: "base", text: "Be helpful." }],
        script: [
          { toolCalls: [{ name: "lookup", args: { query: "cats" } }] },
          { chunks: ["Four letters."] },
        ],
      });

      // Six entries: session, tools, prompt, models, the provider, loop.
      expect(client.pluginList.state.map((entry) => entry.id)).toEqual([
        "session",
        "tools",
        "prompt",
        "models",
        "model",
        "loop",
      ]);

      agent.send("find cats");
      await agent.idle();

      expect(session.messages().at(-1)).toEqual({
        role: "assistant",
        content: "Four letters.",
        toolCalls: [],
      });
      expect(fetchSpy).not.toHaveBeenCalled();

      await client.destroy();
    } finally {
      globalThis.fetch = original;
    }
  });
});
