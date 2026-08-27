import { describe, expect, test } from "bun:test";
import { type Context, Service, type Plugin } from "cordis";
import { createPluginHarness, verifyPluginPackage } from "./index.js";

class MarkerService extends Service {
  constructor(ctx: Context) {
    super(ctx, "marker");
  }
}

declare module "cordis" {
  interface Context {
    marker: MarkerService;
  }
}

const fixtureManifest = {
  schemaVersion: 2,
  id: "fixture",
  displayName: "Fixture",
  version: "1.2.3",
  compatibility: { frockbot: ">=0.0.1" },
  contributions: {
    runtime: { entry: "./agent" },
    desktop: {
      entry: "./desktop",
      execution: "sandboxed-renderer",
      commands: ["fixture.read"],
    },
  },
  permissions: ["fixture:read"],
};

const fixturePackage = {
  name: "@frockbot/plugin-fixture",
  version: "1.2.3",
  private: true,
  exports: {
    ".": "./src/index.ts",
    "./agent": "./src/agent.ts",
    "./desktop": "./src/desktop.ts",
    "./manifest": "./src/manifest.ts",
    "./frockbot.json": "./frockbot.json",
    "./package.json": "./package.json",
  },
  frockbot: { manifest: "./frockbot.json" },
};

describe("verifyPluginPackage", () => {
  test("verifies package identity and contribution exports", () => {
    expect(
      verifyPluginPackage({
        packageJson: fixturePackage,
        manifest: fixtureManifest,
      }),
    ).toMatchObject({
      name: "@frockbot/plugin-fixture",
      contributionKinds: ["runtime", "desktop"],
      manifest: { id: "fixture", version: "1.2.3" },
    });
  });

  test("reports all package-level compliance failures together", () => {
    let failure: unknown;
    try {
      verifyPluginPackage({
        packageJson: {
          ...fixturePackage,
          name: "fixture",
          version: "9.0.0",
          private: false,
          exports: { ".": "./src/index.ts" },
          frockbot: { manifest: "./other.json" },
        },
        manifest: {
          ...fixtureManifest,
          permissions: ["fixture:read", "fixture:read"],
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("package name must be");
    expect(message).toContain("versions must match");
    expect(message).toContain("must be private");
    expect(message).toContain("./manifest");
    expect(message).toContain("must not contain duplicates");
  });

  test("verifies the mobile contribution export", () => {
    expect(
      verifyPluginPackage({
        packageJson: {
          ...fixturePackage,
          exports: { ...fixturePackage.exports, "./mobile": "./src/mobile.ts" },
        },
        manifest: {
          ...fixtureManifest,
          contributions: {
            ...fixtureManifest.contributions,
            mobile: { entry: "./mobile" },
          },
        },
      }),
    ).toMatchObject({
      contributionKinds: ["runtime", "desktop", "mobile"],
    });
  });

  test("reports a missing mobile contribution export", () => {
    let failure: unknown;
    try {
      verifyPluginPackage({
        packageJson: fixturePackage,
        manifest: {
          ...fixtureManifest,
          contributions: {
            ...fixtureManifest.contributions,
            mobile: { entry: "./mobile" },
          },
        },
      });
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure instanceof Error ? failure.message : "").toContain(
      'package exports must include "./mobile"',
    );
  });
});

describe("PluginHarness", () => {
  test("mounts injected plugins and disposes their effects", async () => {
    let active = false;
    const dependent: Plugin.Function = () => {
      active = true;
      return () => {
        active = false;
      };
    };
    dependent.inject = ["marker"];
    const harness = await createPluginHarness([MarkerService]);

    await harness.mount(dependent);
    expect(active).toBeTrue();

    await harness.dispose();
    expect(active).toBeFalse();
  });

  test("disposes setup plugins when later setup fails", async () => {
    let cleaned = false;
    const tracked: Plugin.Function = () => () => {
      cleaned = true;
    };
    const failing: Plugin.Function = () => {
      throw new Error("setup failed");
    };
    let failure: unknown;

    try {
      await createPluginHarness([tracked, failing]);
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect(cleaned).toBeTrue();
  });
});
