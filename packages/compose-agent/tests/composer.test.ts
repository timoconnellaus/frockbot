import { createPlugin, reconcileAction } from "@frockbot/compose-core";
import { jsonSchemaValidator } from "@frockbot/compose-tools";
import { describe, expect, it } from "bun:test";
import { promptKey, scriptedModelPlugin, toolCallAction } from "../src";
import {
  buildComposer,
  clockPlugin,
  clockToolsPlugin,
  greeterPlugin,
  listing,
  resultOf,
  resultsOf,
} from "./helpers/composer";
import type { ComposerResult } from "@frockbot/compose-tools";
import type { ToolOutcome } from "../src";

const done = { chunks: ["done"] };

describe("the composer's tools", () => {
  it("lists every entry with its status, and names what a pending entry is missing", async () => {
    const { agent, session } = await buildComposer({
      plugins: [{ id: "clock-tools", plugin: clockToolsPlugin }],
      script: [{ toolCalls: [{ name: "list_plugins", args: {} }] }, done],
    });

    agent.send("what are you running?");
    await agent.idle();

    const result = resultOf(session)!;
    expect(result.ok).toBe(true);
    expect(
      result.entries.map((entry) => `${entry.id}:${entry.status}`),
    ).toEqual([
      "session:active",
      "tools:active",
      "prompt:active",
      "models:active",
      "model:active",
      "loop:active",
      "clock-tools:pending",
      "composer:active",
    ]);
    expect(result.entries.find((entry) => entry.id === "clock-tools")).toEqual({
      id: "clock-tools",
      plugin: "clock-tools",
      kind: "plugin",
      enabled: true,
      protected: false,
      status: "pending",
      missing: ["clock"],
    });
    expect(result.entries.find((entry) => entry.id === "loop")?.protected).toBe(
      true,
    );
    expect(result.catalog).toEqual([]);
  });

  it("disables an entry and enables it again, both in one turn", async () => {
    const { client, agent, session } = await buildComposer({
      plugins: [
        { id: "clock", plugin: clockPlugin },
        { id: "clock-tools", plugin: clockToolsPlugin },
      ],
      script: [
        { toolCalls: [{ name: "disable_plugin", args: { id: "clock" } }] },
        { toolCalls: [{ name: "enable_plugin", args: { id: "clock" } }] },
        done,
      ],
    });

    agent.send("turn the clock off and on again");
    await agent.idle();

    const [disabled, enabled] = resultsOf(session);
    expect(disabled?.ok).toBe(true);
    expect(disabled?.message).toContain("now disabled");
    expect(
      disabled?.entries.map((entry) => `${entry.id}:${entry.status}`),
    ).toEqual(["clock:disabled", "clock-tools:pending"]);
    expect(disabled?.effect).toContain("next turn");

    expect(enabled?.ok).toBe(true);
    expect(
      enabled?.entries.map((entry) => `${entry.id}:${entry.status}`),
    ).toEqual(["clock:active"]);

    expect(listing(client)).toEqual([
      "session:active",
      "tools:active",
      "prompt:active",
      "models:active",
      "model:active",
      "loop:active",
      "clock:active",
      "clock-tools:active",
      "composer:active",
    ]);
  });

  it("sets an entry's options, and the instance restarts with them", async () => {
    const { agent, session } = await buildComposer({
      plugins: [
        { id: "clock", plugin: clockPlugin, options: { start: 0 } },
        { id: "clock-tools", plugin: clockToolsPlugin },
      ],
      script: [
        {
          toolCalls: [
            {
              name: "configure_plugin",
              args: { id: "clock", options: { start: 100 } },
            },
          ],
        },
        done,
        { toolCalls: [{ name: "read_clock", args: {} }] },
        done,
      ],
    });

    agent.send("start the clock at a hundred");
    await agent.idle();
    expect(resultOf(session)?.ok).toBe(true);

    agent.send("what time is it?");
    await agent.idle();

    const reading = session
      .snapshot()
      .find(
        (entry) => entry.kind === "tool-result" && entry.name === "read_clock",
      );
    expect(reading?.kind === "tool-result" && reading.outcome).toEqual({
      ok: true,
      value: 101,
    });
  });

  it("shows what options an entry has and what its plugin takes", async () => {
    const described = createPlugin({
      name: "banner",
      validator: jsonSchemaValidator<{ text: string }>({
        type: "object",
        properties: { text: { type: "string" } },
        required: ["text"],
      }),
      setup() {},
    });
    const { agent, session } = await buildComposer({
      plugins: [{ id: "banner", plugin: described, options: { text: "hi" } }],
      catalog: { banner: described },
      script: [{ toolCalls: [{ name: "list_plugins", args: {} }] }, done],
    });

    agent.send("what are you running?");
    await agent.idle();

    const result = resultOf(session)!;
    const row = result.entries.find((entry) => entry.id === "banner")!;
    expect(row.options).toEqual({ text: "hi" });
    expect(row.optionsSchema?.properties?.text).toEqual({ type: "string" });
    expect(result.catalogOptions?.banner).toBe(row.optionsSchema);
  });

  it("tells the model how the plugin list works, with the protected ids and catalog live", async () => {
    const { client } = await buildComposer({
      catalog: { greeter: greeterPlugin },
      protected: ["loop"],
      script: [done],
    });

    const text = client.getContext(promptKey)!.assemble();
    expect(text).toContain("plugin list");
    expect(text).toContain("Protected entries");
    expect(text).toContain("loop");
    expect(text).toContain("The catalog offers: greeter.");
    expect(text).toContain("from the next turn");
  });

  it("refuses options for a plugin that declares none", async () => {
    const { agent, session } = await buildComposer({
      plugins: [{ id: "clock-tools", plugin: clockToolsPlugin }],
      script: [
        {
          toolCalls: [
            {
              name: "configure_plugin",
              args: { id: "clock-tools", options: { text: "OK ALREADY!" } },
            },
          ],
        },
        done,
      ],
    });

    agent.send("change the text");
    await agent.idle();

    const result = resultOf(session)!;
    expect(result.ok).toBe(false);
    expect(result.message).toContain("declares no options");
  });

  it("adds a plugin from the catalog by name, with its options validated", async () => {
    const { client, agent, session } = await buildComposer({
      catalog: { greeter: greeterPlugin },
      script: [
        {
          toolCalls: [
            {
              name: "add_from_catalog",
              args: { id: "hello", name: "greeter", options: { label: "Hi" } },
            },
          ],
        },
        done,
      ],
    });

    agent.send("add the greeter");
    await agent.idle();

    const result = resultOf(session)!;
    expect(result.ok).toBe(true);
    expect(result.entries).toEqual([
      {
        id: "hello",
        plugin: "greeter",
        kind: "plugin",
        enabled: true,
        protected: false,
        status: "active",
        options: { label: "Hi" },
      },
    ]);
    expect(client.pluginList.state.at(-1)?.id).toBe("hello");
  });

  it("removes an entry it added, leaving nothing behind", async () => {
    const { client, agent, session } = await buildComposer({
      catalog: { greeter: greeterPlugin },
      script: [
        {
          toolCalls: [
            {
              name: "add_from_catalog",
              args: { id: "hello", name: "greeter", options: { label: "Hi" } },
            },
          ],
        },
        { toolCalls: [{ name: "remove_plugin", args: { id: "hello" } }] },
        done,
      ],
    });

    agent.send("add the greeter and take it away again");
    await agent.idle();

    const [, removed] = resultsOf(session);
    expect(removed?.ok).toBe(true);
    expect(removed?.entries).toEqual([
      {
        id: "hello",
        plugin: "removed",
        kind: "plugin",
        enabled: false,
        protected: false,
        status: "removed",
      },
    ]);
    expect(client.pluginList.state.some((entry) => entry.id === "hello")).toBe(
      false,
    );
    expect(client.resources("hello")).toBeUndefined();
  });

  it("changes what runs only by writing the plugin list", async () => {
    const applied: Array<Array<string>> = [];
    const { client, agent, session } = await buildComposer({
      catalog: { greeter: greeterPlugin },
      plugins: [{ id: "clock", plugin: clockPlugin }],
      script: [
        { toolCalls: [{ name: "disable_plugin", args: { id: "clock" } }] },
        {
          toolCalls: [
            {
              name: "add_from_catalog",
              args: { id: "hello", name: "greeter", options: { label: "Hi" } },
            },
          ],
        },
        { toolCalls: [{ name: "remove_plugin", args: { id: "hello" } }] },
        done,
      ],
    });
    client.use(reconcileAction, ({ input, next }) => {
      applied.push(input.map((entry) => entry.id));
      return next(input);
    });

    agent.send("rearrange yourself");
    await agent.idle();

    expect(resultsOf(session).every((result) => result.ok)).toBe(true);
    // Three edits, three reconciles, and the last one is what runs.
    expect(applied).toHaveLength(3);
    expect(applied.at(-1)).toEqual(
      client.pluginList.state.map((one) => one.id),
    );
  });

  it("is an ordinary tool, so middleware can refuse an edit", async () => {
    const policy = createPlugin({
      name: "policy",
      setup(instance) {
        const refusal: ToolOutcome = {
          ok: false,
          error: "the operator does not allow disabling anything",
        };
        instance.use(toolCallAction, ({ input, next }) =>
          input.call.name === "disable_plugin" ? refusal : next(input),
        );
      },
    });

    const { client, agent, session } = await buildComposer({
      plugins: [
        { id: "clock", plugin: clockPlugin },
        { id: "policy", plugin: policy },
      ],
      script: [
        { toolCalls: [{ name: "disable_plugin", args: { id: "clock" } }] },
        done,
      ],
    });

    agent.send("turn the clock off");
    await agent.idle();

    const outcome = session
      .snapshot()
      .find((entry) => entry.kind === "tool-result");
    expect(outcome?.kind === "tool-result" && outcome.outcome).toEqual({
      ok: false,
      error: "the operator does not allow disabling anything",
    });
    expect(listing(client)).toContain("clock:active");
  });

  it("selects a model provider at runtime, without a plugin-list edit", async () => {
    const applied: Array<unknown> = [];
    const { client, agent, session } = await buildComposer({
      select: "scripted",
      script: [
        { toolCalls: [{ name: "select_model", args: { name: "b" } }] },
        { chunks: ["the first model, signing off"] },
      ],
      plugins: [
        {
          id: "model-b",
          plugin: scriptedModelPlugin,
          options: { name: "b", script: [{ chunks: ["hello from b"] }] },
        },
      ],
    });
    client.use(reconcileAction, ({ input, next }) => {
      applied.push(input);
      return next(input);
    });

    agent.send("use the other model");
    await agent.idle();

    const result = resultOf(session)! as ComposerResult & {
      providers: Array<string>;
      selected: string;
    };
    expect(result.ok).toBe(true);
    expect(result.providers).toEqual(["scripted", "b"]);
    expect(result.selected).toBe("b");
    expect(result.effect).toContain("nothing restarts");
    // Not a plugin-list edit: nothing reconciled, and nothing restarted.
    expect(applied).toEqual([]);

    agent.send("and now?");
    await agent.idle();
    expect(session.messages().at(-1)).toEqual({
      role: "assistant",
      content: "hello from b",
      toolCalls: [],
    });
  });
});
