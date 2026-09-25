/**
 * What `bun run setup` decides, separated from what it does.
 *
 * Every judgement the installer makes — which account, which profile, which
 * secret still needs minting, which asset to fetch for this tag, which Access
 * application to ask for — is a function here, over values. The steps in
 * `../setup.ts` do the talking and the running; this file is what the tests
 * drive, because an installer whose decisions can only be checked by deploying
 * is an installer nobody checks.
 */
import type {
  DeploymentProfileV1,
  DeploymentRegionV1,
} from "../deployment-config/profile.ts";
import { resourceNamesV1 } from "../deployment-config/generate.ts";
import {
  OPTIONAL_PRODUCTION_SECRETS_V1,
  REQUIRED_PRODUCTION_SECRETS_V1,
} from "../../apps/cloudflare/src/production-secrets.js";

/** The profile the installer writes, and the only one it ever writes. */
export const SIMPLE_PROFILE_NAME_V1 = "simple";

/** Where the record of what this installer minted lives, under `.deployment/`. */
export const MINTED_SECRETS_FILE_V1 = `.deployment/${SIMPLE_PROFILE_NAME_V1}/secrets.env`;

/** Where the release's container images are published (ADR 0028 step 5). */
export const PUBLISHED_IMAGE_REGISTRY_V1 = "docker.io/timoconnellaus";

/** The GitHub repository a release is downloaded from. */
export const RELEASE_REPOSITORY_V1 = "timoconnellaus/frockbot";

/**
 * The Vectorize index the memory Package reads and writes.
 *
 * 768 cosine dimensions, which is `@cf/baai/bge-base-en-v1.5` — the embedding
 * model it uses on Cloudflare. `--preset` is how wrangler is told both at once,
 * and an index created with any other shape rejects every vector the Package
 * writes.
 */
export const MEMORY_INDEX_PRESET_V1 = "@cf/baai/bge-base-en-v1.5";

/** One Cloudflare account, as `wrangler whoami` lists it. */
export interface WhoamiAccountV1 {
  readonly name: string;
  readonly id: string;
}

/**
 * The accounts in `wrangler whoami`'s output.
 *
 * Parsed from the table rather than asked for as JSON, because `whoami` has no
 * JSON mode: it prints one bordered row per account, name then 32-hex id.
 */
export function parseWhoamiAccountsV1(stdout: string): WhoamiAccountV1[] {
  const found: WhoamiAccountV1[] = [];
  const seen = new Set<string>();
  for (const line of stdout.split("\n")) {
    const match = line.match(
      /^\s*[│|]?\s*(.+?)\s*[│|]\s*([0-9a-f]{32})\s*[│|]?/,
    );
    if (!match) continue;
    const id = match[2]!;
    if (seen.has(id)) continue;
    seen.add(id);
    found.push({ name: match[1]!.trim(), id });
  }
  return found;
}

/** What the installer refuses to touch without being told twice. */
export interface AccountRefusalV1 {
  readonly reason: string;
}

/**
 * Whether this account may be installed into.
 *
 * `deployments/hosted.json` is somebody's live deployment — Tim's — and an
 * installer that created a `frockbot` Worker there would collide with it. The
 * flag exists so the refusal can be overridden deliberately and never by
 * accident.
 */
export function accountRefusalV1(
  accountId: string,
  hostedAccountId: string,
  allowHostedAccount: boolean,
): AccountRefusalV1 | undefined {
  if (allowHostedAccount || accountId !== hostedAccountId) return undefined;
  return {
    reason:
      `Account ${accountId} is the one deployments/hosted.json names, which is a live deployment. ` +
      "Installing into it would create Workers beside the hosted ones. " +
      "Pass --allow-hosted-account if that is genuinely what you mean.",
  };
}

/** What the account step settled on. */
export type AccountChoiceV1 =
  | { readonly kind: "chosen"; readonly account: WhoamiAccountV1 }
  | { readonly kind: "ask"; readonly accounts: readonly WhoamiAccountV1[] }
  | { readonly kind: "failure"; readonly reason: string };

/**
 * Which account to install into: the one named, the only one there is, or a
 * question. Never a guess from a list of several.
 */
export function accountChoiceV1(
  accounts: readonly WhoamiAccountV1[],
  requested: string | undefined,
): AccountChoiceV1 {
  if (requested) {
    const named = accounts.find(
      (account) => account.id === requested || account.name === requested,
    );
    return named
      ? { kind: "chosen", account: named }
      : {
          kind: "failure",
          reason: `This token can reach ${accounts.length} account(s), and none of them is ${requested}.`,
        };
  }
  if (accounts.length === 0) {
    return {
      kind: "failure",
      reason:
        "`wrangler whoami` listed no account. Run `bunx wrangler login` first.",
    };
  }
  return accounts.length === 1
    ? { kind: "chosen", account: accounts[0]! }
    : { kind: "ask", accounts };
}

/** The account, or why there is not one. Every leg of the choice, answered. */
export function chosenAccountV1(choice: AccountChoiceV1): WhoamiAccountV1 {
  if (choice.kind === "chosen") return choice.account;
  if (choice.kind === "failure") throw new Error(choice.reason);
  throw new Error(
    `This token can reach ${choice.accounts.length} accounts; name one with --account <id>.`,
  );
}

/** The answers the profile is written from. */
export interface ProfileAnswersV1 {
  readonly prefix: string;
  readonly accountId: string;
  /** The app's hostname on a zone the account holds, e.g. `bot.example.com`. */
  readonly appHostname: string;
  readonly adminEmails: readonly string[];
  readonly accessTeamDomain: string;
  /** Filled in by the Access step; a placeholder until it is. */
  readonly accessAud?: string;
  readonly region?: DeploymentRegionV1;
  readonly imageTag: string;
}

/**
 * The audience tag a profile carries before Access has issued one.
 *
 * The schema requires 64 hex characters, so the profile cannot simply omit it
 * while the rest of the installer proceeds. Zeroes are what an unissued tag
 * looks like, and the Worker refuses every token against them — which is the
 * right behaviour for a deployment whose Access application does not exist yet.
 */
export const UNISSUED_ACCESS_AUD_V1 = "0".repeat(64);

/** The profile `deployments/simple.json` holds. */
export function simpleProfileV1(
  answers: ProfileAnswersV1,
): DeploymentProfileV1 {
  return {
    schemaVersion: 1,
    name: SIMPLE_PROFILE_NAME_V1,
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

/** The image and asset tag this checkout installs, and why. */
export interface ImageTagV1 {
  readonly tag: string;
  readonly warning?: string;
}

/**
 * Which release this checkout is.
 *
 * The images and the release assets are published per tag, so a checkout that
 * is not on a tag has nothing coherent to pull: `latest` is the only answer
 * left, and it is a warning rather than a default, because the images and the
 * assets it fetches are then whatever the newest release happens to be.
 */
export function imageTagV1(
  gitDescribe: string | undefined,
  packageVersion: string | undefined,
): ImageTagV1 {
  const described = gitDescribe?.trim();
  if (described && /^v?\d+\.\d+\.\d+$/.test(described)) {
    return { tag: described.replace(/^v/, "") };
  }
  const version = packageVersion?.trim();
  if (version && /^\d+\.\d+\.\d+$/.test(version) && version !== "0.0.1") {
    return { tag: version };
  }
  return {
    tag: "latest",
    warning:
      "This checkout is not on a release tag, so the container images and the release assets " +
      "will be whatever `latest` is right now. Check out a tag and run this again to pin a release.",
  };
}

/** What the installer downloads from the release for its tag. */
export interface ReleaseAssetsV1 {
  readonly webClient: string;
  readonly applicationArtifact: string;
}

/**
 * The asset names `release.yml` attached for a version.
 *
 * One spelling, checked against the workflow by `setup.test.ts`: a name that
 * drifted would download nothing, and the installer would deploy a Worker with
 * no client and an artifact hash pointing at an empty bucket.
 */
export function releaseAssetNamesV1(version: string): ReleaseAssetsV1 {
  return {
    webClient: `frockbot-web-client-${version}.zip`,
    applicationArtifact: `frockbot-application-artifact-${version}.mjs`,
  };
}

/** The two R2 buckets and the one index a deployment needs. */
export interface DeploymentResourcesV1 {
  readonly buckets: readonly string[];
  readonly memoryIndex: string;
  /** Where the application artifact is uploaded, and the Worker loads it from. */
  readonly applicationArtifactsBucket: string;
}

/**
 * What to create, taken from the generator rather than derived again.
 *
 * A profile may name its resources instead of deriving them from the prefix, and
 * a second derivation here would create a bucket nothing opens.
 */
export function deploymentResourcesV1(
  profile: DeploymentProfileV1,
): DeploymentResourcesV1 {
  const named = resourceNamesV1(profile);
  return {
    buckets: [named.applicationArtifactsBucket, named.memoryFilesBucket],
    memoryIndex: named.memoryIndex,
    applicationArtifactsBucket: named.applicationArtifactsBucket,
  };
}

/** The secrets the installer mints itself, and which Workers hold each one. */
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
] as const satisfies readonly {
  name: string;
  workers: readonly ("app" | "computerHost" | "appletBuild")[];
  shape: "keyring" | "hex";
}[];

export type MintedSecretV1 = (typeof MINTED_SECRETS_V1)[number];

/**
 * A fresh credential keyring, in the shape the Worker's parser expects.
 *
 * The same generation `setup-production.sh` does for the hosted deployment: one
 * 32-byte key, named by the month it was minted, and the current key id beside
 * it. Rotating means adding a key and moving `currentKeyId`, which is why it is
 * a keyring rather than a key — and why the installer never regenerates one it
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

export function randomBytesV1(length: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(length));
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

/** Which minted secrets this run has to create, and which it must leave alone. */
export interface MintPlanV1 {
  readonly mint: readonly MintedSecretV1[];
  readonly keep: readonly string[];
}

/**
 * What to mint, given the record of what was minted before.
 *
 * "If absent" means absent from the local record, not absent from the Worker:
 * every one of these signs or decrypts something durable, so minting a second
 * value would invalidate stored Connection credentials, issued Routine webhook
 * keys, paired machines and native sessions. The record is the authority, and
 * a run whose record is intact converges to doing nothing.
 */
export function mintPlanV1(
  recorded: Readonly<Record<string, string>>,
): MintPlanV1 {
  const mint: MintedSecretV1[] = [];
  const keep: string[] = [];
  for (const secret of MINTED_SECRETS_V1) {
    if ((recorded[secret.name] ?? "").trim() === "") mint.push(secret);
    else keep.push(secret.name);
  }
  return { mint, keep };
}

/**
 * The record of what was minted, as a file.
 *
 * Deliberately not a wrangler concept: `wrangler secret list` says a name is
 * set and never what it is set to, so an installer that lost this file could
 * only re-mint and break what the old value protects. `.deployment/` is
 * git-ignored and the file is written 0600.
 */
export function formatMintedSecretsV1(
  values: Readonly<Record<string, string>>,
): string {
  const lines = [
    "# Written by `bun run setup`. Not tracked, never committed, mode 0600.",
    "# These values encrypt and sign durable state: stored Connection",
    "# credentials, issued Routine webhook keys, paired machines and native",
    "# sessions. Losing this file means the installer can only mint new ones,",
    "# which invalidates all of it. Back it up.",
  ];
  for (const name of Object.keys(values).sort()) {
    lines.push(`${name}=${values[name]!}`);
  }
  return `${lines.join("\n")}\n`;
}

export function parseMintedSecretsV1(
  contents: string | undefined,
): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of (contents ?? "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    values[trimmed.slice(0, separator)] = trimmed.slice(separator + 1);
  }
  return values;
}

/** One key the installer asks a person for, rather than minting. */
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
    enables: "push notifications to an Android app you build yourself",
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
  {
    name: "JEV_API_KEY",
    enables:
      "Turn supervision: without it no Bot runs a Turn, because every Turn is supervised",
    where: "https://typesafe.ai — an API key for Jev",
    required: true,
    workers: ["app"],
  },
];

/**
 * Required names the generated wrangler config already carries as `vars`.
 *
 * `identityVarsV1` in the generator writes the Access team and audience into the
 * app Worker's `vars`, and wrangler refuses a Worker that has the same name as
 * both a var and a secret. So the installer sets neither as a secret.
 */
export const CONFIGURED_AS_VARS_V1: readonly string[] = [
  "ACCESS_TEAM_DOMAIN",
  "ACCESS_AUD",
];

/**
 * Optional names a simple deployment deliberately never holds.
 *
 * Billing is switched by `STRIPE_SECRET_KEY`, and the simple installer never
 * asks for one — which is the whole of how ADR 0028 keeps billing out of a
 * self-hosted deployment without gating it: set one by hand and billing turns
 * on. The Gateway bearer is the other: the simple profile names no AI Gateway,
 * so the Worker takes the `AI` binding, where Auto resolves to a concrete
 * Workers AI model rather than the hosted dynamic route (cloudflare/ai#617).
 */
export const DELIBERATELY_UNSET_V1: readonly string[] = [
  "STRIPE_SECRET_KEY",
  "STRIPE_WEBHOOK_SECRET",
  "STRIPE_MONTHLY_PRICE_ID",
  "FROCK_AI_GATEWAY_TOKEN",
];

/**
 * Every `env` name a simple deployment is expected to hold.
 *
 * Read off the same manifest the hosted release is checked against, filtered to
 * the build the installer deploys, so a secret the Worker starts reading cannot
 * be one the installer never asks about. The two exclusions are the names this
 * deployment carries as `vars` and the ones it is deliberately without.
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

/** One Access application the deployment needs, and the policy on it. */
export interface AccessApplicationSpecV1 {
  readonly name: string;
  /** `host` or `host/path`, as an Access destination is written. */
  readonly destination: string;
  readonly decision: "allow" | "bypass";
  readonly why: string;
}

/**
 * The Access applications a simple deployment needs.
 *
 * Two, because Access matches by path prefix and there is no way to say "the
 * document and nothing under it". The app's own hostname is protected, which
 * covers the document, the client's assets, `/sign-out` and the whole native
 * sign-in flow; `/api` is then bypassed so it reaches the Worker, which is what
 * the ADR means by the application being path-scoped. `/api` being public is
 * not a hole: every `/api` request is authenticated by the Worker itself, from
 * the Access cookie a browser sends or the bearer a phone sends.
 */
export function accessApplicationsV1(
  appHostname: string,
  prefix: string,
): AccessApplicationSpecV1[] {
  return [
    {
      name: `${prefix} app`,
      destination: appHostname,
      decision: "allow",
      why: "The document, the client, sign-out and the native sign-in flow. This policy is the deployment's allowlist: whoever it admits has an account.",
    },
    {
      name: `${prefix} api`,
      destination: `${appHostname}/api`,
      decision: "bypass",
      why: "Reaches the Worker, which authenticates every one of these itself — from the Access cookie a browser sends, or the bearer token a phone exchanged. Without this, no native client could sign in.",
    },
  ];
}

/** What to tell a deployer whose token cannot create an Access application. */
export function accessDashboardStepsV1(
  applications: readonly AccessApplicationSpecV1[],
  teamDomain: string,
  adminEmails: readonly string[],
): string[] {
  const steps = [
    `Open https://one.dash.cloudflare.com/ and pick the ${teamDomain} team.`,
    "Go to Access → Applications → Add an application → Self-hosted.",
  ];
  for (const application of applications) {
    steps.push(
      `Add "${application.name}" with the public hostname ${application.destination}, ` +
        `and one policy whose action is ${application.decision === "allow" ? `Allow, including the emails ${adminEmails.join(", ")}` : "Bypass, including Everyone"}. ` +
        application.why,
    );
  }
  steps.push(
    `Open "${applications[0]!.name}" again, copy its Application Audience (AUD) tag, and paste it below.`,
  );
  return steps;
}

/** The R2 key the Worker loads its application artifact from. */
export function applicationArtifactKeyV1(sha256: string): string {
  return `applications/${sha256}.mjs`;
}
