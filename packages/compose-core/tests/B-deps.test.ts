import { describe, expect, it, mock } from "bun:test";
import {
  createAction,
  createClient,
  createContextKey,
  createPlugin,
} from "../src/index";

const loggerKey = createContextKey<{ log: (message: string) => void }>(
  "logger",
);
const timerKey = createContextKey<{ now: () => number }>("timer");
const absentKey = createContextKey<string>("absent");

const loggerPlugin = createPlugin({
  name: "logger",
  provides: [loggerKey],
  setup(instance) {
    instance.provide(loggerKey, { log: () => {} });
  },
});

const timerPlugin = createPlugin({
  name: "timer",
  provides: [timerKey],
  setup(instance) {
    instance.provide(timerKey, { now: () => 1 });
  },
});

describe("B. Deps and context", () => {
  it("treats an owned action like a dependency", async () => {
    const run = createAction<number, string>("run");
    const order: Array<string> = [];
    const results: Array<string> = [];
    const consumer = createPlugin({
      name: "consumer",
      deps: [run],
      async setup(instance) {
        order.push("consumer:start");
        results.push(await instance.get(run)(1));
        instance.cleanup(() => {
          order.push("consumer:cleanup");
        });
      },
    });
    const owner = createPlugin({
      name: "owner",
      provides: [run],
      setup(instance) {
        order.push("owner:start");
        instance.defineAction(run, (input) => String(input));
        instance.cleanup(() => {
          order.push("owner:cleanup");
        });
      },
    });
    const client = createClient({
      plugins: [{ id: "consumer", plugin: consumer }],
    });
    await client.settled();

    expect(client.inspect()[0]).toMatchObject({
      status: "pending",
      missing: ["run"],
    });

    await client.addPlugin({ id: "owner", plugin: owner });
    expect(order).toEqual(["owner:start", "consumer:start"]);
    expect(results).toEqual(["1"]);

    await client.removePlugin("owner");
    expect(order).toEqual([
      "owner:start",
      "consumer:start",
      "consumer:cleanup",
      "owner:cleanup",
    ]);
    expect(client.inspect()[0]).toMatchObject({
      status: "pending",
      missing: ["run"],
    });
  });

  it("does not make middleware registration an action dependency", async () => {
    const run = createAction<void, void>("unowned");
    const middleware = createPlugin({
      name: "middleware",
      setup(instance) {
        instance.use(run, ({ next, input }) => next(input));
      },
    });
    const client = createClient({
      plugins: [{ id: "middleware", plugin: middleware }],
    });
    await client.settled();

    expect(client.inspect()[0]).toMatchObject({
      status: "active",
      missing: [],
    });
  });

  it("an instance stays pending until the last dep is provided, whatever the order", async () => {
    const started = mock();
    const consumer = createPlugin({
      name: "consumer",
      deps: [loggerKey, timerKey],
      setup(instance) {
        started(
          instance.context.get(loggerKey),
          instance.context.get(timerKey),
        );
      },
    });

    // The consumer is listed first, and one provider is added after the fact.
    const client = createClient({
      plugins: [
        { id: "consumer", plugin: consumer },
        { id: "logger", plugin: loggerPlugin },
      ],
    });
    await client.settled();

    const pending = client.inspect().find((entry) => entry.id === "consumer");
    expect(pending?.status).toBe("pending");
    expect(pending?.missing).toEqual(["timer"]);
    expect(started).not.toHaveBeenCalled();

    await client.addPlugin({ id: "timer", plugin: timerPlugin });
    expect(
      client.inspect().find((entry) => entry.id === "consumer")?.status,
    ).toBe("active");
    expect(started).toHaveBeenCalledTimes(1);
  });

  it("losing a dep cleans the dependent up and returns it to pending", async () => {
    const cleaned = mock();
    const starts: Array<number> = [];
    const signals: Array<AbortSignal> = [];
    const consumer = createPlugin({
      name: "consumer",
      deps: [timerKey],
      setup(instance) {
        starts.push(instance.context.get(timerKey).now());
        signals.push(instance.signal);
        instance.cleanup(cleaned);
      },
    });
    const client = createClient({
      plugins: [
        { id: "timer", plugin: timerPlugin },
        { id: "consumer", plugin: consumer },
      ],
    });
    await client.settled();
    expect(starts).toEqual([1]);

    await client.removePlugin("timer");
    const pending = client.inspect().find((entry) => entry.id === "consumer");
    expect(pending?.status).toBe("pending");
    expect(pending?.missing).toEqual(["timer"]);
    expect(cleaned).toHaveBeenCalledTimes(1);
    expect(signals[0]?.aborted).toBe(true);
    expect(signals[0]?.reason).toBe("deactivated");

    await client.addPlugin({ id: "timer", plugin: timerPlugin });
    expect(
      client.inspect().find((entry) => entry.id === "consumer")?.status,
    ).toBe("active");
    expect(starts).toEqual([1, 1]);
    expect(signals[1]).not.toBe(signals[0]);
    expect(signals[1]?.aborted).toBe(false);
  });

  it("keeps declared deps captured for async work after deactivation", async () => {
    const timer = { now: () => 42 };
    const provider = createPlugin({
      name: "timer",
      provides: [timerKey],
      setup(instance) {
        instance.provide(timerKey, timer);
      },
    });
    let finish:
      | ((result: {
          captured: typeof timer | undefined;
          live: typeof timer | undefined;
          aborted: boolean;
          reason: unknown;
        }) => void)
      | undefined;
    const fired = new Promise<{
      captured: typeof timer | undefined;
      live: typeof timer | undefined;
      aborted: boolean;
      reason: unknown;
    }>((resolve) => {
      finish = resolve;
    });
    const consumer = createPlugin({
      name: "consumer",
      deps: [timerKey],
      setup(instance) {
        setTimeout(() => {
          finish?.({
            captured: instance.context.get(timerKey),
            live: instance.context.peek(timerKey),
            aborted: instance.signal.aborted,
            reason: instance.signal.reason,
          });
        }, 0);
      },
    });
    const client = createClient({
      plugins: [
        { id: "timer", plugin: provider },
        { id: "consumer", plugin: consumer },
      ],
    });
    await client.settled();

    await client.removePlugin("timer");

    await expect(fired).resolves.toEqual({
      captured: timer,
      live: undefined,
      aborted: true,
      reason: "deactivated",
    });
  });

  it("only a value provided by an active instance satisfies a dep", async () => {
    // This provider can never become active: it needs a key nobody provides.
    const blockedProvider = createPlugin({
      name: "blocked-provider",
      deps: [absentKey],
      provides: [loggerKey],
      setup(instance) {
        instance.provide(loggerKey, { log: () => {} });
      },
    });
    const failingProvider = createPlugin({
      name: "failing-provider",
      provides: [timerKey],
      setup(instance) {
        instance.provide(timerKey, { now: () => 2 });
        throw new Error("nope");
      },
    });
    const consumer = createPlugin({
      name: "consumer",
      deps: [loggerKey, timerKey],
      setup() {},
    });

    const client = createClient({
      plugins: [
        { id: "blocked", plugin: blockedProvider },
        { id: "failing", plugin: failingProvider },
        { id: "consumer", plugin: consumer },
      ],
    });
    await client.settled();

    expect(
      client.inspect().find((entry) => entry.id === "blocked")?.status,
    ).toBe("pending");
    expect(
      client.inspect().find((entry) => entry.id === "failing")?.status,
    ).toBe("error");
    const consumerEntry = client
      .inspect()
      .find((entry) => entry.id === "consumer");
    expect(consumerEntry?.status).toBe("pending");
    expect(consumerEntry?.missing).toEqual(["logger", "timer"]);
    expect(client.getContext(loggerKey)).toBeUndefined();
    expect(client.getContext(timerKey)).toBeUndefined();
  });

  it("a plugin can read a key it did not declare and keeps running either way", async () => {
    const seen: Array<unknown> = [];
    const peeker = createPlugin({
      name: "peeker",
      setup(instance) {
        seen.push(instance.context.peek(loggerKey));
        seen.push(instance.context.peek(absentKey));
      },
    });
    const client = createClient({
      plugins: [
        { id: "logger", plugin: loggerPlugin },
        { id: "peeker", plugin: peeker },
      ],
    });
    await client.settled();

    expect(
      client.inspect().find((entry) => entry.id === "peeker")?.status,
    ).toBe("active");
    expect(seen[0]).toBeDefined();
    expect(seen[1]).toBeUndefined();
  });

  it("providing a key that is already provided throws for the second provider", async () => {
    const otherLogger = createPlugin({
      name: "other-logger",
      provides: [loggerKey],
      setup(instance) {
        instance.provide(loggerKey, { log: () => {} });
      },
    });
    const client = createClient({
      plugins: [
        { id: "logger", plugin: loggerPlugin },
        { id: "other", plugin: otherLogger },
      ],
    });
    await client.settled();

    expect(
      client.inspect().find((entry) => entry.id === "logger")?.status,
    ).toBe("active");
    const second = client.inspect().find((entry) => entry.id === "other");
    expect(second?.status).toBe("error");
    expect(String(second?.error)).toMatch(/already provided by "logger"/);
  });

  it("circular deps are detected and reported with the cycle named", async () => {
    const eggKey = createContextKey<string>("egg");
    const chickenKey = createContextKey<string>("chicken");
    const chicken = createPlugin({
      name: "chicken",
      deps: [eggKey],
      provides: [chickenKey],
      setup(instance) {
        instance.provide(chickenKey, "chicken");
      },
    });
    const egg = createPlugin({
      name: "egg",
      deps: [chickenKey],
      provides: [eggKey],
      setup(instance) {
        instance.provide(eggKey, "egg");
      },
    });

    const client = createClient({
      plugins: [
        { id: "chicken", plugin: chicken },
        { id: "egg", plugin: egg },
      ],
    });
    await client.settled();

    const statuses = client.inspect().map((entry) => entry.status);
    expect(statuses).toEqual(["error", "error"]);
    expect(String(client.inspect()[0]?.error)).toMatch(/circular deps/);
    expect(String(client.inspect()[0]?.error)).toMatch(
      /chicken → egg → chicken/,
    );
  });
});
