import { describe, expect, test } from "bun:test";
import {
  decodePluginDescriptorV1,
  PLUGIN_SLOTS_V1,
} from "./plugin-descriptor.js";

const base = {
  id: "weather",
  displayName: "Weather",
  version: "1.0.0",
  tools: [],
  actions: [],
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
