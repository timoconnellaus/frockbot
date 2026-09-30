/**
 * The equivalence gate.
 *
 * A Worker name, Durable Object class or migration tag that differs on deploy is
 * a new namespace, which is data loss. `scripts/deployment-config/fixtures/hosted/`
 * holds the four wrangler configs exactly as production ran them before
 * deployment identity moved into `deployments/`, and this proves the generated
 * hosted and staging configs are still those — comments, key order and the
 * relative spelling of paths aside.
 *
 * When a binding, migration or var legitimately changes, the fixture is updated
 * in the same commit. That is the point: the change is seen.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  AUTH_PACKAGE_CHOOSERS_V1,
  BRAND_ALIAS_V1,
  CONTAINER_IMAGE_REPOSITORIES_V1,
  DEPLOYABLE_WORKERS_V1,
  generateProfileConfigsV1 as generateProfileConfigsInV1,
  generateWorkerConfigV1 as generateWorkerConfigInV1,
  PAYMENTS_CHOOSERS_V1,
  profilePaymentsPackageV1,
  profileWorkersV1,
  PUBLISHED_IMAGE_REGISTRY_V1,
  validateProfileAuthPackageV1,
  validateProfileBrandV1,
  validateProfilePaymentsPackageV1,
  type DeployableWorkerV1,
  type GenerateOptionsV1,
} from "../apps/cloudflare/deployment-config/generate.ts";
import { parseJsoncV1 } from "../apps/cloudflare/deployment-config/jsonc.ts";
import {
  DEPLOYMENT_PROFILE_SCHEMA_V1,
  DEPLOYMENT_REGIONS_V1,
  deploymentRegionV1,
  loadProfileV1 as loadProfileFromV1,
  PROFILE_SCHEMA_FILE_V1,
  validateProfileV1,
} from "../apps/cloudflare/deployment-config/profile.ts";
import {
  PROFILE_DIRECTORY_V1,
  REPO_ROOT_V1,
} from "./deployment-config/repository.ts";

/** This repository's own profiles, as `bun run deployment:config` reads them. */
function loadProfileV1(name: string) {
  return loadProfileFromV1(name, PROFILE_DIRECTORY_V1);
}

type TestOptionsV1 = Omit<
  GenerateOptionsV1,
  "profileDirectory" | "outputRoot"
> &
  Partial<Pick<GenerateOptionsV1, "profileDirectory" | "outputRoot">>;

function withRepositoryDefaults(options: TestOptionsV1): GenerateOptionsV1 {
  return {
    profileDirectory: PROFILE_DIRECTORY_V1,
    outputRoot: join(REPO_ROOT_V1, ".deployment"),
    ...options,
  };
}

function generateWorkerConfigV1(
  worker: DeployableWorkerV1,
  options: TestOptionsV1,
) {
  return generateWorkerConfigInV1(worker, withRepositoryDefaults(options));
}

function generateProfileConfigsV1(options: TestOptionsV1) {
  return generateProfileConfigsInV1(withRepositoryDefaults(options));
}

const FIXTURE_DIRECTORY = join(
  import.meta.dirname,
  "deployment-config",
  "fixtures",
  "hosted",
);

const FIXTURE_FILES: Record<DeployableWorkerV1, string> = {
  app: "app.wrangler.jsonc",
  computerHost: "computer-host.wrangler.jsonc",
  appletBuild: "applet-build.wrangler.jsonc",
  marketing: "marketing.wrangler.jsonc",
  adminPortal: "admin-portal.wrangler.jsonc",
  pushRelay: "push-relay.wrangler.jsonc",
};

/**
 * The staging deploy resolves this from `wrangler d1 list` and hands it to the
 * generator; the fixture carries the placeholder the deploy used to rewrite. The
 * gate compares the shape, so it compares the same identifier on both sides.
 */
const STAGING_D1_PLACEHOLDER = "00000000-0000-0000-0000-000000000000";

/**
 * Keys a named environment does not inherit. Wrangler resolves `--env staging`
 * as the top level for everything else, so a shallow overlay is that resolution
 * exactly — provided staging redefines each of these, which is asserted below.
 */
const NON_INHERITED_KEYS = [
  "vars",
  "durable_objects",
  "r2_buckets",
  "d1_databases",
  "vectorize",
  "ai",
  "services",
  "worker_loaders",
  "kv_namespaces",
  "queues",
  "hyperdrive",
  "analytics_engine_datasets",
] as const;

type Config = Record<string, unknown>;

function fixture(worker: DeployableWorkerV1): Config {
  const file = join(FIXTURE_DIRECTORY, FIXTURE_FILES[worker]);
  return parseJsoncV1(readFileSync(file, "utf8"), file) as Config;
}

/** Where a fixture's relative paths were relative to: the app it was copied from. */
function fixtureBase(worker: DeployableWorkerV1): string {
  return join(REPO_ROOT_V1, "apps", DEPLOYABLE_WORKERS_V1[worker].directory);
}

/**
 * The deployed shape of a fixture: no `env` (a named environment is a different
 * Worker, and `development` and `e2e` are never deployed) and every path made
 * absolute, so the two sides are compared by what they point at rather than by
 * how they spell it.
 */
function deployedShape(config: Config, base: string): Config {
  const shape = structuredClone(config);
  delete shape.env;
  absolutizePaths(shape, base);
  return shape;
}

function absolutizePaths(config: Config, base: string): void {
  const absolute = (value: unknown): string | undefined =>
    typeof value === "string" && value !== "" && !isAbsolute(value)
      ? resolve(base, value)
      : undefined;
  for (const key of ["$schema", "main"] as const) {
    const next = absolute(config[key]);
    if (next !== undefined) config[key] = next;
  }
  const assets = config.assets as Config | undefined;
  if (assets) {
    const next = absolute(assets.directory);
    if (next !== undefined) assets.directory = next;
  }
  for (const database of (config.d1_databases as Config[] | undefined) ?? []) {
    const next = absolute(database.migrations_dir);
    if (next !== undefined) database.migrations_dir = next;
  }
  for (const container of (config.containers as Config[] | undefined) ?? []) {
    for (const key of ["image", "image_build_context"] as const) {
      const next = absolute(container[key]);
      if (next !== undefined) container[key] = next;
    }
  }
}

/** What `wrangler deploy --env staging` resolved from the fixture. */
function fixtureStagingShape(): Config {
  const config = fixture("app");
  const environments = config.env as Record<string, Config>;
  const staging = environments.staging;
  expect(
    staging,
    "the fixture still carries the staging environment",
  ).toBeDefined();
  const inherited = structuredClone(config);
  delete inherited.env;
  // Not inherited by a named environment either, and staging binds no sender,
  // so `wrangler deploy --env staging` resolves none.
  delete inherited.send_email;
  for (const key of NON_INHERITED_KEYS) {
    if (key in inherited) {
      expect(
        staging!,
        `staging must redefine the non-inherited key ${key}`,
      ).toHaveProperty(key);
      delete inherited[key];
    }
  }
  const shape = { ...inherited, ...structuredClone(staging!) };
  absolutizePaths(shape, fixtureBase("app"));
  return shape;
}

describe("the hosted deployment profile", () => {
  const generated = generateProfileConfigsV1({
    profile: loadProfileV1("hosted"),
  });

  test("generates every deployable", () => {
    expect(generated.map((entry) => entry.worker).sort()).toEqual(
      (Object.keys(DEPLOYABLE_WORKERS_V1) as DeployableWorkerV1[]).sort(),
    );
  });

  for (const entry of generated) {
    test(`${entry.worker} is what production runs today`, () => {
      const produced = structuredClone(entry.config);
      absolutizePaths(produced, dirname(entry.file));
      expect(produced).toEqual(
        deployedShape(fixture(entry.worker), fixtureBase(entry.worker)),
      );
    });
  }
});

describe("the staging deployment profile", () => {
  const profile = loadProfileV1("staging");
  const generated = generateProfileConfigsV1({
    profile,
    d1DatabaseId: STAGING_D1_PLACEHOLDER,
  });

  test("deploys the app Worker and nothing hosted-only", () => {
    // No marketing site and no admin portal: with Access deciding admission
    // there is nothing for a portal to administer, and a profile that names
    // neither has neither generated.
    expect(profileWorkersV1(profile)).toEqual([
      "app",
      "computerHost",
      "appletBuild",
    ]);
    expect(() => generateWorkerConfigV1("adminPortal", { profile })).toThrow(
      /does not deploy adminPortal/,
    );
  });

  test("the app Worker is what staging runs today", () => {
    const app = generated.find((entry) => entry.worker === "app")!;
    const produced = structuredClone(app.config);
    absolutizePaths(produced, dirname(app.file));
    expect(produced).toEqual(fixtureStagingShape());
  });

  test("its Computer host and build service are production's", () => {
    // Deliberate: both are stateless request handlers holding no per-user data,
    // so staging exercises the ones production runs rather than paying for a
    // second container deployment.
    for (const worker of ["computerHost", "appletBuild"] as const) {
      const entry = generated.find((candidate) => candidate.worker === worker)!;
      const produced = structuredClone(entry.config);
      absolutizePaths(produced, dirname(entry.file));
      expect(produced).toEqual(
        deployedShape(fixture(worker), fixtureBase(worker)),
      );
    }
  });
});

describe("the generator", () => {
  test("rewrites every path to resolve from where the config is written", () => {
    const app = generateWorkerConfigV1("app", {
      profile: loadProfileV1("hosted"),
    });
    const directory = dirname(app.file);
    const cloudflare = join(REPO_ROOT_V1, "apps", "cloudflare");
    expect(resolve(directory, String(app.config.main))).toBe(
      join(cloudflare, "src", "index.ts"),
    );
    expect(
      resolve(directory, String((app.config.assets as Config).directory)),
    ).toBe(join(cloudflare, "dist", "web"));
    expect(
      resolve(
        directory,
        String((app.config.d1_databases as Config[])[0]!.migrations_dir),
      ),
    ).toBe(join(cloudflare, "migrations"));

    const host = generateWorkerConfigV1("computerHost", {
      profile: loadProfileV1("hosted"),
    });
    const container = (host.config.containers as Config[])[0]!;
    expect(resolve(dirname(host.file), String(container.image))).toBe(
      join(REPO_ROOT_V1, "apps", "computer-host", "Dockerfile"),
    );
    expect(
      resolve(dirname(host.file), String(container.image_build_context)),
    ).toBe(REPO_ROOT_V1);
  });

  test("refuses a better-auth profile with no database", () => {
    const profile = loadProfileV1("staging");
    expect(() => generateWorkerConfigV1("app", { profile })).toThrow(
      /names no d1DatabaseId/,
    );
  });

  test("gives a Worker with no hostname its workers.dev name", () => {
    const profile = {
      ...loadProfileV1("hosted"),
      name: "simple",
      workers: { app: {} },
    };
    const app = generateWorkerConfigV1("app", {
      profile: profile as ReturnType<typeof loadProfileV1>,
    });
    expect(app.config.routes).toBeUndefined();
    expect(app.config.workers_dev).toBe(true);
    expect(app.config.name).toBe("frockbot");
  });

  test("builds the container images from the Dockerfile by default", () => {
    // What the hosted profile still does, and what the equivalence gate above
    // depends on: production's deploy builds its own images.
    for (const worker of ["computerHost", "appletBuild"] as const) {
      const generated = generateWorkerConfigV1(worker, {
        profile: loadProfileV1("hosted"),
      });
      const container = (generated.config.containers as Config[])[0]!;
      expect(String(container.image)).toEndWith("Dockerfile");
      expect(container.image_build_context).toBeDefined();
    }
  });

  test("pulls the published images when the profile names a registry", () => {
    const profile = {
      ...loadProfileV1("hosted"),
      name: "simple",
      images: {
        source: "registry" as const,
        registry: PUBLISHED_IMAGE_REGISTRY_V1,
        tag: "1.2.3",
      },
    };
    for (const worker of ["computerHost", "appletBuild"] as const) {
      const generated = generateWorkerConfigV1(worker, { profile });
      const container = (generated.config.containers as Config[])[0]!;
      expect(container.image).toBe(
        `${PUBLISHED_IMAGE_REGISTRY_V1}/${CONTAINER_IMAGE_REPOSITORIES_V1[worker]}:1.2.3`,
      );
      // A pulled image has nothing to build, and wrangler refuses the pair.
      expect(container).not.toHaveProperty("image_build_context");
    }
  });

  test("refuses a pulled image with no tag", () => {
    // The tag is the release the deployment is running; without it wrangler
    // would be handed a reference with nothing to resolve.
    expect(() =>
      validateProfileV1(
        {
          ...loadProfileV1("hosted"),
          images: {
            source: "registry",
            registry: PUBLISHED_IMAGE_REGISTRY_V1,
          },
        },
        "a profile",
      ),
    ).toThrow(/tag/);
  });

  test("the generated profile type is the schema file", () => {
    expect(DEPLOYMENT_PROFILE_SCHEMA_V1).toEqual(
      JSON.parse(readFileSync(PROFILE_SCHEMA_FILE_V1, "utf8")),
    );
  });

  test("the region enum is the schema's", () => {
    expect(DEPLOYMENT_REGIONS_V1).toEqual([
      "wnam",
      "enam",
      "weur",
      "eeur",
      "apac",
      "oc",
    ]);
    expect(deploymentRegionV1("enam")).toBe("enam");
    expect(() => deploymentRegionV1("us-east")).toThrow(/region/);
  });

  test("refuses an Access profile that names no Access application", () => {
    expect(() =>
      validateProfileV1(
        {
          ...loadProfileV1("hosted"),
          name: "simple",
          authPackage: "access",
        },
        "a profile",
      ),
    ).toThrow(/access/);
  });

  test("the Access Package binds no database", () => {
    const profile = {
      ...loadProfileV1("hosted"),
      name: "simple",
      authPackage: "access" as const,
      access: {
        teamDomain: "example.cloudflareaccess.com",
        aud: "a".repeat(64),
      },
    };
    const app = generateWorkerConfigV1("app", { profile });
    expect(app.config.d1_databases).toBeUndefined();
    expect((app.config.vars as Config).ACCESS_TEAM_DOMAIN).toBe(
      "example.cloudflareaccess.com",
    );
  });

  test("aliases the sign-in Package the profile builds", () => {
    // The whole of how a deployment chooses its auth Package: the tracked source
    // resolves `#auth-package` to the better-auth chooser, and this alias is what
    // makes the Access build's bundle carry the other one instead — and no
    // better-auth at all.
    const app = generateWorkerConfigV1("app", {
      profile: {
        ...loadProfileV1("hosted"),
        name: "simple",
        authPackage: "access" as const,
        access: {
          teamDomain: "example.cloudflareaccess.com",
          aud: "a".repeat(64),
        },
      },
    });
    const alias = app.config.alias as Config;
    expect(resolve(dirname(app.file), String(alias["#auth-package"]))).toBe(
      join(REPO_ROOT_V1, "apps", "cloudflare", "src", "auth-package.access.ts"),
    );
  });

  test("every chooser it can alias to is a file that is there", () => {
    // A renamed chooser would be aliased to a path wrangler cannot resolve, and
    // the only place that shows up is a failed deploy.
    for (const chooser of Object.values(AUTH_PACKAGE_CHOOSERS_V1)) {
      expect(
        existsSync(join(REPO_ROOT_V1, "apps", "cloudflare", chooser)),
      ).toBe(true);
    }
  });

  test("writes no alias for the build the tracked source already resolves", () => {
    // Which is what keeps the hosted and staging configs byte-for-byte what
    // production runs, so the equivalence gate above has nothing new to approve.
    for (const name of ["hosted", "staging"]) {
      const app = generateWorkerConfigV1("app", {
        profile: loadProfileV1(name),
        d1DatabaseId: STAGING_D1_PLACEHOLDER,
      });
      expect(app.config.alias).toBeUndefined();
    }
  });

  test("aliases the brand a profile names, relative to the profile", async () => {
    const fixtures = join(import.meta.dirname, "deployment-config", "fixtures");
    const profile = {
      ...loadProfileV1("hosted"),
      name: "white-label",
      brand: "./white-label/brand.ts",
    };
    validateProfileV1(profile, "a profile");
    await validateProfileBrandV1(profile, fixtures);
    const app = generateWorkerConfigV1("app", {
      profile,
      profileDirectory: fixtures,
    });
    const alias = app.config.alias as Config;
    expect(String(alias[BRAND_ALIAS_V1])).toStartWith("../");
    expect(resolve(dirname(app.file), String(alias[BRAND_ALIAS_V1]))).toBe(
      join(fixtures, "white-label", "brand.ts"),
    );
    // The brand is the app Worker's alone.
    const host = generateWorkerConfigV1("computerHost", {
      profile,
      profileDirectory: fixtures,
    });
    expect(host.config.alias).toBeUndefined();
  });

  test("refuses a brand module that is missing or is not a brand", async () => {
    const hosted = loadProfileV1("hosted");
    const directory = mkdtempSync(join(tmpdir(), "frockbot-brand-"));
    await expect(
      validateProfileBrandV1({ ...hosted, brand: "./absent.ts" }, directory),
    ).rejects.toThrow(/no .*absent\.ts/);
    writeFileSync(
      join(directory, "brand.ts"),
      "export const BRAND_V1 = { schemaVersion: 1, productName: 'Pal' };\n",
    );
    await expect(
      validateProfileBrandV1({ ...hosted, brand: "./brand.ts" }, directory),
    ).rejects.toThrow(/brand must carry exactly/);
    // A hosted profile names none, and FrockBot's own is the tracked default.
    await validateProfileBrandV1(hosted, PROFILE_DIRECTORY_V1);
  });

  describe("a white-label's own auth Package", () => {
    const fixtures = join(import.meta.dirname, "deployment-config", "fixtures");
    const external = {
      ...loadProfileV1("hosted"),
      name: "white-label",
      authPackage: "./white-label/auth-package.ts",
      authEnvironment: {
        secrets: [{ name: "STUB_SIGN_IN_SECRET", why: "Signs every session." }],
        vars: { STUB_SIGN_IN_APP_ID: "app-123" },
      },
    };
    const { d1DatabaseId: _none, ...withoutDatabase } = external;

    test("is aliased by path, relative to the profile", async () => {
      validateProfileV1(withoutDatabase, "a profile");
      await validateProfileAuthPackageV1(withoutDatabase, fixtures);
      const app = generateWorkerConfigV1("app", {
        profile: withoutDatabase,
        profileDirectory: fixtures,
      });
      const alias = app.config.alias as Config;
      expect(String(alias["#auth-package"])).toStartWith("../");
      expect(resolve(dirname(app.file), String(alias["#auth-package"]))).toBe(
        join(fixtures, "white-label", "auth-package.ts"),
      );
      // Its vars are written; its secrets are the deploy's, never the config's.
      const vars = app.config.vars as Config;
      expect(vars.STUB_SIGN_IN_APP_ID).toBe("app-123");
      expect(vars).not.toHaveProperty("STUB_SIGN_IN_SECRET");
      expect(vars).not.toHaveProperty("ACCESS_AUD");
      // Nothing to store in unless the profile names a database for it.
      expect(app.config.d1_databases).toBeUndefined();
    });

    test("binds AUTH_DB when the profile names a database", () => {
      const app = generateWorkerConfigV1("app", {
        profile: external,
        profileDirectory: fixtures,
      });
      expect((app.config.d1_databases as Config[])[0]!.database_id).toBe(
        external.d1DatabaseId,
      );
    });

    test("must be told where every setting it requires comes from", async () => {
      await expect(
        validateProfileAuthPackageV1(
          {
            ...withoutDatabase,
            authEnvironment: { vars: { STUB_SIGN_IN_APP_ID: "app-123" } },
          },
          fixtures,
        ),
      ).rejects.toThrow(/Required and not named: STUB_SIGN_IN_SECRET/);
      await expect(
        validateProfileAuthPackageV1(
          {
            ...withoutDatabase,
            authEnvironment: {
              ...withoutDatabase.authEnvironment,
              vars: { STUB_SIGN_IN_APP_ID: "a", UNREAD: "b" },
            },
          },
          fixtures,
        ),
      ).rejects.toThrow(/Named and not required: UNREAD/);
    });

    test("is refused when missing, or when it claims a built-in name", async () => {
      await expect(
        validateProfileAuthPackageV1(
          { ...withoutDatabase, authPackage: "./absent.ts" },
          fixtures,
        ),
      ).rejects.toThrow(/no .*absent\.ts/);
      const directory = mkdtempSync(join(tmpdir(), "frockbot-auth-"));
      writeFileSync(
        join(directory, "chooser.ts"),
        "export const AUTH_PACKAGE_V1 = { id: 'access', required: [] };\n",
      );
      await expect(
        validateProfileAuthPackageV1(
          {
            ...withoutDatabase,
            authPackage: "./chooser.ts",
            authEnvironment: {},
          },
          directory,
        ),
      ).rejects.toThrow(/names itself "access"/);
    });

    test("the schema requires authEnvironment for a path and refuses it otherwise", () => {
      const { authEnvironment: _unnamed, ...bare } = withoutDatabase;
      expect(() => validateProfileV1(bare, "a profile")).toThrow(
        /authEnvironment/,
      );
      expect(() =>
        validateProfileV1(
          { ...loadProfileV1("hosted"), authEnvironment: {} },
          "a profile",
        ),
      ).toThrow(/authEnvironment/);
      expect(() =>
        validateProfileV1(
          { ...withoutDatabase, authPackage: "my-sign-in" },
          "a profile",
        ),
      ).toThrow(/authPackage/);
    });
  });

  describe("the payments Package", () => {
    const fixtures = join(import.meta.dirname, "deployment-config", "fixtures");
    const hosted = () => loadProfileV1("hosted");
    const external = () => ({
      ...hosted(),
      name: "white-label",
      payments: "./white-label/payments.ts" as const,
      paymentsEnvironment: {
        secrets: [
          { name: "STUB_PAYMENTS_SECRET", why: "Verifies payment events." },
        ],
        vars: { STUB_PAYMENTS_ACCOUNT: "acct-123" },
      },
    });

    test("is Stripe when a profile names it or names none, with no alias", () => {
      const { payments: _stripe, ...unnamed } = hosted();
      validateProfileV1(unnamed, "a profile");
      for (const profile of [hosted(), unnamed]) {
        const app = generateWorkerConfigV1("app", { profile });
        expect(app.config.alias).toBeUndefined();
      }
    });

    test("aliases the build that does not bill", () => {
      const app = generateWorkerConfigV1("app", {
        profile: { ...hosted(), payments: "none" as const },
      });
      const alias = app.config.alias as Config;
      expect(resolve(dirname(app.file), String(alias["#payments"]))).toBe(
        join(REPO_ROOT_V1, "apps", "cloudflare", "src", "payments.none.ts"),
      );
      for (const chooser of Object.values(PAYMENTS_CHOOSERS_V1))
        expect(
          existsSync(join(REPO_ROOT_V1, "apps", "cloudflare", chooser)),
        ).toBe(true);
    });

    test("a white-label's own is aliased by path and gets its vars, never its secrets", async () => {
      const profile = external();
      validateProfileV1(profile, "a profile");
      await validateProfilePaymentsPackageV1(profile, fixtures);
      const app = generateWorkerConfigV1("app", {
        profile,
        profileDirectory: fixtures,
      });
      const alias = app.config.alias as Config;
      expect(String(alias["#payments"])).toStartWith("../");
      expect(resolve(dirname(app.file), String(alias["#payments"]))).toBe(
        join(fixtures, "white-label", "payments.ts"),
      );
      const vars = app.config.vars as Config;
      expect(vars.STUB_PAYMENTS_ACCOUNT).toBe("acct-123");
      expect(vars).not.toHaveProperty("STUB_PAYMENTS_SECRET");
      expect(await profilePaymentsPackageV1(profile, fixtures)).toEqual({
        id: "stub-payments",
        required: [
          { name: "STUB_PAYMENTS_SECRET", why: "Verifies payment events." },
        ],
      });
      expect(
        await profilePaymentsPackageV1(hosted(), fixtures),
      ).toBeUndefined();
    });

    test("a white-label's own must be told where every setting comes from, and name itself", async () => {
      const profile = external();
      await expect(
        validateProfilePaymentsPackageV1(
          {
            ...profile,
            paymentsEnvironment: { vars: { STUB_PAYMENTS_ACCOUNT: "a" } },
          },
          fixtures,
        ),
      ).rejects.toThrow(/Required and not named: STUB_PAYMENTS_SECRET/);
      await expect(
        validateProfilePaymentsPackageV1(
          { ...profile, payments: "./absent.ts" },
          fixtures,
        ),
      ).rejects.toThrow(/no .*absent\.ts/);
      const directory = mkdtempSync(join(tmpdir(), "frockbot-payments-"));
      writeFileSync(
        join(directory, "chooser.ts"),
        "export const PAYMENTS_PACKAGE_V1 = { id: 'stripe', required: [], plan: {} };\n",
      );
      await expect(
        validateProfilePaymentsPackageV1(
          { ...profile, payments: "./chooser.ts", paymentsEnvironment: {} },
          directory,
        ),
      ).rejects.toThrow(/names itself "stripe"/);
    });

    test("the schema requires paymentsEnvironment for a path and refuses it otherwise", () => {
      const { paymentsEnvironment: _unnamed, ...bare } = external();
      expect(() => validateProfileV1(bare, "a profile")).toThrow(
        /paymentsEnvironment/,
      );
      expect(() =>
        validateProfileV1(
          { ...hosted(), paymentsEnvironment: {} },
          "a profile",
        ),
      ).toThrow(/paymentsEnvironment/);
      expect(() =>
        validateProfileV1(
          { ...hosted(), payments: "my-payments" },
          "a profile",
        ),
      ).toThrow(/payments/);
    });
  });

  test("uploads a profile's own web client, relative to the profile", () => {
    const fixtures = join(import.meta.dirname, "deployment-config", "fixtures");
    const app = generateWorkerConfigV1("app", {
      profile: { ...loadProfileV1("hosted"), webClient: "./white-label/web" },
      profileDirectory: fixtures,
    });
    const assets = app.config.assets as Config;
    expect(resolve(dirname(app.file), String(assets.directory))).toBe(
      join(fixtures, "white-label", "web"),
    );
    // Everything else about the assets is the tracked file's.
    expect(assets.html_handling).toBe("none");
  });

  test("hands the Worker the signed native apps as one var", () => {
    const hosted = loadProfileV1("hosted");
    const app = generateWorkerConfigV1("app", { profile: hosted });
    expect(JSON.parse(String((app.config.vars as Config).NATIVE_APPS))).toEqual(
      hosted.nativeApps,
    );
    const { nativeApps: _none, ...bare } = hosted;
    expect(
      generateWorkerConfigV1("app", { profile: bare }).config.vars as Config,
    ).not.toHaveProperty("NATIVE_APPS");
    expect(() =>
      validateProfileV1(
        { ...hosted, nativeApps: { android: [{ packageName: "com.x" }] } },
        "a profile",
      ),
    ).toThrow(/sha256CertFingerprints/);
    expect(() =>
      validateProfileV1(
        { ...hosted, nativeApps: { apple: ["com.frockbot.mobile"] } },
        "a profile",
      ),
    ).toThrow(/apple/);
  });

  test("gives the app Worker the email domain and a sender for it", () => {
    const hosted = generateWorkerConfigV1("app", {
      profile: loadProfileV1("hosted"),
    });
    expect((hosted.config.vars as Config).EMAIL_DOMAIN).toBe(
      "bots.frockbot.com",
    );
    // The binding cannot name a domain, so it names no sender at all and the
    // sender holds every `from` to `EMAIL_DOMAIN` itself.
    expect(hosted.config.send_email).toEqual([{ name: "SEND_EMAIL" }]);
    // The app Worker is the only one that receives or sends.
    const portal = generateWorkerConfigV1("adminPortal", {
      profile: loadProfileV1("hosted"),
    });
    expect(portal.config.send_email).toBeUndefined();
    // A profile that names no domain has neither: staging today.
    const staging = generateWorkerConfigV1("app", {
      profile: loadProfileV1("staging"),
      d1DatabaseId: STAGING_D1_PLACEHOLDER,
    });
    expect(staging.config.send_email).toBeUndefined();
    expect(staging.config.vars as Config).not.toHaveProperty("EMAIL_DOMAIN");
    expect(() =>
      validateProfileV1(
        { ...loadProfileV1("hosted"), email: { domain: "not a domain" } },
        "hosted",
      ),
    ).toThrow(/email/);
    expect(() =>
      validateProfileV1(
        {
          ...loadProfileV1("hosted"),
          email: { senderAddress: "bot@frockbot.com" },
        },
        "hosted",
      ),
    ).toThrow();
  });

  test("names the artifact the deployment uploaded, not the placeholder", () => {
    // A Worker whose `DEFAULT_APPLICATION_HASH` still says `foundation-v1` looks
    // in R2 for an object nobody put there.
    const hash = "b".repeat(64);
    const app = generateWorkerConfigV1("app", {
      profile: loadProfileV1("hosted"),
      applicationHash: hash,
    });
    expect((app.config.vars as Config).DEFAULT_APPLICATION_HASH).toBe(hash);
    const untouched = generateWorkerConfigV1("app", {
      profile: loadProfileV1("hosted"),
    });
    expect((untouched.config.vars as Config).DEFAULT_APPLICATION_HASH).toBe(
      "foundation-v1",
    );
  });
});

/**
 * A profile that pulls names the image `release.yml` pushed. If the two spellings
 * ever drift, every installer written against a tag deploys a Worker whose
 * container image does not exist, and the failure appears only when a Bot first
 * asks for a Computer.
 */
describe("the published container images", () => {
  const workflow = readFileSync(
    join(REPO_ROOT_V1, ".github", "workflows", "release.yml"),
    "utf8",
  );

  test(`release.yml pushes to ${PUBLISHED_IMAGE_REGISTRY_V1}`, () => {
    expect(workflow).toContain(PUBLISHED_IMAGE_REGISTRY_V1);
  });

  for (const [worker, repository] of Object.entries(
    CONTAINER_IMAGE_REPOSITORIES_V1,
  )) {
    test(`release.yml publishes ${repository}`, () => {
      expect(workflow).toContain(repository);
      expect(workflow).toContain(
        `${DEPLOYABLE_WORKERS_V1[worker as DeployableWorkerV1].directory}/Dockerfile`,
      );
    });
  }
});

/**
 * `main.yml`'s `deploy-staging` creates staging's buckets, index and database
 * before it generates the config that binds them. A name that drifted from the
 * profile would provision a bucket the Worker never opens, and nothing would
 * fail loudly.
 */
describe("the staging provisioning steps", () => {
  const workflow = readFileSync(
    join(REPO_ROOT_V1, ".github", "workflows", "main.yml"),
    "utf8",
  );
  const app = generateWorkerConfigV1("app", {
    profile: loadProfileV1("staging"),
    d1DatabaseId: STAGING_D1_PLACEHOLDER,
  }).config;

  const bound = [
    ...(app.r2_buckets as Config[]).map((bucket) => String(bucket.bucket_name)),
    ...(app.vectorize as Config[]).map((index) => String(index.index_name)),
    ...(app.d1_databases as Config[]).map((database) =>
      String(database.database_name),
    ),
  ];

  for (const name of bound) {
    test(`provision ${name}`, () => {
      expect(workflow).toContain(name);
    });
  }
});
