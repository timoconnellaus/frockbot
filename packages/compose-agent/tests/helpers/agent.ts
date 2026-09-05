import { createClient } from "@frockbot/compose-core";
import {
  agentKey,
  loopPlugin,
  modelsPlugin,
  promptPlugin,
  scriptedModelPlugin,
  sessionKey,
  sessionPlugin,
  toolsKey,
  toolsPlugin,
} from "../../src";
import type { Client } from "@frockbot/compose-core";
import type {
  Agent,
  AnyTool,
  PromptSection,
  ScriptedResponse,
  SessionEntry,
  SessionLog,
  ToolRegistry,
} from "../../src";

/** A promise a test resolves by hand, to hold a turn open at a known point. */
export const deferred = <TValue = void>() => {
  let resolve!: (value: TValue) => void;
  const promise = new Promise<TValue>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/**
 * The whole agent: a session, a tool registry, a prompt registry, a model
 * registry, a scripted provider registered into it, and the loop — six plugin
 * entries and nothing else (A3).
 */
export const buildAgent = async (setup?: {
  script?: Array<ScriptedResponse>;
  tools?: Array<AnyTool>;
  sections?: Array<PromptSection>;
  entries?: Array<SessionEntry>;
  maxSteps?: number;
}): Promise<{
  client: Client;
  agent: Agent;
  session: SessionLog;
  tools: ToolRegistry;
}> => {
  const client = createClient({
    plugins: [
      {
        id: "session",
        plugin: sessionPlugin,
        options: { entries: setup?.entries },
      },
      { id: "tools", plugin: toolsPlugin, options: { tools: setup?.tools } },
      {
        id: "prompt",
        plugin: promptPlugin,
        options: { sections: setup?.sections },
      },
      { id: "models", plugin: modelsPlugin },
      {
        id: "model",
        plugin: scriptedModelPlugin,
        options: { script: setup?.script ?? [] },
      },
      {
        id: "loop",
        plugin: loopPlugin,
        options: { maxSteps: setup?.maxSteps },
      },
    ],
  });
  await client.settled();
  return {
    client,
    agent: client.getContext(agentKey)!,
    session: client.getContext(sessionKey)!,
    tools: client.getContext(toolsKey)!,
  };
};

/**
 * Record the loop instance's status every time the client publishes, so a test
 * can show that nothing it did restarted the loop. A restart shows up as the
 * status leaving `active`, and as a new `agentKey` value.
 */
export const watchLoop = (client: Client) => {
  const statusOf = () =>
    client.inspect().find((entry) => entry.id === "loop")?.status ?? "missing";
  const statuses: Array<string> = [statusOf()];
  const subscription = client.instances.subscribe(() => {
    const status = statusOf();
    if (status !== statuses[statuses.length - 1]) statuses.push(status);
  });
  return { statuses, stop: () => subscription.unsubscribe() };
};

/** The kinds of every entry in a log, for asserting the shape of a turn. */
export const kindsOf = (entries: ReadonlyArray<SessionEntry>): Array<string> =>
  entries.map((entry) => entry.kind);
