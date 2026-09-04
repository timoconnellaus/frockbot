import { plugin } from "bun";
import { expect, test } from "bun:test";
import type { UserSettingsViewV1 } from "@frockbot/configuration-core";
import type { Ref } from "vue";
import type { FrockBotWebData } from "../shared.js";

// Bun has no single-file-component loader; the shell's Vue modules stand in as
// empty components, exactly as `index.test.ts` does.
plugin({
  name: "shell-client-vue-no-bot-loader",
  setup(build) {
    build.onLoad({ filter: /\.vue$/ }, () => ({
      contents: "export default {};",
      loader: "js",
    }));
  },
});

const { shellClientPlugin } = await import("./index.js");

/**
 * A first-run account: the platform model resolves against a ready ambient
 * Frock AI Connection whose Catalog is fresh, and no Bot has been created yet.
 * The account's model is available, so the shell must not tell the User it is
 * unavailable before they have made their first Bot.
 */
test("does not report the account model unavailable before a Bot exists", async () => {
  const user: UserSettingsViewV1 = {
    schemaVersion: 1,
    revision: 3,
    profile: { name: "FrockBot user" },
    packages: [
      { packageId: "provider-flock-ai", version: "0.0.1", state: "installed" },
    ],
    connections: [
      {
        connectionId: "flock-ai-ambient",
        packageId: "provider-flock-ai",
        connectionTypeId: "flock-ai-account",
        displayName: "Frock AI",
        state: "ready",
        providerType: "flock-ai",
        safeMetadata: {},
        modelCatalog: {
          schemaVersion: 1,
          generation: "flock-ai-static-v1",
          state: "fresh",
          models: [
            {
              providerModelId: "@frock/auto",
              displayName: "Auto (recommended)",
              capabilities: { tools: true, vision: false, reasoning: true },
              source: "discovered",
            },
          ],
        },
      },
    ],
    platformModel: {
      connectionId: "flock-ai-ambient",
      providerModelId: "@frock/auto",
    },
  };

  let provided: Ref<FrockBotWebData> | undefined;
  await shellClientPlugin({
    transport: {
      turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      readApplicationManifest: () =>
        Promise.resolve({
          schemaVersion: 1,
          deployment: { userId: "development", applicationHash: "hash-1" },
          applicationHash: "hash-1",
          packages: [
            {
              id: "provider-flock-ai",
              displayName: "Frock AI",
              version: "0.0.1",
              contributions: ["backend", "runtime"],
              configuration: {
                settings: [],
                connectionTypes: [
                  {
                    id: "flock-ai-account",
                    displayName: "Frock AI",
                    allowMultiple: false,
                    authorization: { kind: "ambient-native" },
                    capabilities: ["flock-ai-models"],
                  },
                ],
                capabilities: [
                  {
                    id: "flock-ai-models",
                    kind: "model",
                    connectionTypes: ["flock-ai-account"],
                    admission: { turnTypes: ["chat"] },
                  },
                ],
              },
            },
          ],
        }),
      readConfiguration: () => Promise.resolve(user),
    },
    slot: () => () => {},
    inject: () => {
      throw new Error("unexpected client provider injection");
    },
    provide: (_key, value) => {
      provided = value as Ref<FrockBotWebData>;
      return () => {};
    },
  });
  if (!provided) throw new Error("shell data was not provided");

  await provided.value.loadPluginCatalog();

  // No Bot has been created, so `activeBotId` is unset.
  expect(provided.value.activeBotId).toBeUndefined();
  expect(provided.value.modelLabel).toBe("Auto (recommended) · Frock AI");
  expect(provided.value.modelReady).toBe(true);
});
