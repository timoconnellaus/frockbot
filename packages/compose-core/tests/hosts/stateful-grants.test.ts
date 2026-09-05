import { describe, expect, mock, test } from "bun:test";
import { createClient, createInProcessHost, createStub } from "../../src";
import {
  createInProcessGrants,
  scheduleStub,
  storageStub,
} from "../../src/grants";

// Keep the grant object in module scope where exported handlers can use it.
const storedSource = (extra = "") => `
let store
export default async ({ options, stubs }) => {
  store = stubs.storage
  const count = (await store.get('count')) ?? 0
  await store.set('count', count + options.step)
}
export const count = () => store.get('count')
${extra}
`;

async function waitFor(assertion: () => void, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await Bun.sleep(10);
    }
  }
}

describe("in-process stateful grants", () => {
  test("storage survives restart and source rewrite, then remove destroys it", async () => {
    const client = createClient({
      hosts: {
        "in-process": createInProcessHost({ grants: createInProcessGrants() }),
      },
      plugins: [
        {
          id: "stateful-test",
          source: storedSource(),
          host: "in-process",
          options: { step: 1 },
          stubs: [storageStub],
        },
      ],
    });
    await client.settled();
    expect(await client.callSource("stateful-test", "count")).toBe(1);

    await client.setOptions("stateful-test", { step: 2 });
    expect(await client.callSource("stateful-test", "count")).toBe(3);

    await client.setPluginList([
      {
        id: "stateful-test",
        source: storedSource("// rewritten"),
        host: "in-process",
        options: { step: 10 },
        stubs: [storageStub],
      },
    ]);
    expect(await client.callSource("stateful-test", "count")).toBe(13);

    await client.removePlugin("stateful-test");
    await client.addPlugin({
      id: "stateful-test",
      source: storedSource(),
      host: "in-process",
      options: { step: 4 },
      stubs: [storageStub],
    });
    expect(await client.callSource("stateful-test", "count")).toBe(4);
    await client.destroy();
  });

  test("a schedule calls a named export with no source call in flight", async () => {
    const fired = mock();
    const note = createStub({
      name: "note",
      declarations: "declare const note: (input: unknown) => Promise<void>",
      handler: ({ input }) => fired(input),
    });
    const client = createClient({
      hosts: {
        "in-process": createInProcessHost({ grants: createInProcessGrants() }),
      },
      plugins: [
        {
          id: "scheduled-test",
          source: `
let note
export default async ({ stubs }) => {
  note = stubs.note
  await stubs.schedule.at(Date.now() + 10, 'wake')
}
export const wake = (input) => note(input)
`,
          host: "in-process",
          stubs: [scheduleStub, note],
        },
      ],
    });
    await client.settled();

    await waitFor(() => expect(fired).toHaveBeenCalledTimes(1));
    expect(fired.mock.calls[0]?.[0]).toEqual({
      scheduledAt: expect.any(Number),
    });
    await client.removePlugin("scheduled-test");
  });
});
