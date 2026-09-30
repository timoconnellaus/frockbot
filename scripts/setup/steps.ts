/**
 * The seven things `bun run setup` does, in order (ADR 0028 step 4).
 *
 * Each step prints what it did and is idempotent: a second run converges and
 * says "nothing to do", which is also how an upgrade works — check out the next
 * tag and run it again. Nothing here decides anything; every judgement is a
 * function in `plan.ts`, and everything it touches goes through `SetupRunnerV1`,
 * so `--dry-run` and the tests are the same shape as a real run.
 */
import { join } from "node:path";
import {
  bundleAssetNamesV1,
  checkInstallNameV1,
  installWorkersV1,
} from "../../apps/cloudflare/deployment-config/bundle.ts";
import {
  createCloudflareApiV1,
  deployBundleV1,
} from "../../apps/cloudflare/deployment-config/deploy.ts";
import {
  deploymentRegionV1,
  validateProfileV1,
  type DeploymentProfileV1,
} from "../../apps/cloudflare/deployment-config/profile.ts";
import { PROFILE_DIRECTORY_V1 } from "../deployment-config/repository.ts";
import {
  cloudflareTokenV1,
  latestReleaseVersionV1,
  loadBundleV1,
  releaseAssetUrlV1,
  type LocalBundleV1,
} from "../deploy-bundle/local.ts";
import {
  accessApplicationsV1,
  accessDashboardStepsV1,
  accountChoiceV1,
  accountRefusalV1,
  chosenAccountV1,
  credentialKeyringV1,
  formatMintedSecretsV1,
  HUMAN_SECRETS_V1,
  imageTagV1,
  MINTED_SECRETS_FILE_V1,
  mintPlanV1,
  parseMintedSecretsV1,
  parseWhoamiAccountsV1,
  randomHexV1,
  setupInstallV1,
  vapidKeysV1,
  appHostnameV1,
  type MintedSecretV1,
  simpleProfileV1,
  SIMPLE_PROFILE_NAME_V1,
  UNISSUED_ACCESS_AUD_V1,
  type AccessApplicationSpecV1,
  type HumanSecretV1,
  type WhoamiAccountV1,
} from "./plan.ts";
import type { AskerV1 } from "./prompts.ts";
import type { SetupRunnerV1 } from "./runner.ts";

export interface SetupOptionsV1 {
  readonly yes: boolean;
  readonly allowHostedAccount: boolean;
  /** An account id or name, when the token can reach more than one. */
  readonly account?: string;
  /** A profile file to reuse instead of asking; still validated and generated. */
  readonly profile?: string;
  readonly repoRoot?: string;
}

export interface SetupContextV1 {
  readonly runner: SetupRunnerV1;
  readonly asker: AskerV1;
  readonly options: SetupOptionsV1;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly repoRoot: string;
}

/** What the installer leaves behind for the operator to finish by hand. */
export interface SetupOutcomeV1 {
  readonly url: string;
  /** The install name, which every Worker and resource is named from. */
  readonly install: string;
  readonly byHand: readonly string[];
}

const PROFILE_PATH_V1 = join(
  PROFILE_DIRECTORY_V1,
  `${SIMPLE_PROFILE_NAME_V1}.json`,
);

function stage(context: SetupContextV1, index: number, name: string): void {
  context.runner.say("");
  context.runner.say(`▸ ${index}/7 · ${name}`);
}

/* ── 1. Account ─────────────────────────────────────────────────────────── */

export async function chooseAccountV1(
  context: SetupContextV1,
  hostedAccountId: string,
): Promise<WhoamiAccountV1> {
  stage(context, 1, "Account");
  const whoami = await context.runner.run(
    { cmd: ["bunx", "wrangler", "whoami"], cwd: context.repoRoot },
    // A dry run has no token, so it borrows the identity of the account the
    // profile would name; every command it prints is still the real one.
    {
      exitCode: 0,
      stdout: "│ dry run │ 00000000000000000000000000000000 │",
      stderr: "",
    },
  );
  if (whoami.exitCode !== 0) {
    throw new Error(
      `\`wrangler whoami\` failed: ${whoami.stderr.trim() || whoami.stdout.trim()}. Run \`bunx wrangler login\` first.`,
    );
  }
  const accounts = parseWhoamiAccountsV1(whoami.stdout);
  let choice = accountChoiceV1(accounts, context.options.account);
  if (choice.kind === "ask") {
    context.runner.say(
      `  This token can reach ${choice.accounts.length} accounts:`,
    );
    for (const listed of choice.accounts) {
      context.runner.say(`    ${listed.id}  ${listed.name}`);
    }
    const answer = await context.asker.ask("Which account?", {
      default: choice.accounts[0]!.id,
    });
    choice = accountChoiceV1(choice.accounts, answer);
  }
  const account = chosenAccountV1(choice);

  const refusal = accountRefusalV1(
    account.id,
    hostedAccountId,
    context.options.allowHostedAccount,
  );
  if (refusal) throw new Error(refusal.reason);

  context.runner.say(`  account    ${account.id}  ${account.name}`);
  await reportWorkersPaidV1(context, account.id);
  return account;
}

/**
 * Whether the account is on the Workers Paid plan.
 *
 * Containers and Dynamic Workers both need it, and both are load-bearing: no
 * Computer and no Plugin without them. A token scoped only to Workers cannot
 * read the subscription, which is the common case and not an error — so the
 * requirement is stated and the install proceeds, and the deploy is what fails
 * if it is really unpaid.
 */
async function reportWorkersPaidV1(
  context: SetupContextV1,
  accountId: string,
): Promise<void> {
  const token = context.env.CLOUDFLARE_API_TOKEN;
  if (!token) {
    context.runner.say(
      "  plan       not checked (no CLOUDFLARE_API_TOKEN); FrockBot needs Workers Paid.",
    );
    return;
  }
  const answer = await context.runner.request({
    method: "GET",
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/subscriptions`,
    token,
  });
  const subscriptions =
    answer.status === 200 &&
    typeof answer.body === "object" &&
    answer.body !== null
      ? ((answer.body as { result?: unknown }).result ?? [])
      : undefined;
  const paid =
    Array.isArray(subscriptions) &&
    subscriptions.some((subscription) =>
      JSON.stringify(subscription).toLowerCase().includes("workers paid"),
    );
  context.runner.say(
    paid
      ? "  plan       Workers Paid"
      : "  plan       could not confirm Workers Paid from this token; FrockBot needs it for Containers and Dynamic Workers.",
  );
}

/* ── 2. Profile ─────────────────────────────────────────────────────────── */

export async function writeProfileV1(
  context: SetupContextV1,
  account: WhoamiAccountV1,
): Promise<DeploymentProfileV1> {
  stage(context, 2, "Profile");
  const existing = existingProfileV1(context);
  if (context.options.profile) {
    const reused = readProfileFileV1(context, context.options.profile);
    context.runner.say(`  reusing    ${context.options.profile}`);
    return writtenV1(context, reused);
  }

  const tag = imageTagV1(await gitDescribeV1(context), repoVersionV1(context));
  if (tag.warning) context.runner.say(`  ! ${tag.warning}`);

  const prefix = await context.asker.ask("Worker name prefix?", {
    default: existing?.prefix ?? "frockbot",
  });
  const appHostname = await context.asker.ask(
    "The app's hostname, on a zone this account holds (e.g. bot.example.com)?",
    ...(existing?.workers?.app?.hostnames?.[0]
      ? [{ default: existing.workers.app.hostnames[0] }]
      : []),
  );
  const adminEmails = (
    await context.asker.ask(
      "Admin email(s), comma-separated — the deployment's admins, who bypass admission?",
      ...(existing?.adminEmails?.length
        ? [{ default: existing.adminEmails.join(",") }]
        : []),
    )
  )
    .split(",")
    .map((email) => email.trim())
    .filter(Boolean);
  const accessTeamDomain = await context.asker.ask(
    "Zero Trust team domain (e.g. yourteam.cloudflareaccess.com)?",
    ...(existing?.access?.teamDomain
      ? [{ default: existing.access.teamDomain }]
      : []),
  );
  const region = await context.asker.ask(
    "Region for the R2 buckets and the Vectorize index (wnam, enam, weur, eeur, apac, oc)?",
    { default: existing?.region ?? "enam" },
  );

  const profile = simpleProfileV1({
    prefix,
    accountId: account.id,
    appHostname,
    adminEmails,
    accessTeamDomain,
    // Kept across runs so a second run does not undo a tag Access has issued.
    ...(existing?.access?.aud && existing.access.aud !== UNISSUED_ACCESS_AUD_V1
      ? { accessAud: existing.access.aud }
      : {}),
    region: deploymentRegionV1(region),
    imageTag: tag.tag,
  });
  return writtenV1(context, profile);
}

function existingProfileV1(
  context: SetupContextV1,
): DeploymentProfileV1 | undefined {
  const contents = context.runner.readFile(PROFILE_PATH_V1);
  if (!contents) return undefined;
  try {
    return JSON.parse(contents) as DeploymentProfileV1;
  } catch {
    return undefined;
  }
}

function readProfileFileV1(
  context: SetupContextV1,
  path: string,
): DeploymentProfileV1 {
  const contents = context.runner.readFile(path);
  if (!contents) throw new Error(`No deployment profile at ${path}`);
  const parsed = JSON.parse(contents) as DeploymentProfileV1;
  // The installer deploys one profile and knows it by name: a reused file is
  // this deployment's profile whatever it was called on disk.
  const named: DeploymentProfileV1 = {
    ...parsed,
    name: SIMPLE_PROFILE_NAME_V1,
  };
  validateProfileV1(named, path);
  return named;
}

/** Validate and write the profile: the record of this install's answers. */
function writtenV1(
  context: SetupContextV1,
  profile: DeploymentProfileV1,
): DeploymentProfileV1 {
  validateProfileV1(profile, "the profile this installer wrote");
  // The prefix names every Worker and resource of the install, and a bundle
  // takes a narrower name than a profile does.
  checkInstallNameV1(profile.prefix);
  context.runner.writeFile(
    PROFILE_PATH_V1,
    `${JSON.stringify(profile, null, 2)}
`,
  );
  context.runner.say(`  profile    deployments/${SIMPLE_PROFILE_NAME_V1}.json`);
  return profile;
}

async function gitDescribeV1(
  context: SetupContextV1,
): Promise<string | undefined> {
  const described = await context.runner.run(
    {
      cmd: ["git", "describe", "--tags", "--exact-match"],
      cwd: context.repoRoot,
    },
    { exitCode: 1, stdout: "", stderr: "not on a tag" },
  );
  return described.exitCode === 0 ? described.stdout.trim() : undefined;
}

function repoVersionV1(context: SetupContextV1): string | undefined {
  const manifest = context.runner.readFile(
    join(context.repoRoot, "package.json"),
  );
  if (!manifest) return undefined;
  try {
    return (JSON.parse(manifest) as { version?: string }).version;
  } catch {
    return undefined;
  }
}

/* ── 3 and 4. Secrets ───────────────────────────────────────────────────── */

export interface SecretValuesV1 {
  readonly values: Readonly<Record<string, string>>;
  readonly skipped: readonly string[];
}

export async function mintInternalSecretsV1(
  context: SetupContextV1,
  profile: DeploymentProfileV1,
): Promise<Record<string, string>> {
  stage(context, 3, "Internal secrets");
  const recordPath = join(context.repoRoot, MINTED_SECRETS_FILE_V1);
  const recorded = parseMintedSecretsV1(context.runner.readFile(recordPath));
  const plan = mintPlanV1(recorded);
  for (const name of plan.keep) {
    context.runner.say(`  ${name} already minted; keeping it`);
  }
  if (plan.mint.length === 0) {
    context.runner.say("  nothing to do");
    return recorded;
  }
  const values: Record<string, string> = { ...recorded };
  for (const secret of plan.mint) {
    // A dry run mints placeholders. It prints every value it would write, and
    // real key material printed to a terminal ends up in scrollback and logs —
    // where a value that is never going to be set has no business being.
    values[secret.name] = await mintedValueV1(
      secret,
      profile,
      context.runner.dryRun,
    );
    context.runner.say(`  ${secret.name} minted`);
  }
  context.runner.writeFile(recordPath, formatMintedSecretsV1(values), 0o600);
  context.runner.say(
    `  recorded in ${MINTED_SECRETS_FILE_V1} — git-ignored, mode 0600, and the only copy. Back it up: these encrypt and sign durable state.`,
  );
  return values;
}

/**
 * A fresh value in the secret's shape. A dry run gets one of the right shape
 * and no secrecy, since it prints what it would write.
 */
async function mintedValueV1(
  secret: MintedSecretV1,
  profile: DeploymentProfileV1,
  dryRun: boolean,
): Promise<string> {
  switch (secret.shape) {
    case "keyring":
      return dryRun
        ? credentialKeyringV1(new Date(0), (length) => new Uint8Array(length))
        : credentialKeyringV1();
    case "vapid":
      return dryRun
        ? `dry-run-placeholder-for-${secret.name}`
        : await vapidKeysV1(appHostnameV1(profile));
    case "hex":
      return dryRun ? `dry-run-placeholder-for-${secret.name}` : randomHexV1();
  }
}

export async function askHumanSecretsV1(
  context: SetupContextV1,
  profile: DeploymentProfileV1,
): Promise<SecretValuesV1> {
  stage(context, 4, "Keys only you have");
  const values: Record<string, string> = {
    FROCKBOT_ADMIN_EMAILS: (profile.adminEmails ?? []).join(","),
  };
  context.runner.say(
    `  FROCKBOT_ADMIN_EMAILS ${values.FROCKBOT_ADMIN_EMAILS} (from the profile)`,
  );
  if (profile.adminUserIds?.length) {
    values.FROCKBOT_ADMIN_USER_IDS = profile.adminUserIds.join(",");
    context.runner.say(
      `  FROCKBOT_ADMIN_USER_IDS ${values.FROCKBOT_ADMIN_USER_IDS} (from the profile)`,
    );
  }
  const skipped: string[] = [];
  for (const secret of HUMAN_SECRETS_V1) {
    const answer = await askOneSecretV1(context, secret);
    if (answer) values[secret.name] = answer;
    else if (secret.required) {
      throw new Error(
        `${secret.name} is required: without it ${secret.enables} does not exist.`,
      );
    } else {
      skipped.push(secret.name);
      context.runner.say(
        `  ${secret.name} skipped, so ${secret.enables} stays shut`,
      );
    }
  }
  // No AI Gateway values are asked for: the simple profile names no gateway, so
  // the Worker takes the `AI` binding and Auto resolves to a concrete Workers AI
  // model rather than the hosted dynamic route (cloudflare/ai#617).
  return { values, skipped };
}

async function askOneSecretV1(
  context: SetupContextV1,
  secret: HumanSecretV1,
): Promise<string> {
  context.runner.say(
    `  ${secret.name} — ${secret.enables}${secret.where ? ` (${secret.where})` : ""}`,
  );
  // `--yes` skips every optional key. A required key it cannot invent, so
  // `--yes` alone stops there and says so; a dry run takes a placeholder instead,
  // because printing the whole install is the point of it and nothing is set.
  const fallback = secret.required
    ? context.runner.dryRun
      ? `dry-run-placeholder-for-${secret.name}`
      : undefined
    : "";
  return context.asker.askSecret(
    secret.required ? `${secret.name}?` : `${secret.name}? (Enter to skip)`,
    ...(fallback === undefined ? [] : [{ default: fallback }]),
  );
}

/* ── 5. Access ──────────────────────────────────────────────────────────── */

export async function configureAccessV1(
  context: SetupContextV1,
  profile: DeploymentProfileV1,
): Promise<{ profile: DeploymentProfileV1; byHand: string[] }> {
  stage(context, 5, "Cloudflare Access");
  const appHostname = appHostnameV1(profile);
  const applications = accessApplicationsV1(appHostname, profile.prefix);
  const token = context.env.CLOUDFLARE_API_TOKEN;

  if (!token) {
    for (const step of accessDashboardStepsV1(
      applications,
      profile.access?.teamDomain ?? "",
      profile.adminEmails ?? [],
    )) {
      context.runner.say(`  • ${step}`);
    }
    const aud = await context.asker.ask("Application Audience (AUD) tag?", {
      default: profile.access?.aud ?? UNISSUED_ACCESS_AUD_V1,
    });
    return finishAccessV1(context, profile, aud, [
      "Create the two Access applications above, if you have not already.",
    ]);
  }

  let audience = profile.access?.aud ?? UNISSUED_ACCESS_AUD_V1;
  for (const application of applications) {
    const found = await findAccessApplicationV1(
      context,
      profile.accountId,
      token,
      application,
    );
    if (found) {
      context.runner.say(`  ${application.name} already exists`);
      if (application.decision === "allow" && found.aud) audience = found.aud;
      const repaired = await ensureAccessPolicyV1(
        context,
        profile.accountId,
        token,
        application,
        found.id,
        profile.adminEmails ?? [],
      );
      if (!repaired.ok) {
        return finishAccessV1(context, profile, audience, [
          `Add the ${application.decision} policy to the Access application "${application.name}" by hand: ${repaired.why}. ` +
            "A token that can do it holds Zero Trust: Access Apps and Policies Write.",
        ]);
      }
      continue;
    }
    const created = await createAccessApplicationV1(
      context,
      profile.accountId,
      token,
      application,
      profile.adminEmails ?? [],
    );
    if (!created.ok) {
      return finishAccessV1(context, profile, audience, [
        `Create the Access application "${application.name}" for ${application.destination} by hand: ${created.why}. ` +
          "A token that can do it holds Zero Trust: Access Apps and Policies Write.",
      ]);
    }
    context.runner.say(
      `  ${application.name} created (${application.decision})`,
    );
    // An application created with no audience in the answer is created; the
    // operator reads the tag off the dashboard, which `finishAccessV1` says.
    if (application.decision === "allow" && created.aud) audience = created.aud;
  }
  return finishAccessV1(context, profile, audience, []);
}

function finishAccessV1(
  context: SetupContextV1,
  profile: DeploymentProfileV1,
  audience: string,
  byHand: string[],
): { profile: DeploymentProfileV1; byHand: string[] } {
  if (!/^[0-9a-f]{64}$/.test(audience)) {
    throw new Error(
      `"${audience}" is not an Access audience tag; it is 64 hex characters, shown as the application's AUD.`,
    );
  }
  if (audience === UNISSUED_ACCESS_AUD_V1) {
    byHand.push(
      "Put the Access application's real AUD tag in deployments/simple.json and run `bun run setup` again: " +
        "until then the Worker refuses every token, which is the right answer for a deployment with no Access application.",
    );
  }
  const next: DeploymentProfileV1 = {
    ...profile,
    access: { teamDomain: profile.access!.teamDomain, aud: audience },
  };
  validateProfileV1(next, "the profile this installer wrote");
  context.runner.writeFile(
    PROFILE_PATH_V1,
    `${JSON.stringify(next, null, 2)}\n`,
  );
  context.runner.say(`  audience   ${audience}`);
  return { profile: next, byHand };
}

async function findAccessApplicationV1(
  context: SetupContextV1,
  accountId: string,
  token: string,
  application: AccessApplicationSpecV1,
): Promise<{ id?: string; aud?: string } | undefined> {
  const listed = await context.runner.request({
    method: "GET",
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`,
    token,
  });
  if (listed.status !== 200) return undefined;
  const result = (listed.body as { result?: unknown }).result;
  if (!Array.isArray(result)) return undefined;
  const match = result.find(
    (entry) =>
      typeof entry === "object" &&
      entry !== null &&
      (entry as { name?: unknown }).name === application.name,
  ) as { id?: string; aud?: string } | undefined;
  return match;
}

/**
 * Give an existing Access application its policy when it has none, so a re-run
 * repairs an application whose policy failed on the run that created it.
 */
async function ensureAccessPolicyV1(
  context: SetupContextV1,
  accountId: string,
  token: string,
  application: AccessApplicationSpecV1,
  applicationId: string | undefined,
  adminEmails: readonly string[],
): Promise<{ ok: true } | { ok: false; why: string }> {
  if (!applicationId) {
    return { ok: false, why: "the API listed the application without an id" };
  }
  const listed = await context.runner.request({
    method: "GET",
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps/${applicationId}/policies`,
    token,
  });
  const result = (listed.body as { result?: unknown } | undefined)?.result;
  if (listed.status !== 200 || !Array.isArray(result)) {
    return {
      ok: false,
      why: `the API answered ${listed.status} to listing its policies`,
    };
  }
  if (result.length > 0) return { ok: true };
  const created = await createAccessPolicyV1(
    context,
    accountId,
    token,
    application,
    applicationId,
    adminEmails,
  );
  if (!created) {
    return { ok: false, why: "the API refused to create its policy" };
  }
  context.runner.say(
    `  ${application.name} policy added (${application.decision})`,
  );
  return { ok: true };
}

async function createAccessPolicyV1(
  context: SetupContextV1,
  accountId: string,
  token: string,
  application: AccessApplicationSpecV1,
  applicationId: string,
  adminEmails: readonly string[],
): Promise<boolean> {
  const policy = await context.runner.request({
    method: "POST",
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps/${applicationId}/policies`,
    token,
    body: {
      name: `${application.name} policy`,
      decision: application.decision,
      include:
        application.decision === "allow"
          ? adminEmails.map((email) => ({ email: { email } }))
          : [{ everyone: {} }],
    },
  });
  return policy.status < 300;
}

/**
 * Create one Access application and its one policy.
 *
 * `ok` and `aud` are separate answers on purpose: an application created whose
 * response carried no audience tag is still created, and telling the operator to
 * create it again would give the deployment two.
 */
async function createAccessApplicationV1(
  context: SetupContextV1,
  accountId: string,
  token: string,
  application: AccessApplicationSpecV1,
  adminEmails: readonly string[],
): Promise<{ ok: true; aud?: string } | { ok: false; why: string }> {
  const created = await context.runner.request({
    method: "POST",
    url: `https://api.cloudflare.com/client/v4/accounts/${accountId}/access/apps`,
    token,
    body: {
      name: application.name,
      type: "self_hosted",
      destinations: [{ type: "public", uri: application.destination }],
      session_duration: "24h",
    },
  });
  const result = (created.body as { result?: { id?: string; aud?: string } })
    ?.result;
  if (created.status >= 300 || !result?.id) {
    return {
      ok: false,
      why: `the API answered ${created.status} to creating the application`,
    };
  }
  const policyCreated = await createAccessPolicyV1(
    context,
    accountId,
    token,
    application,
    result.id,
    adminEmails,
  );
  if (!policyCreated) {
    return {
      ok: false,
      why:
        "the application was created but the API refused its policy, " +
        "so it currently admits nobody — add the policy rather than the application",
    };
  }
  return result.aud === undefined
    ? { ok: true }
    : { ok: true, aud: result.aud };
}

/* ── 6. The release's deploy bundle ────────────────────────────────────── */

/**
 * The deploy bundle for this checkout's release: every Worker prebuilt, the web
 * client, the application artifact and the manifest that names them all
 * (docs/deploy-bundles.md). Downloaded and held to its manifest's sha256;
 * nothing is built here. Undefined in a dry run, which downloads nothing.
 */
export async function fetchBundleV1(
  context: SetupContextV1,
  profile: DeploymentProfileV1,
): Promise<LocalBundleV1 | undefined> {
  stage(context, 6, "The release's deploy bundle");
  const tag =
    profile.images?.source === "registry" ? profile.images.tag : "latest";
  if (context.runner.dryRun) {
    const names = bundleAssetNamesV1(tag);
    for (const asset of [names.manifest, names.archive]) {
      context.runner.say(`  would fetch  ${releaseAssetUrlV1(tag, asset)}`);
    }
    return undefined;
  }
  const version = tag === "latest" ? await latestReleaseVersionV1() : tag;
  const bundle = await loadBundleV1(
    version,
    join(context.repoRoot, ".deployment", SIMPLE_PROFILE_NAME_V1, "bundles"),
  );
  context.runner.say(
    `  bundle     ${bundle.manifest.version}, ${bundle.manifest.archive.sha256.slice(0, 12)}… as its manifest says`,
  );
  return bundle;
}

/* ── 7. Deploy ──────────────────────────────────────────────────────────── */

export async function deployV1(
  context: SetupContextV1,
  profile: DeploymentProfileV1,
  secrets: Readonly<Record<string, string>>,
  bundle: LocalBundleV1 | undefined,
): Promise<SetupOutcomeV1> {
  stage(context, 7, "Deploy");
  const install = setupInstallV1(profile, secrets);
  if (bundle) {
    // The deploy page's own path: the Cloudflare API, with nothing built here.
    // Resources, the artifact, each Worker with its migrations and secrets, its
    // container application and its domains, in dependency order.
    await deployBundleV1({
      api: createCloudflareApiV1({
        token: await cloudflareTokenV1(context.env, context.repoRoot),
      }),
      manifest: bundle.manifest,
      files: bundle.files,
      install,
      say: context.runner.say,
    });
  } else {
    context.runner.say(
      `  would deploy  ${installWorkersV1(install).join(", ")} for install "${install.name}" through the Cloudflare API, with ${Object.keys(secrets).sort().join(", ")}`,
    );
  }

  const url = `https://${profile.workers!.app!.hostnames![0]}`;
  await checkLivenessV1(context, url, secrets.DEBUG_TOKEN);
  return { url, install: install.name, byHand: [] };
}

/**
 * Whether the deployment answers.
 *
 * `/api/debug` when there is a token — the operator surface, which is the only
 * read that proves the identity store, the bindings and the Durable Objects are
 * all there. Without one, the document: a non-5xx means the Worker is up, and
 * an Access redirect is a pass, not a failure.
 */
async function checkLivenessV1(
  context: SetupContextV1,
  url: string,
  debugToken: string | undefined,
): Promise<void> {
  const target = debugToken ? `${url}/api/debug` : url;
  const probe = await context.runner.run(
    {
      // The token goes in on stdin, not on the command line: argv is readable by
      // every process on the machine.
      cmd: [
        "curl",
        "-sS",
        "-o",
        "/dev/null",
        "-w",
        "%{http_code}",
        "--config",
        "-",
      ],
      cwd: context.repoRoot,
      stdin: [
        `url = "${target}"`,
        ...(debugToken
          ? [`header = "x-frockbot-debug-token: ${debugToken}"`]
          : []),
        "",
      ].join("\n"),
      redactedStdin: debugToken
        ? `a curl config naming ${target} and the debug token`
        : `a curl config naming ${target}`,
    },
    { exitCode: 0, stdout: "200", stderr: "" },
  );
  const status = Number(probe.stdout.trim());
  if (probe.exitCode !== 0 || !Number.isFinite(status) || status >= 500) {
    context.runner.say(
      `  ! ${target} answered ${probe.stdout.trim() || probe.stderr.trim()}. The deploy succeeded, so this is DNS propagating or Access not yet configured; try again in a minute.`,
    );
    return;
  }
  context.runner.say(`  live       ${target} answered ${status}`);
}

/** What the deployer does next, printed at the end of a successful run. */
export function nextStepsV1(
  outcome: SetupOutcomeV1,
  skipped: readonly string[],
): string[] {
  const lines = [
    `Open ${outcome.url} and sign in through Cloudflare Access.`,
    "The Access policy is the allowlist: whoever it admits has an account, and there is no admission screen to approve them on.",
    "To upgrade: check out the next release tag and run `bun run setup` again. It converges — nothing already there is created twice, and no minted secret is replaced.",
  ];
  if (skipped.length > 0) {
    lines.push(
      `Skipped keys can be added later with \`bunx wrangler secret put <NAME> --name ${outcome.install}\`, or by running this again: ${skipped.join(", ")}.`,
    );
  }
  lines.push(
    "The phone app is not prebuilt for a simple deployment, because a `flutter build` bakes the origin in; docs/app-updates.md says how to build your own.",
  );
  return [...lines, ...outcome.byHand];
}
