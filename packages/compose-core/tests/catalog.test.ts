import { describe, expect, it } from "bun:test";
import { createClient, createPlugin, createStub } from "../src";
import { resolvePluginList, serializePluginList } from "../src/catalog";

describe("serializable plugin catalogs", () => {
  it("round-trips catalog plugins, source and named stubs", () => {
    const trusted = createPlugin({ name: "trusted", setup() {} });
    const note = createStub({
      name: "note",
      declarations: "declare const note: (value: string) => Promise<void>",
      handler() {},
    });
    const catalog = { plugins: { safe: trusted }, stubs: { note } };
    const entries = [
      { id: "safe", plugin: trusted },
      { id: "written", source: "export default function () {}", stubs: [note] },
    ];

    const serialized = serializePluginList(entries, catalog);
    expect(serialized).toEqual([
      {
        id: "safe",
        plugin: { catalog: "safe" },
        options: undefined,
        enabled: undefined,
        stubs: [],
      },
      {
        id: "written",
        plugin: { source: "export default function () {}" },
        options: undefined,
        enabled: undefined,
        stubs: ["note"],
      },
    ]);
    expect(resolvePluginList(serialized, catalog)).toEqual(entries);
  });

  it("loads an unknown plugin name as one error entry", async () => {
    const healthy = createPlugin({ name: "healthy", setup() {} });
    const entries = resolvePluginList(
      [
        { id: "missing", plugin: { catalog: "gone" }, stubs: [] },
        { id: "healthy", plugin: { catalog: "healthy" }, stubs: [] },
      ],
      { plugins: { healthy }, stubs: {} },
    );
    const client = createClient({ plugins: entries });
    await client.settled();

    expect(client.inspect().map(({ id, status }) => ({ id, status }))).toEqual([
      { id: "missing", status: "error" },
      { id: "healthy", status: "active" },
    ]);
    expect(client.inspect()[0]?.error).toMatchObject({
      message: 'no plugin named "gone" in the catalog',
    });
  });
});
