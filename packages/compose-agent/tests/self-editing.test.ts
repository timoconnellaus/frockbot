import { describe, expect, it } from "bun:test";
import { watchLoop } from "./helpers/agent";
import {
  buildComposer,
  clockPlugin,
  clockToolsPlugin,
  greeterPlugin,
  listing,
  markerChecker,
  resultsOf,
} from "./helpers/composer";
import type { SessionEntry } from "../src";

/** The plugin the model ends up with, written in TypeScript the checker strips. */
const working = `
export default async function ({ stubs }) {
  await stubs.tools({
    name: 'add_up',
    description: 'Add two numbers',
    parameters: {
      type: 'object',
      properties: { a: { type: 'number' }, b: { type: 'number' } },
      required: ['a', 'b'],
    },
    handler: 'addUp',
  })
}

export function addUp({ a, b }) {
  const total: number = a + b
  return total
}
`.trim();

/** The model's first attempt: it does not type-check. */
const notTyped = `
export default async function ({ stubs }) {
  const name = NOPE
  await stubs.tools({ name, description: 'Add two numbers', handler: 'addUp' })
}
`.trim();

/** Its second attempt: it checks, and then throws on the way up. */
const throwsOnSetup = `
export default async function ({ stubs }) {
  const limit: number = 1
  throw new Error('I have not written the handler yet')
}
`.trim();

/** What the model said, what it called, and what it was told, in order. */
const trace = (entries: ReadonlyArray<SessionEntry>): Array<string> =>
  entries.map((entry) => {
    if (entry.kind === "tool-call") return `call ${entry.call.name}`;
    if (entry.kind === "tool-result") {
      return `result ${entry.name} ${entry.outcome.ok ? "ok" : "error"}`;
    }
    return entry.kind;
  });

describe("an agent editing itself end to end", () => {
  it("lists, disables, re-enables, adds, writes, corrects, uses and removes its own plugins", async () => {
    const { client, agent, session } = await buildComposer({
      checker: markerChecker,
      catalog: { greeter: greeterPlugin },
      plugins: [
        { id: "clock", plugin: clockPlugin, options: { start: 0 } },
        { id: "clock-tools", plugin: clockToolsPlugin },
      ],
      script: [
        // ---------------------------------------------------------- turn one
        { toolCalls: [{ name: "list_plugins", args: {} }] },
        { toolCalls: [{ name: "disable_plugin", args: { id: "clock" } }] },
        { toolCalls: [{ name: "enable_plugin", args: { id: "clock" } }] },
        {
          toolCalls: [
            {
              name: "add_from_catalog",
              args: {
                id: "greeter",
                name: "greeter",
                options: { label: "Hello" },
              },
            },
          ],
        },
        { chunks: ["I have a greeter now."] },
        // ---------------------------------------------------------- turn two
        { toolCalls: [{ name: "greet", args: {} }] },
        {
          toolCalls: [
            { name: "write_plugin", args: { id: "adder", source: notTyped } },
          ],
        },
        {
          toolCalls: [
            {
              name: "write_plugin",
              args: { id: "adder", source: throwsOnSetup },
            },
          ],
        },
        { toolCalls: [{ name: "read_plugin", args: { id: "adder" } }] },
        {
          toolCalls: [
            { name: "rewrite_plugin", args: { id: "adder", source: working } },
          ],
        },
        { chunks: ["The adder works now."] },
        // -------------------------------------------------------- turn three
        { toolCalls: [{ name: "add_up", args: { a: 2, b: 3 } }] },
        { toolCalls: [{ name: "disable_plugin", args: { id: "loop" } }] },
        { toolCalls: [{ name: "remove_plugin", args: { id: "adder" } }] },
        { chunks: ["Tidied up."] },
      ],
    });
    const loop = watchLoop(client);

    agent.send("show me what you are, then give yourself a greeter");
    await agent.idle();
    agent.send("greet me, then write yourself an adder");
    await agent.idle();
    agent.send("add two and three, then put yourself back");
    await agent.idle();

    // ------------------------------------------------- what the model was told
    const results = resultsOf(session);
    expect(
      results.map((result) => `${result.message} — ${result.ok ? "ok" : "no"}`),
    ).toEqual([
      "The plugin list, as it runs now. — ok",
      'the entry "clock" is now disabled — ok',
      'the entry "clock" is now enabled — ok',
      'added "greeter" from the catalog as the entry "greeter" — ok',
      "2:3 Cannot find name 'NOPE'. — no",
      'the source of "adder" did not start — no',
      'the source of "adder", as it runs now — ok',
      'rewrote the entry "adder" — ok',
      'the entry "loop" is protected and cannot be changed — no',
      'removed the entry "adder" — ok',
    ]);

    // Listing it showed everything, including what was not yet running.
    expect(results[0]?.entries.map((entry) => entry.id)).toEqual(
      client.pluginList.state
        .map((entry) => entry.id)
        .filter((id) => id !== "adder" && id !== "greeter"),
    );

    // Disabling the clock left its dependent pending, and named what it wanted.
    expect(
      results[1]?.entries.map((entry) => `${entry.id}:${entry.status}`),
    ).toEqual(["clock:disabled", "clock-tools:pending"]);
    expect(
      results[1]?.entries.find((entry) => entry.id === "clock-tools")?.missing,
    ).toEqual(["clock"]);

    // The type error came back as a diagnostic with a line and a column, and
    // the entry was never created.
    expect(results[4]?.diagnostics).toEqual([
      { message: "Cannot find name 'NOPE'.", line: 2, column: 3 },
    ]);
    expect(results[4]?.entries).toEqual([]);

    // The setup failure came back in the same shape, one phase further on.
    expect(results[5]?.entries[0]?.sourceError).toMatchObject({
      phase: "setup",
      message: "I have not written the handler yet",
      line: 3,
    });

    // Reading it back is what unlocked the rewrite, and it showed the error too.
    expect(results[6]?.source).toBe(throwsOnSetup);
    expect(results[6]?.declarations).toContain("declare const tools");
    expect(results[6]?.entries[0]?.status).toBe("error");

    // ------------------------------------------------------ what actually ran
    const outcomes = session
      .snapshot()
      .filter(
        (entry) =>
          entry.kind === "tool-result" &&
          (entry.name === "greet" || entry.name === "add_up"),
      );
    expect(
      outcomes.map((entry) => entry.kind === "tool-result" && entry.outcome),
    ).toEqual([
      { ok: true, value: "Hello, hello" },
      { ok: true, value: 5 },
    ]);

    // --------------------------------------------------------- the whole log
    expect(trace(session.snapshot())).toEqual([
      // turn one
      "turn-opened",
      "input",
      "step-opened",
      "assistant",
      "call list_plugins",
      "result list_plugins ok",
      "step-closed",
      "step-opened",
      "assistant",
      "call disable_plugin",
      "result disable_plugin ok",
      "step-closed",
      "step-opened",
      "assistant",
      "call enable_plugin",
      "result enable_plugin ok",
      "step-closed",
      "step-opened",
      "assistant",
      "call add_from_catalog",
      "result add_from_catalog ok",
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
      "call greet",
      "result greet ok",
      "step-closed",
      "step-opened",
      "assistant",
      "call write_plugin",
      "result write_plugin ok",
      "step-closed",
      "step-opened",
      "assistant",
      "call write_plugin",
      "result write_plugin ok",
      "step-closed",
      "step-opened",
      "assistant",
      "call read_plugin",
      "result read_plugin ok",
      "step-closed",
      "step-opened",
      "assistant",
      "call rewrite_plugin",
      "result rewrite_plugin ok",
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
      "assistant",
      "call add_up",
      "result add_up ok",
      "step-closed",
      "step-opened",
      "assistant",
      "call disable_plugin",
      "result disable_plugin ok",
      "step-closed",
      "step-opened",
      "assistant",
      "call remove_plugin",
      "result remove_plugin ok",
      "step-closed",
      "step-opened",
      "chunk",
      "assistant",
      "step-closed",
      "turn-closed",
    ]);

    // ------------------------------------------------- the final plugin list
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
      "greeter:active",
    ]);

    // The only thing the client contained is the setup the model got wrong,
    // and the loop was never restarted by any of it.
    expect(
      client.errors.state.map((report) => [report.scope, report.instanceId]),
    ).toEqual([["setup", "adder"]]);
    loop.stop();
    expect(loop.statuses).toEqual(["active"]);

    // And the client holds no leaked resources afterwards.
    const ids = client.inspect().map((entry) => entry.id);
    await client.destroy();
    expect(client.inspect()).toEqual([]);
    expect(client.context.state).toEqual([]);
    for (const id of [...ids, "adder"]) {
      expect(client.resources(id)).toBeUndefined();
    }
  });
});
