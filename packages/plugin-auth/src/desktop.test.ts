import { describe, expect, test } from "bun:test";
import { createPluginHarness } from "@frockbot/plugin-testkit";
import manifest from "../frockbot.json" with { type: "json" };
import desktopAuthPlugin, { DesktopAuthCapability } from "./desktop.js";

class FakeDesktopAuthCapability extends DesktopAuthCapability {
  starts = 0;
  stops = 0;

  start(): () => void {
    this.starts += 1;
    return () => {
      this.stops += 1;
    };
  }
}

describe("desktop authentication Contribution", () => {
  test("declares one trusted main-process Contribution", () => {
    expect(manifest.schemaVersion).toBe(3);
    expect(manifest.contributions.desktop).toEqual({
      entry: "./desktop",
      execution: "trusted-main",
      commands: [],
    });
  });

  test("owns setup and cleanup for its mounted lifetime", async () => {
    const harness = await createPluginHarness([FakeDesktopAuthCapability]);
    const capability = harness.root
      .desktopAuthCapability as FakeDesktopAuthCapability;

    const mounted = await harness.mount(desktopAuthPlugin);
    expect(capability.starts).toBe(1);
    expect(capability.stops).toBe(0);

    await mounted.dispose();
    expect(capability.stops).toBe(1);
  });
});
