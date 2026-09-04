import { describe, expect, it } from "bun:test";
import {
  createAction,
  createClient,
  createContextKey,
  createPlugin,
} from "../src/index";

interface Logger {
  kind: string;
  log: (message: string) => void;
}
interface Timer {
  now: () => number;
}
interface Tools {
  register: (name: string) => void;
  list: () => Array<string>;
}

const loggerKey = createContextKey<Logger>("logger");
const timerKey = createContextKey<Timer>("timer");
const toolsKey = createContextKey<Tools>("tools");

const callTool = createAction<{ name: string; args: string }, string>(
  "tools.call",
);
const editList = createAction<
  "disable-timer" | "enable-timer" | "swap-logger",
  void
>("scenario.step");

const lines: Array<string> = [];

const makeLogger = (kind: string) =>
  createPlugin({
    name: `${kind}-logger`,
    provides: [loggerKey],
    setup(instance) {
      instance.provide(loggerKey, {
        kind,
        log: (message) => lines.push(`${kind}: ${message}`),
      });
    },
  });

const timerPlugin = createPlugin({
  name: "timer",
  provides: [timerKey],
  setup(instance) {
    let ticks = 0;
    const handle = setInterval(() => {
      ticks++;
    }, 1000);
    instance.cleanup(() => {
      clearInterval(handle);
    }, "interval");
    instance.provide(timerKey, { now: () => ticks });
  },
});

// The tools registry needs a logger, so it is a dependent of both providers.
const toolsPlugin = createPlugin({
  name: "tools",
  deps: [loggerKey, timerKey],
  provides: [toolsKey, callTool],
  setup(instance) {
    const registered: Array<string> = [];
    const logger = instance.context.get(loggerKey);
    instance.provide(toolsKey, {
      register: (name) => {
        registered.push(name);
      },
      list: () => [...registered],
    });
    instance.defineAction(callTool, ({ name, args }) => {
      logger.log(
        `call ${name}(${args}) at ${instance.context.get(timerKey).now()}`,
      );
      return `${name}:${args}`;
    });
    instance.cleanup(() => {
      registered.length = 0;
    }, "registered tools");
  },
});

const echoToolPlugin = createPlugin({
  name: "echo-tool",
  deps: [toolsKey],
  setup(instance) {
    instance.context.get(toolsKey).register("echo");
  },
});

// Rewrites every tool call without the tools plugin knowing.
const rewriterPlugin = createPlugin({
  name: "rewriter",
  setup(instance) {
    instance.use(callTool, ({ input, next }) =>
      next({ ...input, args: input.args.toUpperCase() }),
    );
  },
});

const selfEditingPlugin = createPlugin({
  name: "composer",
  provides: [editList],
  setup(instance) {
    instance.defineAction(editList, async (step) => {
      if (step === "disable-timer")
        await instance.client.setEnabled("timer", false);
      if (step === "enable-timer")
        await instance.client.setEnabled("timer", true);
      if (step === "swap-logger") {
        await instance.client.setPluginList(
          instance.client.pluginList.state.map((entry) =>
            entry.id === "logger" && entry.source === undefined
              ? { ...entry, plugin: makeLogger("buffer") }
              : entry,
          ),
        );
      }
    });
  },
});

describe("J. End to end", () => {
  it("assembles a client, swaps a provider, and edits its own plugin list", async () => {
    lines.length = 0;
    const client = createClient({
      plugins: [
        { id: "logger", plugin: makeLogger("console") },
        { id: "timer", plugin: timerPlugin },
        { id: "tools", plugin: toolsPlugin },
        { id: "echo", plugin: echoToolPlugin },
        { id: "rewriter", plugin: rewriterPlugin },
        { id: "composer", plugin: selfEditingPlugin },
      ],
    });
    await client.settled();

    expect(client.inspect().map((entry) => entry.status)).toEqual([
      "active",
      "active",
      "active",
      "active",
      "active",
      "active",
    ]);
    expect(await client.dispatch(callTool, { name: "echo", args: "hi" })).toBe(
      "echo:HI",
    );
    expect(lines).toEqual(["console: call echo(HI) at 0"]);

    // The composer disables the timer from inside the client.
    await client.dispatch(editList, "disable-timer");
    await client.settled();
    expect(
      client.inspect().map((entry) => [entry.id, entry.status, entry.missing]),
    ).toEqual([
      ["logger", "active", []],
      ["tools", "pending", ["timer"]],
      ["echo", "pending", ["tools"]],
      ["rewriter", "active", []],
      ["composer", "active", []],
    ]);
    await expect(
      client.dispatch(callTool, { name: "echo", args: "hi" }),
    ).rejects.toThrow(/no plugin owns/);

    await client.dispatch(editList, "enable-timer");
    await client.settled();
    expect(client.inspect().every((entry) => entry.status === "active")).toBe(
      true,
    );

    // Swapping the logger restarts everything downstream of it, untouched.
    await client.dispatch(editList, "swap-logger");
    await client.settled();
    lines.length = 0;
    expect(await client.dispatch(callTool, { name: "echo", args: "hi" })).toBe(
      "echo:HI",
    );
    expect(lines).toEqual(["buffer: call echo(HI) at 0"]);
    expect(client.getContext(loggerKey)?.kind).toBe("buffer");

    // G1: exactly the expected instances, all active, nothing pending or errored.
    expect(
      client.inspect().map((entry) => [entry.id, entry.plugin, entry.status]),
    ).toEqual([
      ["logger", "buffer-logger", "active"],
      ["timer", "timer", "active"],
      ["tools", "tools", "active"],
      ["echo", "echo-tool", "active"],
      ["rewriter", "rewriter", "active"],
      ["composer", "composer", "active"],
    ]);
    expect(client.errors.state).toEqual([]);

    // G2: the resources held are exactly the ones registered, and no more.
    expect(
      client.resources("tools")?.children.map((node) => node.label),
    ).toEqual(["provide(tools)", "action(tools.call)", "registered tools"]);

    await client.destroy();
    expect(client.inspect()).toEqual([]);
    expect(client.context.state).toEqual([]);
    expect(client.errors.state).toEqual([]);
  });
});
