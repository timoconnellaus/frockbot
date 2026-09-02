import { describe, expect, it } from "bun:test";
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

    expect(slots.map((slot) => slot.slot)).toEqual([
      "frockbot.sidebar-actions",
      "frockbot.user-profile",
      "frockbot.right-panel",
      "frockbot.bot-actions",
    ]);
    // Composition is an internal detail the Settings Package no longer shows,
    // so it provides no client state of its own.
    expect(provided).toEqual([]);
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
