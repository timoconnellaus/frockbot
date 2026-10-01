/**
 * The simple deployment profile a deploy bundle is built from, and the secrets
 * an install of it holds: which ones the installer mints, which a person
 * supplies, and how a minted one is made. `scripts/build-deploy-bundle.ts`
 * builds the bundle's manifest from these, and `scripts/deploy-bundle.ts` mints
 * from them.
 */
import type {
  DeploymentProfileV1,
  DeploymentRegionV1,
} from "../../apps/cloudflare/deployment-config/profile.ts";
import { PUBLISHED_IMAGE_REGISTRY_V1 } from "../../apps/cloudflare/deployment-config/generate.ts";
import { generateVapidKeysV1 } from "../../apps/cloudflare/src/web-push.ts";
import {
  OPTIONAL_PRODUCTION_SECRETS_V1,
  REQUIRED_PRODUCTION_SECRETS_V1,
} from "../../apps/cloudflare/src/production-secrets.js";

/**
 * The Vectorize index the memory Package reads and writes: 768 cosine
 * dimensions, which is `@cf/baai/bge-base-en-v1.5` — the embedding model it
 * uses on Cloudflare, and the preset `main.yml` creates staging's with. An index
 * with any other shape rejects every vector the Package writes.
 */
export const MEMORY_INDEX_DIMENSIONS_V1 = 768;

/** The answers a simple profile is written from. */
export interface ProfileAnswersV1 {
  readonly prefix: string;
  readonly accountId: string;
  /** The app's hostname on a zone the account holds, e.g. `bot.example.com`. */
  readonly appHostname: string;
  readonly adminEmails: readonly string[];
  readonly accessTeamDomain: string;
  readonly accessAud?: string;
  readonly region?: DeploymentRegionV1;
  readonly imageTag: string;
}

/**
 * The audience tag a profile carries before Access has issued one.
 *
 * The schema requires 64 hex characters, so the profile cannot simply omit it.
 * Zeroes are what an unissued tag looks like, and the Worker refuses every
 * token against them — which is the right behaviour for a deployment whose
 * Access application does not exist yet.
 */
export const UNISSUED_ACCESS_AUD_V1 = "0".repeat(64);

/** The simple deployment profile. */
export function simpleProfileV1(
  answers: ProfileAnswersV1,
): DeploymentProfileV1 {
  return {
    schemaVersion: 1,
    name: "simple",
    accountId: answers.accountId,
    ...(answers.region === undefined ? {} : { region: answers.region }),
    prefix: answers.prefix,
    authPackage: "access",
    workers: {
      app: { hostnames: [answers.appHostname] },
      computerHost: {},
      appletBuild: {},
    },
    images: {
      source: "registry",
      registry: PUBLISHED_IMAGE_REGISTRY_V1,
      tag: answers.imageTag,
    },
    access: {
      teamDomain: answers.accessTeamDomain,
      aud: answers.accessAud ?? UNISSUED_ACCESS_AUD_V1,
    },
    adminEmails: [...answers.adminEmails],
  };
}

/** The secrets an install mints itself, and which Workers hold each one. */
export const MINTED_SECRETS_V1 = [
  { name: "CREDENTIAL_KEYRING", workers: ["app"], shape: "keyring" },
  {
    name: "COMPUTER_HOST_TOKEN",
    workers: ["app", "computerHost"],
    shape: "hex",
  },
  { name: "APPLET_BUILD_TOKEN", workers: ["app", "appletBuild"], shape: "hex" },
  { name: "ROUTINE_HOOK_SECRET", workers: ["app"], shape: "hex" },
  { name: "MACHINE_TOKEN_SECRET", workers: ["app"], shape: "hex" },
  { name: "NATIVE_TOKEN_SECRET", workers: ["app"], shape: "hex" },
  // Every browser subscription is bound to this key pair, so a second one
  // would silence every browser that turned notifications on.
  { name: "WEB_PUSH_VAPID_KEYS", workers: ["app"], shape: "vapid" },
] as const satisfies readonly {
  name: string;
  workers: readonly ("app" | "computerHost" | "appletBuild")[];
  shape: "keyring" | "hex" | "vapid";
}[];

/**
 * A fresh credential keyring, in the shape the Worker's parser expects.
 *
 * The same generation `setup-production.sh` does for the hosted deployment: one
 * 32-byte key, named by the month it was minted, and the current key id beside
 * it. Rotating means adding a key and moving `currentKeyId`, which is why it is
 * a keyring rather than a key — and why an install never regenerates one it
 * has already minted, since the stored Connection credentials are encrypted
 * under it.
 */
export function credentialKeyringV1(
  now: Date = new Date(),
  bytes: (length: number) => Uint8Array = randomBytesV1,
): string {
  const keyId = now.toISOString().slice(0, 7);
  return JSON.stringify({
    schemaVersion: 1,
    currentKeyId: keyId,
    keys: { [keyId]: base64UrlV1(bytes(32)) },
  });
}

function randomBytesV1(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
}

export function appHostnameV1(profile: DeploymentProfileV1): string {
  const hostname = profile.workers?.app?.hostnames?.[0];
  if (!hostname) throw new Error("The profile gives the app no hostname.");
  return hostname;
}

/**
 * The deployment's VAPID key pair, as `WEB_PUSH_VAPID_KEYS` holds it. The
 * subject is the app's own origin: the contact a push service is given.
 * `scripts/web-push-keys.ts` mints the hosted and staging ones with it.
 */
export async function vapidKeysV1(appHostname: string): Promise<string> {
  return JSON.stringify(await generateVapidKeysV1(`https://${appHostname}`));
}

/** 32 random bytes as hex, which is what every shared secret here is. */
export function randomHexV1(bytes = randomBytesV1(32)): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The encoding `parseCredentialKeyringV1` reads key material in. */
function base64UrlV1(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
}

/** One key a person supplies, rather than one the install mints. */
export interface HumanSecretV1 {
  readonly name: string;
  /** What it enables, in one line, so skipping it is an informed choice. */
  readonly enables: string;
  /** Where to get one. */
  readonly where?: string;
  readonly required?: boolean;
  readonly workers: readonly ("app" | "computerHost" | "appletBuild")[];
}

export const HUMAN_SECRETS_V1: readonly HumanSecretV1[] = [
  {
    name: "SPRITES_TOKEN",
    enables:
      "the Computer: a Bot that browses, runs commands and sees a screen",
    where:
      "https://fly.io/dashboard — the token the Computer host presents to Fly",
    // Required because the Computer is part of every deployment (ADR 0028).
    required: true,
    // The host is the only place it is used; the app Worker is handed it too
    // because the release does, and the manifest classifies it there.
    workers: ["app", "computerHost"],
  },
  {
    name: "OPENAI_API_KEY",
    enables: "dictation in the composer",
    where: "https://platform.openai.com/api-keys",
    workers: ["app"],
  },
  {
    name: "GEMINI_API_KEY",
    enables: "the voice session: hearing you and speaking back",
    where: "https://aistudio.google.com/apikey",
    workers: ["app"],
  },
  {
    name: "FCM_SERVICE_ACCOUNT",
    enables:
      "push sent to FCM yourself; without it, push goes through the relay",
    where: "a Firebase project's service-account JSON",
    workers: ["app"],
  },
  {
    name: "COMPOSIO_API_KEY",
    enables:
      "Connected apps: a Bot using your Gmail, Slack, Notion and the rest",
    where: "https://app.composio.dev",
    workers: ["app"],
  },
  {
    name: "COMPOSIO_WEBHOOK_SECRET",
    enables:
      "Routines that fire on a connected-app event (a new Gmail message, an email sent)",
    where:
      "https://app.composio.dev — the webhook secret for this project's event URL",
    workers: ["app"],
  },
  {
    name: "BRAVE_SEARCH_API_KEY",
    enables: "web search: a Bot that searches the public web",
    where: "https://api-dashboard.search.brave.com — a Search plan's API key",
    workers: ["app"],
  },
  {
    name: "DEBUG_TOKEN",
    enables: "the read-only /api/debug operator surface",
    workers: ["app"],
  },
];

/**
 * Required names the generated wrangler config already carries as `vars`.
 *
 * `identityVarsV1` in the generator writes the Access team and audience into the
 * app Worker's `vars`, and wrangler refuses a Worker that has the same name as
 * both a var and a secret. So neither is a secret of the bundle.
 */
export const CONFIGURED_AS_VARS_V1: readonly string[] = [
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
];

/**
 * Optional names a simple deployment deliberately never holds.
 *
 * Billing is switched by `STRIPE_SECRET_KEY`, and the bundle never asks for
 * one — which is the whole of how ADR 0028 keeps billing out of a self-hosted
 * deployment without gating it: set one by hand and billing turns on. The
 * Gateway bearer is the other: the simple profile names no AI Gateway, so the
 * Worker takes the `AI` binding, where Auto resolves to a concrete Workers AI
 * model rather than the hosted dynamic route (cloudflare/ai#617).
 */
export const DELIBERATELY_UNSET_V1: readonly string[] = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_MONTHLY_PRICE_ID",
  "STRIPE_PLUS_PRICE_ID",
  "STRIPE_BYO_PRICE_ID",
  "FROCK_AI_GATEWAY_TOKEN",
];

/**
 * Every `env` name a simple deployment is expected to hold.
 *
 * Read off the same manifest the hosted release is checked against, filtered to
 * the Access build, so a secret the Worker starts reading cannot be one the
 * bundle never declares. The two exclusions are the names this deployment
 * carries as `vars` and the ones it is deliberately without.
 */
export function accessBuildSecretNamesV1(): string[] {
  return [...REQUIRED_PRODUCTION_SECRETS_V1, ...OPTIONAL_PRODUCTION_SECRETS_V1]
    .filter(
      (secret) =>
        secret.authPackage === undefined || secret.authPackage === "access",
    )
    .map((secret) => secret.name)
    .filter(
      (name) =>
        !CONFIGURED_AS_VARS_V1.includes(name) &&
        !DELIBERATELY_UNSET_V1.includes(name),
    );
}

/** The R2 key the Worker loads its application artifact from. */
export function applicationArtifactKeyV1(sha256: string): string {
  return `applications/${sha256}.mjs`;
}
