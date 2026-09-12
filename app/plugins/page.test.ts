import { describe, expect, test } from "bun:test";
import {
  botPluginsDocumentV1,
  decodeSetBotPluginEnabledCommandV1,
  pluginNetworkCopyV1,
  type BotPluginsFrameV1,
} from "./page.js";

const frame: BotPluginsFrameV1 = {
  schemaVersion: 1,
  botId: "bot-1",
  revision: 4,
  plugins: [
    {
      pluginId: "web",
      displayName: "Web",
      description: "Read public web pages.",
      kind: "first-party",
      on: true,
      switchable: true,
    },
    {
      pluginId: "image",
      displayName: "Image",
      description: "Create images.",
      kind: "first-party",
      on: false,
      switchable: true,
      unavailable: "Turned off for the whole account.",
    },
    {
      pluginId: "audit-log",
      displayName: "Audit log",
      description: "Keeps a record.",
      kind: "seeded",
      seed: "locked",
      on: true,
      switchable: false,
    },
    {
      pluginId: "weather",
      displayName: "Weather",
      description: "Forecasts.",
      kind: "authored",
      on: false,
      switchable: true,
      network: { hosts: ["api.weather.example"] },
    },
  ],
};

function groups(document: ReturnType<typeof botPluginsDocumentV1>) {
  return (
    document.root as { children: Array<Record<string, unknown>> }
  ).children.filter((node) => node.type === "group") as Array<{
    title: string;
    children: Array<Record<string, unknown>>;
  }>;
}

function toggle(group: { children: Array<Record<string, unknown>> }) {
  const row = group.children.find((child) => child.type === "group") as
    { children: Array<Record<string, unknown>> } | undefined;
  return row?.children.find((child) => child.type === "action");
}

describe("a Bot's Plugins document", () => {
  test("one card per row: its kind, its reach, and a switch fenced on the revision", () => {
    const document = botPluginsDocumentV1(frame);
    expect(document.surfaceId).toBe("bot-plugins");
    expect(document.revision).toBe(4);
    const cards = groups(document);
    expect(cards.map((card) => card.title)).toEqual([
      "Web · Built in",
      "Image · Built in",
      "Audit log · Always on",
      "Weather · Made by your Bot",
    ]);
    expect(toggle(cards[0]!)).toMatchObject({
      actionId: "set-package-enabled",
      label: "Turn off",
      input: {
        kind: "set-plugin-enabled",
        pluginId: "web",
        enabled: false,
        expectedRevision: 4,
      },
    });
    // Unavailable and locked rows carry no switch.
    expect(toggle(cards[1]!)).toBeUndefined();
    expect(toggle(cards[2]!)).toBeUndefined();
    expect(toggle(cards[3]!)).toMatchObject({
      label: "Turn on",
      input: { pluginId: "weather", enabled: true },
    });
    const weatherLines = cards[3]!.children
      .filter((child) => child.type === "text")
      .map((child) => child.text);
    expect(weatherLines).toContain("Reaches api.weather.example.");
    expect(document.actions.map((action) => action.id)).toEqual([
      "set-package-enabled",
    ]);
  });

  test("says what an open-network plugin means for the whole account", () => {
    expect(pluginNetworkCopyV1({ open: true })).toMatch(
      /every plugin on this account/,
    );
    expect(pluginNetworkCopyV1(undefined)).toBe("");
  });

  test("an empty frame says so", () => {
    const document = botPluginsDocumentV1({ ...frame, plugins: [] });
    const texts = (
      document.root as { children: Array<{ type: string; text?: string }> }
    ).children.map((node) => node.text ?? "");
    expect(texts.some((text) => text.includes("Nothing to switch yet"))).toBe(
      true,
    );
  });
});

describe("a switch command", () => {
  const command = {
    schemaVersion: 1 as const,
    kind: "set-plugin-enabled" as const,
    commandId: "c-1",
    pluginId: "weather",
    enabled: true,
    expectedRevision: 4,
  };

  test("decodes exactly", () => {
    expect(decodeSetBotPluginEnabledCommandV1(command)).toEqual(command);
    expect(() =>
      decodeSetBotPluginEnabledCommandV1({ ...command, pluginId: "Weather" }),
    ).toThrow(/invalid plugin/);
    expect(() =>
      decodeSetBotPluginEnabledCommandV1({ ...command, expectedRevision: -1 }),
    ).toThrow(/revision/);
    expect(() =>
      decodeSetBotPluginEnabledCommandV1({ ...command, extra: 1 }),
    ).toThrow(/invalid fields/);
    expect(() =>
      decodeSetBotPluginEnabledCommandV1({ ...command, kind: "other" }),
    ).toThrow(/not a plugin switch/);
  });
});
