/**
 * The deploy's steps, run against the person's account.
 *
 * The release itself goes in through the deploy bundle's own deployer,
 * `deployBundleV1` ([docs/deploy-bundles.md](../../../../docs/deploy-bundles.md)),
 * the same one `scripts/deploy-bundle.ts` runs, so an install made here and one made
 * from the repository are the same install. What is this page's own is around
 * it: staging the release, Access, the secrets a first install mints, and the
 * checks.
 *
 * Every step converges: it finds what a previous run made and keeps it, so a
 * step retried after an eviction, a failure or a closed page does the same
 * thing twice without making anything twice. An update is the same steps over
 * the same install record, which is how the install keeps its data.
 */
import {
  installNameOfV1,
  installWorkersV1,
  type BundleWorkerKeyV1,
  type DeployBundleManifestV1,
  type InstallV1,
} from "../../../cloudflare/deployment-config/bundle.ts";
import {
  createCloudflareApiV1,
  deployBundleV1,
} from "../../../cloudflare/deployment-config/deploy.ts";
import { generateVapidKeysV1 } from "../../../cloudflare/src/web-push.ts";
import { CloudflareApiErrorV1, type CloudflareApiV1 } from "./cloudflare-api";
import {
  credentialKeyringV1,
  installHostnameV1,
  installOriginV1,
  randomHexV1,
  suggestedTeamNameV1,
  type DeployStepIdV1,
} from "./plan";
import {
  stageBundleV1,
  stagedFilesV1,
  type DigestSinkV1,
  type StagingBucketV1,
} from "./release";
import { JEV_MODEL_V1, probeJevV1 } from "./jev-probe";
import { randomSuffixV1 } from "./oauth";

/** What `/deploy` keeps about an install: names and ids, never a secret. */
export interface InstallRecordV1 {
  readonly name: string;
  readonly accountId: string;
  readonly accountName: string;
  readonly workersSubdomain: string;
  readonly ownerEmail: string;
  /** The release the install runs, once a deploy of it finished. */
  readonly version?: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly accessTeamDomain?: string;
  readonly accessAud?: string;
}

export interface DeployContextV1 {
  readonly api: CloudflareApiV1;
  /** The person's token, for the bundle's deployer. */
  readonly token: string;
  readonly manifest: DeployBundleManifestV1;
  /** frockbot.com's own bucket, where releases are staged. */
  readonly bundles: StagingBucketV1;
  readonly fetcher: typeof fetch;
  readonly now: () => Date;
  readonly digestSink?: () => DigestSinkV1;
  /** Between a probe's attempts; tests pass one that doesn't sleep. */
  readonly wait?: (ms: number) => Promise<void>;
}

/** Thrown by a step that isn't finished yet and should be tried again shortly. */
export class NotYetV1 extends Error {}

export type StepRunnerV1 = (
  context: DeployContextV1,
  install: InstallRecordV1,
) => Promise<InstallRecordV1>;

/**
 * The release staged, and the install's buckets and search index. The bundle's
 * deployer would create these too; they are made here so the page can say so,
 * and it finds them present.
 */
async function storage(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  const { api, manifest } = context;
  await stageBundleV1(context.bundles, manifest, {
    fetcher: context.fetcher,
    ...(context.digestSink ? { digestSink: context.digestSink } : {}),
  });
  for (const template of manifest.resources.r2Buckets) {
    await api.ensureR2Bucket(
      install.accountId,
      installNameOfV1(template, install.name),
    );
  }
  for (const index of manifest.resources.vectorizeIndexes) {
    await api.ensureVectorizeIndex(
      install.accountId,
      installNameOfV1(index.name, install.name),
      { dimensions: index.dimensions, metric: index.metric },
    );
  }
  return install;
}

/**
 * The Access organization, created when Zero Trust is on but has none, and
 * the install's applications (ADR 0028): Allow on the hostname for the owner
 * alone, which covers the document, the client and the native sign-in flow;
 * Bypass on `/api`, which reaches the Worker, which authenticates every one
 * of those requests itself; and Bypass on the discovery file the apps read
 * before anyone has signed in.
 */
async function signIn(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  const { api } = context;
  const { accountId } = install;
  let organization = await api.accessOrganization(accountId);
  for (let attempt = 0; !organization; attempt += 1) {
    // A team domain is global across Cloudflare, so a taken one gets a suffix.
    const base = suggestedTeamNameV1(install.accountName, accountId);
    const team = attempt === 0 ? base : `${base}-${randomSuffixV1()}`;
    try {
      organization = await api.createAccessOrganization(accountId, {
        name: install.accountName || team,
        auth_domain: `${team}.cloudflareaccess.com`,
      });
    } catch (error) {
      if (
        attempt >= 2 ||
        !(error instanceof CloudflareApiErrorV1) ||
        error.status >= 500
      )
        throw error;
    }
  }
  const hostname = installHostnameV1(install.name, install.workersSubdomain);
  const existing = await api.accessApplications(accountId);
  const app = await api.putAccessApplication(
    accountId,
    {
      name: `FrockBot ${install.name}`,
      domain: hostname,
      decision: "allow",
      email: install.ownerEmail,
    },
    existing,
  );
  await api.putAccessApplication(
    accountId,
    {
      name: `FrockBot ${install.name} API`,
      domain: `${hostname}/api`,
      decision: "bypass",
    },
    existing,
  );
  await api.putAccessApplication(
    accountId,
    {
      name: `FrockBot ${install.name} discovery`,
      domain: `${hostname}/.well-known/frockbot.json`,
      decision: "bypass",
    },
    existing,
  );
  return {
    ...install,
    accessTeamDomain: organization.auth_domain,
    accessAud: app.aud,
  };
}

/**
 * The secrets this deploy sets, by name.
 *
 * A minted secret is established once the app Worker holds it: the app is
 * what encrypts and signs stored state with it, and it is uploaded last. Until
 * then a fresh value is minted and set on every Worker that shares it, which
 * is safe because nothing durable depends on it yet — and is how a first
 * deploy that stopped between two Workers converges. Once established it is
 * never sent again: the upload keeps it. The owner's email is set every time,
 * as the one admin.
 */
async function secretsFor(
  context: DeployContextV1,
  install: InstallRecordV1,
  bundleInstall: Omit<InstallV1, "secrets">,
): Promise<Record<string, string>> {
  const { api, manifest } = context;
  const app = installNameOfV1(manifest.workers.app.name, install.name);
  const appHolds = new Set(
    (await api.script(install.accountId, app))
      ? await api.scriptSecretNames(install.accountId, app)
      : [],
  );
  const origin = installOriginV1(install.name, install.workersSubdomain);
  const secrets: Record<string, string> = {
    FROCKBOT_ADMIN_EMAILS: install.ownerEmail,
  };
  const workers: readonly BundleWorkerKeyV1[] = installWorkersV1({
    ...bundleInstall,
    secrets: {},
  });
  for (const key of workers) {
    for (const secret of manifest.workers[key].secrets) {
      if (!secret.mint || secret.name in secrets) continue;
      // A secret for a Worker this install doesn't run is left to whoever
      // deploys that Worker, who then sets it on both sides.
      if (secret.requiredWith && !workers.includes(secret.requiredWith)) {
        continue;
      }
      if (appHolds.has(secret.name)) continue;
      secrets[secret.name] =
        secret.mint === "keyring"
          ? credentialKeyringV1(context.now())
          : secret.mint === "vapid"
            ? JSON.stringify(await generateVapidKeysV1(origin))
            : randomHexV1();
    }
  }
  return secrets;
}

/**
 * The release, through the bundle's deployer, on `workers.dev`: the install
 * names no hostname, so the app answers at its own address, which Access
 * already stands in front of.
 */
async function release(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  if (!install.accessTeamDomain || !install.accessAud) {
    throw new Error(
      "Sign-in wasn't set up before the release, so it wasn't deployed",
    );
  }
  const bundleInstall = {
    accountId: install.accountId,
    name: install.name,
    hostnames: [],
    computerHost: false,
    // Only the names the bundle asks for are used.
    vars: {
      ACCESS_TEAM_DOMAIN: install.accessTeamDomain,
      ACCESS_AUD: install.accessAud,
      APP_ORIGIN: installOriginV1(install.name, install.workersSubdomain),
    },
  };
  await deployBundleV1({
    api: createCloudflareApiV1({
      token: context.token,
      fetch: context.fetcher,
    }),
    manifest: context.manifest,
    files: stagedFilesV1(context.bundles, context.manifest.version),
    install: {
      ...bundleInstall,
      secrets: await secretsFor(context, install, bundleInstall),
    },
  });
  return install;
}

/**
 * Jev answers this account's `AI` binding. Asked again here, after the
 * release, because the Choose page's reading may be stale; a probe that
 * couldn't tell is tried again rather than failed.
 */
async function workersAi(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  const jev = await probeJevV1(context.api, install.accountId, {
    subdomain: async () => install.workersSubdomain,
    fetcher: context.fetcher,
    ...(context.wait ? { wait: context.wait } : {}),
  });
  if (jev.state === "refused") {
    throw new Error(
      `Workers AI won’t run Jev (${JEV_MODEL_V1}) for this account, so your bots can’t start a Turn. Cloudflare said: ${jev.reason}`,
    );
  }
  if (jev.state === "unknown") throw new NotYetV1(jev.reason);
  return install;
}

/**
 * The install answers, and answers the right way: the page is behind Access,
 * and `/api` reaches the Worker, which refuses a request with no sign-in
 * itself. A new `workers.dev` name can take a minute or two to resolve, so an
 * install that doesn't answer yet is tried again rather than failed.
 */
async function firstCheck(
  context: DeployContextV1,
  install: InstallRecordV1,
): Promise<InstallRecordV1> {
  const origin = installOriginV1(install.name, install.workersSubdomain);
  let page: Response;
  let api: Response;
  try {
    page = await context.fetcher(`${origin}/`, { redirect: "manual" });
    api = await context.fetcher(`${origin}/api/identity`, {
      redirect: "manual",
    });
  } catch {
    throw new NotYetV1("Your install isn’t answering yet.");
  }
  const location = page.headers.get("location") ?? "";
  const guarded =
    (page.status === 302 || page.status === 303) &&
    (/\.cloudflareaccess\.com\//.test(location) ||
      location.includes("/cdn-cgi/access/"));
  if (!guarded) {
    if (page.status === 404 || page.status >= 500) {
      throw new NotYetV1("Your install isn’t answering yet.");
    }
    throw new Error(
      `Your install answered without asking anyone to sign in (${page.status}). Cloudflare Access isn’t in front of it yet.`,
    );
  }
  const isWorker =
    api.status === 401 &&
    (api.headers.get("content-type") ?? "").includes("json");
  if (!isWorker) throw new NotYetV1("Your install’s app isn’t answering yet.");
  return install;
}

/**
 * Sign-in runs before the release on purpose: the Worker is uploaded with the
 * audience Access issued, and `workers.dev` is switched on only once Access
 * stands in front of it, so the install is never reachable unguarded.
 */
export const STEP_RUNNERS_V1: Readonly<Record<DeployStepIdV1, StepRunnerV1>> = {
  storage,
  "sign-in": signIn,
  release,
  "workers-ai": workersAi,
  "first-check": firstCheck,
};

/** A failure worth trying again by itself, rather than showing. */
export function isTransientV1(error: unknown): boolean {
  if (error instanceof NotYetV1) return true;
  if (error instanceof CloudflareApiErrorV1)
    return error.status === 429 || error.status >= 500;
  return false;
}
