import { describe, expect, test } from "bun:test";
import { defineComponent } from "vue";
import { createClientSurfaceRegistry } from "./surfaces.js";

const Surface = defineComponent(() => () => null);

describe("client surface registry", () => {
  test("opens registered surfaces and closes a disposed active surface", () => {
    const registry = createClientSurfaceRegistry();
    const dispose = registry.register({
      id: "bot-settings",
      title: "Bot settings",
      component: Surface,
    });

    expect(registry.has("bot-settings")).toBe(true);
    registry.open("bot-settings");
    expect(registry.active.value).toMatchObject({
      id: "bot-settings",
      title: "Bot settings",
    });

    dispose();
    expect(registry.active.value).toBeUndefined();
    expect(registry.activeId.value).toBeUndefined();
  });

  test("rejects missing and duplicate surfaces", () => {
    const registry = createClientSurfaceRegistry();
    expect(() => registry.open("missing")).toThrow(
      "client surface is unavailable: missing",
    );
    registry.register({
      id: "plugins",
      title: "Plugins",
      component: Surface,
    });
    expect(() =>
      registry.register({
        id: "plugins",
        title: "Another Plugins view",
        component: Surface,
      }),
    ).toThrow("client surface is already registered: plugins");
  });
});
