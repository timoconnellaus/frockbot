import { describe, expect, test } from "bun:test";
import type { PackageIframeHostMessageV2 } from "@frockbot/kernel-contracts";
import { postPackageIframeHostMessage } from "./package-iframe-host-message.js";

describe("Package iframe host messages", () => {
  test("posts unchanged state once and posts changed state again", () => {
    const posted: PackageIframeHostMessageV2[] = [];
    const target = {
      postMessage(message: PackageIframeHostMessageV2): void {
        posted.push(message);
      },
    } as Pick<Window, "postMessage">;
    const lastStateWireByName = new Map<string, string>();

    const postSettings = (value: unknown): void =>
      postPackageIframeHostMessage(
        target,
        { schemaVersion: 1, type: "state", name: "settings", value },
        lastStateWireByName,
      );

    postSettings({ temperatureUnit: "celsius" });
    postSettings({ temperatureUnit: "celsius" });
    postSettings({ temperatureUnit: "fahrenheit" });

    expect(posted).toEqual([
      {
        schemaVersion: 1,
        type: "state",
        name: "settings",
        value: { temperatureUnit: "celsius" },
      },
      {
        schemaVersion: 1,
        type: "state",
        name: "settings",
        value: { temperatureUnit: "fahrenheit" },
      },
    ]);
  });
});
