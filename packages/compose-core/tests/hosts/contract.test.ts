import { describe, expect, it } from "bun:test";
import {
  createClient,
  createContextKey,
  createPlugin,
  createStub,
  stubCallAction,
  stubDeclarations,
} from "../../src/index";
import type { Host, HostStartRequest } from "../../src/index";

const seenKey = createContextKey<Array<string>>("seen");
const echoKey = createContextKey<string>("echo");

const noteStub = createStub<string, string>({
  name: "note",
  declarations: "declare const note: (message: string) => Promise<string>",
  deps: [seenKey],
  handler: ({ input, instance }) => {
    instance.context.get(seenKey).push(input);
    return `ok:${input}`;
  },
});

const recorder = createPlugin({
  name: "recorder",
  provides: [seenKey],
  setup(instance) {
    instance.provide(seenKey, []);
  },
});

/** A host that records what it was asked to start and answers from a table. */
const fakeHost = (name: string) => {
  const started: Array<HostStartRequest> = [];
  const stopped: Array<string> = [];
  const host: Host = {
    name,
    start(request) {
      started.push(request);
      return Promise.resolve({
        call: (called: string) => Promise.resolve(`${name}:${called}`),
        stop: () => {
          stopped.push(request.instanceId);
          return Promise.resolve();
        },
      });
    },
  };
  return { host, started, stopped };
};

describe("the host contract", () => {
  it("starts entries only in the host they name", async () => {
    const elsewhere = fakeHost("elsewhere");
    const client = createClient({
      hosts: { elsewhere: elsewhere.host },
      plugins: [
        { id: "recorder", plugin: recorder },
        {
          id: "here",
          source: `export default async function ({ stubs }) { await stubs.note('here') }`,
          host: "in-process",
          stubs: [noteStub],
        },
        {
          id: "there",
          source: "export default function () {}",
          host: "elsewhere",
        },
      ],
    });
    await client.settled();

    expect(client.inspect().map((one) => one.status)).toEqual([
      "active",
      "active",
      "active",
    ]);
    expect(client.getContext(seenKey)).toEqual(["here"]);
    expect(elsewhere.started.map((one) => one.instanceId)).toEqual(["there"]);

    await client.destroy();
  });

  it("refuses a source entry that omits its host", async () => {
    const client = createClient({
      plugins: [
        {
          id: "unhosted",
          source: "export default function () {}",
        } as never,
      ],
    });
    await client.settled();

    const [snapshot] = client.inspect();
    expect(snapshot?.status).toBe("error");
    expect(String((snapshot?.error as Error).message)).toContain(
      "must name a host explicitly",
    );
  });

  it("leaves an entry naming a host the client does not have in error", async () => {
    const client = createClient({
      plugins: [
        { id: "a", source: "export default function () {}", host: "nowhere" },
      ],
    });
    await client.settled();

    const [snapshot] = client.inspect();
    expect(snapshot?.status).toBe("error");
    expect(String((snapshot?.error as Error).message)).toContain(
      'names a host "nowhere"',
    );
  });

  it("restarts the instance in the new host when an entry changes host", async () => {
    const first = fakeHost("first");
    const second = fakeHost("second");
    const source = "export default function () {}";
    const client = createClient({
      hosts: { first: first.host, second: second.host },
      plugins: [{ id: "a", source, host: "first" }],
    });
    await client.settled();
    expect(first.started).toHaveLength(1);

    await client.setPluginList([{ id: "a", source, host: "second" }]);

    expect(first.stopped).toEqual(["a"]);
    expect(second.started.map((one) => one.instanceId)).toEqual(["a"]);
    expect(client.inspect()[0]?.status).toBe("active");

    // The same list again changes nothing.
    await client.setPluginList([{ id: "a", source, host: "second" }]);
    expect(second.started).toHaveLength(1);
  });

  it("hands a hosted plugin exactly the stubs its entry was granted", async () => {
    const client = createClient({
      plugins: [
        { id: "recorder", plugin: recorder },
        {
          id: "a",
          source: `
            export default async function ({ stubs }) {
              await stubs.note(Object.keys(stubs).join(','))
              await stubs.note(typeof stubs.secret)
            }
          `,
          host: "in-process",
          stubs: [noteStub],
        },
      ],
    });
    await client.settled();

    expect(client.getContext(seenKey)).toEqual(["note", "undefined"]);

    // Nor can anything else reach a stub the entry was not granted.
    await expect(
      client.dispatch(stubCallAction, {
        stub: "secret",
        instanceId: "a",
        input: undefined,
      }),
    ).rejects.toThrow('was not granted a stub named "secret"');
  });

  it("takes deps and provides for a hosted entry from the stubs it was granted", async () => {
    const publishStub = createStub<string, void>({
      name: "publish",
      declarations: "declare const publish: (value: string) => Promise<void>",
      provides: [echoKey],
      handler: ({ input, instance }) => {
        instance.provide(echoKey, input);
      },
    });
    const reader = createPlugin({
      name: "reader",
      deps: [echoKey],
      setup() {},
    });

    const client = createClient({
      plugins: [
        {
          id: "a",
          source: `export default async function ({ stubs }) { await stubs.publish('hello') }`,
          host: "in-process",
          stubs: [noteStub, publishStub],
        },
        { id: "reader", plugin: reader },
      ],
    });
    await client.settled();

    // `note` needs `seen`, which nothing provides yet.
    expect(client.inspect()[0]?.status).toBe("pending");
    expect(client.inspect()[0]?.missing).toEqual(["seen"]);

    await client.addPlugin({ id: "recorder", plugin: recorder });

    expect(client.inspect()[0]?.status).toBe("active");
    expect(client.getContext(echoKey)).toBe("hello");
    expect(client.inspect().find((one) => one.id === "reader")?.status).toBe(
      "active",
    );
  });

  it("carries only structured-clone-safe values across the boundary, in both directions", async () => {
    const client = createClient({
      plugins: [
        { id: "recorder", plugin: recorder },
        {
          id: "ok",
          source: `
            export default async function ({ options, stubs }) {
              await stubs.note(options.greeting + ':' + (await stubs.note('inner')))
            }
          `,
          host: "in-process",
          options: { greeting: "hi" },
          stubs: [noteStub],
        },
      ],
    });
    await client.settled();
    expect(client.getContext(seenKey)).toEqual(["inner", "hi:ok:inner"]);

    await client.addPlugin({
      id: "smuggler",
      source: `export default async function ({ stubs }) { await stubs.note(() => 1) }`,
      host: "in-process",
      stubs: [noteStub],
    });

    const smuggler = client.inspect().find((one) => one.id === "smuggler");
    expect(smuggler?.status).toBe("error");
    expect(String((smuggler?.error as Error).message)).toContain(
      "not structured-clone-safe",
    );
  });

  it("attaches the calling instance id to every stub call, where middleware sees it", async () => {
    const seen: Array<{ instanceId: string; stub: string }> = [];
    const source = `
      export default async function ({ stubs }) {
        await stubs.note('mine')
      }
    `;
    const client = createClient({
      plugins: [
        { id: "recorder", plugin: recorder },
        { id: "a", source, host: "in-process", stubs: [noteStub] },
        { id: "b", source, host: "in-process", stubs: [noteStub] },
      ],
    });
    client.use(stubCallAction, ({ input, next }) => {
      seen.push({ instanceId: input.instanceId, stub: input.stub });
      // Refuse one instance and let the other through.
      if (input.instanceId === "b") throw new Error("refused");
      return next(input);
    });
    await client.settled();

    expect(seen).toEqual([
      { instanceId: "a", stub: "note" },
      { instanceId: "b", stub: "note" },
    ]);
    expect(client.getContext(seenKey)).toEqual(["mine"]);
    expect(client.inspect().find((one) => one.id === "a")?.status).toBe(
      "active",
    );
    expect(client.inspect().find((one) => one.id === "b")?.status).toBe(
      "error",
    );
  });

  it("cannot be told a different caller by the plugin it hosts", async () => {
    const client = createClient({
      plugins: [
        { id: "recorder", plugin: recorder },
        {
          id: "honest",
          source: `
            export default async function ({ stubs }) {
              // Nothing the plugin passes reaches the identity the client sees.
              await stubs.note({ instanceId: 'someone-else', input: 'forged' })
            }
          `,
          host: "in-process",
          stubs: [noteStub],
        },
      ],
    });
    const callers: Array<string> = [];
    client.use(stubCallAction, ({ input, next }) => {
      callers.push(input.instanceId);
      return next(input);
    });
    await client.settled();

    expect(callers).toEqual(["honest"]);
  });

  it("derives an entry declarations from its grants, in grant order", () => {
    expect(stubDeclarations([noteStub])).toBe(noteStub.declarations);
    expect(stubDeclarations(undefined)).toBe("");
  });
});
