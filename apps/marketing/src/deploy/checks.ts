/**
 * The account checks on the Choose page, read from the person's account.
 *
 * Each answers yes, no, or "couldn't tell"; only a yes lets Deploy on, and a
 * no carries the fix. Nothing here is cached beyond the page's session: a
 * person who just turned something on clicks Check again and is read afresh.
 */
import { CloudflareApiErrorV1, type CloudflareApiV1 } from "./cloudflare-api";
import { JEV_MODEL_V1 } from "./deployer";
import {
  r2CheckV1,
  workersAiCheckV1,
  workersPaidCheckV1,
  zeroTrustCheckV1,
  type AccountCheckV1,
} from "./plan";

export const PLAN_PROBE_WORKER_V1 = "frockbot-plan-check";

/** R2's code for an account that has not turned it on. */
const R2_NOT_ENABLED = 10042;

/**
 * Whether the account is on Workers Paid.
 *
 * Cloudflare grants no billing scope to a third party, so the plan is read by
 * doing the thing FrockBot needs Paid for: uploading a Worker with a Worker
 * Loader binding, which only Paid accepts. The probe is a one-line Worker,
 * deleted straight after, under one fixed name: a delete that failed leaves a
 * single Worker the next probe overwrites, never a trail of them.
 */
export async function probeWorkersPaidV1(
  api: CloudflareApiV1,
  accountId: string,
): Promise<boolean | undefined> {
  const name = PLAN_PROBE_WORKER_V1;
  try {
    await api.uploadScript(accountId, name, {
      metadata: {
        main_module: "index.js",
        compatibility_date: "2026-08-27",
        bindings: [{ type: "worker_loader", name: "LOADER" }],
      },
      modules: [
        {
          name: "index.js",
          contentType: "application/javascript+module",
          body: new TextEncoder().encode(
            "export default { fetch() { return new Response(null, { status: 204 }); } };",
          ),
        },
      ],
    });
    return true;
  } catch (error) {
    if (
      error instanceof CloudflareApiErrorV1 &&
      /paid|plan|subscri/i.test(error.message)
    ) {
      return false;
    }
    return undefined;
  } finally {
    await api.deleteScript(accountId, name).catch(() => undefined);
  }
}

async function r2Enabled(
  api: CloudflareApiV1,
  accountId: string,
): Promise<boolean | undefined> {
  try {
    await api.r2Buckets(accountId);
    return true;
  } catch (error) {
    if (error instanceof CloudflareApiErrorV1 && error.has(R2_NOT_ENABLED))
      return false;
    return undefined;
  }
}

/** Workers AI answers, and serves Jev, which every Turn is supervised by. */
async function workersAi(
  api: CloudflareApiV1,
  accountId: string,
): Promise<boolean | undefined> {
  try {
    return await api.aiModelAvailable(accountId, JEV_MODEL_V1);
  } catch {
    return undefined;
  }
}

async function readsAsEnabled(
  read: () => Promise<unknown>,
): Promise<boolean | undefined> {
  try {
    return (await read()) !== null;
  } catch (error) {
    if (
      error instanceof CloudflareApiErrorV1 &&
      error.status >= 400 &&
      error.status < 500
    ) {
      return error.status === 401 ? undefined : false;
    }
    return undefined;
  }
}

/**
 * Whether Zero Trust is on: the account has an Access organization, or its
 * Zero Trust (Gateway) account exists and the organization is what the deploy
 * still has to create. An account that never turned it on answers both reads
 * with an error rather than an empty result; only an authorization failure is
 * "couldn't tell".
 */
export async function zeroTrustEnabledV1(
  api: CloudflareApiV1,
  accountId: string,
): Promise<boolean | undefined> {
  const organization = await readsAsEnabled(() =>
    api.accessOrganization(accountId),
  );
  if (organization === true) return true;
  const gateway = await readsAsEnabled(() => api.zeroTrustAccount(accountId));
  if (gateway === true) return true;
  return organization === undefined || gateway === undefined
    ? undefined
    : false;
}

export async function accountChecksV1(
  api: CloudflareApiV1,
  accountId: string,
): Promise<AccountCheckV1[]> {
  const [paid, r2, ai, zeroTrust] = await Promise.all([
    probeWorkersPaidV1(api, accountId),
    r2Enabled(api, accountId),
    workersAi(api, accountId),
    zeroTrustEnabledV1(api, accountId),
  ]);
  return [
    workersPaidCheckV1(accountId, paid),
    r2CheckV1(accountId, r2),
    workersAiCheckV1(accountId, ai),
    zeroTrustCheckV1(accountId, zeroTrust),
  ];
}
