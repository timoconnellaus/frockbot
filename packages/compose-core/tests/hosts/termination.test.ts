import { describe, expect, it } from "bun:test";
import {
  createClient,
  createContextKey,
  createPlugin,
  createStub,
  inProcessHost,
  stubCallAction,
} from "../../src/index";
import type { Host } from "../../src/index";

const seenKey = createContextKey<Array<string>>("seen");

const recorder = createPlugin({
  name: "recorder",
  provides: [seenKey],
  setup(instance) {
    instance.provide(seenKey, []);
  },
});

const noteStub = createStub<string, void>({
  name: "note",
  declarations: "declare const note: (message: string) => Promise<void>",
  deps: [seenKey],
  handler: ({ input, instance }) => {
    instance.context.get(seenKey).push(input);
  },
});

/** Stashes its stubs where the test can reach them, which only works in-process. */
const stashing = `
  export default function ({ stubs }) {
    globalThis.stashedStubs = stubs
    return () => { globalThis.stashedCleanup = true }
  }

  export function double(n) {
    return n * 2
  }
`;

interface Stashed {
  stashedStubs?: { note: (message: string) => Promise<void> };
  stashedCleanup?: boolean;
}

/** Read through a call so nothing narrows away between the two assertions. */
const stash = (): Stashed => globalThis as unknown as Stashed;

describe("stopping a hosted instance", () => {
  it("stops but does not destroy a host when an entry restarts", async () => {
    const calls: Array<string> = [];
    const host: Host = {
      name: "stateful",
      start: ({ options }) => {
        calls.push(`start:${String(options)}`);
        return Promise.resolve({
          call: () => Promise.resolve(undefined),
          stop: () => {
            calls.push("stop");
            return Promise.resolve();
          },
          destroy: () => {
            calls.push("destroy");
            return Promise.resolve();
          },
        });
      },
    };
    const client = createClient({
      hosts: { stateful: host },
      plugins: [
        {
          id: "a",
          source: "export default function () {}",
          host: "stateful",
          options: "one",
        },
      ],
    });
    await client.settled();

    await client.setOptions("a", "two");

    expect(calls).toEqual(["start:one", "stop", "start:two"]);
    await client.destroy();
  });

  it("stops then destroys a stateful host when the entry is removed", async () => {
    const calls: Array<string> = [];
    const host: Host = {
      name: "stateful",
      start: () =>
        Promise.resolve({
          call: () => Promise.resolve(undefined),
          stop: () => {
            calls.push("stop");
            return Promise.resolve();
          },
          destroy: () => {
            calls.push("destroy");
            return Promise.resolve();
          },
        }),
    };
    const client = createClient({
      hosts: { stateful: host },
      plugins: [
        { id: "a", source: "export default function () {}", host: "stateful" },
      ],
    });
    await client.settled();

    await client.removePlugin("a");

    expect(calls).toEqual(["stop", "destroy"]);
  });

  it("stops between two calls, so calls after it fail and the code is released", async () => {
    stash().stashedStubs = undefined;
    stash().stashedCleanup = undefined;
    const notes: Array<string> = [];

    const hosted = await inProcessHost.start({
      instanceId: "a",
      code: stashing,
      options: undefined,
      stubs: {
        note: (input) => {
          notes.push(input as string);
          return Promise.resolve(undefined);
        },
      },
    });

    await expect(hosted.call("double", 21)).resolves.toBe(42);
    await stash().stashedStubs?.note("before");

    await hosted.stop();

    // Cleanup has run by the time stop resolves.
    expect(stash().stashedCleanup).toBe(true);
    // A call the client makes afterwards fails rather than landing.
    await expect(hosted.call("double", 21)).rejects.toThrow("has stopped");
    // So does a stub the plugin kept hold of.
    await expect(stash().stashedStubs?.note("after")).rejects.toThrow(
      "revoked",
    );
    expect(notes).toEqual(["before"]);

    // Stopping twice is safe.
    await hosted.stop();
  });

  it("revokes the stubs of a removed instance before the client reports done", async () => {
    const client = createClient({
      plugins: [
        { id: "recorder", plugin: recorder },
        {
          id: "a",
          source: `export default async function ({ stubs }) { await stubs.note('start') }`,
          stubs: [noteStub],
        },
      ],
    });
    await client.settled();
    expect(client.getContext(seenKey)).toEqual(["start"]);

    await client.removePlugin("a");

    expect(client.inspect().map((one) => one.id)).toEqual(["recorder"]);
    await expect(
      client.dispatch(stubCallAction, {
        stub: "note",
        instanceId: "a",
        input: "late",
      }),
    ).rejects.toThrow("have been revoked");
    expect(client.getContext(seenKey)).toEqual(["start"]);
  });

  it("does not report removal done until the host has released the instance", async () => {
    const order: Array<string> = [];
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = () => {
        order.push("released");
        resolve();
      };
    });
    const slow = {
      name: "slow",
      start: () =>
        Promise.resolve({
          call: () => Promise.resolve(undefined),
          stop: () => released,
        }),
    };
    const client = createClient({
      hosts: { slow },
      plugins: [
        { id: "a", source: "export default function () {}", host: "slow" },
      ],
    });
    await client.settled();

    const removal = client.removePlugin("a").then(() => order.push("removed"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(order).toEqual([]);

    release();
    await removal;
    expect(order).toEqual(["released", "removed"]);
  });
});
