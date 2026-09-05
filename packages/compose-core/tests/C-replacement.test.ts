import { describe, expect, it } from "bun:test";
import { createClient, createContextKey, createPlugin } from "../src/index";

const loggerKey = createContextKey<{
  log: (message: string) => void;
  kind: string;
}>("logger");

const makeLogger = (kind: string) =>
  createPlugin({
    name: `${kind}-logger`,
    provides: [loggerKey],
    setup(instance) {
      instance.provide(loggerKey, { kind, log: () => {} });
    },
  });

const consoleLogger = makeLogger("console");
const bufferLogger = makeLogger("buffer");

const aKey = createContextKey<{ ping: () => string }>("a");
const bKey = createContextKey<{ ping: () => string }>("b");

const cleanupChain = (order: Array<string>) => {
  let aAlive = true;
  const a = createPlugin({
    name: "a",
    provides: [aKey],
    setup(instance) {
      instance.provide(aKey, {
        ping: () => (aAlive ? "alive" : "dead"),
      });
      instance.cleanup(() => {
        aAlive = false;
        order.push("a");
      });
    },
  });
  const b = createPlugin({
    name: "b",
    deps: [aKey],
    provides: [bKey],
    setup(instance) {
      const service = instance.context.get(aKey);
      instance.provide(bKey, { ping: service.ping });
      instance.cleanup(() => {
        order.push(`b:${service.ping()}`);
      });
    },
  });
  const c = createPlugin({
    name: "c",
    deps: [bKey],
    setup(instance) {
      const service = instance.context.get(bKey);
      instance.cleanup(() => {
        order.push(`c:${service.ping()}`);
      });
    },
  });
  return [
    { id: "a", plugin: a },
    { id: "b", plugin: b },
    { id: "c", plugin: c },
  ];
};

// Written once, with no knowledge that the provider can be swapped.
const seenKinds: Array<string> = [];
const dependent = createPlugin({
  name: "dependent",
  deps: [loggerKey],
  setup(instance) {
    seenKinds.push(instance.context.get(loggerKey).kind);
  },
});

describe("C. Replacement", () => {
  it("every dependent runs against the new provider after a swap", async () => {
    seenKinds.length = 0;
    const client = createClient({
      plugins: [
        { id: "logger", plugin: consoleLogger },
        { id: "dependent", plugin: dependent },
      ],
    });
    await client.settled();
    expect(seenKinds).toEqual(["console"]);

    await client.setPluginList([
      { id: "logger", plugin: bufferLogger },
      { id: "dependent", plugin: dependent },
    ]);

    expect(seenKinds).toEqual(["console", "buffer"]);
    expect(client.getContext(loggerKey)?.kind).toBe("buffer");
    expect(
      client.inspect().find((entry) => entry.id === "dependent")?.status,
    ).toBe("active");
  });

  it("there is no window in which a dependent is active against a removed provider", async () => {
    seenKinds.length = 0;
    const client = createClient({
      plugins: [
        { id: "logger", plugin: consoleLogger },
        { id: "dependent", plugin: dependent },
      ],
    });
    await client.settled();

    const violations: Array<string> = [];
    const check = () => {
      const dependentEntry = client.instances.state.find(
        (entry) => entry.id === "dependent",
      );
      const provider = client.context.state.find(
        (entry) => entry.key === "logger",
      );
      if (
        dependentEntry?.status === "active" &&
        provider?.providedBy !== "logger"
      ) {
        violations.push(
          `${dependentEntry.status}/${String(provider?.providedBy)}`,
        );
      }
    };
    const unsubscribeInstances = client.instances.subscribe(check);
    const unsubscribeContext = client.context.subscribe(check);

    await client.setPluginList([
      { id: "logger", plugin: bufferLogger },
      { id: "dependent", plugin: dependent },
    ]);
    await client.removePlugin("logger");

    unsubscribeInstances.unsubscribe();
    unsubscribeContext.unsubscribe();

    expect(violations).toEqual([]);
    expect(
      client.inspect().find((entry) => entry.id === "dependent")?.status,
    ).toBe("pending");
  });

  it("cleans up a three-deep dependency chain before its provider", async () => {
    const order: Array<string> = [];
    const client = createClient({ plugins: cleanupChain(order) });
    await client.settled();

    await client.removePlugin("a");

    expect(order).toEqual(["c:alive", "b:alive", "a"]);
    expect(client.inspect().map((entry) => [entry.id, entry.status])).toEqual([
      ["b", "pending"],
      ["c", "pending"],
    ]);
  });

  it("destroys dependents before the providers they still use", async () => {
    const order: Array<string> = [];
    const client = createClient({ plugins: cleanupChain(order) });
    await client.settled();

    await client.destroy();

    expect(order).toEqual(["c:alive", "b:alive", "a"]);
    expect(client.inspect()).toEqual([]);
  });
});
