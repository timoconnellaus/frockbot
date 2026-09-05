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
 * The bug that produced this: `APPLET_VIEWER_SECRET` was set in every test
 * environment and in none of production, so from the moment the Applet
 * authority shipped, every published Applet answered 503 and no check
 * anywhere noticed (2026-09-05).
 *
 * A second, quieter hazard is written into the same lists. The deploy passes
 * `wrangler deploy --secrets-file`, which *replaces* the Worker's whole secret
 * set: a secret set by hand with `wrangler secret put`, and not carried by the
 * workflow, is deleted by the next release. So a name absent from these lists
 * is not merely unchecked — it is actively removed.
 */

/** One setting the deploy hands the Worker. */
export interface ProductionSecretV1 {
  readonly name: string;
  /** What it is for, in one line, for the operator reading a failed deploy. */
  readonly why: string;
}

/** One setting the deploy may omit, and what the product loses when it does. */
export interface OptionalProductionSecretV1 extends ProductionSecretV1 {
  /** What stops working while it is unset, said plainly. */
  readonly degraded: string;
}

/**
 * Required: production is broken without it, so the deploy fails rather than
 * shipping a Worker that answers an error to a User instead of a feature.
 */
export const REQUIRED_PRODUCTION_SECRETS_V1: readonly ProductionSecretV1[] = [
  {
    name: "FROCKBOT_AUTHORIZATION_STATE_SECRET",
    why: "Signs and binds public Connection callbacks to their durable User and pending authorization; independent of the session secret.",
  },
  {
    name: "BETTER_AUTH_URL",
    why: "The deployment's own origin; every sign-in redirect is built from it.",
  },
  {
    name: "BETTER_AUTH_SECRET",
    why: "Signs every session cookie. Absent, nobody can sign in.",
  },
  {
    name: "GOOGLE_CLIENT_ID",
    why: "The only sign-in method production offers.",
  },
  {
    name: "GOOGLE_CLIENT_SECRET",
    why: "The only sign-in method production offers.",
  },
  {
    name: "SPRITES_TOKEN",
    why: "Authorizes the Computer host's Sprite provider. Absent, no Computer starts.",
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
    name: "APPLET_VIEWER_SECRET",
    why: "Signs the viewer token an open Applet's page presents. Absent, every published Applet answers 503.",
  },
];

/**
 * Optional: the deploy proceeds and says what stays shut. Each still has to be
 * carried by the workflow, because `--secrets-file` deletes what it omits.
 */
export const OPTIONAL_PRODUCTION_SECRETS_V1: readonly OptionalProductionSecretV1[] =
  [
    {
      name: "COMPOSIO_API_KEY",
      why: "Connect Link and toolkit API for external services.",
      degraded:
        "Composio Connections are unavailable; the Package advertises nothing",
    },
    {
      name: "FROCKBOT_ADMIN_EMAILS",
      why: "The identities allowed to open Admin.",
      degraded:
        "nobody can administer the signup policy, though signups stay closed and existing Users keep signing in",
    },
    {
      name: "DEBUG_TOKEN",
      why: "Authorizes the read-only `/api/debug` operator surface.",
      degraded: "the operator debug routes 404",
    },
    {
      name: "FROCK_AI_GATEWAY_TOKEN",
      why: "The `cf-aig-authorization` bearer for the AI Gateway (ADR 0025).",
      degraded:
        "Frock AI falls back to the `AI` binding and the Auto model fails",
    },
    {
      name: "OPENAI_API_KEY",
      why: "The direct realtime key composer dictation prefers.",
      degraded: "dictation falls back to the AI Gateway's BYOK key",
    },
    {
      name: "GEMINI_API_KEY",
      why: "Read the same way by the voice assistant.",
      degraded: "the voice assistant falls back to the AI Gateway",
    },
  ];

/**
 * Every other string the Worker reads off `env`: a `vars` entry in
 * `wrangler.jsonc`, or a door only a test harness opens. None of these is
 * carried by the deploy, and each is listed so that adding a setting is a
 * decision somebody made rather than one nobody noticed.
 */
export const NON_SECRET_WORKER_SETTINGS_V1: readonly ProductionSecretV1[] = [
  {
    name: "NATIVE_SLICE_2_AUTH",
    why: "Qualification gate; not enabled by the production configuration.",
  },
  {
    name: "DEFAULT_APPLICATION_HASH",
    why: "A `vars` entry the deploy writes.",
  },
  { name: "UI_ARTIFACT_HOSTS", why: "A `vars` entry." },
  { name: "ALLOWED_CLIENT_ORIGINS", why: "A `vars` entry." },
  { name: "FROCK_AI_GATEWAY_ID", why: "A `vars` entry." },
  { name: "FROCK_AI_AUTO_ROUTE", why: "A `vars` entry." },
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
  },
  {
    name: "WORKSPACE_SEED_TOKEN",
    why: "Opens the Workspace seed door; set by the end-to-end harness only.",
  },
  {
    name: "VOICE_UPSTREAM_URL",
    why: "Local dictation stand-in; set by the end-to-end harness only.",
  },
  {
    name: "VOICE_ASSISTANT_UPSTREAM_URL",
    why: "Local Gemini Live stand-in; set by the end-to-end harness only.",
  },
];

/** Every name the deploy's secrets file may carry, required first. */
export function deployedSecretNamesV1(): string[] {
  return [
    ...REQUIRED_PRODUCTION_SECRETS_V1.map((secret) => secret.name),
    ...OPTIONAL_PRODUCTION_SECRETS_V1.map((secret) => secret.name),
  ];
}

/** Required names the given environment does not supply. */
export function missingRequiredSecretsV1(
  present: Readonly<Record<string, string | undefined>>,
): ProductionSecretV1[] {
  return REQUIRED_PRODUCTION_SECRETS_V1.filter(
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
 * Secrets the live Worker holds that this deploy would silently delete.
 *
 * `--secrets-file` replaces the whole set, so a secret put on the Worker by
 * hand — the repair somebody made at 2am — disappears at the next release
 * unless the workflow carries it. It is reported as a warning rather than a
 * failure: a required name in this state has already failed the check above,
 * and everything else here is a name nobody has claimed, which is worth
 * saying out loud but is not worth holding a release for.
 */
export function secretsThisDeployWouldDeleteV1(
  live: readonly string[],
  present: Readonly<Record<string, string | undefined>>,
): string[] {
  const carried = new Set(
    deployedSecretNamesV1().filter(
      (name) => (present[name] ?? "").trim() !== "",
    ),
  );
  return live.filter((name) => !carried.has(name)).toSorted();
}

/** The whole verdict, as the release workflow prints it. */
export function productionSecretsReportV1(
  present: Readonly<Record<string, string | undefined>>,
  live?: readonly string[],
): { ok: boolean; failures: string[]; warnings: string[] } {
  const failures = missingRequiredSecretsV1(present).map(
    (secret) =>
      `Missing production configuration: ${secret.name} — ${secret.why} Add it to the repository's production environment, then re-run this release.`,
  );
  const warnings = missingOptionalSecretsV1(present).map(
    (secret) => `${secret.name} is unset, so ${secret.degraded}.`,
  );
  for (const name of live
    ? secretsThisDeployWouldDeleteV1(live, present)
    : []) {
    warnings.push(
      `The deployed Worker holds a secret this release does not carry: ${name}. ` +
        "`wrangler deploy --secrets-file` replaces the whole secret set, so this deploy deletes it. " +
        "Add it to the production environment and to this manifest, or remove it from the Worker.",
    );
  }
  return { ok: failures.length === 0, failures, warnings };
}
