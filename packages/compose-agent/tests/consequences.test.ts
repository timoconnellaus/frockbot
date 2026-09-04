import { createPlugin, reconcileAction } from "@frockbot/compose-core";
import { describe, expect, it } from "bun:test";
import {
  promptSectionPlugin,
  requestAction,
  sessionKey,
  sessionPlugin,
} from "../src";
import { deriveMessages } from "../src/session";
import {
  buildComposer,
  clockPlugin,
  clockToolsPlugin,
  greeterPlugin,
  listing,
  resultsOf,
} from "./helpers/composer";

const done = { chunks: ["done"] };

describe("what an edit does to the rest of the agent", () => {
  it("leaves dependents pending with their missing deps named, and restores them in the same turn", async () => {
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

    agent.send("break it and fix it");
    await agent.idle();

    const [off, on] = resultsOf(session);
    const dependent = off?.entries.find((entry) => entry.id === "clock-tools");
    expect(dependent?.status).toBe("pending");
    expect(dependent?.missing).toEqual(["clock"]);
    expect(on?.entries.map((entry) => entry.status)).toEqual(["active"]);
    expect(listing(client)).toContain("clock-tools:active");
    expect(client.errors.state).toEqual([]);
  });

  it("is in the session as a tool call and its result, so a replay shows what changed", async () => {
    const { agent, session } = await buildComposer({
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

    const entries = session.snapshot();
    const call = entries.find((entry) => entry.kind === "tool-call");
    expect(call?.kind === "tool-call" && call.call).toEqual({
      id: "call-1",
      name: "add_from_catalog",
      args: { id: "hello", name: "greeter", options: { label: "Hi" } },
    });

    // The edit and its consequence are both derivable from the log alone.
    const replayed = deriveMessages(entries);
    expect(replayed).toEqual(session.messages());
    const told = replayed.find((message) => message.role === "tool");
    expect(told?.role === "tool" && JSON.parse(told.content)).toMatchObject({
      ok: true,
      entries: [{ id: "hello", plugin: "greeter", status: "active" }],
    });

    // And the same log replayed into a fresh session derives the same messages.
    const { client: fresh } = await buildComposer({ script: [] });
    await fresh.setPluginList([
      { id: "session", plugin: sessionPlugin, options: { entries } },
    ]);
    expect(fresh.getContext(sessionKey)!.messages()).toEqual(replayed);
    await fresh.destroy();
  });

  it("leaves the client as it was when a reconcile fails, and the turn carries on", async () => {
    const veto = createPlugin({
      name: "veto",
      setup(instance) {
        instance.use(reconcileAction, ({ input, next }) => {
          if (input.some((entry) => entry.id === "hello")) {
            throw new Error("the operator vetoed this list");
          }
          return next(input);
        });
      },
    });

    const { client, agent, session } = await buildComposer({
      catalog: { greeter: greeterPlugin },
      plugins: [
        { id: "clock", plugin: clockPlugin },
        { id: "veto", plugin: veto },
      ],
      script: [
        {
          toolCalls: [
            {
              name: "add_from_catalog",
              args: { id: "hello", name: "greeter", options: { label: "Hi" } },
            },
          ],
        },
        // The turn continues: the model tries something else and it works.
        { toolCalls: [{ name: "disable_plugin", args: { id: "clock" } }] },
        done,
      ],
    });

    agent.send("add the greeter");
    await agent.idle();

    const [failed, worked] = resultsOf(session);
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain("the operator vetoed this list");
    expect(worked?.ok).toBe(true);

    expect(client.pluginList.state.some((entry) => entry.id === "hello")).toBe(
      false,
    );
    expect(client.inspect().some((one) => one.id === "hello")).toBe(false);
    expect(client.errors.state.map((report) => report.scope)).toEqual([
      "reconcile",
    ]);
    // The turn closed normally, not with an error.
    expect(
      session.snapshot().filter((entry) => entry.kind === "turn-closed"),
    ).toMatchObject([{ reason: "complete" }]);
  });

  it("offers a plugin it added from the next turn: its tools, its prompt and its context", async () => {
    const steps: Array<{ system: string; tools: Array<string> }> = [];
    const { client, agent, session } = await buildComposer({
      catalog: { greeter: greeterPlugin, notice: promptSectionPlugin },
      script: [
        {
          toolCalls: [
            {
              name: "add_from_catalog",
              args: { id: "hello", name: "greeter", options: { label: "Hi" } },
            },
            {
              name: "add_from_catalog",
              args: {
                id: "notice",
                name: "notice",
                options: { sections: [{ name: "notice", text: "Be brief." }] },
              },
            },
          ],
        },
        done,
        { toolCalls: [{ name: "greet", args: {} }] },
        done,
      ],
    });
    client.use(requestAction, ({ input, next }) => {
      steps.push({
        system: input.system,
        tools: input.tools.map((tool) => tool.name),
      });
      return next(input);
    });

    agent.send("add a greeter and a notice");
    await agent.idle();
    // Turn one ran against the world it opened with.
    expect(steps[0]?.system).not.toContain("Be brief.");
    expect(steps[0]?.tools).not.toContain("greet");
    expect(steps[1]?.tools).not.toContain("greet");

    agent.send("now greet me");
    await agent.idle();
    // Turn two opened against the world the edits left behind.
    expect(steps[2]?.system).toContain("Be brief.");
    expect(steps[2]?.tools).toContain("greet");

    const greeting = session
      .snapshot()
      .find((entry) => entry.kind === "tool-result" && entry.name === "greet");
    expect(greeting?.kind === "tool-result" && greeting.outcome).toEqual({
      ok: true,
      value: "Hi, hello",
    });
  });
});
