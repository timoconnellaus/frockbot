import { afterEach, describe, expect, test } from "bun:test";
import { Context } from "cordis";
import {
  type ActiveContribution,
  type ContributionHost,
  type ContributionKind,
  decodeFrockBotManifest,
  declaredContributionKinds,
  LocalCordisContributionHost,
  PackageCatalog,
  type PackageDescriptor,
  type PreparedContribution,
} from "./index.js";

const roots: Context[] = [];

async function createCatalog(): Promise<Context> {
  const root = new Context();
  roots.push(root);
  await root.plugin(PackageCatalog);
  return root;
}

function manifest(id = "fixture") {
  return {
    schemaVersion: 1,
    id,
    displayName: id,
    version: "1.0.0",
    contributions: {
      agent: "./agent",
      desktop: "./host",
      web: { entry: "./client.ts", manifest: "./manifest.json", slots: [] },
    },
    permissions: [],
  };
}

class FakeHost implements ContributionHost {
  readonly kind: ContributionKind;
  private log: string[];
  private failCommit: boolean;

  constructor(kind: ContributionKind, log: string[], failCommit = false) {
    this.kind = kind;
    this.log = log;
    this.failCommit = failCommit;
  }

  prepare(pkg: PackageDescriptor): Promise<PreparedContribution> {
    this.log.push(`prepare:${this.kind}:${pkg.manifest.id}`);
    return Promise.resolve({
      kind: this.kind,
      commit: async (): Promise<ActiveContribution> => {
        this.log.push(`commit:${this.kind}`);
        if (this.failCommit) throw new Error(`${this.kind} commit failed`);
        return {
          dispose: async () => {
            this.log.push(`dispose:${this.kind}`);
          },
        };
      },
      rollback: async () => {
        this.log.push(`rollback:${this.kind}`);
      },
    });
  }
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => root.fiber.dispose()));
});

describe("PackageCatalog", () => {
  test("keeps backend Contributions unavailable to v2 manifests", () => {
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 2,
        id: "legacy",
        displayName: "Legacy",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: {
          backend: { entry: "./backend", host: "gateway" },
        },
        permissions: [],
      }),
    ).toThrow("manifest has no contributions");
    expect(
      decodeFrockBotManifest({
        schemaVersion: 3,
        id: "current",
        displayName: "Current",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: {
          backend: { entry: "./backend", host: "bot" },
        },
        permissions: [],
      }).contributions.backend,
    ).toEqual([{ entry: "./backend", host: "bot" }]);
  });

  test("decodes the reference package manifest", async () => {
    const root = await createCatalog();
    const value = await Bun.file(
      new URL("../../plugin-clock/frockbot.json", import.meta.url),
    ).json();
    const installed = root.packages.install({
      specifier: "@frockbot/plugin-clock",
      manifest: value,
    });

    expect(installed.manifest).toMatchObject({
      schemaVersion: 2,
      id: "clock",
      contributions: {
        runtime: { entry: "./agent" },
        desktop: { entry: "./host", execution: "trusted-main-legacy" },
        client: { mounts: [{ slot: "frockbot.right-panel" }] },
      },
      permissions: ["time:read"],
    });
  });

  test("commits and disables contributions in dependency-safe order", async () => {
    const root = await createCatalog();
    const log: string[] = [];
    root.packages.registerHost(new FakeHost("runtime", log));
    root.packages.registerHost(new FakeHost("client", log));
    root.packages.registerHost(new FakeHost("desktop", log));
    root.packages.install({ specifier: "fixture", manifest: manifest() });

    await root.packages.enable("fixture");
    expect(root.packages.get("fixture")?.status).toBe("active");
    await root.packages.disable("fixture");

    expect(log).toEqual([
      "prepare:runtime:fixture",
      "prepare:client:fixture",
      "prepare:desktop:fixture",
      "commit:runtime",
      "commit:client",
      "commit:desktop",
      "dispose:desktop",
      "dispose:client",
      "dispose:runtime",
    ]);
    expect(root.packages.get("fixture")?.status).toBe("installed");
  });

  test("rolls back prepared and committed contributions after failure", async () => {
    const root = await createCatalog();
    const log: string[] = [];
    root.packages.registerHost(new FakeHost("runtime", log));
    root.packages.registerHost(new FakeHost("client", log));
    root.packages.registerHost(new FakeHost("desktop", log, true));
    root.packages.install({ specifier: "fixture", manifest: manifest() });

    let failure: unknown;
    try {
      await root.packages.enable("fixture");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(failure instanceof Error ? failure.message : "").toContain(
      "desktop commit failed",
    );
    expect(log.slice(-3)).toEqual([
      "dispose:client",
      "dispose:runtime",
      "rollback:desktop",
    ]);
    expect(root.packages.get("fixture")).toMatchObject({
      status: "failed",
      error: "desktop commit failed",
    });
  });

  test("mounts a local mobile contribution behind the host interface", async () => {
    const root = await createCatalog();
    let setups = 0;
    let cleanups = 0;
    const plugin = () => {
      setups += 1;
      return () => {
        cleanups += 1;
      };
    };
    root.packages.registerHost(
      new LocalCordisContributionHost("mobile", root, () =>
        Promise.resolve({ default: plugin }),
      ),
    );
    root.packages.install({
      specifier: "fixture",
      manifest: {
        schemaVersion: 1,
        id: "local-mobile",
        displayName: "Local Mobile",
        version: "1.0.0",
        contributions: { mobile: "./mobile" },
      },
    });

    await root.packages.enable("local-mobile");
    expect(setups).toBe(1);
    await root.packages.disable("local-mobile");
    expect(cleanups).toBe(1);
  });

  test("mounts a local Cordis contribution behind the host interface", async () => {
    const root = await createCatalog();
    let setups = 0;
    let cleanups = 0;
    const plugin = () => {
      setups += 1;
      return () => {
        cleanups += 1;
      };
    };
    root.packages.registerHost(
      new LocalCordisContributionHost("runtime", root, () =>
        Promise.resolve({ default: plugin }),
      ),
    );
    root.packages.install({
      specifier: "fixture",
      manifest: {
        schemaVersion: 1,
        id: "local",
        displayName: "Local",
        version: "1.0.0",
        contributions: { agent: "./agent" },
      },
    });

    await root.packages.enable("local");
    expect(setups).toBe(1);
    await root.packages.disable("local");
    expect(cleanups).toBe(1);
  });
});

describe("decodeFrockBotManifest", () => {
  test("decodes an explicitly hosted backend Contribution", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 3,
      id: "connection-driver",
      displayName: "Connection driver",
      version: "1.0.0",
      compatibility: { frockbot: ">=0.0.1" },
      contributions: {
        backend: { entry: "./backend", host: "gateway" },
      },
      permissions: [],
      configuration: {},
    });
    expect(decoded.contributions.backend).toEqual([
      { entry: "./backend", host: "gateway" },
    ]);
    expect(declaredContributionKinds(decoded)).toEqual(["backend"]);
  });

  test("accepts a manifest that only contributes to mobile", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 1,
      id: "mobile-only",
      displayName: "Mobile Only",
      version: "1.0.0",
      contributions: { mobile: "./mobile" },
      permissions: ["mobile:notifications"],
    });

    expect(decoded.contributions).toEqual({
      runtime: undefined,
      client: undefined,
      desktop: undefined,
      mobile: { entry: "./mobile" },
    });
    expect(declaredContributionKinds(decoded)).toEqual(["mobile"]);
  });

  test("rejects a mobile contribution that is not a relative export path", () => {
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 1,
        id: "mobile-only",
        displayName: "Mobile Only",
        version: "1.0.0",
        contributions: { mobile: "mobile" },
      }),
    ).toThrow('manifest contribution "mobile" must be a relative export path');
  });

  test("decodes manifest v3 settings, Connection Types, and capabilities", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 3,
      id: "composio",
      displayName: "Composio",
      version: "1.0.0",
      compatibility: { frockbot: ">=0.0.1" },
      contributions: { runtime: { entry: "./runtime" } },
      permissions: ["connections:manage"],
      configuration: {
        settings: [
          {
            id: "preferences",
            schemaVersion: 1,
            scopes: ["user"],
            schema: { type: "object", properties: {} },
          },
        ],
        connectionTypes: [
          {
            id: "gmail",
            displayName: "Gmail",
            allowMultiple: true,
            authorization: { kind: "oauth2", driverId: "composio" },
            capabilities: ["gmail-tools"],
          },
        ],
        capabilities: [
          {
            id: "gmail-tools",
            kind: "tool",
            connectionTypes: ["gmail"],
          },
        ],
      },
    });

    expect(decoded).toMatchObject({
      schemaVersion: 3,
      configuration: {
        connectionTypes: [{ id: "gmail", authorization: { kind: "oauth2" } }],
        capabilities: [{ id: "gmail-tools", kind: "tool" }],
      },
    });
  });

  test("rejects remote schema references in manifest v3", () => {
    expect(() =>
      decodeFrockBotManifest({
        schemaVersion: 3,
        id: "unsafe",
        displayName: "Unsafe",
        version: "1.0.0",
        compatibility: { frockbot: "*" },
        contributions: { runtime: { entry: "./runtime" } },
        configuration: {
          settings: [
            {
              id: "unsafe",
              schemaVersion: 1,
              scopes: ["user"],
              schema: { $ref: "https://attacker.test/schema.json" },
            },
          ],
        },
      }),
    ).toThrow("remote schema references are not supported");
  });

  test("orders normalized contribution kinds", () => {
    const decoded = decodeFrockBotManifest({
      schemaVersion: 1,
      id: "every-kind",
      displayName: "Every Kind",
      version: "1.0.0",
      contributions: {
        web: { entry: "./client.ts", manifest: "./manifest.json", slots: [] },
        mobile: "./mobile",
        desktop: "./host",
        agent: "./agent",
      },
    });

    expect(declaredContributionKinds(decoded)).toEqual([
      "runtime",
      "client",
      "desktop",
      "mobile",
    ]);
  });
});
