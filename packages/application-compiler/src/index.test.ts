import { describe, expect, test } from "bun:test";
import {
  compileApplicationDeclarations,
  compileApplicationPlan,
  type ApplicationPackageResolver,
  type ApplicationSource,
} from "./index.js";

function runtimeManifest(
  id: string,
  options: {
    version?: string;
    permissions?: string[];
    dependencies?: Record<string, string>;
    compatibility?: string;
  } = {},
) {
  return {
    schemaVersion: 2,
    id,
    displayName: id,
    version: options.version ?? "1.0.0",
    compatibility: { frockbot: options.compatibility ?? ">=0.0.1" },
    dependencies: options.dependencies,
    contributions: { runtime: { entry: "./runtime" } },
    permissions: options.permissions ?? [],
  };
}

function resolver(
  manifests: Record<string, unknown>,
): ApplicationPackageResolver {
  return (specifier) => {
    const manifest = manifests[specifier];
    if (!manifest) return Promise.reject(new Error(`unknown ${specifier}`));
    return Promise.resolve({ specifier, manifest });
  };
}

function selection(
  specifier: string,
  grants: string[] = [],
): ApplicationSource["packages"][number] {
  return { specifier, version: "1.0.0", grants };
}

describe("compileApplicationPlan", () => {
  test("resolves Contribution declarations synchronously before hashing", () => {
    const declarations = compileApplicationDeclarations(
      { schemaVersion: 1, packages: [selection("@fixture/base")] },
      (specifier) => ({ specifier, manifest: runtimeManifest("base") }),
      { frockbotVersion: "1.0.0" },
    );

    expect(declarations.contributions.runtime).toEqual(["base"]);
    expect(declarations).not.toHaveProperty("applicationHash");
  });

  test("orders dependencies and hashes semantic input deterministically", async () => {
    const manifests = {
      "@fixture/base": runtimeManifest("base"),
      "@fixture/feature": runtimeManifest("feature", {
        dependencies: { base: "^1.0.0" },
      }),
    };
    const compile = (packages: ApplicationSource["packages"]) =>
      compileApplicationPlan(
        { schemaVersion: 1, packages },
        resolver(manifests),
        { frockbotVersion: "1.0.0" },
      );

    const first = await compile([
      { ...selection("@fixture/feature"), config: { z: 1, a: true } },
      selection("@fixture/base"),
    ]);
    const second = await compile([
      selection("@fixture/base"),
      { ...selection("@fixture/feature"), config: { a: true, z: 1 } },
    ]);

    expect(first.packages.map((pkg) => pkg.id)).toEqual(["base", "feature"]);
    expect(first.applicationHash).toBe(second.applicationHash);
    expect(first.applicationHash).toHaveLength(64);
  });

  test("normalizes v1 package manifests into the runtime vocabulary", async () => {
    const plan = await compileApplicationPlan(
      { schemaVersion: 1, packages: [selection("@fixture/legacy")] },
      resolver({
        "@fixture/legacy": {
          schemaVersion: 1,
          id: "legacy",
          displayName: "Legacy",
          version: "1.0.0",
          contributions: { agent: "./agent" },
          permissions: [],
        },
      }),
      { frockbotVersion: "1.0.0" },
    );

    expect(plan.contributions.runtime).toEqual(["legacy"]);
    expect(plan.packages[0]?.manifest).toMatchObject({
      schemaVersion: 2,
      compatibility: { frockbot: "*" },
      contributions: { runtime: { entry: "./agent" } },
    });
  });

  test("rejects missing grants and incompatible packages", async () => {
    let grantFailure: unknown;
    try {
      await compileApplicationPlan(
        { schemaVersion: 1, packages: [selection("@fixture/secure")] },
        resolver({
          "@fixture/secure": runtimeManifest("secure", {
            permissions: ["secure:read"],
          }),
        }),
        { frockbotVersion: "1.0.0" },
      );
    } catch (error) {
      grantFailure = error;
    }
    expect(grantFailure instanceof Error ? grantFailure.message : "").toContain(
      'missing grant "secure:read"',
    );

    let compatibilityFailure: unknown;
    try {
      await compileApplicationPlan(
        { schemaVersion: 1, packages: [selection("@fixture/future")] },
        resolver({
          "@fixture/future": runtimeManifest("future", {
            compatibility: ">=2.0.0",
          }),
        }),
        { frockbotVersion: "1.0.0" },
      );
    } catch (error) {
      compatibilityFailure = error;
    }
    expect(
      compatibilityFailure instanceof Error ? compatibilityFailure.message : "",
    ).toContain("is incompatible");
  });

  test("rejects missing dependencies and dependency cycles", async () => {
    let missing: unknown;
    try {
      await compileApplicationPlan(
        { schemaVersion: 1, packages: [selection("@fixture/feature")] },
        resolver({
          "@fixture/feature": runtimeManifest("feature", {
            dependencies: { base: "^1.0.0" },
          }),
        }),
        { frockbotVersion: "1.0.0" },
      );
    } catch (error) {
      missing = error;
    }
    expect(missing instanceof Error ? missing.message : "").toContain(
      'requires missing package "base"',
    );

    const manifests = {
      "@fixture/left": runtimeManifest("left", {
        dependencies: { right: "1.0.0" },
      }),
      "@fixture/right": runtimeManifest("right", {
        dependencies: { left: "1.0.0" },
      }),
    };
    let cycle: unknown;
    try {
      await compileApplicationPlan(
        {
          schemaVersion: 1,
          packages: [selection("@fixture/left"), selection("@fixture/right")],
        },
        resolver(manifests),
        { frockbotVersion: "1.0.0" },
      );
    } catch (error) {
      cycle = error;
    }
    expect(cycle instanceof Error ? cycle.message : "").toContain(
      "dependency cycle",
    );
  });

  test("validates client roots and declared outlets", async () => {
    const clientManifest = (
      id: string,
      slot: string,
      outlets: string[] = [],
    ) => ({
      schemaVersion: 2,
      id,
      displayName: id,
      version: "1.0.0",
      compatibility: { frockbot: ">=0.0.1" },
      contributions: {
        client: { entry: "./client", mounts: [{ slot }], outlets },
      },
      permissions: [],
    });
    let failure: unknown;
    try {
      await compileApplicationPlan(
        {
          schemaVersion: 1,
          packages: [selection("@fixture/a"), selection("@fixture/b")],
        },
        resolver({
          "@fixture/a": clientManifest("a", "root"),
          "@fixture/b": clientManifest("b", "root"),
        }),
        { frockbotVersion: "1.0.0" },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure instanceof Error ? failure.message : "").toContain(
      "multiple client roots",
    );
  });
});
