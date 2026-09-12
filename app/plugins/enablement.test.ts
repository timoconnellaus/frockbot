import { describe, expect, test } from "bun:test";
import {
  decodePluginEnablementV1,
  enabledPluginIdsV1,
  PLUGIN_ENABLEMENT_KEY_V1,
  PluginEnablementConflictError,
  readPluginEnablementV1,
  setPluginEnabledV1,
} from "./enablement.js";

function storage() {
  const entries = new Map<string, unknown>();
  return {
    entries,
    get: (key: string) => Promise.resolve(entries.get(key)),
    put: (key: string, value: unknown) => {
      entries.set(key, structuredClone(value));
      return Promise.resolve();
    },
  };
}

describe("which plugins a Bot runs", () => {
  test("absent is on: a Bot that never switched anything runs what its User installed", async () => {
    const store = storage();
    const enablement = await readPluginEnablementV1(store);
    expect(enablement).toMatchObject({ revision: 0, enabled: {} });
    expect(
      enabledPluginIdsV1(
        [{ packageId: "weather" }, { packageId: "greeter" }],
        enablement,
      ),
    ).toEqual(["weather", "greeter"]);
  });

  test("switching off removes the plugin from this Bot and only this Bot's map", async () => {
    const store = storage();
    const off = await setPluginEnabledV1(store, {
      pluginId: "greeter",
      enabled: false,
      now: new Date("2026-09-12T00:00:00Z"),
    });
    expect(off).toEqual({
      schemaVersion: 1,
      revision: 1,
      enabled: { greeter: false },
      updatedAt: "2026-09-12T00:00:00.000Z",
    });
    expect(
      enabledPluginIdsV1(
        [{ packageId: "weather" }, { packageId: "greeter" }],
        off,
      ),
    ).toEqual(["weather"]);
    // Back on is absent again: the map holds only what someone changed.
    const on = await setPluginEnabledV1(store, {
      pluginId: "greeter",
      enabled: true,
      expectedRevision: 1,
    });
    expect(on.enabled).toEqual({});
    expect(on.revision).toBe(2);
    expect(store.entries.get(PLUGIN_ENABLEMENT_KEY_V1)).toEqual(on);
  });

  test("a stale revision is refused, and a bad id never lands", async () => {
    const store = storage();
    await setPluginEnabledV1(store, { pluginId: "weather", enabled: false });
    await expect(
      setPluginEnabledV1(store, {
        pluginId: "weather",
        enabled: true,
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(PluginEnablementConflictError);
    await expect(
      setPluginEnabledV1(store, { pluginId: "Weather", enabled: false }),
    ).rejects.toThrow(/invalid/);
    expect(await readPluginEnablementV1(store)).toMatchObject({ revision: 1 });
  });

  test("a stored map is decoded exactly", () => {
    expect(() =>
      decodePluginEnablementV1({
        schemaVersion: 1,
        revision: 1,
        enabled: { weather: "off" },
        updatedAt: "2026-09-12T00:00:00.000Z",
      }),
    ).toThrow(/boolean/);
    expect(() =>
      decodePluginEnablementV1({
        schemaVersion: 1,
        revision: 1,
        enabled: {},
        updatedAt: "2026-09-12T00:00:00.000Z",
        extra: true,
      }),
    ).toThrow(/invalid fields/);
  });
});
