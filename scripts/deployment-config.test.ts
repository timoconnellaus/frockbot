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
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import {
  AUTH_PACKAGE_CHOOSERS_V1,
  CONTAINER_IMAGE_REPOSITORIES_V1,
  DEPLOYABLE_WORKERS_V1,
  generateProfileConfigsV1,
  generateWorkerConfigV1,
  profileWorkersV1,
  PUBLISHED_IMAGE_REGISTRY_V1,
  type DeployableWorkerV1,
} from "./deployment-config/generate.ts";
import { parseJsoncV1 } from "./deployment-config/jsonc.ts";
import {
  DEPLOYMENT_PROFILE_SCHEMA_V1,
  DEPLOYMENT_REGIONS_V1,
  deploymentRegionV1,
  loadProfileV1,
  REPO_ROOT_V1,
  validateProfileV1,
} from "./deployment-config/profile.ts";

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
      JSON.parse(
        readFileSync(
          join(REPO_ROOT_V1, "deployments/profile.schema.json"),
          "utf8",
        ),
      ),
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
