import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  NON_SECRET_WORKER_SETTINGS_V1,
  OPTIONAL_PRODUCTION_SECRETS_V1,
  REQUIRED_PRODUCTION_SECRETS_V1,
  deployedSecretNamesV1,
  liveSecretPlanV1,
  missingRequiredSecretsV1,
  productionSecretsReportV1,
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
    // The deploy is the only thing that writes a secret, so a name the deploy
    // step does not receive is a value frozen at whatever production last
    // got — including an old key nobody meant to keep.
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

  test("plans an additive deploy: added, overwritten, left alone", () => {
    // `wrangler deploy --secrets-file` "applies additively with secrets from
    // previous deployments - omitted secrets will not be deleted" (4.93). A
    // deploy adds and overwrites; it never removes.
    const plan = liveSecretPlanV1(
      ["BETTER_AUTH_SECRET", "SOMETHING_SET_BY_HAND"],
      complete,
    );
    expect(plan.updated).toEqual(["BETTER_AUTH_SECRET"]);
    expect(plan.added).toContain("APPLET_VIEWER_SECRET");
    expect(plan.added).not.toContain("BETTER_AUTH_SECRET");
    expect(plan.leftInPlace).toEqual(["SOMETHING_SET_BY_HAND"]);
    expect(plan.forbidden).toEqual([]);
  });

  test("says a live secret this release does not carry survives it", () => {
    const report = productionSecretsReportV1(complete, [
      "SOMETHING_SET_BY_HAND",
    ]);
    expect(report.ok).toBe(true);
    expect(report.warnings[0]).toContain("SOMETHING_SET_BY_HAND");
    expect(report.warnings[0]).toContain("stays live and in effect");
    expect(report.warnings[0]).toContain("revoke SOMETHING_SET_BY_HAND");
    expect(report.warnings.join(" ")).not.toContain("deletes it");
    expect(report.notices.join(" ")).toContain(
      "a deploy never deletes a secret",
    );
  });

  test("an optional secret dropped from the environment is not revoked", () => {
    // The trap this module was rewritten for: an operator removes
    // COMPOSIO_API_KEY from the production environment to disable Composio,
    // ships a release, and the old key is still live and still authorized.
    const { COMPOSIO_API_KEY: _dropped, ...rest } = complete;
    const report = productionSecretsReportV1(rest, ["COMPOSIO_API_KEY"]);
    expect(report.ok).toBe(true);
    expect(report.warnings[0]).toContain("the deployed Worker still holds it");
    expect(report.warnings[0]).toContain("does not revoke it");
    expect(report.warnings[0]).toContain(
      "bun scripts/check-production-secrets.ts revoke COMPOSIO_API_KEY",
    );
    // And it does not claim Composio is off: it is running on the old key.
    expect(report.warnings[0]).not.toContain(
      "Composio Connections are unavailable",
    );
    expect(liveSecretPlanV1(["COMPOSIO_API_KEY"], rest).leftInPlace).toEqual([
      "COMPOSIO_API_KEY",
    ]);
  });

  test("fails when the live Worker holds a door production must not have", () => {
    // Additive deploys cannot close it, so the release stops rather than
    // shipping on top of an open development sign-in door.
    const report = productionSecretsReportV1(complete, [
      "ALLOW_DEVELOPMENT_AUTH",
    ]);
    expect(report.ok).toBe(false);
    expect(report.failures[0]).toContain(
      "The deployed Worker holds ALLOW_DEVELOPMENT_AUTH",
    );
    expect(report.failures[0]).toContain(
      "sign in as any identity without Google",
    );
    expect(report.failures[0]).toContain("revoke ALLOW_DEVELOPMENT_AUTH");
    // Reported once, as a failure, not also as a survivor.
    expect(report.warnings.join(" ")).not.toContain("ALLOW_DEVELOPMENT_AUTH");
  });

  test("every forbidden name is a setting the deploy never carries", () => {
    const deployed = new Set(deployedSecretNamesV1());
    for (const setting of NON_SECRET_WORKER_SETTINGS_V1) {
      if (setting.forbiddenLive === undefined) continue;
      expect(deployed.has(setting.name)).toBe(false);
    }
    // The harness doors are the ones that matter: production holding one is a
    // way in, and no release will take it away.
    expect(
      NON_SECRET_WORKER_SETTINGS_V1.filter(
        (setting) => setting.forbiddenLive !== undefined,
      ).map((setting) => setting.name),
    ).toEqual([
      "COMPOSIO_TEST_URL",
      "ALLOW_DEVELOPMENT_AUTH",
      "WORKSPACE_SEED_TOKEN",
      "VOICE_UPSTREAM_URL",
      "VOICE_ASSISTANT_UPSTREAM_URL",
    ]);
  });
});
