/**
 * `/deploy` on frockbot.com: sign in with Cloudflare, choose, deploy, update.
 *
 * The browser holds one cookie naming the person's Durable Object and a
 * session secret; everything else — the Cloudflare grant included — stays in
 * that object. Every form posts back here, checked against the page's own
 * origin, so another site cannot start a deploy in someone's account.
 */
import { CloudflareApiV1 } from "./cloudflare-api";
import type { DeployStatusV1 } from "./account-object";
import { deployOriginV1, oauthClientV1, type DeployEnvV1 } from "./env";
import { authorizeUrlV1, exchangeCodeV1, randomTokenV1 } from "./oauth";
import {
  choosePageV1,
  installsPageV1,
  oneAccountPageV1,
  problemPageV1,
  progressPageV1,
  readyPageV1,
  startPageV1,
  unavailablePageV1,
} from "./pages";
import {
  checksPassV1,
  normalizeInstallNameV1,
  suggestedInstallNameV1,
} from "./plan";
import { latestDeployableVersionV1, releaseManifestV1 } from "./release";

export const DEPLOY_PATH_V1 = "/deploy";
const SESSION_COOKIE = "__Host-frockbot_deploy";
const OAUTH_COOKIE = "__Host-frockbot_deploy_oauth";

export function isDeployPathV1(pathname: string): boolean {
  return (
    pathname === DEPLOY_PATH_V1 || pathname.startsWith(`${DEPLOY_PATH_V1}/`)
  );
}

function cookie(request: Request, name: string): string | undefined {
  for (const part of (request.headers.get("cookie") ?? "").split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return rest.join("=");
  }
  return undefined;
}

function setCookie(name: string, value: string, maxAge: number): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=${maxAge}`;
}

function redirect(location: string, cookies: readonly string[] = []): Response {
  const headers = new Headers({ location, "cache-control": "no-store" });
  for (const c of cookies) headers.append("set-cookie", c);
  return new Response(null, { status: 303, headers });
}

/** The session cookie is `<cloudflare user id>.<secret>`: which object, and proof. */
function sessionOf(
  request: Request,
): { userId: string; secret: string } | null {
  const value = cookie(request, SESSION_COOKIE);
  if (!value) return null;
  const dot = value.indexOf(".");
  if (dot <= 0) return null;
  const userId = value.slice(0, dot);
  const secret = value.slice(dot + 1);
  if (
    !/^[A-Za-z0-9_-]{1,64}$/.test(userId) ||
    !/^[A-Za-z0-9_-]{20,128}$/.test(secret)
  )
    return null;
  return { userId, secret };
}

function stub(env: DeployEnvV1, userId: string) {
  return env.DEPLOY_ACCOUNTS.get(env.DEPLOY_ACCOUNTS.idFromName(userId));
}

/** A form post from anywhere but this page is refused. */
function sameOrigin(request: Request, env: DeployEnvV1): boolean {
  const origin = request.headers.get("origin");
  return (
    origin === deployOriginV1(env) || origin === new URL(request.url).origin
  );
}

async function latestRelease(): Promise<{
  version: string;
  highlights?: string;
} | null> {
  try {
    const version = await latestDeployableVersionV1();
    if (!version) return null;
    const manifest = await releaseManifestV1(version);
    return {
      version,
      ...(manifest.highlights ? { highlights: manifest.highlights } : {}),
    };
  } catch {
    return null;
  }
}

async function signIn(request: Request, env: DeployEnvV1): Promise<Response> {
  const client = oauthClientV1(env)!;
  const cookies: string[] = [];
  const state = randomTokenV1(24);
  const verifier = randomTokenV1(48);
  cookies.push(setCookie(OAUTH_COOKIE, `${state}.${verifier}`, 600));
  const reconsent = new URL(request.url).searchParams.has("switch");
  return redirect(
    await authorizeUrlV1(client, state, verifier, reconsent),
    cookies,
  );
}

async function callback(request: Request, env: DeployEnvV1): Promise<Response> {
  const url = new URL(request.url);
  const [state, verifier] = (cookie(request, OAUTH_COOKIE) ?? "").split(".");
  const clear = setCookie(OAUTH_COOKIE, "", 0);
  if (url.searchParams.get("error")) {
    return withCookies(startPageV1("Cloudflare sign-in was cancelled."), [
      clear,
    ]);
  }
  const code = url.searchParams.get("code");
  if (!state || !verifier || !code || url.searchParams.get("state") !== state) {
    return withCookies(
      startPageV1("That sign-in link has expired. Sign in again."),
      [clear],
    );
  }
  try {
    const tokens = await exchangeCodeV1(oauthClientV1(env)!, code, verifier);
    const api = new CloudflareApiV1(tokens.accessToken);
    const [user, accounts] = await Promise.all([api.user(), api.accounts()]);
    const secret = await stub(env, user.id).startSession(
      { id: user.id, email: user.email },
      accounts.map((a) => ({ id: a.id, name: a.name })),
      tokens,
    );
    // A sign-in replaces the one before it, which ends here rather than on
    // the GET that started this one, so no other site can sign anyone out.
    const previous = sessionOf(request);
    if (previous) {
      await stub(env, previous.userId)
        .endSession(previous.secret)
        .catch(() => undefined);
    }
    return redirect("/deploy/choose", [
      clear,
      setCookie(SESSION_COOKIE, `${user.id}.${secret}`, 12 * 60 * 60),
    ]);
  } catch (error) {
    return withCookies(
      startPageV1(
        error instanceof Error ? error.message : "Cloudflare sign-in failed.",
      ),
      [clear],
    );
  }
}

function withCookies(response: Response, cookies: readonly string[]): Response {
  const next = new Response(response.body, response);
  for (const c of cookies) next.headers.append("set-cookie", c);
  return next;
}

async function choose(
  env: DeployEnvV1,
  session: { userId: string; secret: string },
  status: DeployStatusV1,
  name?: string,
  problem?: string,
  recheck = false,
): Promise<Response> {
  const [account, ...others] = status.session.accounts;
  if (!account) {
    return startPageV1(
      "That Cloudflare sign-in didn’t include an account. Sign in again and choose one.",
    );
  }
  if (others.length > 0) return oneAccountPageV1(status.session.accounts);
  const object = stub(env, session.userId);
  const [subdomain, checks, latest] = await Promise.all([
    object.workersSubdomain(session.secret, account.id),
    object.checks(session.secret, account.id, recheck),
    latestRelease(),
  ]);
  const chosen =
    name ??
    (status.installs.some(
      (i) => i.name === suggestedInstallNameV1(status.session.user.email),
    )
      ? `${suggestedInstallNameV1(status.session.user.email).slice(0, 36)}-${status.installs.length + 1}`
      : suggestedInstallNameV1(status.session.user.email));
  return choosePageV1({
    email: status.session.user.email,
    account,
    name: chosen,
    workersSubdomain: subdomain?.subdomain ?? "your-account",
    checks: checks ?? [],
    canDeploy:
      checksPassV1(checks ?? []) &&
      latest !== null &&
      status.job?.state !== "running",
    version: latest?.version ?? null,
    ...(problem ? { problem } : {}),
  });
}

function jobInstall(status: DeployStatusV1) {
  const job = status.job;
  if (!job) return undefined;
  return status.installs.find(
    (i) => `${i.accountId}/${i.name}` === job.installKey,
  );
}

/**
 * Every `/deploy` request. A Cloudflare call that fails — a revoked grant, an
 * API that answered 403 — is shown as a page with a way back, never a 500.
 */
export async function handleDeployRequestV1(
  request: Request,
  env: DeployEnvV1,
): Promise<Response> {
  try {
    return await handle(request, env);
  } catch (error) {
    return problemPageV1(
      error instanceof Error ? error.message : "Something went wrong.",
    );
  }
}

async function handle(request: Request, env: DeployEnvV1): Promise<Response> {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || DEPLOY_PATH_V1;
  if (!oauthClientV1(env)) return unavailablePageV1();

  if (path === "/deploy/sign-in") return signIn(request, env);
  if (path === "/deploy/callback") return callback(request, env);

  const session = sessionOf(request);
  const status = session
    ? await stub(env, session.userId).status(session.secret)
    : null;
  const signedOut = () =>
    withCookies(
      path === DEPLOY_PATH_V1 ? startPageV1() : redirect(DEPLOY_PATH_V1),
      [setCookie(SESSION_COOKIE, "", 0)],
    );

  if (request.method === "POST") {
    if (!sameOrigin(request, env))
      return new Response("Forbidden", { status: 403 });
    if (!session || !status)
      return redirect(DEPLOY_PATH_V1, [setCookie(SESSION_COOKIE, "", 0)]);
    const object = stub(env, session.userId);
    const form = await request.formData();
    switch (path) {
      case "/deploy/start": {
        const name = normalizeInstallNameV1(String(form.get("name") ?? ""));
        const accountId = String(form.get("accountId") ?? "");
        const latest = await latestRelease();
        if (!latest)
          return choose(
            env,
            session,
            status,
            name,
            "There’s no release to deploy right now.",
          );
        const started = await object.startDeploy(
          session.secret,
          accountId,
          name,
          latest.version,
        );
        return started.ok
          ? redirect("/deploy/progress")
          : choose(env, session, status, name, started.problem);
      }
      case "/deploy/update": {
        const latest = await latestRelease();
        if (!latest) return redirect("/deploy/installs");
        const started = await object.startUpdate(
          session.secret,
          String(form.get("install") ?? ""),
          latest.version,
        );
        return started.ok
          ? redirect("/deploy/progress")
          : installsPageV1(
              status.installs,
              latest,
              status.job?.state === "running",
              started.problem,
            );
      }
      case "/deploy/retry": {
        const started = await object.retry(session.secret);
        return started.ok
          ? redirect("/deploy/progress")
          : redirect("/deploy/installs");
      }
      case "/deploy/sign-out":
        await object.endSession(session.secret);
        return redirect(DEPLOY_PATH_V1, [setCookie(SESSION_COOKIE, "", 0)]);
      default:
        return new Response("Not found", { status: 404 });
    }
  }
  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { allow: "GET, HEAD, POST" },
    });
  }

  if (!session || !status) return signedOut();
  switch (path) {
    case DEPLOY_PATH_V1:
      if (status.job?.state === "running") return redirect("/deploy/progress");
      return redirect(
        status.installs.length > 0 ? "/deploy/installs" : "/deploy/choose",
      );
    case "/deploy/choose":
      return choose(
        env,
        session,
        status,
        undefined,
        undefined,
        url.searchParams.has("check"),
      );
    case "/deploy/progress": {
      const install = jobInstall(status);
      if (!status.job || !install) return redirect("/deploy/choose");
      if (status.job.state === "done") return redirect("/deploy/ready");
      return progressPageV1(status.job, install);
    }
    case "/deploy/ready": {
      const install = jobInstall(status);
      if (!install || status.job?.state !== "done")
        return redirect("/deploy/progress");
      return readyPageV1(install);
    }
    case "/deploy/installs":
      return installsPageV1(
        status.installs,
        await latestRelease(),
        status.job?.state === "running",
      );
    default:
      return new Response("Not found", { status: 404 });
  }
}
