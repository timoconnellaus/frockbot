import { describe, expect, test } from "bun:test";
import type {
  BotSettingsViewV1,
  ConnectionView,
} from "@frockbot/configuration-core";
import type { PluginCatalogItem } from "@frockbot/plugin-shell/shared";
import { projectBotInfoV1 } from "./bot-info.js";

function settings(
  overrides: Partial<BotSettingsViewV1> = {},
): BotSettingsViewV1 {
  return {
    schemaVersion: 1,
    botId: "alpha",
    revision: 3,
    profile: { name: "Inspected" },
    notifications: { enabled: false },
    assignments: [],
    assignmentOperations: [],
    ...overrides,
  };
}

const catalog: PluginCatalogItem[] = [
  {
    packageId: "ollama-cloud",
    displayName: "Ollama Cloud",
    version: "1.0.0",
    capabilities: [
      { id: "ollama-cloud-models", kind: "model", connectionTypes: ["api"] },
    ],
    connectionTypes: [
      {
        id: "api",
        displayName: "API key",
        allowMultiple: true,
        authorizationKind: "api-key",
        capabilities: ["ollama-cloud-models"],
      },
    ],
  },
];

const connections: ConnectionView[] = [
  {
    connectionId: "c1",
    packageId: "ollama-cloud",
    connectionTypeId: "api",
    displayName: "Local Ollama",
    state: "ready",
    safeMetadata: {},
  },
];

describe("bot info projection", () => {
  test("is absent until the Bot's settings have loaded", () => {
    expect(projectBotInfoV1({})).toBeUndefined();
  });

  test("carries the identity a person reads off the pane", () => {
    const projection = projectBotInfoV1({
      settings: settings({
        profile: {
          name: "Inspected",
          title: "Chief of staff",
          label: "Research",
          description: "Keeps the calendar honest.",
          namedBy: "bot",
          hiddenFromSidebar: true,
          avatar: {
            kind: "image",
            digest: "a".repeat(64),
            contentType: "image/png",
            size: 1024,
          },
        },
        notifications: { enabled: true },
      }),
    });
    expect(projection).toMatchObject({
      botId: "alpha",
      name: "Inspected",
      title: "Chief of staff",
      label: "Research",
      description: "Keeps the calendar honest.",
      namedBy: "bot",
      namedByLabel: "Named by itself",
      avatarDigest: "a".repeat(64),
      notificationsEnabled: true,
      hiddenFromSidebar: true,
    });
  });

  test("reports an unrecorded name provenance rather than guessing one", () => {
    const projection = projectBotInfoV1({ settings: settings() });
    expect(projection?.namedBy).toBe("unrecorded");
    expect(projection?.namedByLabel).toBe("Name provenance not recorded");
    expect(projection?.avatarDigest).toBeUndefined();
  });

  test("names each Assignment's Package and Connection", () => {
    const projection = projectBotInfoV1({
      settings: settings({
        assignments: [
          {
            assignmentId: "a1",
            packageId: "ollama-cloud",
            capabilityId: "ollama-cloud-models",
            connectionId: "c1",
            state: "enabled",
          },
        ],
      }),
      catalog,
      connections,
    });
    expect(projection?.capabilities).toEqual([
      {
        key: "a1",
        assignmentId: "a1",
        packageId: "ollama-cloud",
        packageName: "Ollama Cloud",
        capabilityId: "ollama-cloud-models",
        connectionName: "Local Ollama",
        state: "enabled",
        orphaned: false,
      },
    ]);
    expect(projection?.enabledCapabilityCount).toBe(1);
  });

  test("marks an Assignment the catalog no longer offers, without dropping it", () => {
    const projection = projectBotInfoV1({
      settings: settings({
        assignments: [
          {
            assignmentId: "a2",
            packageId: "retired",
            capabilityId: "gone",
            state: "unavailable",
          },
        ],
      }),
      catalog,
      connections,
    });
    expect(projection?.capabilities).toHaveLength(1);
    expect(projection?.capabilities[0]).toMatchObject({
      packageName: "retired",
      orphaned: true,
      state: "unavailable",
    });
    expect(projection?.capabilities[0]?.connectionName).toBeUndefined();
    expect(projection?.enabledCapabilityCount).toBe(0);
  });
});
