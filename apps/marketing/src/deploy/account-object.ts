/**
 * One Cloudflare user's side of `/deploy`: their sign-in sessions, the
 * installs they deployed from here, and the deploy running now.
 *
 * A Durable Object named by the Cloudflare user id, so everything about one
 * person is in one place and one deploy runs at a time. The deploy advances
 * by alarm, one step per wake, with its state written before and after each
 * step: a closed page, an eviction or a failed step leaves it resumable from
 * the step it was on, and reopening the page reads the same record.
 *
 * Cloudflare tokens live here and nowhere else — never in a cookie, never in
 * the page. Each sign-in is one grant, which its session and any deploy it
 * started share: Cloudflare rotates the refresh token on every use, so two
 * copies would each invalidate the other. The grant goes when neither needs
 * it — the session ended or lapsed after twelve hours, and no deploy runs on it.
 */
import { DurableObject } from "cloudflare:workers";
import { accountChecksV1 } from "./checks";
import {
  CloudflareApiV1,
  type CloudflareAccountV1,
  type CloudflareUserV1,
} from "./cloudflare-api";
import {
  STEP_RUNNERS_V1,
  isTransientV1,
  type InstallRecordV1,
} from "./deployer";
import { releaseManifestV1 } from "./release";
import {
  checksPassV1,
  initialStepsV1,
  installNameProblemV1,
  suggestedWorkersSubdomainV1,
  type AccountCheckV1,
  type DeployStepV1,
} from "./plan";
import {
  randomTokenV1,
  refreshTokensV1,
  revokeTokenV1,
  type OAuthClientV1,
  type OAuthTokensV1,
} from "./oauth";
import { oauthClientV1, type DeployEnvV1 } from "./env";

export const SESSION_LIFETIME_MS_V1 = 12 * 60 * 60 * 1000;
/** How long a step that isn't finished yet (a new `workers.dev` name) is waited on. */
const NOT_YET_LIMIT_MS = 5 * 60 * 1000;
const TRANSIENT_RETRIES = 4;

interface SessionRecordV1 {
  readonly secretHash: string;
  readonly user: CloudflareUserV1;
  readonly accounts: readonly CloudflareAccountV1[];
  readonly expiresAt: number;
  readonly checks?: {
    readonly accountId: string;
    readonly results: readonly AccountCheckV1[];
  };
}

export interface DeployJobV1 {
  readonly id: string;
  readonly kind: "deploy" | "update";
  readonly installKey: string;
  readonly version: string;
  readonly fromVersion?: string;
  readonly steps: readonly DeployStepV1[];
  readonly state: "running" | "done" | "failed";
  readonly error?: string;
  readonly startedAt: string;
  readonly finishedAt?: string;
  /** The sign-in the job runs on; present only while it runs. */
  readonly grantId?: string;
  readonly attempts?: number;
  readonly waitingSince?: number;
}

export interface SessionViewV1 {
  readonly user: CloudflareUserV1;
  readonly accounts: readonly CloudflareAccountV1[];
}

export interface DeployStatusV1 {
  readonly session: SessionViewV1;
  readonly installs: readonly InstallRecordV1[];
  readonly job?: Omit<DeployJobV1, "grantId">;
}

export type StartResultV1 =
  | { readonly ok: true; readonly job: Omit<DeployJobV1, "grantId"> }
  | { readonly ok: false; readonly problem: string };

export function installKeyV1(accountId: string, name: string): string {
  return `${accountId}/${name}`;
}

async function hashSecret(secret: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(secret),
  );
  return [...new Uint8Array(digest)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function publicJob(job: DeployJobV1): Omit<DeployJobV1, "grantId"> {
  const { grantId: _grantId, ...rest } = job;
  return rest;
}

export class DeployAccount extends DurableObject<DeployEnvV1> {
  /** Refreshes in flight, so a page and the deploy never redeem one refresh token twice. */
  private readonly refreshing = new Map<string, Promise<OAuthTokensV1>>();

  private client(): OAuthClientV1 {
    const client = oauthClientV1(this.env);
    if (!client)
      throw new Error("Sign in with Cloudflare isn't configured here");
    return client;
  }

  private sessionKey(secretHash: string): string {
    return `session:${secretHash}`;
  }

  private grantKey(grantId: string): string {
    return `grant:${grantId}`;
  }

  /** A usable access token for the grant, refreshed once and written back when lapsed. */
  private async token(grantId: string): Promise<string> {
    const grant = await this.ctx.storage.get<OAuthTokensV1>(
      this.grantKey(grantId),
    );
    if (!grant)
      throw new Error("Your Cloudflare sign-in has ended. Sign in again.");
    if (grant.expiresAt > Date.now()) return grant.accessToken;
    let pending = this.refreshing.get(grantId);
    if (!pending) {
      pending = (async () => {
        const tokens = await refreshTokensV1(this.client(), grant);
        await this.ctx.storage.put(this.grantKey(grantId), tokens);
        return tokens;
      })().finally(() => this.refreshing.delete(grantId));
      this.refreshing.set(grantId, pending);
    }
    return (await pending).accessToken;
  }

  /** Drops the grant once neither a live session nor a running deploy needs it. */
  private async releaseGrant(grantId: string): Promise<void> {
    const session = await this.ctx.storage.get<SessionRecordV1>(
      this.sessionKey(grantId),
    );
    if (session && session.expiresAt > Date.now()) return;
    const job = await this.job();
    if (job?.state === "running" && job.grantId === grantId) return;
    const grant = await this.ctx.storage.get<OAuthTokensV1>(
      this.grantKey(grantId),
    );
    await this.ctx.storage.delete(this.grantKey(grantId));
    const client = oauthClientV1(this.env);
    if (client && grant?.refreshToken) {
      await revokeTokenV1(client, grant.refreshToken);
    }
  }

  private async installs(): Promise<Record<string, InstallRecordV1>> {
    return (
      (await this.ctx.storage.get<Record<string, InstallRecordV1>>(
        "installs",
      )) ?? {}
    );
  }

  private async putInstall(install: InstallRecordV1): Promise<void> {
    const installs = await this.installs();
    installs[installKeyV1(install.accountId, install.name)] = install;
    await this.ctx.storage.put("installs", installs);
  }

  private async job(): Promise<DeployJobV1 | undefined> {
    return this.ctx.storage.get<DeployJobV1>("job");
  }

  /** Opens a session; the returned secret is the cookie's half, and only its hash is kept. */
  async startSession(
    user: CloudflareUserV1,
    accounts: readonly CloudflareAccountV1[],
    tokens: OAuthTokensV1,
  ): Promise<string> {
    const secret = randomTokenV1(32);
    const record: SessionRecordV1 = {
      secretHash: await hashSecret(secret),
      user,
      accounts,
      expiresAt: Date.now() + SESSION_LIFETIME_MS_V1,
    };
    await this.ctx.storage.put(this.grantKey(record.secretHash), tokens);
    await this.ctx.storage.put(this.sessionKey(record.secretHash), record);
    await this.scheduleAlarm();
    return secret;
  }

  private async session(secret: string): Promise<SessionRecordV1 | null> {
    const record = await this.ctx.storage.get<SessionRecordV1>(
      this.sessionKey(await hashSecret(secret)),
    );
    if (!record || record.expiresAt <= Date.now()) return null;
    return record;
  }

  async endSession(secret: string): Promise<void> {
    const record = await this.session(secret);
    if (!record) return;
    await this.ctx.storage.delete(this.sessionKey(record.secretHash));
    // A deploy running on this sign-in keeps the grant until it finishes.
    await this.releaseGrant(record.secretHash);
  }

  async status(secret: string): Promise<DeployStatusV1 | null> {
    const record = await this.session(secret);
    if (!record) return null;
    const job = await this.job();
    return {
      session: { user: record.user, accounts: record.accounts },
      installs: Object.values(await this.installs()).sort((a, b) =>
        a.createdAt.localeCompare(b.createdAt),
      ),
      ...(job ? { job: publicJob(job) } : {}),
    };
  }

  /** The account's `workers.dev` subdomain, or the one a first deploy will create. */
  async workersSubdomain(
    secret: string,
    accountId: string,
  ): Promise<{ subdomain: string; exists: boolean } | null> {
    const record = await this.session(secret);
    const account = record?.accounts.find((a) => a.id === accountId);
    if (!record || !account) return null;
    const api = new CloudflareApiV1(await this.token(record.secretHash));
    const subdomain = await api.workersSubdomain(accountId);
    return subdomain
      ? { subdomain, exists: true }
      : {
          subdomain: suggestedWorkersSubdomainV1(account.name, accountId),
          exists: false,
        };
  }

  async checks(
    secret: string,
    accountId: string,
  ): Promise<AccountCheckV1[] | null> {
    const record = await this.session(secret);
    if (!record || !record.accounts.some((a) => a.id === accountId))
      return null;
    const api = new CloudflareApiV1(await this.token(record.secretHash));
    const results = await accountChecksV1(api, accountId);
    const latest = (await this.session(secret)) ?? record;
    await this.ctx.storage.put(this.sessionKey(record.secretHash), {
      ...latest,
      checks: { accountId, results },
    });
    return results;
  }

  async startDeploy(
    secret: string,
    accountId: string,
    name: string,
    version: string,
  ): Promise<StartResultV1> {
    const record = await this.session(secret);
    const account = record?.accounts.find((a) => a.id === accountId);
    if (!record || !account)
      return {
        ok: false,
        problem: "Your Cloudflare sign-in has ended. Sign in again.",
      };
    const current = await this.job();
    if (current?.state === "running")
      return { ok: false, problem: "A deploy is already running." };
    const nameProblem = installNameProblemV1(name);
    if (nameProblem) return { ok: false, problem: nameProblem };
    // Deploy turns on only once every check passed, and the server holds the
    // page to the same rule rather than trusting a button's state.
    if (
      record.checks?.accountId !== accountId ||
      !checksPassV1(record.checks.results)
    ) {
      return { ok: false, problem: "Every account check has to pass first." };
    }
    const key = installKeyV1(accountId, name);
    const existing = (await this.installs())[key];
    const api = new CloudflareApiV1(await this.token(record.secretHash));
    if (!existing && (await api.script(accountId, name))) {
      return {
        ok: false,
        problem: `This account already has a Worker called ${name}. Choose another name.`,
      };
    }
    let subdomain = await api.workersSubdomain(accountId);
    if (!subdomain) {
      subdomain = await api.createWorkersSubdomain(
        accountId,
        suggestedWorkersSubdomainV1(account.name, accountId),
      );
    }
    const now = new Date().toISOString();
    const install: InstallRecordV1 = existing ?? {
      name,
      accountId,
      accountName: account.name,
      workersSubdomain: subdomain,
      ownerEmail: record.user.email,
      createdAt: now,
      updatedAt: now,
    };
    await this.putInstall(install);
    return this.begin(
      existing ? "update" : "deploy",
      install,
      version,
      record.secretHash,
    );
  }

  async startUpdate(
    secret: string,
    key: string,
    version: string,
  ): Promise<StartResultV1> {
    const record = await this.session(secret);
    if (!record)
      return {
        ok: false,
        problem: "Your Cloudflare sign-in has ended. Sign in again.",
      };
    const install = (await this.installs())[key];
    if (!install)
      return {
        ok: false,
        problem: "That install isn't one deployed from here.",
      };
    if (!record.accounts.some((a) => a.id === install.accountId)) {
      return {
        ok: false,
        problem: `Sign in to the Cloudflare account ${install.accountName} to update this install.`,
      };
    }
    const current = await this.job();
    if (current?.state === "running")
      return { ok: false, problem: "A deploy is already running." };
    return this.begin("update", install, version, record.secretHash);
  }

  /** Picks the failed job up at the step it failed on, with this session's grant. */
  async retry(secret: string): Promise<StartResultV1> {
    const record = await this.session(secret);
    const job = await this.job();
    if (!record)
      return {
        ok: false,
        problem: "Your Cloudflare sign-in has ended. Sign in again.",
      };
    if (!job || job.state !== "failed")
      return { ok: false, problem: "There's nothing to try again." };
    const resumed: DeployJobV1 = {
      ...job,
      state: "running",
      grantId: record.secretHash,
      attempts: 0,
      steps: job.steps.map((s) =>
        s.state === "failed" ? { id: s.id, state: "waiting" } : s,
      ),
    };
    delete (resumed as { error?: string }).error;
    delete (resumed as { finishedAt?: string }).finishedAt;
    await this.ctx.storage.put("job", resumed);
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true, job: publicJob(resumed) };
  }

  private async begin(
    kind: DeployJobV1["kind"],
    install: InstallRecordV1,
    version: string,
    grantId: string,
  ): Promise<StartResultV1> {
    const job: DeployJobV1 = {
      id: randomTokenV1(12),
      kind,
      installKey: installKeyV1(install.accountId, install.name),
      version,
      ...(install.version ? { fromVersion: install.version } : {}),
      steps: initialStepsV1(),
      state: "running",
      startedAt: new Date().toISOString(),
      grantId,
      attempts: 0,
    };
    await this.ctx.storage.put("job", job);
    await this.ctx.storage.setAlarm(Date.now());
    return { ok: true, job: publicJob(job) };
  }

  async alarm(): Promise<void> {
    await this.advance();
    await this.expireSessions();
    await this.scheduleAlarm();
  }

  private async advance(): Promise<void> {
    let job = await this.job();
    if (!job || job.state !== "running") return;
    const index = job.steps.findIndex((s) => s.state !== "done");
    if (index < 0) return this.finish(job);
    const step = job.steps[index]!;
    const install = (await this.installs())[job.installKey];
    if (!install)
      return this.fail(job, index, "The install record is missing.");

    job = {
      ...job,
      steps: job.steps.map((s, i) =>
        i === index ? { id: s.id, state: "running" } : s,
      ),
    };
    await this.ctx.storage.put("job", job);
    try {
      if (!job.grantId) {
        throw new Error(
          "This deploy has no Cloudflare sign-in to continue with",
        );
      }
      const token = await this.token(job.grantId);
      const manifest = await releaseManifestV1(job.version);
      const updated = await STEP_RUNNERS_V1[step.id](
        {
          api: new CloudflareApiV1(token),
          manifest,
          fetcher: fetch,
          now: () => new Date(),
        },
        install,
      );
      await this.putInstall({
        ...updated,
        updatedAt: new Date().toISOString(),
      });
      job = {
        ...job,
        attempts: 0,
        steps: job.steps.map((s, i) =>
          i === index ? { id: s.id, state: "done" } : s,
        ),
      };
      delete (job as { waitingSince?: number }).waitingSince;
      await this.ctx.storage.put("job", job);
      if (job.steps.every((s) => s.state === "done")) await this.finish(job);
      else await this.ctx.storage.setAlarm(Date.now());
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const waitingSince = job.waitingSince ?? Date.now();
      const attempts = (job.attempts ?? 0) + 1;
      const waitedOut =
        Date.now() - waitingSince > NOT_YET_LIMIT_MS ||
        attempts > TRANSIENT_RETRIES * 6;
      if (isTransientV1(error) && !waitedOut) {
        const retried: DeployJobV1 = {
          ...job,
          attempts,
          waitingSince,
          steps: job.steps.map((s, i) =>
            i === index ? { id: s.id, state: "running", detail: message } : s,
          ),
        };
        await this.ctx.storage.put("job", retried);
        await this.ctx.storage.setAlarm(
          Date.now() + Math.min(30_000, 2_000 * 2 ** Math.min(attempts, 4)),
        );
        return;
      }
      await this.fail(job, index, message);
    }
  }

  private async finish(job: DeployJobV1): Promise<void> {
    const install = (await this.installs())[job.installKey];
    if (install)
      await this.putInstall({
        ...install,
        version: job.version,
        updatedAt: new Date().toISOString(),
      });
    const done: DeployJobV1 = {
      ...job,
      state: "done",
      finishedAt: new Date().toISOString(),
    };
    delete (done as { grantId?: string }).grantId;
    await this.ctx.storage.put("job", done);
    if (job.grantId) await this.releaseGrant(job.grantId);
  }

  private async fail(
    job: DeployJobV1,
    index: number,
    message: string,
  ): Promise<void> {
    const failed: DeployJobV1 = {
      ...job,
      state: "failed",
      error: message,
      finishedAt: new Date().toISOString(),
      steps: job.steps.map((s, i) =>
        i === index ? { id: s.id, state: "failed", detail: message } : s,
      ),
    };
    delete (failed as { grantId?: string }).grantId;
    await this.ctx.storage.put("job", failed);
    if (job.grantId) await this.releaseGrant(job.grantId);
  }

  private async expireSessions(): Promise<void> {
    const sessions = await this.ctx.storage.list<SessionRecordV1>({
      prefix: "session:",
    });
    const now = Date.now();
    for (const [key, record] of sessions) {
      if (record.expiresAt > now) continue;
      await this.ctx.storage.delete(key);
      await this.releaseGrant(record.secretHash);
    }
  }

  /** The next wake: a running job's is set where it advances; otherwise the next session expiry. */
  private async scheduleAlarm(): Promise<void> {
    const job = await this.job();
    if (
      job?.state === "running" &&
      (await this.ctx.storage.getAlarm()) !== null
    )
      return;
    const sessions = await this.ctx.storage.list<SessionRecordV1>({
      prefix: "session:",
    });
    let next: number | undefined;
    for (const record of sessions.values()) {
      next =
        next === undefined
          ? record.expiresAt
          : Math.min(next, record.expiresAt);
    }
    if (job?.state === "running") next = Date.now();
    if (next !== undefined) await this.ctx.storage.setAlarm(next);
    else await this.ctx.storage.deleteAlarm();
  }
}
