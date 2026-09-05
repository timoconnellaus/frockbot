import { describe, expect, it, mock } from "bun:test";
import {
  createAction,
  createClient,
  createEvent,
  createPlugin,
} from "../src/index";

const greet = createAction<string, string>("greet");
const unused = createAction<void, void>("unused");
const noticed = createEvent<{ what: string }>("noticed");
const drained = createEvent<{ what: string }>("drained", { awaited: true });

const seen: Array<string> = [];

const owner = createPlugin({
  name: "owner",
  provides: [greet],
  setup(instance) {
    instance.defineAction(greet, (input) => {
      seen.push(input);
      return `hello ${input}`;
    });
  },
});

describe("E. Middleware and events", () => {
  it("keeps only the newest reports up to the configured error limit", () => {
    const failed = createEvent<number>("failed");
    const client = createClient({ errorLimit: 3 });
    client.on(failed, (number) => {
      throw new Error(String(number));
    });

    client.emit(failed, 1);
    client.emit(failed, 2);
    client.emit(failed, 3);
    client.emit(failed, 4);

    expect(client.errors.state.map((report) => String(report.error))).toEqual([
      "Error: 2",
      "Error: 3",
      "Error: 4",
    ]);
  });

  it("middleware can rewrite the input, rewrite the result, or stop the action", async () => {
    seen.length = 0;
    const rewriteInput = createPlugin({
      name: "rewrite-input",
      setup(instance) {
        instance.use(greet, ({ input, next }) => next(input.toUpperCase()));
      },
    });
    const client = createClient({
      plugins: [
        { id: "owner", plugin: owner },
        { id: "rewrite-input", plugin: rewriteInput },
      ],
    });
    await client.settled();
    expect(await client.dispatch(greet, "ada")).toBe("hello ADA");
    expect(seen).toEqual(["ADA"]);

    await client.setPluginList([
      { id: "owner", plugin: owner },
      {
        id: "rewrite-result",
        plugin: createPlugin({
          name: "rewrite-result",
          setup(instance) {
            instance.use(
              greet,
              async ({ input, next }) => `${await next(input)}!`,
            );
          },
        }),
      },
    ]);
    expect(await client.dispatch(greet, "ada")).toBe("hello ada!");

    await client.setPluginList([
      { id: "owner", plugin: owner },
      {
        id: "stop",
        plugin: createPlugin({
          name: "stop",
          setup(instance) {
            instance.use(greet, () => "stopped");
          },
        }),
      },
    ]);
    seen.length = 0;
    expect(await client.dispatch(greet, "ada")).toBe("stopped");
    // The owner cannot tell which of the three happened: it simply was not called.
    expect(seen).toEqual([]);
  });

  it("middleware runs in registration order, first goes to the front, and removal is clean", async () => {
    const order: Array<string> = [];
    const mark = (name: string) =>
      createPlugin({
        name,
        setup(instance) {
          instance.use(
            greet,
            ({ input, next }) => {
              order.push(name);
              return next(input);
            },
            name === "first" ? { first: true } : undefined,
          );
        },
      });

    const client = createClient({
      plugins: [
        { id: "owner", plugin: owner },
        { id: "a", plugin: mark("a") },
        { id: "b", plugin: mark("b") },
        { id: "first", plugin: mark("first") },
      ],
    });
    await client.settled();

    await client.dispatch(greet, "x");
    expect(order).toEqual(["first", "a", "b"]);

    order.length = 0;
    await client.removePlugin("a");
    expect(await client.dispatch(greet, "x")).toBe("hello x");
    expect(order).toEqual(["first", "b"]);
  });

  it("a listener observes an event and a throwing listener is contained", async () => {
    const heard: Array<string> = [];
    const emitter = createPlugin({
      name: "emitter",
      provides: [unused],
      setup(instance) {
        instance.cleanup(() => {});
        instance.defineAction(unused, () => {});
        instance.on(noticed, () => heard.push("emitter heard itself"));
      },
    });
    const observer = createPlugin({
      name: "observer",
      setup(instance) {
        instance.on(noticed, () => {
          throw new Error("listener failed");
        });
        instance.on(noticed, (payload) => heard.push(payload.what));
      },
    });
    const client = createClient({
      plugins: [
        { id: "emitter", plugin: emitter },
        { id: "observer", plugin: observer },
      ],
    });
    await client.settled();

    client.emit(noticed, { what: "something" });
    expect(heard).toEqual(["emitter heard itself", "something"]);
    expect(client.errors.state).toHaveLength(1);
    expect(client.errors.state[0]?.scope).toBe("listener");
    expect(client.errors.state[0]?.instanceId).toBe("observer");

    await client.removePlugin("observer");
    heard.length = 0;
    client.emit(noticed, { what: "again" });
    expect(heard).toEqual(["emitter heard itself"]);
  });

  it("dispatch is fire-and-forget or awaited according to the event definition", async () => {
    const finished = mock();
    const slow = createPlugin({
      name: "slow-listener",
      setup(instance) {
        instance.on(drained, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          finished();
        });
        instance.on(noticed, async () => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          finished();
        });
      },
    });
    const client = createClient({ plugins: [{ id: "slow", plugin: slow }] });
    await client.settled();

    const fireAndForget: void = client.emit(noticed, { what: "go" });
    expect(fireAndForget).toBeUndefined();
    expect(finished).not.toHaveBeenCalled();

    const awaited: Promise<void> = client.emit(drained, { what: "go" });
    expect(awaited).toBeInstanceOf(Promise);
    await awaited;
    expect(finished).toHaveBeenCalled();
  });
});
