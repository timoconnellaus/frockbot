/*
 * What the production Worker must be given, and what happens when it is not.
 *
 * Every string setting the Worker reads off `env` is named here exactly once,
 * in one of three lists. That is the whole point of the module: a Worker that
 * reads a new secret cannot ship until somebody has said, in this file,
 * whether production is allowed to run without it — the release workflow
 * builds its secrets file from these lists and refuses to deploy when a
 * required name is missing, and `production-secrets.test.ts` fails when the
 * `Env` interface names a setting these lists do not.
 *
 * A second, quieter hazard runs the other way. `wrangler deploy
 * --secrets-file` is *additive*: it adds and overwrites the names the file
 * carries and leaves every other secret the Worker already holds exactly
 * where it is (`wrangler deploy --help`, 4.93). So no release ever revokes
 * anything. Deleting a name from the production environment stops the
 * release *updating* that secret; the value production is already running on
 * stays live and stays authorized until somebody deletes it deliberately,
 * with `bun scripts/check-production-secrets.ts revoke <NAME>`.
 *
 * That is why the live comparison below reports what a deploy actually does
 * — adds, updates, leaves in place — rather than what it would do if the
 * flag replaced the set, and why a door that must never be open in
 * production (`ALLOW_DEVELOPMENT_AUTH`) fails the gate when the live Worker
 * holds it: no deploy is going to close it.
 *
 * One list here is not the same for every deployment: a required secret may
 * belong to one auth Package (ADR 0028). Both Packages' names are classified,
 * because the Worker's `Env` declares both, and only the built Package's are
 * required, checked and deployed.
 */
import type { AuthPackageIdV1 } from "@frockbot/core/contracts";
import { AUTH_PACKAGE_V1 } from "#auth-package";

/** One setting the deploy hands the Worker. */
export interface ProductionSecretV1 {
  readonly name: string;
  /** What it is for, in one line, for the operator reading a failed deploy. */
  readonly why: string;
  /**
   * Required by the deployment but read by another Worker in it, not by the
   * app Worker. The deploy still refuses without it — the deployment is not
   * complete — but the app Worker declares no `env` string for it, and the
   * manifest's "names nothing the Worker does not read" rule skips it.
   */
  readonly hostOnly?: boolean;
  /**
   * Required by one auth Package only. A build that chose the other Package
   * neither reads it nor deploys it, so it is required nowhere until that
   * build is the one being released.
   */
  readonly authPackage?: AuthPackageIdV1;
}

/**
 * Whether this build carries the secret at all.
 *
 * The one asymmetry in this module: every other name is required or optional
 * for every deployment, and these are required for one and unknown to the
 * other.
 */
function belongsToThisBuildV1(secret: ProductionSecretV1): boolean {
  return (
    secret.authPackage === undefined ||
    secret.authPackage === AUTH_PACKAGE_V1.id
  );
}

/** One setting the deploy may omit, and what the product loses when it does. */
export interface OptionalProductionSecretV1 extends ProductionSecretV1 {
  /** What stops working while it is unset, said plainly. */
  readonly degraded: string;
}

/** One setting the deploy never carries as a secret. */
export interface NonSecretWorkerSettingV1 extends ProductionSecretV1 {
  /**
   * Set on a door that must never be open in production: what it would let
   * through if the live Worker held it as a secret. The deploy is additive
   * and cannot close it, so the gate fails and an operator revokes it.
   */
  readonly forbiddenLive?: string;
}

/**
 * Required: production is broken without it, so the deploy fails rather than
 * shipping a Worker that answers an error to a User instead of a feature.
 */
export const REQUIRED_PRODUCTION_SECRETS_V1: readonly ProductionSecretV1[] = [
  {
    name: "FCM_SERVICE_ACCOUNT",
    why: "Authorizes Firebase push delivery to registered Android devices.",
  },
  {
    name: "BETTER_AUTH_URL",
    why: "The deployment's own origin; every sign-in redirect is built from it.",
    authPackage: "better-auth",
  },
  {
    name: "BETTER_AUTH_SECRET",
    why: "Signs every session cookie. Absent, nobody can sign in.",
    authPackage: "better-auth",
  },
  {
    name: "GOOGLE_CLIENT_ID",
    why: "The only sign-in method the hosted deployment offers.",
    authPackage: "better-auth",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    why: "The only sign-in method the hosted deployment offers.",
    authPackage: "better-auth",
  },
  {
    name: "ACCESS_TEAM_DOMAIN",
    why: "The Zero Trust team whose public keys sign every Access token, and whose logout ends a session.",
    authPackage: "access",
  },
  {
    name: "ACCESS_AUD",
    why: "The Access application's audience tag. Absent, a token minted for another application would be accepted.",
    authPackage: "access",
  },
  {
    // The hosted build signs the native door with `BETTER_AUTH_SECRET` above,
    // which it has always signed with and which nothing may rotate without
    // revoking every signed-in phone and Mac. A build with no better-auth has
    // no such key, so the installer mints this one.
    name: "NATIVE_TOKEN_SECRET",
    why: "Signs the native sign-in codes and bearer tokens. Absent, the phone and Mac cannot sign in.",
    authPackage: "access",
  },
  {
    name: "SPRITES_TOKEN",
    why: "Authorizes the Computer host against its vendor. Absent, no Computer starts.",
    // Read by `apps/computer-host`, never by this Worker: the app Worker asks
    // whether it was handed a Computer host, not which credential that host
    // needs. It is required here because the deployment is not complete
    // without it, and the release forwards it to both Workers.
    hostOnly: true,
  },
  {
    name: "COMPUTER_HOST_TOKEN",
    why: "Presented on every call to the Computer host Worker.",
  },
  {
    name: "CREDENTIAL_KEYRING",
    why: "Decrypts stored Connection credentials. Absent, every Connection fails.",
  },
  {
    name: "ROUTINE_HOOK_SECRET",
    why: "Signs Routine webhook keys. Absent, every Routine webhook is refused.",
  },
  {
    name: "MACHINE_TOKEN_SECRET",
    why: "Signs machine tokens and pairing codes. Absent, no machine can pair.",
  },
  {
    name: "APPLET_BUILD_TOKEN",
    why: "Presented on every call to the plugin build service. Absent, no Plugin can be checked or published.",
  },
  {
    name: "OPENAI_API_KEY",
    why: "Opens the composer's dictation session. Absent, dictation answers that voice is not set up.",
  },
  {
    name: "GEMINI_API_KEY",
    why: "Runs the voice session: one Gemini Live socket per call, ears, words and voice together. Absent, the voice session refuses to start.",
  },
];

/**
 * Optional: the deploy proceeds and says what stays shut. Each still has to be
 * carried by the workflow: the deploy is the only thing that updates a
 * secret, so a name the workflow drops is a value frozen at whatever
 * production last received.
 */
export const OPTIONAL_PRODUCTION_SECRETS_V1: readonly OptionalProductionSecretV1[] =
  [
    {
      name: "STRIPE_SECRET_KEY",
      why: "Creates account subscriptions, top-ups and portal sessions, and is the switch that turns billing on.",
      degraded:
        "billing stays switched off: nothing is metered, no subscription is required, and the billing page says payments are not available",
    },
    {
      name: "STRIPE_WEBHOOK_SECRET",
      why: "Verifies payment events before granting credit.",
      degraded: "no Stripe event can grant credit, so checkout cannot complete",
    },
    {
      name: "STRIPE_MONTHLY_PRICE_ID",
      why: "Pins the US$20 monthly Stripe price.",
      degraded: "subscription checkout answers that the plan is not configured",
    },
    {
      name: "FROCKBOT_ADMIN_EMAILS",
      why: "The identities allowed to open Admin.",
      degraded:
        "nobody can administer beta access, so admission stays closed and only accounts already granted access can sign in",
    },
    {
      name: "DEBUG_TOKEN",
      why: "Authorizes the read-only `/api/debug` operator surface.",
      degraded: "the operator debug routes 404",
    },
    {
      name: "COMPOSIO_API_KEY",
      why: "The project key behind Connected apps: sign-in links, connected accounts and every app tool call.",
      degraded:
        "no app can be connected; Connect answers that connecting apps is unavailable, and a Bot has no app tools",
    },
    {
      name: "COMPOSIO_WEBHOOK_SECRET",
      why: "HMAC-SHA256 secret that verifies Connected-app event deliveries at POST /api/connect/events.",
      degraded:
        "the events door answers 503; Routines cannot fire on a connected-app event",
    },
    {
      name: "BRAVE_SEARCH_API_KEY",
      why: "The Brave Search API key behind every Bot's `web_search`, billed per search.",
      degraded:
        "web search is unavailable: a Bot has no `web_search` tool, and `web_fetch` still reads pages",
    },
    {
      name: "FROCK_AI_GATEWAY_TOKEN",
      why: "The `cf-aig-authorization` bearer for the AI Gateway.",
      degraded:
        "Frock AI falls back to the `AI` binding and the Auto model fails",
    },
    {
      name: "JEV_API_KEY",
      why: "Authorizes the hosted TurnSupervisor, the routine-event rejector, and dictation tidy review against Jev.",
      degraded:
        "turn supervision, the routine-event rejector and dictation tidy review are unavailable",
    },
  ];

/**
 * Every other string the Worker reads off `env`: a `vars` entry in
 * `wrangler.jsonc`, or a door only a test harness opens. None of these is
 * carried by the deploy, and each is listed so that adding a setting is a
 * decision somebody made rather than one nobody noticed.
 */
export const NON_SECRET_WORKER_SETTINGS_V1: readonly NonSecretWorkerSettingV1[] =
  [
    {
      name: "NATIVE_SLICE_2_AUTH",
      why: "Native sign-in returns, exactly as listed; production enables Android, macOS, the FrockBot Dev Mac and iOS.",
    },
    {
      name: "DEFAULT_APPLICATION_HASH",
      why: "A `vars` entry the deploy writes.",
    },
    {
      name: "ALLOWED_CLIENT_ORIGINS",
      why: "Admits a cross-origin client; no deployment configures one, since the web app is same-origin and the native app sends no `Origin`.",
    },
    { name: "FROCK_AI_GATEWAY_ID", why: "A `vars` entry." },
    {
      name: "VOICE_ASSISTANT_MODEL",
      why: "An optional `vars` entry pinning the gateway model the end-of-call memory update is asked; the platform's Auto route when unset.",
    },
    {
      name: "VOICE_ASSISTANT_UPSTREAM_URL",
      why: "Points the voice session at a local stand-in; set by the test harness only.",
      forbiddenLive:
        "every voice call would be sent to that host instead of Gemini Live",
    },
    {
      name: "VOICE_DICTATION_CLEANUP_MODEL",
      why: "An optional `vars` entry pinning the model that tidies a dictated transcript; Groq's 8B instant class when unset.",
    },
    {
      name: "VOICE_DICTATION_UPSTREAM_URL",
      why: "Points dictation at a local stand-in; set by the test harness only.",
      forbiddenLive:
        "every dictation session would be sent to that host instead of the speech provider",
    },
    { name: "FROCK_AI_AUTO_ROUTE", why: "A `vars` entry." },
    {
      name: "EMAIL_DOMAIN",
      why: "The `vars` entry the profile's `email` writes: the domain Email Routing hands to `email()` and every Bot sends from. Absent, every message is refused and nothing is sent.",
    },
    { name: "FROCK_AI_ACCOUNT_ID", why: "A `vars` entry." },
    {
      name: "FLOCK_AI_GATEWAY_ID",
      why: "The pre-rename `vars` twin, read as a fallback.",
    },
    {
      name: "FLOCK_AI_AUTO_ROUTE",
      why: "The pre-rename `vars` twin, read as a fallback.",
    },
    {
      name: "FLOCK_AI_ACCOUNT_ID",
      why: "The pre-rename `vars` twin, read as a fallback.",
    },
    {
      name: "FLOCK_AI_GATEWAY_TOKEN",
      why: "The pre-rename secret twin; the workflow resolves it into FROCK_AI_GATEWAY_TOKEN.",
    },
    {
      name: "ALLOW_DEVELOPMENT_AUTH",
      why: "Opens the development sign-in door; never set in production.",
      forbiddenLive:
        "anybody reaching the deployment can sign in as any identity without Google",
    },
  ];

/** What this build must be given, the other auth Package's names aside. */
export function requiredSecretsV1(): ProductionSecretV1[] {
  return REQUIRED_PRODUCTION_SECRETS_V1.filter(belongsToThisBuildV1);
}

/** Every name the deploy's secrets file may carry, required first. */
export function deployedSecretNamesV1(): string[] {
  return [
    ...requiredSecretsV1().map((secret) => secret.name),
    ...OPTIONAL_PRODUCTION_SECRETS_V1.map((secret) => secret.name),
  ];
}

/** Required names the given environment does not supply. */
export function missingRequiredSecretsV1(
  present: Readonly<Record<string, string | undefined>>,
): ProductionSecretV1[] {
  return requiredSecretsV1().filter(
    (secret) => (present[secret.name] ?? "").trim() === "",
  );
}

/** Optional names the given environment does not supply. */
export function missingOptionalSecretsV1(
  present: Readonly<Record<string, string | undefined>>,
): OptionalProductionSecretV1[] {
  return OPTIONAL_PRODUCTION_SECRETS_V1.filter(
    (secret) => (present[secret.name] ?? "").trim() === "",
  );
}

/**
 * What a deploy of this environment actually does to the live secret set.
 *
 * `--secrets-file` is additive, so there are only three outcomes: a carried
 * name the Worker does not hold yet is added, a carried name it already holds
 * is overwritten, and everything else — the secret somebody put on by hand at
 * 2am, the optional key an operator has just removed from GitHub — is left
 * exactly as it is. Nothing here deletes anything, which is the point: this
 * plan is what an operator reads before believing a release revoked
 * something.
 *
 * `forbidden` is the exception that fails the release: a live secret named in
 * `NON_SECRET_WORKER_SETTINGS_V1` as a door production must never have open.
 * The deploy will not close it, so the gate refuses to ship over the top of
 * it.
 */
export interface LiveSecretPlanV1 {
  readonly added: string[];
  readonly updated: string[];
  readonly leftInPlace: string[];
  readonly forbidden: NonSecretWorkerSettingV1[];
}

/** The names this environment's deploy carries, non-empty values only. */
function carriedSecretNamesV1(
  present: Readonly<Record<string, string | undefined>>,
): Set<string> {
  return new Set(
    deployedSecretNamesV1().filter(
      (name) => (present[name] ?? "").trim() !== "",
    ),
  );
}

/** What deploying this environment over that live secret set would do. */
export function liveSecretPlanV1(
  live: readonly string[],
  present: Readonly<Record<string, string | undefined>>,
): LiveSecretPlanV1 {
  const carried = carriedSecretNamesV1(present);
  const held = new Set(live);
  const forbidden = NON_SECRET_WORKER_SETTINGS_V1.filter(
    (setting) => setting.forbiddenLive !== undefined && held.has(setting.name),
  );
  const forbiddenNames = new Set(forbidden.map((setting) => setting.name));
  return {
    added: [...carried].filter((name) => !held.has(name)).toSorted(),
    updated: [...carried].filter((name) => held.has(name)).toSorted(),
    leftInPlace: live
      .filter((name) => !carried.has(name) && !forbiddenNames.has(name))
      .toSorted(),
    forbidden,
  };
}

/** How an operator deletes one secret from the deployed Worker. */
function revokeInstructionV1(name: string): string {
  return `run \`bun scripts/check-production-secrets.ts revoke ${name}\``;
}

/** The whole verdict, as the release workflow prints it. */
export function productionSecretsReportV1(
  present: Readonly<Record<string, string | undefined>>,
  live?: readonly string[],
): { ok: boolean; failures: string[]; warnings: string[]; notices: string[] } {
  const failures = missingRequiredSecretsV1(present).map(
    (secret) =>
      `Missing production configuration: ${secret.name} — ${secret.why} Add it to the repository's production environment, then re-run this release.`,
  );
  const plan = live ? liveSecretPlanV1(live, present) : undefined;
  const held = new Set(live ?? []);
  const warnings = missingOptionalSecretsV1(present).map((secret) =>
    held.has(secret.name)
      ? `${secret.name} is unset in this release's environment, but the deployed Worker still holds it. ` +
        "`wrangler deploy --secrets-file` is additive, so this release leaves the old value live and in use. " +
        `Removing it from the production environment does not revoke it — ${revokeInstructionV1(secret.name)}.`
      : `${secret.name} is unset, so ${secret.degraded}.`,
  );
  for (const setting of plan?.forbidden ?? []) {
    failures.push(
      `The deployed Worker holds ${setting.name}, which production must never have: ${setting.forbiddenLive}. ` +
        "The deploy is additive and will not remove it, so this release stops here. " +
        `${revokeInstructionV1(setting.name).replace("run", "Run")}, then re-run this release.`,
    );
  }
  for (const name of plan?.leftInPlace ?? []) {
    warnings.push(
      `The deployed Worker holds a secret this release does not carry: ${name}. ` +
        "The deploy is additive, so it stays live and in effect afterwards. " +
        `Add it to the production environment and to this manifest so releases own it, or ${revokeInstructionV1(name)}.`,
    );
  }
  const notices = plan
    ? [
        plan.added.length
          ? `This deploy adds ${plan.added.length} secret(s) the Worker does not hold: ${plan.added.join(", ")}.`
          : "This deploy adds no secret the Worker does not already hold.",
        `It overwrites ${plan.updated.length} secret(s) the Worker already holds.`,
        `It leaves ${plan.leftInPlace.length} live secret(s) untouched: a deploy never deletes a secret.`,
      ]
    : [];
  return { ok: failures.length === 0, failures, warnings, notices };
}
