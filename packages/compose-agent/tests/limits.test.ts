import { describe, expect, it } from "bun:test";
import { toolsKey } from "../src";
import {
  buildComposer,
  clockPlugin,
  greeterPlugin,
  listing,
  resultsOf,
} from "./helpers/composer";

const done = { chunks: ["done"] };

describe("what the composer will not do", () => {
  it("refuses to disable, reconfigure or remove a protected entry", async () => {
    const { client, agent, session } = await buildComposer({
      script: [
        { toolCalls: [{ name: "disable_plugin", args: { id: "loop" } }] },
        {
          toolCalls: [
            {
              name: "configure_plugin",
              args: { id: "tools", options: { tools: [] } },
            },
          ],
        },
        { toolCalls: [{ name: "remove_plugin", args: { id: "session" } }] },
        done,
      ],
    });
    const before = listing(client);

    agent.send("take yourself apart");
    await agent.idle();

    const results = resultsOf(session);
    expect(results.map((result) => result.ok)).toEqual([false, false, false]);
    expect(results[0]?.error).toBe(
      'the entry "loop" is protected and cannot be changed',
    );
    expect(results[1]?.error).toContain('"tools" is protected');
    expect(results[2]?.error).toContain('"session" is protected');
    for (const result of results) {
      expect(result.entries[0]?.protected).toBe(true);
    }
    // Nothing moved.
    expect(listing(client)).toEqual(before);
  });

  it("protects its own entry, whatever the operator listed", async () => {
    const { client, agent, session } = await buildComposer({
      protected: [],
      script: [
        { toolCalls: [{ name: "disable_plugin", args: { id: "composer" } }] },
        { toolCalls: [{ name: "remove_plugin", args: { id: "composer" } }] },
        done,
      ],
    });

    agent.send("stop being able to edit yourself");
    await agent.idle();

    const results = resultsOf(session);
    expect(results.map((result) => result.error)).toEqual([
      'the entry "composer" is protected and cannot be changed',
      'the entry "composer" is protected and cannot be removed',
    ]);
    expect(listing(client)).toContain("composer:active");
    // And the tools it registered are all still there.
    expect(
      client
        .getContext(toolsKey)!
        .list()
        .map((tool) => tool.name),
    ).toContain("disable_plugin");
  });

  it("adds only what the catalog offers, and only with options that validate", async () => {
    const { client, agent, session } = await buildComposer({
      catalog: { greeter: greeterPlugin },
      script: [
        {
          toolCalls: [
            { name: "add_from_catalog", args: { id: "x", name: "mystery" } },
          ],
        },
        {
          toolCalls: [
            {
              name: "add_from_catalog",
              args: { id: "x", name: "greeter", options: { label: 7 } },
            },
          ],
        },
        done,
      ],
    });
    const before = listing(client);

    agent.send("add whatever you like");
    await agent.idle();

    const [unknown, invalid] = resultsOf(session);
    expect(unknown?.ok).toBe(false);
    expect(unknown?.error).toBe(
      'there is no plugin named "mystery" in the catalog; it offers greeter',
    );
    expect(unknown?.catalog).toEqual(["greeter"]);

    expect(invalid?.ok).toBe(false);
    expect(invalid?.error).toBe(
      'invalid options for "greeter" — label: expected a string',
    );

    expect(listing(client)).toEqual(before);
  });

  it("refuses options that the entry's own validator rejects", async () => {
    const { client, agent, session } = await buildComposer({
      plugins: [{ id: "clock", plugin: clockPlugin, options: { start: 1 } }],
      script: [
        {
          toolCalls: [
            {
              name: "configure_plugin",
              args: { id: "clock", options: { start: "soon" } },
            },
          ],
        },
        done,
      ],
    });

    agent.send("set the clock to soon");
    await agent.idle();

    const [result] = resultsOf(session);
    expect(result?.ok).toBe(false);
    expect(result?.error).toBe(
      'invalid options for "clock" — start: expected a number',
    );
    expect(
      client.pluginList.state.find((one) => one.id === "clock")?.options,
    ).toEqual({ start: 1 });
  });

  it("offers the model no tool that changes the catalog, the protection, the stubs or the host", async () => {
    const { client } = await buildComposer({
      catalog: { greeter: greeterPlugin },
      script: [],
    });

    // The whole surface the model can call. Everything else about how the
    // composer runs is the operator's, decided in the assembly.
    expect(
      client
        .getContext(toolsKey)!
        .list()
        .map((tool) => tool.name),
    ).toEqual([
      "list_plugins",
      "enable_plugin",
      "disable_plugin",
      "configure_plugin",
      "add_from_catalog",
      "read_plugin",
      "write_plugin",
      "rewrite_plugin",
      "remove_plugin",
      "select_model",
    ]);
  });

  it("leaves the composer in error when the operator's own options are wrong", async () => {
    const { client } = await buildComposer({
      script: [],
      composerOptions: { catalog: { broken: { name: "not a plugin" } } },
    });

    const composer = client.inspect().find((one) => one.id === "composer");
    expect(composer?.status).toBe("error");
    expect(String((composer?.error as Error).message)).toContain(
      "options.catalog.broken: expected a plugin created by createPlugin",
    );
  });
});
