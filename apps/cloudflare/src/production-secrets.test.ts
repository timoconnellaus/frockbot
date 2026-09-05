import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  NON_SECRET_WORKER_SETTINGS_V1,
  OPTIONAL_PRODUCTION_SECRETS_V1,
  REQUIRED_PRODUCTION_SECRETS_V1,
  deployedSecretNamesV1,
  missingRequiredSecretsV1,
  productionSecretsReportV1,
  secretsThisDeployWouldDeleteV1,
} from "./production-secrets.js";

const workerSource = readFileSync(`${import.meta.dir}/index.ts`, "utf8");
const releaseWorkflow = readFileSync(
  `${import.meta.dir}/../../../.github/workflows/release.yml`,
  "utf8",
);

/** Every string setting the Worker's `Env` interface declares. */
function declaredStringSettings(): string[] {
  const body = workerSource.slice(
    workerSource.indexOf("interface Env {"),
    workerSource.indexOf("\n}", workerSource.indexOf("interface Env {")),
  );
  return [...body.matchAll(/^ {2}([A-Z0-9_]+)\??: string;$/gm)].map(
    (match) => match[1],
  );
}

/** The `env:` keys of the release workflow's "Deploy Worker" step. */
function deployStepEnvKeys(): string[] {
  const step = releaseWorkflow.slice(releaseWorkflow.indexOf("Deploy Worker"));
  const env = step.slice(step.indexOf("        env:"), step.indexOf("shell:"));
  return [...env.matchAll(/^ {10}([A-Z0-9_]+):/gm)].map((match) => match[1]);
}

describe("the production secrets manifest", () => {
  test("classifies every string setting the Worker reads", () => {
    const classified = new Set([
      ...REQUIRED_PRODUCTION_SECRETS_V1.map((secret) => secret.name),
      ...OPTIONAL_PRODUCTION_SECRETS_V1.map((secret) => secret.name),
      ...NON_SECRET_WORKER_SETTINGS_V1.map((setting) => setting.name),
    ]);
    const declared = declaredStringSettings();
    expect(declared.length).toBeGreaterThan(20);
    // A new `env` string with nowhere in the manifest is the whole bug this
    // module exists to stop: say, in this file, whether production may run
    // without it.
    expect(declared.filter((name) => !classified.has(name))).toEqual([]);
  });

  test("names nothing the Worker does not read", () => {
    const declared = new Set(declaredStringSettings());
    const named = [
      ...deployedSecretNamesV1(),
      ...NON_SECRET_WORKER_SETTINGS_V1.map((setting) => setting.name),
    ];
    expect(named.filter((name) => !declared.has(name))).toEqual([]);
  });

  test("names each setting exactly once", () => {
    const named = [
      ...deployedSecretNamesV1(),
      ...NON_SECRET_WORKER_SETTINGS_V1.map((setting) => setting.name),
    ];
    expect(named.length).toBe(new Set(named).size);
  });

  test("requires the Applet viewer secret", () => {
    // The regression this manifest was written for: absent, every published
    // Applet answered 503 in production for weeks.
    expect(
      REQUIRED_PRODUCTION_SECRETS_V1.map((secret) => secret.name),
    ).toContain("APPLET_VIEWER_SECRET");
  });

  test("is carried by the release workflow's deploy step", () => {
    // `--secrets-file` replaces the Worker's whole secret set, so a name the
    // deploy step does not receive is a secret the next release deletes.
    const carried = new Set(deployStepEnvKeys());
    expect(
      deployedSecretNamesV1().filter((name) => !carried.has(name)),
    ).toEqual([]);
  });

  test("is checked before the Worker is deployed", () => {
    const step = releaseWorkflow.slice(
      releaseWorkflow.indexOf("Deploy Worker"),
    );
    expect(releaseWorkflow).toContain(
      "bun scripts/check-production-secrets.ts check",
    );
    expect(
      releaseWorkflow.indexOf("check-production-secrets.ts check"),
    ).toBeLessThan(releaseWorkflow.indexOf("wrangler deploy --secrets-file"));
    expect(step).toContain("write-secrets-file");
  });
});

describe("the production secrets report", () => {
  const complete = Object.fromEntries(
    deployedSecretNamesV1().map((name) => [name, "set"]),
  );

  test("passes when every required secret is present", () => {
    const report = productionSecretsReportV1(complete);
    expect(report.ok).toBe(true);
    expect(report.failures).toEqual([]);
    expect(report.warnings).toEqual([]);
  });

  test("fails naming the missing secret and why it matters", () => {
    const { APPLET_VIEWER_SECRET: _missing, ...rest } = complete;
    const report = productionSecretsReportV1(rest);
    expect(report.ok).toBe(false);
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toContain(
      "Missing production configuration: APPLET_VIEWER_SECRET",
    );
    expect(report.failures[0]).toContain("every published Applet answers 503");
  });

  test("treats a blank value as missing", () => {
    expect(
      missingRequiredSecretsV1({ ...complete, BETTER_AUTH_SECRET: "  " }).map(
        (secret) => secret.name,
      ),
    ).toEqual(["BETTER_AUTH_SECRET"]);
  });

  test("says what an absent optional secret closes", () => {
    const { DEBUG_TOKEN: _absent, ...rest } = complete;
    const report = productionSecretsReportV1(rest);
    expect(report.ok).toBe(true);
    expect(report.warnings).toEqual([
      "DEBUG_TOKEN is unset, so the operator debug routes 404.",
    ]);
  });

  test("warns about a live secret this deploy would delete", () => {
    expect(
      secretsThisDeployWouldDeleteV1(
        ["BETTER_AUTH_SECRET", "SOMETHING_SET_BY_HAND"],
        complete,
      ),
    ).toEqual(["SOMETHING_SET_BY_HAND"]);
    const report = productionSecretsReportV1(complete, [
      "SOMETHING_SET_BY_HAND",
    ]);
    expect(report.ok).toBe(true);
    expect(report.warnings[0]).toContain("SOMETHING_SET_BY_HAND");
  });
});
