import { createClient } from "@frockbot/compose-core";
import {
  createTypeScriptChecker,
  pluginDeclarations,
} from "@frockbot/compose-typescript";
import { describe, expect, it } from "bun:test";
import {
  agentKey,
  agentStubs,
  composerPlugin,
  loopPlugin,
  modelsPlugin,
  promptPlugin,
  scriptedModelPlugin,
  sessionKey,
  sessionPlugin,
  toolCallAction,
  toolsKey,
  toolsPlugin,
} from "@frockbot/compose-agent";
import type { ComposerResult } from "@frockbot/compose-tools";
import type { Client } from "@frockbot/compose-core";
import type { SessionLog } from "@frockbot/compose-agent";

/**
 * The model's first attempt. `handlerName` is not a property of the `tools`
 * stub's argument, and the property it needed is missing — a real type error
 * against the real declarations, not a marker the test planted.
 */
const wrongProperty = `const setup: Setup = async ({ stubs }) => {
  await stubs.tools({
    name: 'add_up',
    description: 'Add two numbers',
    handlerName: 'addUp',
  })
}
export default setup

export function addUp(input: { a: number; b: number }) {
  return input.a + input.b
}
`;

/** Its second attempt, which type-checks against those same declarations. */
const corrected = `const setup: Setup = async ({ stubs }) => {
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
export default setup

export function addUp(input: { a: number; b: number }) {
  return input.a + input.b
}
`;

/** The composer tools, so a result can be picked out of the session by name. */
const composerTools = ["list_plugins", "write_plugin", "remove_plugin"];

const resultsOf = (session: SessionLog): Array<ComposerResult> =>
  session
    .snapshot()
    .filter(
      (entry) =>
        entry.kind === "tool-result" && composerTools.includes(entry.name),
    )
    .map(
      (entry) =>
        (entry as { outcome: { value?: unknown } }).outcome
          .value as ComposerResult,
    );

/**
 * Record the loop instance's status every time the client publishes: a restart
 * shows up as the status leaving `active`. The agent package's own test helper,
 * kept here because helpers are not published.
 */
const watchLoop = (client: Client) => {
  const statusOf = () =>
    client.inspect().find((entry) => entry.id === "loop")?.status ?? "missing";
  const statuses: Array<string> = [statusOf()];
  const subscription = client.instances.subscribe(() => {
    const status = statusOf();
    if (status !== statuses[statuses.length - 1]) statuses.push(status);
  });
  return { statuses, stop: () => subscription.unsubscribe() };
};

describe("an agent writing a plugin against the real type checker", () => {
  it("reads the declarations, fails to check, corrects it, uses the tool and removes it", async () => {
    const client = createClient({
      checker: createTypeScriptChecker(),
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
              // ------------------------------------------------------ turn one
              { toolCalls: [{ name: "list_plugins", args: {} }] },
              {
                toolCalls: [
                  {
                    name: "write_plugin",
                    args: { id: "adder", source: wrongProperty },
                  },
                ],
              },
              {
                toolCalls: [
                  {
                    name: "write_plugin",
                    args: { id: "adder", source: corrected },
                  },
                ],
              },
              { chunks: ["The adder is up."] },
              // ------------------------------------------------------ turn two
              { toolCalls: [{ name: "add_up", args: { a: 2, b: 3 } }] },
              { chunks: ["Two and three make five."] },
              // ---------------------------------------------------- turn three
              { toolCalls: [{ name: "remove_plugin", args: { id: "adder" } }] },
              { chunks: ["Tidied up."] },
            ],
          },
        },
        { id: "loop", plugin: loopPlugin },
        {
          id: "composer",
          plugin: composerPlugin,
          options: {
            protected: ["session", "tools", "prompt", "models", "loop"],
            stubs: [...agentStubs],
            host: "in-process",
          },
        },
      ],
    });
    await client.settled();

    const agent = client.getContext(agentKey)!;
    const session = client.getContext(sessionKey)!;
    const tools = client.getContext(toolsKey)!;
    const loop = watchLoop(client);

    /** The plugin list as it stood after each `write_plugin` returned. */
    const listAfterWrite: Array<Array<string>> = [];
    client.use(toolCallAction, async ({ input, next }) => {
      const outcome = await next(input);
      if (input.call.name === "write_plugin") {
        listAfterWrite.push(client.pluginList.state.map((entry) => entry.id));
      }
      return outcome;
    });

    agent.send("write yourself something that adds two numbers");
    await agent.idle();

    const [listed, rejected, written] = resultsOf(session);

    // What the model was shown is the declaration file the checker compiles
    // against, not a paraphrase of it: one producer, one text.
    expect(listed?.declarations).toBe(
      pluginDeclarations(
        agentStubs.map((grant) => ({
          name: grant.name,
          declarations: grant.declarations,
        })),
      ),
    );
    expect(listed?.declarations).toContain("interface Stubs");
    expect(listed?.declarations).toContain("declare const tools");

    // The type error came back as TypeScript's own sentence, at the position
    // the model wrote it at, and the entry was never created.
    expect(rejected?.ok).toBe(false);
    expect(rejected?.diagnostics).toEqual([
      {
        message:
          "Object literal may only specify known properties, and 'handlerName' does not exist in type '{ name: string; description: string; parameters?: JsonSchema | undefined; handler: string; concurrency?: \"parallel\" | \"exclusive\" | undefined; }'.",
        line: 5,
        column: 5,
      },
    ]);
    expect(wrongProperty.split("\n")[4]).toContain("handlerName");
    expect(rejected?.entries).toEqual([]);
    expect(rejected?.declarations).toBe(listed?.declarations);
    expect(listAfterWrite[0]).not.toContain("adder");

    // The corrected source checks, and the entry it wrote is running.
    expect(written?.ok).toBe(true);
    expect(written?.entries).toEqual([
      {
        id: "adder",
        plugin: "source",
        kind: "source",
        enabled: true,
        protected: false,
        status: "active",
        readable: true,
      },
    ]);

    // ---------------------------------------------------------- the next turn
    expect(tools.list().map((tool) => tool.name)).toContain("add_up");

    agent.send("add two and three");
    await agent.idle();

    const outcome = session
      .snapshot()
      .find((entry) => entry.kind === "tool-result" && entry.name === "add_up");
    expect(outcome?.kind === "tool-result" && outcome.outcome).toEqual({
      ok: true,
      value: 5,
    });

    // ------------------------------------------------------------- and gone
    agent.send("now put yourself back");
    await agent.idle();

    const removed = resultsOf(session).at(-1);
    expect(removed?.ok).toBe(true);
    expect(removed?.message).toBe('removed the entry "adder"');
    expect(tools.list().map((tool) => tool.name)).not.toContain("add_up");
    expect(client.resources("adder")).toBeUndefined();
    expect(client.pluginList.state.map((entry) => entry.id)).not.toContain(
      "adder",
    );
    expect(client.errors.state).toEqual([]);

    // None of it restarted the loop.
    loop.stop();
    expect(loop.statuses).toEqual(["active"]);

    // And nothing the written plugin held outlived the client.
    const ids = client.inspect().map((entry) => entry.id);
    await client.destroy();
    expect(client.inspect()).toEqual([]);
    expect(client.context.state).toEqual([]);
    for (const id of [...ids, "adder"]) {
      expect(client.resources(id)).toBeUndefined();
    }
  });
});
