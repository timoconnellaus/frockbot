import {
  createClient,
  createContextKey,
  createPlugin,
  createStub,
  sourceErrorOf,
} from "@frockbot/compose-core";
import { createTypeScriptChecker } from "../../src/index";
import type { Client } from "@frockbot/compose-core";

/** A tool registry a written plugin can register into through its stub. */
export interface Registry {
  add: (name: string, run: (input: unknown) => Promise<unknown>) => () => void;
  call: (name: string, input: unknown) => Promise<unknown>;
}

export const registryKey = createContextKey<Registry>("tests.registry");

const registryPlugin = createPlugin({
  name: "registry",
  provides: [registryKey],
  setup(instance) {
    const tools = new Map<string, (input: unknown) => Promise<unknown>>();
    instance.provide(registryKey, {
      add(name, run) {
        tools.set(name, run);
        return () => tools.delete(name);
      },
      call: (name, input) => tools.get(name)!(input),
    });
  },
});

/** The one stub the tests grant: register a named export as a tool. */
export const toolsStub = createStub<{ name: string; handler: string }, void>({
  name: "tools",
  declarations: `/** Offer one of this module's named exports to the client as a tool. */
declare const tools: (tool: { name: string; handler: string }) => Promise<void>`,
  deps: [registryKey],
  handler: ({ input, instance, call }) => {
    const remove = instance.context
      .get(registryKey)
      .add(input.name, (argument) => call(input.handler, argument));
    instance.cleanup(remove, `tool(${input.name})`);
  },
});

/** A second grant, so "exactly the stubs it was granted" has something to miss. */
export const logStub = createStub<string, void>({
  name: "log",
  declarations: `declare const log: (message: string) => Promise<void>`,
  handler: () => {},
});

/** Start a client with the checker and one written entry, and let it settle. */
export async function write(
  source: string,
  grants: Array<typeof toolsStub | typeof logStub> = [toolsStub],
): Promise<Client> {
  const client = createClient({
    checker: createTypeScriptChecker(),
    plugins: [
      { id: "registry", plugin: registryPlugin },
      { id: "written", source, stubs: grants },
    ],
  });
  await client.settled();
  return client;
}

/** The written entry's snapshot and, when it failed, its source-error detail. */
export function outcome(client: Client) {
  const snapshot = client.inspect().find((one) => one.id === "written");
  return { snapshot, detail: sourceErrorOf(snapshot?.error) };
}
