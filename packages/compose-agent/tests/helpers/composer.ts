import {
  createClient,
  createContextKey,
  createPlugin,
} from "@frockbot/compose-core";
import {
  agentKey,
  agentStubs,
  composerPlugin,
  createTool,
  loopPlugin,
  modelsPlugin,
  promptPlugin,
  scriptedModelPlugin,
  sessionKey,
  sessionPlugin,
  toolsKey,
  toolsPlugin,
} from "../../src";
import { anyValidator, validator } from "./validator";
import type {
  AnyPlugin,
  AnyStubGrant,
  Client,
  ContextKey,
  Host,
  PluginEntry,
  SourceChecker,
} from "@frockbot/compose-core";
import type {
  Agent,
  AnyTool,
  PromptSection,
  ScriptedResponse,
  SessionLog,
} from "../../src";
import type { ComposerResult } from "@frockbot/compose-tools";

// ------------------------------------------------------------------ fixtures

/** A value one plugin provides and another depends on, so C1 has something to break. */
const clockKey: ContextKey<{ now: () => number }> = createContextKey<{
  now: () => number;
}>("clock");

/** Provides `clock`. Its options are validated, so a bad update is refused. */
export const clockPlugin = createPlugin({
  name: "clock",
  provides: [clockKey],
  validator: validator<{ start?: number } | undefined, { start: number }>(
    (value) => {
      const start = value?.start ?? 0;
      if (typeof start !== "number") {
        return { issues: [{ message: "expected a number", path: ["start"] }] };
      }
      return { value: { start } };
    },
  ),
  setup(instance, options) {
    let ticks = options.start;
    instance.provide(clockKey, {
      now: () => {
        ticks += 1;
        return ticks;
      },
    });
  },
});

/** Depends on `clock`, and contributes the tool that reads it. */
export const clockToolsPlugin = createPlugin({
  name: "clock-tools",
  deps: [clockKey, toolsKey],
  setup(instance) {
    const clock = instance.context.get(clockKey);
    const tool = createTool({
      name: "read_clock",
      description: "Read the clock",
      validator: anyValidator,
      execute: () => clock.now(),
    });
    instance.cleanup(
      instance.context.get(toolsKey).register(tool),
      "tool(read_clock)",
    );
  },
});

/** A catalog plugin whose options are required, so B3 has something to reject. */
export const greeterPlugin = createPlugin({
  name: "greeter",
  deps: [toolsKey],
  validator: validator<{ label: string }, { label: string }>((value) => {
    const label = (value as { label?: unknown } | null)?.label;
    if (typeof label !== "string") {
      return { issues: [{ message: "expected a string", path: ["label"] }] };
    }
    return { value: { label } };
  }),
  setup(instance, options) {
    const tool = createTool({
      name: "greet",
      description: "Greet someone",
      validator: anyValidator,
      execute: () => `${options.label}, hello`,
    });
    instance.cleanup(
      instance.context.get(toolsKey).register(tool),
      "tool(greet)",
    );
  },
});

/**
 * A checker small enough to read: it rejects any line holding `NOPE`, and
 * otherwise strips the type annotations a real one would compile away. It
 * exists to prove the seam, not to check anything.
 */
export const markerChecker: SourceChecker = {
  check({ source }) {
    const at = source.split("\n").findIndex((line) => line.includes("NOPE"));
    if (at !== -1) {
      return {
        diagnostics: [
          {
            message: "Cannot find name 'NOPE'.",
            line: at + 1,
            column: 3,
          },
        ],
      };
    }
    return {
      code: source.replaceAll(": number", "").replaceAll(": string", ""),
    };
  },
};

/**
 * A checker that publishes declarations of its own — a preamble the grant text
 * alone does not carry — so a test can show that what the composer hands the
 * model is what this checker checks against, not the bare concatenation.
 */
export const declaringChecker: SourceChecker = {
  check: markerChecker.check,
  declarations: (grants) =>
    [
      "/** the whole world this module compiles in */",
      ...grants.map((grant) => grant.declarations),
      `interface Stubs { ${grants.map((grant) => `readonly ${grant.name}: typeof ${grant.name}`).join("; ")} }`,
    ].join("\n"),
};

// ------------------------------------------------------------------ assembly

/** The five entries a recommended assembly protects, plus the composer itself. */
const registryEntries = [
  "session",
  "tools",
  "prompt",
  "models",
  "loop",
] as const;

/**
 * An agent that can edit itself: the six entries of an ordinary agent plus the
 * composer, with whatever else a test wants in the list.
 */
export const buildComposer = async (setup: {
  script: Array<ScriptedResponse>;
  catalog?: Record<string, AnyPlugin>;
  protected?: Array<string>;
  stubs?: Array<AnyStubGrant>;
  /** The stubs a written view is granted; omitted means views are not granted. */
  viewStubs?: Array<AnyStubGrant>;
  /** The slot names a written view may fill; omitted means any of them. */
  viewSlots?: Array<string>;
  host?: string;
  hosts?: Record<string, Host>;
  checker?: SourceChecker;
  /** The model provider the registry selects. */
  select?: string;
  /** Extra entries, placed before the composer. */
  plugins?: Array<PluginEntry>;
  tools?: Array<AnyTool>;
  sections?: Array<PromptSection>;
  composerOptions?: unknown;
}): Promise<{
  client: Client;
  agent: Agent;
  session: SessionLog;
}> => {
  const client = createClient({
    ...(setup.hosts ? { hosts: setup.hosts } : {}),
    ...(setup.checker ? { checker: setup.checker } : {}),
    plugins: [
      { id: "session", plugin: sessionPlugin },
      { id: "tools", plugin: toolsPlugin, options: { tools: setup.tools } },
      {
        id: "prompt",
        plugin: promptPlugin,
        options: { sections: setup.sections },
      },
      {
        id: "models",
        plugin: modelsPlugin,
        ...(setup.select === undefined
          ? {}
          : { options: { select: setup.select } }),
      },
      {
        id: "model",
        plugin: scriptedModelPlugin,
        options: { script: setup.script },
      },
      { id: "loop", plugin: loopPlugin },
      ...(setup.plugins ?? []),
      {
        id: "composer",
        plugin: composerPlugin,
        options:
          setup.composerOptions ??
          ({
            catalog: setup.catalog ?? {},
            protected: setup.protected ?? [...registryEntries],
            stubs: setup.stubs ?? [...agentStubs],
            ...(setup.viewStubs === undefined
              ? {}
              : { viewStubs: setup.viewStubs }),
            ...(setup.viewSlots === undefined
              ? {}
              : { viewSlots: setup.viewSlots }),
            host: setup.host ?? "in-process",
          } as unknown),
      },
    ],
  });
  await client.settled();
  return {
    client,
    agent: client.getContext(agentKey)!,
    session: client.getContext(sessionKey)!,
  };
};

/** The names of every tool the composer registers. */
const composerTools = [
  "list_plugins",
  "enable_plugin",
  "disable_plugin",
  "configure_plugin",
  "add_from_catalog",
  "write_plugin",
  "read_plugin",
  "rewrite_plugin",
  "remove_plugin",
  "select_model",
];

/** Every composer result in the session, in the order the model got them. */
export const resultsOf = (session: SessionLog): Array<ComposerResult> =>
  session
    .snapshot()
    .filter(
      (entry) =>
        entry.kind === "tool-result" && composerTools.includes(entry.name),
    )
    .map((entry) => {
      const outcome = (entry as { outcome: { ok: boolean; value?: unknown } })
        .outcome;
      return outcome.value as ComposerResult;
    });

/** One composer result by index, for a test that only cares about one. */
export const resultOf = (
  session: SessionLog,
  index = 0,
): ComposerResult | undefined => resultsOf(session)[index];

/** The id and status of every entry the client is running, in list order. */
export const listing = (client: Client): Array<string> =>
  client.pluginList.state.map((entry) => {
    const status =
      entry.enabled === false
        ? "disabled"
        : (client.inspect().find((one) => one.id === entry.id)?.status ??
          "removed");
    return `${entry.id}:${status}`;
  });
