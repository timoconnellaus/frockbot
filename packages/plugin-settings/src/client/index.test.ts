import { describe, expect, it } from "bun:test";
import { ref } from "vue";
import { authSessionClientKey } from "@frockbot/plugin-auth/shared";
import { settingsFrameClientKey } from "./settings-frames.js";
import {
  clientSurfaceRegistryKey,
  type ClientPluginContext,
  type ClientSlotRegistration,
} from "@frockbot/client-core";
import { createClientSurfaceRegistry } from "@frockbot/client-ui";
import manifest from "../../frockbot.json";
import { settingsClientPlugin } from "./index.js";

describe("settings client contribution", () => {
  it("registers feature surfaces and shell-owned trigger seats", () => {
    const surfaces = createClientSurfaceRegistry();
    const slots: ClientSlotRegistration[] = [];
    const provided: unknown[] = [];
    const context: ClientPluginContext = {
      transport: {
        turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
      },
      inject: (key) => {
        if (key === authSessionClientKey)
          return {
            projection: ref({ schemaVersion: 1, status: "anonymous" }),
          } as never;
        if (key !== clientSurfaceRegistryKey) {
          throw new Error("unexpected client provider");
        }
        return surfaces as never;
      },
      provide: (key) => {
        provided.push(key);
        return () => {};
      },
      slot: (registration) => {
        slots.push(registration);
        return () => slots.splice(slots.indexOf(registration), 1);
      },
    };

    const result = settingsClientPlugin(context);
    if (!Array.isArray(result)) throw new Error("expected owned registrations");

    // Connectors is reached from the User menu with Models and Plugins, and
    // from nowhere else: no second sidebar entry for the same panel.
    expect(slots.map((slot) => slot.slot)).toEqual([
      "frockbot.user-profile",
      "frockbot.right-panel",
      "frockbot.bot-actions",
    ]);
    expect(provided).toEqual([settingsFrameClientKey]);
    for (const id of [
      "bot-settings",
      "plugins",
      "models",
      "connections",
      "package-catalog",
      "user-settings",
    ]) {
      expect(surfaces.has(id)).toBe(true);
    }
    surfaces.open("connections");
    expect(surfaces.active.value?.title).toBe("Connectors");
    surfaces.close();
    expect(manifest.contributions.client.outlets).toContain(
      "frockbot.models-sections",
    );

    for (const dispose of result.toReversed()) dispose();
    expect(slots).toEqual([]);
    expect(surfaces.active.value).toBeUndefined();
    for (const id of [
      "bot-settings",
      "plugins",
      "models",
      "connections",
      "package-catalog",
      "user-settings",
    ]) {
      expect(surfaces.has(id)).toBe(false);
    }
  });
});
