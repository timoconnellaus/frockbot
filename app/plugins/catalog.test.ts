import { describe, expect, test } from "bun:test";
import {
  decodePluginCatalogV1,
  decodeSeededPluginV1,
  enabledSeededPluginIdsV1,
  FIRST_PARTY_TOGGLEABLE_PLUGINS_V1,
  firstPartyFeatureOnForBotV1,
  isFirstPartyToggleableV1,
  maskPlanForBotV1,
  pluginRunsForBotV1,
  pluginSwitchableV1,
  seededMemberV1,
  seededPluginsForAccountV1,
  type SeededPluginV1,
} from "./catalog.js";
import { emptyPluginEnablementV1 } from "./enablement.js";
import { CAPABILITY_DESCRIPTIONS } from "@frockbot/app/settings/catalog-copy";

function seeded(
  pluginId: string,
  seed: SeededPluginV1["seed"],
): Record<string, unknown> {
  return {
    pluginId,
    displayName: pluginId,
    description: `The ${pluginId} plugin`,
    seed,
    artifact: {
      contentHash: "a".repeat(64),
      size: 12,
      mediaType: "application/javascript",
      bundlerVersion: "seed",
    },
    descriptor: {
      id: pluginId,
      displayName: pluginId,
      version: "1.0.0",
      contractVersion: 4,
      tools: [{ name: "ping", description: "Pings", inputSchema: {} }],
      hooks: [],
      grants: [],
      contextKeys: ["user", "bot", "session"],
    },
  };
}

function enablement(enabled: Record<string, boolean>) {
  return { ...emptyPluginEnablementV1(), enabled };
}

describe("a seeded plugin's record", () => {
  test("decodes exactly, and never under a first-party feature's id", () => {
    expect(decodeSeededPluginV1(seeded("audit-log", "locked")).seed).toBe(
      "locked",
    );
    expect(decodeSeededPluginV1(seeded("gated", "admin-gated")).seed).toBe(
      "admin-gated",
    );
    // One flat enable map keyed by id: a seeded "web" would share the Web
    // feature's switch.
    for (const feature of FIRST_PARTY_TOGGLEABLE_PLUGINS_V1) {
      expect(() =>
        decodeSeededPluginV1(seeded(feature.packageId, "default-off")),
      ).toThrow(/first-party feature/);
    }
    expect(() =>
      decodeSeededPluginV1(
        seeded("weather", "sometimes" as SeededPluginV1["seed"]),
      ),
    ).toThrow(/seed state/);
    expect(() =>
      decodeSeededPluginV1({
        ...seeded("weather", "default-on"),
        descriptor: { ...(seeded("other", "default-on").descriptor as object) },
      }),
    ).toThrow(/does not name/);
    expect(() =>
      decodeSeededPluginV1({ ...seeded("weather", "default-on"), extra: 1 }),
    ).toThrow(/invalid fields/);
  });

  test("a catalog has unique ids", () => {
    expect(() =>
      decodePluginCatalogV1([
        seeded("weather", "default-on"),
        seeded("weather", "default-off"),
      ]),
    ).toThrow(/duplicate/);
    expect(
      decodePluginCatalogV1([seeded("weather", "default-on")]).map(
        (plugin) => plugin.pluginId,
      ),
    ).toEqual(["weather"]);
  });

  test("becomes a member with the deployment as its provenance", () => {
    const member = seededMemberV1(
      decodeSeededPluginV1(seeded("weather", "default-on")),
      "user-1",
      "2026-09-12T00:00:00.000Z",
    );
    expect(member).toMatchObject({
      packageId: "weather",
      version: "1.0.0",
      provenance: { kind: "user", userId: "user-1", packageId: "weather" },
      artifact: { contentHash: "a".repeat(64) },
    });
  });
});

describe("which seeded plugins an account carries", () => {
  test("every seeded plugin except an admin-gated one the admin has not opened", () => {
    const catalog = decodePluginCatalogV1([
      seeded("a", "locked"),
      seeded("b", "default-on"),
      seeded("c", "default-off"),
      seeded("d", "admin-gated"),
      seeded("e", "admin-gated"),
    ]);
    expect(
      seededPluginsForAccountV1(catalog, ["e"]).map(
        (plugin) => plugin.pluginId,
      ),
    ).toEqual(["a", "b", "c", "e"]);
    expect(
      seededPluginsForAccountV1(catalog, []).map((plugin) => plugin.pluginId),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("which plugins one Bot runs", () => {
  test("locked always, default-off only when switched on, the rest unless switched off", () => {
    const off = enablement({
      a: false,
      b: false,
      c: false,
      d: false,
      x: false,
    });
    const on = enablement({ a: true, b: true, c: true, d: true, x: true });
    const none = enablement({});
    expect(pluginRunsForBotV1("locked", "a", off)).toBe(true);
    expect(pluginRunsForBotV1("default-on", "b", none)).toBe(true);
    expect(pluginRunsForBotV1("default-on", "b", off)).toBe(false);
    expect(pluginRunsForBotV1("default-off", "c", none)).toBe(false);
    expect(pluginRunsForBotV1("default-off", "c", on)).toBe(true);
    expect(pluginRunsForBotV1("admin-gated", "d", none)).toBe(true);
    expect(pluginRunsForBotV1("admin-gated", "d", off)).toBe(false);
    // A plugin a Bot wrote is not in the catalog: off until a person — the
    // approval card, or a sibling Bot's Plugins page — switches it on.
    expect(pluginRunsForBotV1(undefined, "x", none)).toBe(false);
    expect(pluginRunsForBotV1(undefined, "x", off)).toBe(false);
    expect(pluginRunsForBotV1(undefined, "x", on)).toBe(true);
    expect(pluginSwitchableV1("locked")).toBe(false);
    expect(pluginSwitchableV1("default-on")).toBe(true);
    expect(pluginSwitchableV1(undefined)).toBe(true);
  });

  test("the enabled list follows the generation's order", () => {
    const catalog = decodePluginCatalogV1([
      seeded("locked-one", "locked"),
      seeded("quiet", "default-off"),
    ]);
    expect(
      enabledSeededPluginIdsV1(
        [
          { packageId: "authored" },
          { packageId: "quiet" },
          { packageId: "locked-one" },
        ],
        enablement({ "locked-one": false, authored: false }),
        catalog,
      ),
    ).toEqual(["locked-one"]);
    expect(
      enabledSeededPluginIdsV1(
        [{ packageId: "authored" }, { packageId: "quiet" }],
        enablement({ quiet: true }),
        catalog,
      ),
    ).toEqual(["quiet"]);
    expect(
      enabledSeededPluginIdsV1(
        [{ packageId: "authored" }, { packageId: "quiet" }],
        enablement({ quiet: true, authored: true }),
        catalog,
      ),
    ).toEqual(["authored", "quiet"]);
  });
});

describe("first-party features a Bot may switch", () => {
  test("are the five the page lists, and custom models is not one", () => {
    expect(
      FIRST_PARTY_TOGGLEABLE_PLUGINS_V1.map((plugin) => plugin.packageId),
    ).toEqual(["web", "routines", "image", "subagents", "machine-messages"]);
    expect(isFirstPartyToggleableV1("custom-models")).toBe(false);
    // The page and Account features describe the same feature in one voice.
    for (const feature of FIRST_PARTY_TOGGLEABLE_PLUGINS_V1) {
      expect(feature.description).toBe(
        CAPABILITY_DESCRIPTIONS[feature.packageId],
      );
    }
  });

  test("absent is on, and an explicit off is what turns a feature off", () => {
    expect(firstPartyFeatureOnForBotV1("image", enablement({}))).toBe(true);
    expect(
      firstPartyFeatureOnForBotV1("image", enablement({ image: true })),
    ).toBe(true);
    expect(
      firstPartyFeatureOnForBotV1("image", enablement({ image: false })),
    ).toBe(false);
  });

  test("a feature switched off contributes none of its capabilities to the Bot's plan", () => {
    const plan = {
      schemaVersion: 1 as const,
      botId: "bot-1",
      revision: 3,
      capabilities: [
        { packageId: "web", capabilityId: "web-read", kind: "tool" as const },
        {
          packageId: "image",
          capabilityId: "image-gen",
          kind: "tool" as const,
        },
        {
          packageId: "provider-ollama-cloud",
          capabilityId: "ollama-cloud-models",
          kind: "model" as const,
          connectionId: "connection-1",
        },
      ],
    };
    const masked = maskPlanForBotV1(
      plan,
      enablement({ web: false, "provider-ollama-cloud": false }),
    );
    expect(
      masked.capabilities.map((capability) => capability.packageId),
    ).toEqual(["image", "provider-ollama-cloud"]);
    expect(masked.revision).toBe(3);
    expect(maskPlanForBotV1(plan, enablement({}))).toEqual(plan);
  });
});
