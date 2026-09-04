import { describe, expect, it, mock } from "bun:test";
import { createClient, createPlugin } from "../src";
import { defineBase, defineGrant } from "../src/base";
import type { GrantContext } from "../src/base";

describe("defineGrant", () => {
  it("dispatches method calls through the low-level wire form", async () => {
    const seen = mock();
    const data = defineGrant({
      name: "data",
      methods: {
        rows(prefix: string, context: GrantContext) {
          seen(prefix, context.instanceId);
          return [`${prefix}:${context.instanceId}`];
        },
      },
    });
    const client = createClient({
      plugins: [
        {
          id: "written",
          source: `let data
export default function ({ stubs }) { data = stubs.data }
export function read(prefix) { return data.rows(prefix) }`,
          stubs: [data],
        },
      ],
    });
    await client.settled();

    await expect(client.callSource("written", "read", "all")).resolves.toEqual([
      "all:written",
    ]);
    expect(seen).toHaveBeenCalledWith("all", "written");
  });

  it("reports an unknown method with the grant and method names", () => {
    const data = defineGrant({
      name: "data",
      methods: { rows: (_context: GrantContext) => [] },
    });
    expect(() =>
      data.handler({
        instanceId: "written",
        input: { method: "records", args: [] },
        instance: {} as never,
        call: () => Promise.resolve(undefined),
      }),
    ).toThrow('"data" has no method "records"');
  });
});

describe("defineBase", () => {
  it("retains the inferred inventories and exposes the plugin catalog", () => {
    const plugin = createPlugin({ name: "one", setup() {} });
    const grant = defineGrant({
      name: "data",
      methods: { rows: (_context: GrantContext) => [] },
    });
    const base = defineBase({
      keys: {},
      actions: {},
      slots: {},
      grants: { data: grant },
      plugins: { one: plugin },
    });

    expect(base.grants.data).toBe(grant);
    expect(base.catalog).toBe(base.plugins);
    expect(base.catalog.one).toBe(plugin);
  });
});
