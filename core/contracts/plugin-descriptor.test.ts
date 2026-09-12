import { describe, expect, test } from "bun:test";
import { ISOLATE_CONTRACT_VERSION } from "./isolate.js";
import {
  decodePluginDescriptorV1,
  isServedPluginContractVersionV1,
  PLUGIN_SLOTS_V1,
  pluginNetworkAdmitsHostV1,
  servedPluginContractVersionsV1,
} from "./plugin-descriptor.js";

const base = {
  id: "weather",
  displayName: "Weather",
  version: "1.0.0",
  contractVersion: 3,
  tools: [],
  hooks: [],
  grants: [],
  contextKeys: ["user", "bot", "session"],
};

describe("a plugin's declared views", () => {
  test("names a slot from the vocabulary and a surface the wire accepts", () => {
    expect(
      decodePluginDescriptorV1({
        ...base,
        views: [
          { slot: "settings.sections", surfaceId: "weather.defaults" },
          { slot: "sidebar.entries", surfaceId: "weather-forecast" },
        ],
      }).views,
    ).toEqual([
      { slot: "settings.sections", surfaceId: "weather.defaults" },
      { slot: "sidebar.entries", surfaceId: "weather-forecast" },
    ]);
    // Absent stays absent: a plugin that renders nothing declares nothing.
    expect(decodePluginDescriptorV1(base).views).toBeUndefined();
  });

  test("refuses a slot the deployment has not opened", () => {
    expect(PLUGIN_SLOTS_V1).not.toContain("trust.chrome");
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [{ slot: "trust.chrome", surfaceId: "weather" }],
      }),
    ).toThrow();
  });

  test("refuses a surface id the client wire would not carry", () => {
    for (const surfaceId of [
      "",
      ".hidden",
      "weather forecast",
      "a".repeat(129),
    ])
      expect(() =>
        decodePluginDescriptorV1({
          ...base,
          views: [{ slot: "sidebar.entries", surfaceId }],
        }),
      ).toThrow();
  });

  test("refuses two views on one surface, an unbounded list and extra fields", () => {
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [
          { slot: "sidebar.entries", surfaceId: "weather" },
          { slot: "bot.profile", surfaceId: "weather" },
        ],
      }),
    ).toThrow();
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: Array.from({ length: 17 }, (_, index) => ({
          slot: "sidebar.entries",
          surfaceId: `weather-${index}`,
        })),
      }),
    ).toThrow();
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        views: [
          { slot: "sidebar.entries", surfaceId: "weather", botId: "default" },
        ],
      }),
    ).toThrow();
  });
});

describe("a plugin's hooks and contract", () => {
  test("orders hooks by the vocabulary and refuses an unopened event", () => {
    expect(
      decodePluginDescriptorV1({
        ...base,
        hooks: [
          "tools/post-execute",
          "agent/request",
          "system-prompt/assemble",
        ],
      }).hooks,
    ).toEqual([
      "system-prompt/assemble",
      "agent/request",
      "tools/post-execute",
    ]);
    expect(() =>
      decodePluginDescriptorV1({ ...base, hooks: ["agent/request-error"] }),
    ).toThrow(/hooks\[0\]/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        hooks: ["agent/request", "agent/request"],
      }),
    ).toThrow(/duplicates/);
  });

  test("names a contract this deployment knows; the served pair is current and previous", () => {
    expect(
      decodePluginDescriptorV1({ ...base, contractVersion: 2 }).contractVersion,
    ).toBe(2);
    expect(() =>
      decodePluginDescriptorV1({ ...base, contractVersion: 0 }),
    ).toThrow(/contractVersion/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        contractVersion: ISOLATE_CONTRACT_VERSION + 1,
      }),
    ).toThrow(/contractVersion/);
    expect(servedPluginContractVersionsV1()).toEqual<number[]>([
      ISOLATE_CONTRACT_VERSION - 1,
      ISOLATE_CONTRACT_VERSION,
    ]);
    expect(isServedPluginContractVersionV1(ISOLATE_CONTRACT_VERSION)).toBe(
      true,
    );
    expect(isServedPluginContractVersionV1(1)).toBe(false);
  });
});

describe("a plugin's network", () => {
  test("is present exactly when the http grant is", () => {
    expect(() =>
      decodePluginDescriptorV1({ ...base, network: { open: true } }),
    ).toThrow(/http grant/);
    expect(() =>
      decodePluginDescriptorV1({ ...base, grants: ["http"] }),
    ).toThrow(/http grant/);
    expect(
      decodePluginDescriptorV1({
        ...base,
        grants: ["http"],
        network: { hosts: ["api.example.com", "*.weather.example"] },
      }).network,
    ).toEqual({ hosts: ["*.weather.example", "api.example.com"] });
    expect(
      decodePluginDescriptorV1({
        ...base,
        grants: ["http"],
        network: { open: true },
      }).network,
    ).toEqual({ open: true });
  });

  test("refuses anything that is not a lowercase hostname", () => {
    for (const host of [
      "https://api.example.com",
      "API.example.com",
      "example",
      "*.com",
      "a.*.example.com",
      "",
    ]) {
      expect(() =>
        decodePluginDescriptorV1({
          ...base,
          grants: ["http"],
          network: { hosts: [host] },
        }),
      ).toThrow();
    }
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        grants: ["http"],
        network: { hosts: [] },
      }),
    ).toThrow(/name a host/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        grants: ["http"],
        network: { open: false },
      }),
    ).toThrow(/open/);
  });

  test("a wildcard admits subdomains and never the bare domain", () => {
    const network = { hosts: ["*.example.com", "api.other.test"] };
    expect(pluginNetworkAdmitsHostV1(network, "api.example.com")).toBe(true);
    expect(pluginNetworkAdmitsHostV1(network, "a.b.example.com")).toBe(true);
    expect(pluginNetworkAdmitsHostV1(network, "API.Example.com")).toBe(true);
    expect(pluginNetworkAdmitsHostV1(network, "example.com")).toBe(false);
    expect(pluginNetworkAdmitsHostV1(network, "notexample.com")).toBe(false);
    expect(pluginNetworkAdmitsHostV1(network, "api.other.test")).toBe(true);
    expect(pluginNetworkAdmitsHostV1(network, "x.api.other.test")).toBe(false);
    expect(pluginNetworkAdmitsHostV1({ open: true }, "anything.invalid")).toBe(
      true,
    );
  });
});

describe("a plugin's services, triggers and settings", () => {
  test("provides and consumes are typed by name and major version", () => {
    const descriptor = decodePluginDescriptorV1({
      ...base,
      provides: [{ name: "weather-data", version: 2 }],
      consumes: [{ name: "geocoder", version: 1 }],
    });
    expect(descriptor.provides).toEqual([{ name: "weather-data", version: 2 }]);
    expect(descriptor.consumes).toEqual([{ name: "geocoder", version: 1 }]);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        provides: [{ name: "x", version: 1 }],
        consumes: [{ name: "x", version: 1 }],
      }),
    ).toThrow(/also consumes/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        provides: [{ name: "x", version: 0 }],
      }),
    ).toThrow(/version/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        provides: [
          { name: "x", version: 1 },
          { name: "x", version: 2 },
        ],
      }),
    ).toThrow(/duplicate/);
  });

  test("triggers are named and described, and unique", () => {
    expect(
      decodePluginDescriptorV1({
        ...base,
        triggers: [
          { name: "forecast_ready", description: "A forecast landed" },
        ],
      }).triggers,
    ).toEqual([{ name: "forecast_ready", description: "A forecast landed" }]);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        triggers: [{ name: "Forecast Ready", description: "x" }],
      }),
    ).toThrow(/name/);
  });

  test("a settings schema describes an object and is bounded", () => {
    expect(
      decodePluginDescriptorV1({
        ...base,
        settingsSchema: {
          type: "object",
          properties: { city: { type: "string" } },
        },
      }).settingsSchema,
    ).toEqual({ type: "object", properties: { city: { type: "string" } } });
    expect(() =>
      decodePluginDescriptorV1({ ...base, settingsSchema: { type: "string" } }),
    ).toThrow(/object/);
    expect(() =>
      decodePluginDescriptorV1({
        ...base,
        settingsSchema: { type: "object", description: "x".repeat(70_000) },
      }),
    ).toThrow(/bound/);
  });
});
