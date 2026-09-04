import { createPlugin } from "@frockbot/compose-core";
import { describe, expect, it } from "bun:test";
import {
  createTool,
  modelKey,
  promptSectionPlugin,
  requestAction,
  toolCallAction,
  toolMiddleware,
  toolsetPlugin,
} from "../src";
import { buildAgent, deferred, kindsOf, watchLoop } from "./helpers/agent";
import { anyValidator, validator } from "./helpers/validator";
import type { ModelProvider, ModelRegistry, ToolOutcome } from "../src";

const wordValidator = validator<unknown, { word: string }>((value) => {
  const word = (value as { word?: unknown } | null)?.word;
  if (typeof word !== "string") {
    return { issues: [{ message: "expected a string", path: ["word"] }] };
  }
  return { value: { word } };
});

/** A second provider, registered into the model registry during turn two. */
const closingProvider: ModelProvider = {
  name: "closing",
  stream: () =>
    (async function* stream() {
      await Promise.resolve();
      yield {
        kind: "text" as const,
        text: "Goodbye from the second provider.",
      };
    })(),
};

describe("G. End to end", () => {
  it("runs a three-turn conversation with tools, middleware, a mid-turn addition and a swap", async () => {
    const ran: Array<string> = [];
    const midTurn = deferred();
    const release = deferred();
    let models: ModelRegistry | undefined = undefined;

    const shout = createTool({
      name: "shout",
      description: "Shout a word",
      validator: wordValidator,
      execute: ({ word }) => {
        ran.push(`shout:${word}`);
        return word.toUpperCase();
      },
    });
    const audit = createTool({
      name: "audit",
      description: "Runs alone, and holds turn one open",
      validator: anyValidator,
      concurrency: "exclusive",
      execute: async () => {
        ran.push("audit");
        midTurn.resolve();
        await release.promise;
        return "audited";
      },
    });
    const secret = createTool({
      name: "secret",
      description: "Never allowed to run",
      validator: anyValidator,
      execute: () => {
        ran.push("secret");
        return "leaked";
      },
    });
    /** Added during turn one; first callable in turn two, where it swaps the provider. */
    const note = createTool({
      name: "note",
      description: "Make a note, and bring a second provider in",
      validator: anyValidator,
      execute: () => {
        ran.push("note");
        models!.register(closingProvider);
        return "noted";
      },
    });

    /** A policy plugin: it refuses one call and rewrites another. */
    const policyPlugin = createPlugin({
      name: "policy",
      setup(instance) {
        const refusal: ToolOutcome = { ok: false, error: "refused by policy" };
        instance.use(toolCallAction, ({ input, next }) =>
          input.call.name === "secret" ? refusal : next(input),
        );
        instance.use(
          toolCallAction,
          toolMiddleware(shout, ({ input, next }) =>
            next({ word: `${input.args.word} there` }),
          ),
        );
      },
    });

    const { client, agent, session } = await buildAgent({
      tools: [shout, audit, secret],
      sections: [{ name: "base", text: "Be helpful." }],
      script: [
        {
          chunks: ["Working", "…"],
          toolCalls: [
            { name: "shout", args: { word: "hello" } },
            { name: "audit", args: {} },
            { name: "secret", args: {} },
          ],
        },
        { chunks: ["Turn one is done."] },
        { toolCalls: [{ name: "note", args: {} }] },
        { chunks: ["Turn two is done."] },
      ],
    });
    models = client.getContext(modelKey);
    await client.addPlugin({ id: "policy", plugin: policyPlugin });

    const steps: Array<{ system: string; tools: Array<string> }> = [];
    client.use(requestAction, ({ input, next }) => {
      steps.push({
        system: input.system,
        tools: input.tools.map((tool) => tool.name),
      });
      return next(input);
    });
    const loop = watchLoop(client);

    // ------------------------------------------------- turn one
    agent.send("say hello");
    await midTurn.promise;

    // A prompt section and a tool, added while turn one is running.
    await client.addPlugin({
      id: "notes",
      plugin: toolsetPlugin,
      options: { tools: [note] },
    });
    await client.addPlugin({
      id: "closing-note",
      plugin: promptSectionPlugin,
      options: { sections: [{ name: "closing", text: "Sign off warmly." }] },
    });

    release.resolve();
    await agent.idle();

    // ------------------------------------------------- turns two and three
    agent.send("make a note");
    await agent.idle();
    expect(models!.current()).toBe(closingProvider);

    agent.send("now say goodbye");
    await agent.idle();

    // The world each step saw: turn one held what it opened with, turn two
    // picked up the section and the tool, turn three kept them.
    expect(steps).toEqual([
      { system: "Be helpful.", tools: ["shout", "audit", "secret"] },
      { system: "Be helpful.", tools: ["shout", "audit", "secret"] },
      {
        system: "Be helpful.\n\nSign off warmly.",
        tools: ["shout", "audit", "secret", "note"],
      },
      {
        system: "Be helpful.\n\nSign off warmly.",
        tools: ["shout", "audit", "secret", "note"],
      },
      {
        system: "Be helpful.\n\nSign off warmly.",
        tools: ["shout", "audit", "secret", "note"],
      },
    ]);

    // Only the calls the policy allowed ran, and the rewrite reached the tool.
    expect(ran).toEqual(["shout:hello there", "audit", "note"]);

    // The session log, all three turns end to end.
    expect(kindsOf(session.snapshot())).toEqual([
      // turn one
      "turn-opened",
      "input",
      "step-opened",
      "chunk",
      "chunk",
      "assistant",
      "tool-call",
      "tool-result",
      "tool-call",
      "tool-result",
      "tool-call",
      "tool-result",
      "step-closed",
      "step-opened",
      "chunk",
      "assistant",
      "step-closed",
      "turn-closed",
      // turn two
      "turn-opened",
      "input",
      "step-opened",
      "assistant",
      "tool-call",
      "tool-result",
      "step-closed",
      "step-opened",
      "chunk",
      "assistant",
      "step-closed",
      "turn-closed",
      // turn three
      "turn-opened",
      "input",
      "step-opened",
      "chunk",
      "assistant",
      "step-closed",
      "turn-closed",
    ]);

    // Results are in the order the model issued the calls, whatever ran when.
    expect(
      session
        .snapshot()
        .filter((entry) => entry.kind === "tool-result")
        .map((entry) => [entry.name, entry.outcome]),
    ).toEqual([
      ["shout", { ok: true, value: "HELLO THERE" }],
      ["audit", { ok: true, value: "audited" }],
      ["secret", { ok: false, error: "refused by policy" }],
      ["note", { ok: true, value: "noted" }],
    ]);

    // The messages derived from that log.
    expect(session.messages()).toEqual([
      { role: "user", content: "say hello" },
      {
        role: "assistant",
        content: "Working…",
        toolCalls: [
          { id: "call-1", name: "shout", args: { word: "hello" } },
          { id: "call-2", name: "audit", args: {} },
          { id: "call-3", name: "secret", args: {} },
        ],
      },
      {
        role: "tool",
        callId: "call-1",
        name: "shout",
        content: "HELLO THERE",
        isError: false,
      },
      {
        role: "tool",
        callId: "call-2",
        name: "audit",
        content: "audited",
        isError: false,
      },
      {
        role: "tool",
        callId: "call-3",
        name: "secret",
        content: "refused by policy",
        isError: true,
      },
      { role: "assistant", content: "Turn one is done.", toolCalls: [] },
      { role: "user", content: "make a note" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-4", name: "note", args: {} }],
      },
      {
        role: "tool",
        callId: "call-4",
        name: "note",
        content: "noted",
        isError: false,
      },
      { role: "assistant", content: "Turn two is done.", toolCalls: [] },
      { role: "user", content: "now say goodbye" },
      {
        role: "assistant",
        content: "Goodbye from the second provider.",
        toolCalls: [],
      },
    ]);

    // Nothing was swallowed on the way, and the loop never restarted.
    expect(client.errors.state).toEqual([]);
    loop.stop();
    expect(loop.statuses).toEqual(["active"]);

    // And the client holds no leaked resources afterwards.
    const ids = client.inspect().map((entry) => entry.id);
    await client.destroy();
    expect(client.inspect()).toEqual([]);
    expect(client.context.state).toEqual([]);
    for (const id of ids) expect(client.resources(id)).toBeUndefined();
  });
});
