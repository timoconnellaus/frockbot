import { describe, expect, test } from "bun:test";
import { validateProfileV1 } from "../../apps/cloudflare/deployment-config/profile.ts";
import { PUBLISHED_IMAGE_REGISTRY_V1 } from "../../apps/cloudflare/deployment-config/generate.ts";
import { parseCredentialKeyringV1 } from "../../core/connection/index.ts";
import {
  accessBuildSecretNamesV1,
  applicationArtifactKeyV1,
  CONFIGURED_AS_VARS_V1,
  credentialKeyringV1,
  DELIBERATELY_UNSET_V1,
  HUMAN_SECRETS_V1,
  MEMORY_INDEX_DIMENSIONS_V1,
  MINTED_SECRETS_V1,
  simpleProfileV1,
  UNISSUED_ACCESS_AUD_V1,
} from "./simple-profile.ts";

const ANSWERS = {
  prefix: "example",
  accountId: "1".repeat(32),
  appHostname: "bot.example.com",
  adminEmails: ["someone@example.com"],
  accessTeamDomain: "example.cloudflareaccess.com",
  region: "enam",
  imageTag: "0.7.20",
} as const;

describe("the simple profile", () => {
  const profile = simpleProfileV1(ANSWERS);

  test("meets the schema every other profile meets", () => {
    expect(() =>
      validateProfileV1(profile, "the simple profile"),
    ).not.toThrow();
  });

  test("builds the Access Package, pulls its images, and names no gateway", () => {
    expect(profile.authPackage).toBe("access");
    expect(profile.images).toEqual({
      source: "registry",
      registry: PUBLISHED_IMAGE_REGISTRY_V1,
      tag: "0.7.20",
    });
    // No AI Gateway: the Worker takes the `AI` binding, where Auto resolves to a
    // concrete Workers AI model instead of the hosted dynamic route.
    expect(profile.aiGateway).toBeUndefined();
    // No marketing site and no admin portal: there is no admin operation left
    // when the Access policy is the allowlist.
    expect(Object.keys(profile.workers ?? {})).toEqual([
      "app",
      "computerHost",
      "appletBuild",
    ]);
    expect(profile.d1DatabaseId).toBeUndefined();
  });

  test("carries an unissued audience until Access has issued one", () => {
    expect(profile.access?.aud).toBe(UNISSUED_ACCESS_AUD_V1);
    expect(
      simpleProfileV1({ ...ANSWERS, accessAud: "d".repeat(64) }).access?.aud,
    ).toBe("d".repeat(64));
  });

  test("the artifact's R2 key is its own sha256, as the release deploy writes it", () => {
    expect(applicationArtifactKeyV1("e".repeat(64))).toBe(
      `applications/${"e".repeat(64)}.mjs`,
    );
  });

  test("the index shape is the embedding model the memory Package uses", () => {
    // An index with any other dimensions or metric rejects every vector it
    // writes; @cf/baai/bge-base-en-v1.5 embeds 768 dimensions.
    expect(MEMORY_INDEX_DIMENSIONS_V1).toBe(768);
  });
});

describe("the secrets an install mints", () => {
  test("the keyring is the shape the Worker's parser reads", () => {
    const keyring = parseCredentialKeyringV1(credentialKeyringV1());
    expect(keyring.schemaVersion).toBe(1);
    expect(Object.keys(keyring.keys)).toEqual([keyring.currentKeyId]);
  });

  test("every minted secret reaches every Worker that reads it", () => {
    const placement = Object.fromEntries(
      MINTED_SECRETS_V1.map((secret) => [secret.name, secret.workers]),
    );
    // The two shared secrets are the pairs: each is presented by the app Worker
    // and checked by the Worker it calls.
    expect(placement.COMPUTER_HOST_TOKEN).toEqual(["app", "computerHost"]);
    expect(placement.APPLET_BUILD_TOKEN).toEqual(["app", "appletBuild"]);
    expect(placement.NATIVE_TOKEN_SECRET).toEqual(["app"]);
  });
});

describe("the keys only a deployer has", () => {
  const declared = [
    ...MINTED_SECRETS_V1.map((secret) => secret.name),
    ...HUMAN_SECRETS_V1.map((secret) => secret.name),
  ];

  test("the Computer's token is the one that is required", () => {
    const required = HUMAN_SECRETS_V1.filter((secret) => secret.required);
    expect(required.map((secret) => secret.name)).toEqual(["SPRITES_TOKEN"]);
    expect(required[0]!.where).toContain("fly.io");
  });

  test("every optional key says what it enables", () => {
    for (const secret of HUMAN_SECRETS_V1) {
      expect(secret.enables.length).toBeGreaterThan(10);
      expect(secret.workers.length).toBeGreaterThan(0);
    }
  });

  test("the bundle covers every secret the Access build's Worker expects", () => {
    // Read off the same manifest the hosted release is checked against, so a
    // secret the Worker starts reading cannot be one the bundle never declares.
    const covered = new Set([
      ...declared,
      "FROCKBOT_ADMIN_EMAILS",
      "FROCKBOT_ADMIN_USER_IDS",
    ]);
    expect(
      accessBuildSecretNamesV1().filter((name) => !covered.has(name)),
    ).toEqual([]);
  });

  test("it never declares as a secret what the config carries as a var", () => {
    // Wrangler refuses a name that is both; the generator writes these two.
    for (const name of CONFIGURED_AS_VARS_V1) {
      expect(accessBuildSecretNamesV1()).not.toContain(name);
      expect(declared).not.toContain(name);
    }
    expect(CONFIGURED_AS_VARS_V1).toEqual(["ACCESS_TEAM_DOMAIN", "ACCESS_AUD"]);
  });

  test("it asks for no Stripe key and no Gateway bearer", () => {
    // Billing is switched by STRIPE_SECRET_KEY, which the bundle never asks
    // for: nothing is gated, and a self-hoster who sets one gets billing.
    expect(DELIBERATELY_UNSET_V1).toContain("STRIPE_SECRET_KEY");
    expect(DELIBERATELY_UNSET_V1).toContain("FROCK_AI_GATEWAY_TOKEN");
    for (const name of DELIBERATELY_UNSET_V1) {
      expect(declared).not.toContain(name);
    }
  });

  test("the hosted build's own names are never asked for", () => {
    // A simple deployment has no better-auth and no Google client, and asking
    // for either would be asking for a secret its Worker cannot read.
    for (const name of [
      "BETTER_AUTH_SECRET",
      "BETTER_AUTH_URL",
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
    ]) {
      expect(declared).not.toContain(name);
      expect(accessBuildSecretNamesV1()).not.toContain(name);
    }
  });
});
