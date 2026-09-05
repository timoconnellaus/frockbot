import { stubDeclarations } from "@frockbot/compose-core";
import { describe, expect, it } from "bun:test";
import { promptStub, requestAction, toolsKey, toolsStub } from "../src";
import {
  buildComposer,
  declaringChecker,
  markerChecker,
  resultsOf,
} from "./helpers/composer";
import type { ResourceNode } from "@frockbot/compose-core";

const done = { chunks: ["done"] };

/** A written plugin: one tool, one prompt section. */
const shouter = `
export default async function ({ stubs }) {
  await stubs.tools({
    name: 'shout',
    description: 'Shout a word',
    parameters: {
      type: 'object',
      properties: { word: { type: 'string' } },
      required: ['word'],
    },
    handler: 'shout',
  })
  await stubs.prompt({ name: 'shouting', text: 'Shout when asked.' })
}

export function shout({ word }) {
  return word.toUpperCase()
}
`.trim();

const alpha = `
export default async function ({ stubs }) {
  await stubs.tools({
    name: 'alpha',
    description: 'The first version',
    handler: 'run',
  })
}
export function run() {
  return 'alpha'
}
`.trim();

const beta = `
export default async function ({ stubs }) {
  await stubs.tools({
    name: 'beta',
    description: 'The second version',
    handler: 'run',
  })
}
export function run() {
  return 'beta'
}
`.trim();

const write = (id: string, source: string, rewrite = false) => ({
  name: rewrite ? "rewrite_plugin" : "write_plugin",
  args: { id, source },
});
const read = (id: string) => ({ name: "read_plugin", args: { id } });

const labels = (node: ResourceNode | undefined): Array<string> => {
  if (!node) return [];
  return [node.label, ...node.children.flatMap(labels)];
};

const toolNames = (client: { getContext: any }): Array<string> =>
  client
    .getContext(toolsKey)!
    .list()
    .map((tool: { name: string }) => tool.name);

describe("the plugins the agent writes", () => {
  it("starts written source, and its tool and prompt section arrive in the next turn", async () => {
    const systems: Array<string> = [];
    const { client, agent, session } = await buildComposer({
      script: [
        { toolCalls: [write("shouter", shouter)] },
        done,
        { toolCalls: [{ name: "shout", args: { word: "hello" } }] },
        done,
      ],
    });
    client.use(requestAction, ({ input, next }) => {
      systems.push(input.system);
      return next(input);
    });

    agent.send("write yourself a shouting tool");
    await agent.idle();

    const [written] = resultsOf(session);
    expect(written?.ok).toBe(true);
    expect(written?.entries).toEqual([
      {
        id: "shouter",
        plugin: "source",
        kind: "source",
        enabled: true,
        protected: false,
        status: "active",
        readable: true,
      },
    ]);
    expect(systems[0]).not.toContain("Shout when asked.");

    agent.send("now shout hello");
    await agent.idle();

    expect(systems[2]).toContain("Shout when asked.");
    const outcome = session
      .snapshot()
      .find((entry) => entry.kind === "tool-result" && entry.name === "shout");
    expect(outcome?.kind === "tool-result" && outcome.outcome).toEqual({
      ok: true,
      value: "HELLO",
    });
  });

  it("validates a written tool's arguments against the schema it declared", async () => {
    const { agent, session } = await buildComposer({
      script: [
        { toolCalls: [write("shouter", shouter)] },
        done,
        { toolCalls: [{ name: "shout", args: { word: 7 } }] },
        done,
      ],
    });

    agent.send("write it");
    await agent.idle();
    agent.send("shout a number");
    await agent.idle();

    const outcome = session
      .snapshot()
      .find((entry) => entry.kind === "tool-result" && entry.name === "shout");
    expect(outcome?.kind === "tool-result" && outcome.outcome).toEqual({
      ok: false,
      error:
        'invalid arguments for tool "shout": word expected string, got number',
    });
  });

  it("runs the previous code's cleanups on a rewrite, so nothing it registered survives", async () => {
    const { client, agent, session } = await buildComposer({
      script: [
        { toolCalls: [write("written", alpha)] },
        { toolCalls: [read("written")] },
        { toolCalls: [write("written", beta, true)] },
        done,
      ],
    });

    agent.send("write it, read it, rewrite it");
    await agent.idle();

    const [, , rewritten] = resultsOf(session);
    expect(rewritten?.ok).toBe(true);
    expect(rewritten?.message).toContain("rewrote");

    const names = toolNames(client);
    expect(names).toContain("beta");
    expect(names).not.toContain("alpha");
    expect(labels(client.resources("written"))).toEqual([
      "hosted (written)",
      "host(in-process)",
      "stubs",
      "tool(beta)",
    ]);
  });

  it("refuses to rewrite source it has not read back in this session", async () => {
    const { client, agent, session } = await buildComposer({
      script: [
        { toolCalls: [write("written", alpha)] },
        done,
        { toolCalls: [write("written", beta, true)] },
        done,
      ],
    });

    agent.send("write it");
    await agent.idle();
    agent.send("rewrite it");
    await agent.idle();

    const [, refused] = resultsOf(session);
    expect(refused?.ok).toBe(false);
    expect(refused?.error).toBe(
      'read the source of "written" with read_plugin before rewriting it',
    );
    expect(toolNames(client)).toContain("alpha");
  });

  it("refuses a rewrite when the source moved since it was read", async () => {
    const { client, agent, session } = await buildComposer({
      script: [
        { toolCalls: [write("written", alpha)] },
        { toolCalls: [read("written")] },
        done,
        { toolCalls: [write("written", beta, true)] },
        done,
      ],
    });

    agent.send("write it and read it");
    await agent.idle();

    // Somebody else edits the entry between the read and the rewrite.
    await client.setPluginList(
      client.pluginList.state.map((entry) =>
        entry.id === "written" && entry.source !== undefined
          ? { ...entry, source: alpha.replace("alpha", "gamma") }
          : entry,
      ),
    );

    agent.send("rewrite it");
    await agent.idle();

    const [, , refused] = resultsOf(session);
    expect(refused?.ok).toBe(false);
    expect(refused?.error).toBe(
      'the source of "written" has changed since you read it; read it again and try again',
    );
    expect(toolNames(client)).toContain("gamma");
  });

  it("reads and rewrites only what it wrote itself", async () => {
    const { agent, session } = await buildComposer({
      plugins: [
        {
          id: "operators",
          source: alpha,
          host: "in-process",
          stubs: [toolsStub],
        },
      ],
      script: [
        { toolCalls: [read("operators")] },
        { toolCalls: [write("operators", beta, true)] },
        { toolCalls: [read("loop")] },
        done,
      ],
    });

    agent.send("read everything you can");
    await agent.idle();

    const [readIt, rewriteIt, readLoop] = resultsOf(session);
    expect(readIt?.error).toBe(
      'the entry "operators" was not written by this agent, so its source cannot be read',
    );
    expect(rewriteIt?.error).toBe(
      'the entry "operators" was not written by this agent, so it cannot be rewritten',
    );
    expect(readLoop?.error).toBe(
      'the entry "loop" is a plugin from the assembly or the catalog and has no source to read',
    );
  });

  it("hands the model the declarations of exactly the stubs the entry was granted", async () => {
    const { agent, session } = await buildComposer({
      stubs: [toolsStub],
      script: [
        { toolCalls: [write("written", alpha)] },
        { toolCalls: [read("written")] },
        done,
      ],
    });

    agent.send("write and read");
    await agent.idle();

    const [, wasRead] = resultsOf(session);
    expect(wasRead?.source).toBe(alpha);
    expect(wasRead?.declarations).toBe(stubDeclarations([toolsStub]));
    expect(wasRead?.declarations).not.toContain("declare const prompt");
    expect(stubDeclarations([toolsStub, promptStub])).toContain(
      "declare const prompt",
    );
  });

  it("shows the model exactly what the source checker checks against", async () => {
    const { agent, session } = await buildComposer({
      checker: declaringChecker,
      stubs: [toolsStub],
      script: [
        { toolCalls: [{ name: "list_plugins", args: {} }] },
        { toolCalls: [write("written", alpha)] },
        { toolCalls: [read("written")] },
        done,
      ],
    });

    agent.send("what am I checked against?");
    await agent.idle();

    const expected = declaringChecker.declarations!([
      { name: toolsStub.name, declarations: toolsStub.declarations },
    ]);
    const [listed, , wasRead] = resultsOf(session);
    // The listing is where a model that has written nothing yet sees them.
    expect(listed?.declarations).toBe(expected);
    expect(wasRead?.declarations).toBe(expected);
    expect(expected).not.toBe(stubDeclarations([toolsStub]));
  });

  it("carries the checker diagnostics and leaves the entry exactly as it was", async () => {
    const { client, agent, session } = await buildComposer({
      checker: markerChecker,
      script: [
        { toolCalls: [write("written", alpha)] },
        { toolCalls: [read("written")] },
        {
          toolCalls: [
            write(
              "written",
              ["export default function () {", "  NOPE", "}"].join("\n"),
              true,
            ),
          ],
        },
        done,
      ],
    });

    agent.send("write something that does not check");
    await agent.idle();

    const [, , rejected] = resultsOf(session);
    expect(rejected?.ok).toBe(false);
    expect(rejected?.diagnostics).toEqual([
      { message: "Cannot find name 'NOPE'.", line: 2, column: 3 },
    ]);
    expect(rejected?.declarations).toBe(
      stubDeclarations(
        client.pluginList.state.find((entry) => entry.id === "written")?.stubs,
      ),
    );
    // Not started, and the entry is untouched: the first version still runs.
    expect(rejected?.entries[0]?.status).toBe("active");
    expect(toolNames(client)).toContain("alpha");
  });

  it("carries a failure to start in the same shape as a failure to check", async () => {
    const { client, agent, session } = await buildComposer({
      checker: markerChecker,
      script: [
        {
          toolCalls: [
            write(
              "written",
              [
                "export default function () {",
                '  throw new Error("boom in setup")',
                "}",
              ].join("\n"),
            ),
          ],
        },
        done,
      ],
    });

    agent.send("write something that throws");
    await agent.idle();

    const [failed] = resultsOf(session);
    expect(failed?.ok).toBe(false);
    expect(failed?.error).toContain("boom in setup");
    expect(failed?.entries[0]?.status).toBe("error");
    expect(failed?.entries[0]?.sourceError).toMatchObject({
      phase: "setup",
      message: "boom in setup",
      line: 2,
    });
    // The rest of the client is untouched.
    expect(
      client.inspect().filter((one) => one.status === "error").length,
    ).toBe(1);
  });

  it("puts the entry in error when the first call into it throws, and the turn goes on", async () => {
    const { client, agent, session } = await buildComposer({
      script: [
        {
          toolCalls: [
            write(
              "written",
              [
                "export default async function ({ stubs }) {",
                "  await stubs.tools({ name: 'bang', description: 'Throws', handler: 'run' })",
                "}",
                "export function run() {",
                '  throw new Error("boom on the first call")',
                "}",
              ].join("\n"),
            ),
          ],
        },
        done,
        { toolCalls: [{ name: "bang", args: {} }] },
        done,
      ],
    });

    agent.send("write it");
    await agent.idle();
    agent.send("call it");
    await agent.idle();

    const outcome = session
      .snapshot()
      .find((entry) => entry.kind === "tool-result" && entry.name === "bang");
    expect(
      outcome?.kind === "tool-result" &&
        outcome.outcome.ok === false &&
        outcome.outcome.error,
    ).toContain("boom on the first call");
    expect(client.inspect().find((one) => one.id === "written")?.status).toBe(
      "error",
    );
    expect(toolNames(client)).not.toContain("bang");
  });

  it("starts source unchecked when no checker is provided, and checked when one is", async () => {
    const typed = alpha.replace(
      "export function run()",
      "export function run(): string",
    );

    const bare = await buildComposer({
      script: [{ toolCalls: [write("written", typed)] }, done],
    });
    bare.agent.send("write TypeScript with no checker in the client");
    await bare.agent.idle();
    const [unchecked] = resultsOf(bare.session);
    expect(unchecked?.ok).toBe(false);
    expect(unchecked?.entries[0]?.sourceError?.phase).toBe("parse");

    const checked = await buildComposer({
      checker: markerChecker,
      script: [{ toolCalls: [write("written", typed)] }, done],
    });
    checked.agent.send("write the same thing with a checker in the client");
    await checked.agent.idle();
    const [started] = resultsOf(checked.session);
    expect(started?.ok).toBe(true);
    expect(toolNames(checked.client)).toContain("alpha");
  });

  it("removes a written entry, leaving no resources and no tools behind", async () => {
    const { client, agent, session } = await buildComposer({
      script: [
        { toolCalls: [write("written", alpha)] },
        { toolCalls: [{ name: "remove_plugin", args: { id: "written" } }] },
        done,
      ],
    });

    agent.send("write it and take it away");
    await agent.idle();

    const [, removed] = resultsOf(session);
    expect(removed?.ok).toBe(true);
    expect(toolNames(client)).not.toContain("alpha");
    expect(client.resources("written")).toBeUndefined();
    expect(client.inspect().some((one) => one.id === "written")).toBe(false);
  });
});
