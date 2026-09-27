import type { DeploymentProfileV1 } from "../../apps/cloudflare/deployment-config/profile.ts";

const ACCOUNT_ID = "0123456789abcdef0123456789abcdef";

/**
 * json-schema-to-ts does not parse `if`/`then` unless asked. This file is
 * typechecked so a regression that drops `parseIfThenElseKeywords` fails here
 * rather than by shipping a type that accepts an Access profile with no
 * Access application.
 */
export const accessProfile: DeploymentProfileV1 = {
  schemaVersion: 1,
  name: "simple",
  accountId: ACCOUNT_ID,
  prefix: "simple",
  authPackage: "access",
  region: "enam",
  workers: {
    app: { hostnames: ["bot.example.com"] },
    computerHost: {},
    appletBuild: {},
  },
  images: {
    source: "registry",
    registry: "docker.io/timoconnellaus",
    tag: "1.0.0",
  },
  access: {
    teamDomain: "example.cloudflareaccess.com",
    aud: "a".repeat(64),
  },
  adminEmails: ["owner@example.com"],
};

export const betterAuthProfile: DeploymentProfileV1 = {
  schemaVersion: 1,
  name: "hosted",
  accountId: ACCOUNT_ID,
  prefix: "frockbot",
  authPackage: "better-auth",
};

// @ts-expect-error access Package requires the access application
export const accessProfileWithoutAccess: DeploymentProfileV1 = {
  schemaVersion: 1,
  name: "simple",
  accountId: ACCOUNT_ID,
  prefix: "simple",
  authPackage: "access",
};

export const externalProfile: DeploymentProfileV1 = {
  schemaVersion: 1,
  name: "wallet-pal",
  accountId: ACCOUNT_ID,
  prefix: "wallet-pal",
  authPackage: "./auth/chooser.ts",
  authEnvironment: {
    secrets: [{ name: "SIGN_IN_SECRET", why: "Signs every session." }],
  },
};

// @ts-expect-error an auth Package named by path says where its settings come from
export const externalProfileWithoutEnvironment: DeploymentProfileV1 = {
  schemaVersion: 1,
  name: "wallet-pal",
  accountId: ACCOUNT_ID,
  prefix: "wallet-pal",
  authPackage: "./auth/chooser.ts",
};
