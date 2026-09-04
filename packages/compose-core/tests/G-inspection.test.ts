import { describe, expect, it } from "bun:test";
import {
  createAction,
  createClient,
  createContextKey,
  createEvent,
  createPlugin,
} from "../src/index";
import type { InstanceSnapshot, ResourceNode } from "../src/index";

const configKey = createContextKey<{ url: string }>("config");
const poolKey = createContextKey<{ size: number }>("pool");
const tickEvent = createEvent<number>("tick");
const queryAction = createAction<string, number>("query");

const flatten = (node: ResourceNode, depth = 0): Array<string> => [
  `${"  ".repeat(depth)}${node.label}`,
  ...node.children.flatMap((child) => flatten(child, depth + 1)),
];

describe("G. Inspection", () => {
  it("every instance is listed with id, plugin, status, missing deps and error", async () => {
    const config = createPlugin({
      name: "config",
      provides: [configKey],
      setup(instance) {
        instance.provide(configKey, { url: "https://example.test" });
      },
    });
    const waiting = createPlugin({
      name: "waiting",
      deps: [configKey, poolKey],
      setup() {},
    });
    const failing = createPlugin({
      name: "failing",
      setup() {
        throw new Error("did not start");
      },
    });

    const client = createClient({
      plugins: [
        { id: "config", plugin: config },
        { id: "waiting", plugin: waiting },
        { id: "failing", plugin: failing },
      ],
    });
    await client.settled();

    const listed: Array<InstanceSnapshot> = client.inspect();
    expect(
      listed.map((entry) => [entry.id, entry.plugin, entry.status]),
    ).toEqual([
      ["config", "config", "active"],
      ["waiting", "waiting", "pending"],
      ["failing", "failing", "error"],
    ]);
    expect(listed[1]?.missing).toEqual(["pool"]);
    expect(String(listed[2]?.error)).toMatch(/did not start/);
    expect(client.context.state).toEqual([
      { key: "config", providedBy: "config" },
    ]);
  });

  it("the resource tree of an instance labels every held registration", async () => {
    const parent = createPlugin({
      name: "parent",
      provides: [configKey, queryAction],
      setup(instance) {
        instance.provide(configKey, { url: "https://example.test" });
        instance.defineAction(queryAction, () => 1);
        instance.on(tickEvent, () => {});
        instance.use(queryAction, ({ input, next }) => next(input));
        instance.cleanup(() => {}, "interval");
      },
    });

    const client = createClient({
      plugins: [{ id: "parent", plugin: parent }],
    });
    await client.settled();

    expect(flatten(client.resources("parent")!)).toEqual([
      "parent (parent)",
      "  provide(config)",
      "  action(query)",
      "  listener(tick)",
      "  middleware(query)",
      "  interval",
    ]);
    expect(client.resources("nope")).toBeUndefined();

    await client.removePlugin("parent");
    expect(client.resources("parent")).toBeUndefined();
  });

  it("status changes are observable through a store, with no polling", async () => {
    const provider = createPlugin({
      name: "provider",
      provides: [poolKey],
      setup(instance) {
        instance.provide(poolKey, { size: 2 });
      },
    });
    const consumer = createPlugin({
      name: "consumer",
      deps: [poolKey],
      setup() {},
    });

    const client = createClient({
      plugins: [{ id: "consumer", plugin: consumer }],
    });
    const seen: Array<Array<string>> = [];
    const subscription = client.instances.subscribe((snapshot) => {
      seen.push(snapshot.map((entry) => `${entry.id}:${entry.status}`));
    });

    await client.settled();
    await client.addPlugin({ id: "provider", plugin: provider });
    await client.removePlugin("provider");
    subscription.unsubscribe();

    expect(seen).toEqual([
      ["consumer:pending"],
      ["consumer:active", "provider:active"],
      ["consumer:pending"],
    ]);
  });
});
