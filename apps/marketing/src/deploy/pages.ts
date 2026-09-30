/**
 * The `/deploy` pages, rendered on the server.
 *
 * Plain HTML under the site's CSP: no inline script or style, so every rule is
 * in `/assets/deploy/deploy.css`, and the one script, `/assets/deploy/deploy.js`, only
 * previews the address as a name is typed and keeps the Deploying page live.
 * Every page works without it.
 */
import type { InstallRecordV1 } from "./deployer";
import type { DeployJobV1 } from "./account-object";
import type { CloudflareAccountV1 } from "./cloudflare-api";
import {
  DEPLOY_STEPS_V1,
  installHostnameV1,
  installOriginV1,
  progressPercentV1,
  stepDoneTextV1,
  stepTitleV1,
  stepWaitingTextV1,
  isNewerVersionV1,
  type AccountCheckV1,
  type DeployStepV1,
} from "./plan";

const REPOSITORY_URL = "https://github.com/timoconnellaus/frockbot";

export class Html {
  constructor(readonly value: string) {}
  toString(): string {
    return this.value;
  }
}

export function escapeHtmlV1(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

type Part = Html | string | number | undefined | null | false | readonly Part[];

function render(part: Part): string {
  if (part === undefined || part === null || part === false) return "";
  if (part instanceof Html) return part.value;
  if (Array.isArray(part)) return part.map(render).join("");
  return escapeHtmlV1(String(part));
}

/** Interpolations are escaped unless they are already `Html`. */
export function html(strings: TemplateStringsArray, ...parts: Part[]): Html {
  let out = strings[0] ?? "";
  parts.forEach((part, i) => {
    out += render(part) + (strings[i + 1] ?? "");
  });
  return new Html(out);
}

const TICK = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="3"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="m5 12 5 5 9-10"></path>
</svg>`;
const ALERT = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="3"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M12 7v6"></path>
  <path d="M12 17h.01"></path>
</svg>`;
const SPIN = html`<svg
  width="14"
  height="14"
  viewBox="0 0 24 24"
  fill="none"
  stroke="currentColor"
  stroke-width="3"
  stroke-linecap="round"
  stroke-linejoin="round"
  aria-hidden="true"
>
  <path d="M12 3a9 9 0 1 0 9 9"></path>
</svg>`;

function page(
  title: string,
  main: Html,
  options: { live?: boolean } = {},
): Response {
  const body = html`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="UTF-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta
          name="description"
          content="Deploy FrockBot into your own Cloudflare account, and update it with one click."
        />
        <meta name="theme-color" content="#1e1d27" />
        <meta name="robots" content="noindex" />
        <link rel="icon" href="/assets/favicon.png" />
        <link rel="stylesheet" href="/assets/deploy/deploy.css" />
        <script src="/assets/deploy/deploy.js" defer></script>
        <title>${title} · FrockBot</title>
      </head>
      <body
        class="deploy-page"
        ${options.live ? new Html(' data-live="true"') : ""}
      >
        <header class="deploy-header">
          <a class="deploy-brand" href="/" aria-label="FrockBot home">
            <img src="/assets/app-icon.png" alt="" width="44" height="44" />
            <span>Frock<span class="deploy-accent">Bot</span></span>
          </a>
          <span class="deploy-muted deploy-small"
            >Run FrockBot in your Cloudflare account</span
          >
        </header>
        <main id="deploy-main" class="deploy-main">${main}</main>
      </body>
    </html>`;
  return new Response(body.value, {
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

type StepName = "Sign in" | "Choose" | "Deploy" | "Ready";
const STEP_NAMES: readonly StepName[] = [
  "Sign in",
  "Choose",
  "Deploy",
  "Ready",
];

function stepper(current: StepName, allDone = false): Html {
  const at = STEP_NAMES.indexOf(current);
  return html`<nav class="deploy-steps" aria-label="Deploy steps">
    <ol>
      ${STEP_NAMES.map((name, i) => {
        const done = allDone || i < at;
        const state = done ? "done" : i === at ? "on" : "";
        return html`<li
          class="${state}"
          ${i === at && !allDone ? new Html(' aria-current="step"') : ""}
        >
          <span class="deploy-step-n">${done ? TICK : String(i + 1)}</span
          >${name}
        </li>`;
      })}
    </ol>
  </nav>`;
}

export function unavailablePageV1(): Response {
  return page(
    "Deploy FrockBot",
    html`<section class="deploy-narrow">
      <p class="deploy-label">Self-host</p>
      <h1 class="deploy-title">One-click deploys aren’t switched on here.</h1>
      <p class="deploy-lede">
        You can still run FrockBot in your own Cloudflare account from the
        repository.
      </p>
      <p>
        <a class="deploy-button deploy-primary" href="${REPOSITORY_URL}"
          >Use the repository</a
        >
      </p>
    </section>`,
  );
}

export function startPageV1(problem?: string): Response {
  return page(
    "Deploy FrockBot",
    html`<div class="deploy-split">
      <section class="deploy-stack">
        <p class="deploy-label">Self-host</p>
        <h1 class="deploy-title deploy-hero">
          FrockBot, in <em>your</em> Cloudflare account.
        </h1>
        <p class="deploy-lede">
          The same app frockbot.com runs, deployed into an account you own. Your
          bots, their memory and their conversations live there. It takes about
          three minutes and you build nothing.
        </p>
        ${problem ? html`<p class="deploy-problem" role="alert">${problem}</p>` : ""}
        <div class="deploy-actions">
          <a class="deploy-button deploy-primary" href="/deploy/sign-in"
            >Sign in with Cloudflare</a
          >
          <a class="deploy-button deploy-outline" href="${REPOSITORY_URL}"
            >Use the repository</a
          >
        </div>
        <p class="deploy-small deploy-muted">
          The repository is for your own domain or code changes. Everything else
          is easier here.
        </p>
      </section>
      <section class="deploy-stack">
        <div class="deploy-box">
          <h2 class="deploy-h3">What you need</h2>
          <ul class="deploy-list">
            <li>
              A Cloudflare account on the Workers Paid plan, billed by
              Cloudflare.
            </li>
            <li>
              A Zero Trust team, which is free. It’s how your install signs you
              in.
            </li>
            <li>Nothing else. A FrockBot account is optional.</li>
          </ul>
        </div>
        <div class="deploy-box">
          <h2 class="deploy-h3">What you get</h2>
          <ul class="deploy-list">
            <li>Your own FrockBot on a workers.dev address, just for you.</li>
            <li>
              Jev and Workers AI from your account, with nothing to set up.
            </li>
            <li>Updates when you choose, one click from this page.</li>
            <li>The FrockBot apps, pointed at your install.</li>
          </ul>
        </div>
        <img
          class="deploy-character"
          src="/assets/characters/guardian.png"
          alt=""
          width="120"
          height="140"
        />
      </section>
    </div>`,
  );
}

export function problemPageV1(problem: string): Response {
  return page(
    "Something went wrong",
    html`<section class="deploy-narrow">
      <h1 class="deploy-title">Something went wrong.</h1>
      <p class="deploy-problem" role="alert">${problem}</p>
      <p class="deploy-lede">
        Nothing you started is lost: a deploy that was running carries on.
      </p>
      <div class="deploy-actions">
        <a class="deploy-button deploy-primary" href="/deploy">Try again</a>
        <a class="deploy-button deploy-outline" href="/deploy/sign-in?switch"
          >Sign in again</a
        >
      </div>
    </section>`,
  );
}

/** Several accounts granted: Cloudflare's own sign-in is where one is picked. */
export function oneAccountPageV1(
  accounts: readonly CloudflareAccountV1[],
): Response {
  return page(
    "Choose one account",
    html`<section class="deploy-narrow">
      ${stepper("Choose")}
      <h1 class="deploy-title">Sign in to one account.</h1>
      <p class="deploy-lede">
        This sign-in reached ${accounts.length} Cloudflare accounts:
        ${accounts.map((a) => a.name).join(", ")}. FrockBot deploys into the
        account you sign in with, so sign in again and choose just the one it
        should use.
      </p>
      <p>
        <a class="deploy-button deploy-primary" href="/deploy/sign-in?switch"
          >Sign in again</a
        >
      </p>
    </section>`,
  );
}

function checkRow(check: AccountCheckV1): Html {
  const icon = check.state === "ok" ? TICK : ALERT;
  return html`<li class="deploy-check">
    <span class="deploy-tick ${check.state === "ok" ? "ok" : "bad"}"
      >${icon}</span
    >
    <div class="deploy-check-body">
      <span class="deploy-check-title">${check.title}</span>
      <span class="deploy-small deploy-muted">${check.detail}</span>
      ${
        check.state !== "ok"
          ? html`<span class="deploy-actions"
              >${
                check.fixUrl
                  ? html`<a
                      class="deploy-button deploy-outline deploy-button-small"
                      href="${check.fixUrl}"
                      target="_blank"
                      rel="noopener"
                      >${check.fixLabel ?? "Fix this"}</a
                    >`
                  : ""
              }<a
                class="deploy-button deploy-outline deploy-button-small"
                href="/deploy/choose?check"
                >Check again</a
              ></span
            >`
          : ""
      }
    </div>
  </li>`;
}

export interface ChoosePageInputV1 {
  readonly email: string;
  readonly account: CloudflareAccountV1;
  readonly name: string;
  readonly workersSubdomain: string;
  readonly checks: readonly AccountCheckV1[];
  readonly canDeploy: boolean;
  readonly version: string | null;
  readonly problem?: string;
}

export function choosePageV1(input: ChoosePageInputV1): Response {
  const address = installOriginV1(input.name, input.workersSubdomain);
  return page(
    "Choose where it goes",
    html`<section class="deploy-narrow">
      ${stepper("Choose")}
      <div class="deploy-stack-tight">
        <h1 class="deploy-title">Choose where it goes.</h1>
        <p class="deploy-lede">Signed in to Cloudflare as ${input.email}.</p>
      </div>
      ${input.problem ? html`<p class="deploy-problem" role="alert">${input.problem}</p>` : ""}
      <form class="deploy-stack" method="post" action="/deploy/start">
        <input type="hidden" name="accountId" value="${input.account.id}" />
        <div class="deploy-box deploy-fields">
          <div class="deploy-field">
            <span class="deploy-field-label">Cloudflare account</span>
            <span
              >${input.account.name}, the account you signed in to.
              <a href="/deploy/sign-in?switch">Use a different account</a></span
            >
          </div>
          <label class="deploy-field">
            <span class="deploy-field-label">Name</span>
            <input
              class="deploy-input"
              name="name"
              value="${input.name}"
              required
              maxlength="40"
              pattern="[a-z]([a-z0-9-]*[a-z0-9])?"
              autocomplete="off"
              spellcheck="false"
              data-subdomain="${input.workersSubdomain}"
              aria-describedby="deploy-address"
            />
            <span class="deploy-small deploy-muted"
              >Your install’s address:</span
            >
            <output id="deploy-address" class="deploy-address"
              >${address}</output
            >
          </label>
          <div class="deploy-field">
            <span class="deploy-field-label">Who can sign in</span>
            <span>Just you, as ${input.email}. Teams are coming.</span>
          </div>
        </div>
        <div class="deploy-box deploy-flush">
          <h2 class="deploy-h3 deploy-box-heading">Checking your account</h2>
          <ul class="deploy-checks">
            ${input.checks.map(checkRow)}
          </ul>
        </div>
        <div class="deploy-actions">
          <button
            class="deploy-button deploy-primary"
            type="submit"
            ${input.canDeploy ? "" : new Html(" disabled")}
          >
            Deploy
          </button>
          <span class="deploy-small deploy-muted"
            >${
              input.canDeploy
                ? input.version
                  ? `Deploys FrockBot ${input.version}.`
                  : ""
                : input.version
                  ? "Deploy turns on once every check passes."
                  : "There’s no release to deploy right now. Try again shortly."
            }</span
          >
        </div>
      </form>
    </section>`,
  );
}

function stepRow(step: DeployStepV1, version: string, email: string): Html {
  const title = stepTitleV1(step.id, version);
  const detail =
    step.state === "done"
      ? stepDoneTextV1(step.id, email)
      : step.state === "failed" || (step.state === "running" && step.detail)
        ? step.detail!
        : stepWaitingTextV1(step.id, email);
  const tick =
    step.state === "done"
      ? html`<span class="deploy-tick ok">${TICK}</span>`
      : step.state === "failed"
        ? html`<span class="deploy-tick bad">${ALERT}</span>`
        : step.state === "running"
          ? html`<span class="deploy-tick run">${SPIN}</span>`
          : html`<span class="deploy-tick wait"></span>`;
  return html`<li
    class="deploy-check ${step.state === "waiting" ? "waiting" : ""}"
  >
    ${tick}
    <div class="deploy-check-body">
      <span class="deploy-check-title">${title}</span>
      <span
        class="deploy-small ${step.state === "failed" ? "deploy-error" : "deploy-muted"}"
        >${detail}</span
      >
    </div>
  </li>`;
}

export function progressPageV1(
  job: Omit<DeployJobV1, "tokens">,
  install: InstallRecordV1,
): Response {
  const steps = DEPLOY_STEPS_V1.map(
    (id) =>
      job.steps.find((s) => s.id === id) ?? { id, state: "waiting" as const },
  );
  const percent = progressPercentV1(steps);
  const updating = job.kind === "update";
  const heading =
    job.state === "failed"
      ? updating
        ? `Updating ${install.name} stopped.`
        : `Deploying ${install.name} stopped.`
      : updating
        ? `Updating ${install.name}.`
        : `Deploying ${install.name}.`;
  return page(
    heading,
    html`<section class="deploy-narrow">
      ${stepper("Deploy")}
      <div class="deploy-stack-tight">
        <h1 class="deploy-title">${heading}</h1>
        <p class="deploy-lede">
          ${
            job.state === "failed"
              ? "Nothing is lost: trying again picks up at the step that stopped."
              : updating
                ? `From ${job.fromVersion ?? "the release it runs"} to ${job.version}. Your bots, memory and conversations stay. You can leave this page; the update carries on.`
                : "About three minutes. You can leave this page; the deploy carries on and you can come back to it."
          }
        </p>
      </div>
      <progress
        class="deploy-progress"
        max="100"
        value="${percent}"
        aria-label="Deploy progress"
      >
        ${percent}%
      </progress>
      <div class="deploy-box deploy-flush">
        <ul class="deploy-checks">
          ${steps.map((s) => stepRow(s, job.version, install.ownerEmail))}
        </ul>
      </div>
      ${
        job.state === "failed"
          ? html`<form
              class="deploy-actions"
              method="post"
              action="/deploy/retry"
            >
              <button class="deploy-button deploy-primary" type="submit">
                Try again
              </button>
              <a class="deploy-button deploy-outline" href="/deploy/installs"
                >Your installs</a
              >
            </form>`
          : ""
      }
    </section>`,
    { live: job.state === "running" },
  );
}

export function readyPageV1(install: InstallRecordV1): Response {
  const origin = installOriginV1(install.name, install.workersSubdomain);
  const host = installHostnameV1(install.name, install.workersSubdomain);
  return page(
    "Your FrockBot is ready",
    html`<div class="deploy-split">
      <section class="deploy-stack">
        ${stepper("Ready", true)}
        <h1 class="deploy-title deploy-hero-small">
          Your FrockBot is <em>ready.</em>
        </h1>
        <span class="deploy-address deploy-address-inline">${origin}</span>
        <div class="deploy-actions">
          <a class="deploy-button deploy-primary" href="${origin}"
            >Open FrockBot</a
          >
          <a class="deploy-button deploy-outline" href="/deploy/installs"
            >See your installs</a
          >
        </div>
        <p class="deploy-lede">
          Sign-in goes through Cloudflare Access, so only you can open it. Next,
          FrockBot asks how you’d like it set up. Frock AI works straight away
          if you link a FrockBot account, and Workers AI works without one.
        </p>
      </section>
      <section class="deploy-box deploy-stack">
        <h2 class="deploy-h3">Use it from the apps</h2>
        <ol class="deploy-list">
          <li>Open FrockBot on your phone or Mac.</li>
          <li>
            Choose <strong>Add an account</strong>, then
            <strong>Use another server</strong>.
          </li>
          <li>Enter <strong>${host}</strong> and sign in.</li>
        </ol>
        <p class="deploy-small deploy-muted">
          Notifications reach your phone through FrockBot’s free push relay. It
          never sees your messages.
        </p>
        <img
          class="deploy-character deploy-character-small"
          src="/assets/characters/sunny.png"
          alt=""
          width="96"
          height="112"
        />
      </section>
    </div>`,
  );
}

export function installsPageV1(
  installs: readonly InstallRecordV1[],
  latest: { version: string } | null,
  running: boolean,
  problem?: string,
): Response {
  return page(
    "Your installs",
    html`<section class="deploy-wide">
      <div class="deploy-row-between">
        <div class="deploy-stack-tight">
          <p class="deploy-label">Self-host</p>
          <h1 class="deploy-title">Your installs.</h1>
        </div>
        <a
          class="deploy-button deploy-outline deploy-button-small"
          href="/deploy/choose"
          >Deploy another</a
        >
      </div>
      ${problem ? html`<p class="deploy-problem" role="alert">${problem}</p>` : ""}
      ${
        installs.length === 0
          ? html`<div class="deploy-box">
              <p>Nothing deployed from here yet.</p>
            </div>`
          : html`<ul class="deploy-installs">
              ${installs.map((install) => {
                const behind =
                  latest !== null &&
                  (install.version === undefined ||
                    isNewerVersionV1(latest.version, install.version));
                return html`<li class="deploy-box deploy-install">
                  <div class="deploy-install-row">
                    <div class="deploy-stack-tight">
                      <a
                        class="deploy-install-name"
                        href="${installOriginV1(install.name, install.workersSubdomain)}"
                        >${install.name}</a
                      >
                      <span class="deploy-small deploy-muted"
                        >${installHostnameV1(install.name, install.workersSubdomain)}
                        · ${install.accountName}</span
                      >
                    </div>
                    <span class="deploy-small deploy-muted"
                      >${install.version ? `Release ${install.version}` : "Not finished deploying"}</span
                    >
                    ${
                      behind
                        ? html`<span class="deploy-pill new"
                              >${latest!.version} is available</span
                            >
                            <form method="post" action="/deploy/update">
                              <input
                                type="hidden"
                                name="install"
                                value="${`${install.accountId}/${install.name}`}"
                              />
                              <button
                                class="deploy-button deploy-primary deploy-button-small"
                                type="submit"
                                ${running ? new Html(" disabled") : ""}
                              >
                                Update
                              </button>
                            </form>`
                        : html`<span class="deploy-pill ok">Up to date</span
                            ><span></span>`
                    }
                  </div>
                  ${
                    behind
                      ? html`<p class="deploy-small deploy-muted">
                          Updating keeps your bots, memory and conversations; it
                          takes about a minute.
                        </p>`
                      : ""
                  }
                </li>`;
              })}
            </ul>`
      }
      <p class="deploy-small deploy-muted">
        Only installs deployed from this page are listed. An install from the
        repository updates with <code>bun run setup</code>.
      </p>
      <form method="post" action="/deploy/sign-out">
        <button class="deploy-link" type="submit">
          Sign out of Cloudflare
        </button>
      </form>
    </section>`,
  );
}
