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
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  DEPLOYABLE_WORKERS_V1,
  generateProfileConfigsV1,
  generateWorkerConfigV1,
  profileWorkersV1,
  type DeployableWorkerV1,
} from "./deployment-config/generate.ts";
import { parseJsoncV1 } from "./deployment-config/jsonc.ts";
import { loadProfileV1, REPO_ROOT_V1 } from "./deployment-config/profile.ts";

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
  return join(REPO_ROOT_V1, DEPLOYABLE_WORKERS_V1[worker].directory);
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
      artifactHostname: undefined,
    };
    const app = generateWorkerConfigV1("app", {
      profile: profile as ReturnType<typeof loadProfileV1>,
    });
    expect(app.config.routes).toBeUndefined();
    expect(app.config.workers_dev).toBe(true);
    expect(app.config.name).toBe("frockbot");
    expect((app.config.vars as Config).UI_ARTIFACT_HOSTS).toBeUndefined();
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
