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
  requiredSecretsV1,
} from "./production-secrets.js";
import { AUTH_PACKAGE_V1 } from "#auth-package";
import { ACCESS_AUTH_PACKAGE_V1 } from "@frockbot/app/auth/access";
import { BETTER_AUTH_PACKAGE_V1 } from "@frockbot/app/auth/better-auth";

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
    // A `hostOnly` secret is read by another Worker of this deployment — the
    // Computer host — and the app Worker declares no `env` string for it,
    // which is the point of the flag.
    const hostOnly = new Set(
      REQUIRED_PRODUCTION_SECRETS_V1.filter((secret) => secret.hostOnly).map(
        (secret) => secret.name,
      ),
    );
    expect([...hostOnly]).toEqual(["SPRITES_TOKEN"]);
    const named = [
      ...deployedSecretNamesV1().filter((name) => !hostOnly.has(name)),
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

  test("requires both voice provider keys, so the hosted product needs no User setup", () => {
    const required = REQUIRED_PRODUCTION_SECRETS_V1.map(
      (secret) => secret.name,
    );
    expect(required).toContain("OPENAI_API_KEY");
    expect(required).toContain("ELEVENLABS_API_KEY");
  });

  test("gives each auth Package exactly the secrets it declares", () => {
    // The Package declares what it reads off `env`; this file says whether
    // production may run without it. Neither list is allowed to be the only
    // one that knows about a name (ADR 0028).
    for (const build of [BETTER_AUTH_PACKAGE_V1, ACCESS_AUTH_PACKAGE_V1]) {
      expect(
        REQUIRED_PRODUCTION_SECRETS_V1.filter(
          (secret) => secret.authPackage === build.id,
        ).map(({ name, why }) => ({ name, why })),
        // The reason too: two copies of the sentence an operator reads on a
        // failed deploy are two chances for one of them to go stale.
      ).toEqual(build.required.map(({ name, why }) => ({ name, why })));
    }
  });

  test("carries only the built auth Package's secrets", () => {
    // The hosted build deploys better-auth's four and has never heard of
    // ACCESS_*; the simple build is the other way round. A deploy that carried
    // both would demand secrets its Worker cannot use.
    expect(AUTH_PACKAGE_V1.id).toBe("better-auth");
    const carried = new Set(deployedSecretNamesV1());
    for (const setting of BETTER_AUTH_PACKAGE_V1.required) {
      expect(carried.has(setting.name)).toBe(true);
    }
    for (const setting of ACCESS_AUTH_PACKAGE_V1.required) {
      expect(carried.has(setting.name)).toBe(false);
    }
    expect(
      requiredSecretsV1().filter((secret) => secret.authPackage === "access"),
    ).toEqual([]);
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
    // Scoped to the app Worker's own job: other Workers this workflow deploys
    // write secrets files of their own, and this manifest is not theirs.
    const job = releaseWorkflow.slice(
      releaseWorkflow.indexOf("  deploy-backend:"),
    );
    const step = job.slice(job.indexOf("Deploy Worker"));
    expect(job).toContain("bun scripts/check-production-secrets.ts check");
    // The deploy names the generated config it reads, so the flag that writes
    // the secrets is what locates it rather than one whole command line.
    expect(job.indexOf("check-production-secrets.ts check")).toBeLessThan(
      job.indexOf('--secrets-file "$secrets_file"'),
    );
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
    // DEBUG_TOKEN from the production environment to close the debug routes,
    // ships a release, and the old token is still live and still authorized.
    const { DEBUG_TOKEN: _dropped, ...rest } = complete;
    const report = productionSecretsReportV1(rest, ["DEBUG_TOKEN"]);
    expect(report.ok).toBe(true);
    expect(report.warnings[0]).toContain("the deployed Worker still holds it");
    expect(report.warnings[0]).toContain("does not revoke it");
    expect(report.warnings[0]).toContain(
      "bun scripts/check-production-secrets.ts revoke DEBUG_TOKEN",
    );
    // And it does not claim the routes are shut: they run on the old token.
    expect(report.warnings[0]).not.toContain("the operator debug routes 404");
    expect(liveSecretPlanV1(["DEBUG_TOKEN"], rest).leftInPlace).toEqual([
      "DEBUG_TOKEN",
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
    ).toEqual(["VOICE_DICTATION_UPSTREAM_URL", "ALLOW_DEVELOPMENT_AUTH"]);
  });
});
