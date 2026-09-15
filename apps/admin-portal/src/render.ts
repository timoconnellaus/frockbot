// The surface. Server-rendered HTML, plain forms, no client framework and no
// script at all: every control is a form the Worker answers, so the page cannot
// hold a second copy of the deployment's state and cannot disagree with it.

import {
  ACCOUNT_ACCESS_STATES_V1,
  ADMISSION_MODES_V1,
  GRANT_USER_CREDIT_MAXIMUM_CENTS,
  isAccountAccessUnavailable,
  isUserBillingUnavailable,
  isUserFeaturesUnavailable,
  USER_FEATURES_DEFAULT_UPDATED_BY,
  type AccountAccessStateV1,
  type AdmissionModeV1,
  type AdminUserListViewV1,
  type AdminUserViewV1,
  type DeploymentPolicyV1,
} from "@frockbot/app/admin/shared";

export interface NoticeV1 {
  tone: "done" | "stale" | "refused";
  message: string;
}

export interface AdminPageV1 {
  /** The administrator reading the page, as Access authenticated them. */
  email: string;
  policy: DeploymentPolicyV1;
  accounts: AdminUserListViewV1;
  notice?: NoticeV1;
  /** One idempotency key per rendered page, so a repeated grant lands once. */
  grantId: string;
  nonce: string;
}

const ADMISSION_COPY: Readonly<
  Record<AdmissionModeV1, { title: string; detail: string }>
> = {
  closed: {
    title: "Closed",
    detail: "No new accounts. Only accounts that already have access get in.",
  },
  "invite-only": {
    title: "Invite only",
    detail: "An invited account becomes active on its next sign-in.",
  },
  open: {
    title: "Open",
    detail: "Anyone who signs in becomes active.",
  },
};

const ACCESS_COPY: Readonly<Record<AccountAccessStateV1, string>> = {
  invited: "Invited",
  active: "Active",
  paused: "Paused",
  ended: "Ended",
  blocked: "Blocked",
};

export function escapeHtmlV1(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function money(micros: number): string {
  return `US$${(micros / 1_000_000).toFixed(2)}`;
}

function when(timestamp: string): string {
  const parsed = Date.parse(timestamp);
  if (!Number.isFinite(parsed)) return timestamp;
  return new Date(parsed).toISOString().slice(0, 16).replace("T", " ");
}

const STYLES = `
:root {
  color-scheme: dark;
  --ink: #15141a;
  --surface: #1f1e24;
  --raised: #2c2a33;
  --line: #36333f;
  --line-strong: #4b4756;
  --text: #f4f2f6;
  --muted: #aaa6b1;
  --subtle: #8d8896;
  --pink: #ec386b;
  --pink-dark: #d92d5f;
  --good: #46b98a;
  --warn: #e3a33c;
  --bad: #e5565b;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--ink);
  color: var(--text);
  font: 16px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  -webkit-font-smoothing: antialiased;
}
main { width: min(960px, 100% - 32px); margin: 0 auto; padding: 32px 0 64px; }
h1 { margin: 0; font-size: 1.5rem; letter-spacing: -0.01em; }
h2 { margin: 0 0 4px; font-size: 1.05rem; letter-spacing: -0.01em; }
h3 { margin: 0; font-size: 0.95rem; font-weight: 600; }
p { margin: 0; }
a { color: var(--pink); }
.masthead {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: baseline;
  justify-content: space-between;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--line);
}
.who { color: var(--muted); font-size: 0.85rem; }
.lede { color: var(--muted); font-size: 0.9rem; max-width: 60ch; }
section {
  margin-top: 24px;
  padding: 20px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 14px;
}
.notice {
  margin-top: 24px;
  padding: 14px 16px;
  border: 1px solid var(--line-strong);
  border-left: 3px solid var(--muted);
  border-radius: 10px;
  background: var(--surface);
  font-size: 0.92rem;
}
.notice-done { border-left-color: var(--good); }
.notice-stale { border-left-color: var(--warn); }
.notice-refused { border-left-color: var(--bad); }
.rows { margin-top: 12px; display: grid; gap: 8px; }
.row {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 16px;
  align-items: center;
  justify-content: space-between;
  padding: 12px 14px;
  background: var(--raised);
  border: 1px solid transparent;
  border-radius: 10px;
}
.row-current { border-color: var(--pink); }
.row p { color: var(--muted); font-size: 0.85rem; }
.pill {
  padding: 2px 9px;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  background: var(--pink);
  color: #fff;
  white-space: nowrap;
}
.pill-quiet { background: var(--line-strong); color: var(--text); }
.pill-good { background: var(--good); color: #0c1f17; }
.pill-warn { background: var(--warn); color: #241802; }
.pill-bad { background: var(--bad); color: #fff; }
button {
  padding: 8px 14px;
  font: inherit;
  font-size: 0.88rem;
  font-weight: 600;
  color: #fff;
  background: var(--pink);
  border: 0;
  border-radius: 8px;
  cursor: pointer;
}
button:hover { background: var(--pink-dark); }
button.quiet {
  color: var(--text);
  background: transparent;
  border: 1px solid var(--line-strong);
}
button.quiet:hover { background: var(--raised); }
input, select {
  padding: 8px 10px;
  font: inherit;
  font-size: 0.9rem;
  color: var(--text);
  background: var(--ink);
  border: 1px solid var(--line-strong);
  border-radius: 8px;
}
input:focus-visible, select:focus-visible, button:focus-visible, summary:focus-visible {
  outline: 2px solid var(--pink);
  outline-offset: 2px;
}
label { font-size: 0.85rem; color: var(--muted); }
fieldset { margin: 0; padding: 0; border: 0; }
legend { padding: 0; font-size: 0.85rem; color: var(--muted); }
.field { display: grid; gap: 4px; }
.inline { display: flex; flex-wrap: wrap; gap: 10px; align-items: flex-end; }
.check { display: flex; gap: 8px; align-items: center; color: var(--text); font-size: 0.9rem; }
.check input { accent-color: var(--pink); }
.account {
  display: grid;
  gap: 14px;
  padding: 16px;
  background: var(--raised);
  border: 1px solid var(--line);
  border-radius: 12px;
}
.account-head { display: flex; flex-wrap: wrap; gap: 6px 12px; align-items: baseline; }
.identifier {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.78rem;
  color: var(--subtle);
  overflow-wrap: anywhere;
}
.account-grid { display: grid; gap: 14px; grid-template-columns: 1fr; }
@media (min-width: 720px) { .account-grid { grid-template-columns: 1fr 1fr; } }
.panel { display: grid; gap: 8px; align-content: start; }
.credit { color: var(--muted); font-size: 0.85rem; }
details summary {
  display: inline-block;
  padding: 6px 0;
  color: var(--pink);
  font-size: 0.88rem;
  font-weight: 600;
  cursor: pointer;
}
details[open] summary { margin-bottom: 8px; }
.unreadable { color: var(--warn); font-size: 0.85rem; }
footer { margin-top: 32px; color: var(--subtle); font-size: 0.8rem; }
.spaced { margin-top: 12px; }
`;

function htmlDocumentV1(options: {
  title: string;
  nonce: string;
  body: string;
}): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${escapeHtmlV1(options.title)}</title>
<style nonce="${options.nonce}">${STYLES}</style>
</head>
<body>
<main>
${options.body}
</main>
</body>
</html>
`;
}

function notice(value: NoticeV1 | undefined): string {
  if (!value) return "";
  const role = value.tone === "done" ? "status" : "alert";
  return `<p class="notice notice-${value.tone}" role="${role}">${escapeHtmlV1(
    value.message,
  )}</p>`;
}

function admission(policy: DeploymentPolicyV1): string {
  const rows = ADMISSION_MODES_V1.map((mode) => {
    const copy = ADMISSION_COPY[mode];
    const current = policy.admission.mode === mode;
    const control = current
      ? `<span class="pill">Current</span>`
      : `<form method="post" action="/">
            <input type="hidden" name="action" value="admission-mode">
            <input type="hidden" name="mode" value="${mode}">
            <input type="hidden" name="revision" value="${policy.revision}">
            <button type="submit">Choose</button>
          </form>`;
    return `<div class="row${current ? " row-current" : ""}">
        <div>
          <h3>${copy.title}</h3>
          <p>${copy.detail}</p>
        </div>
        ${control}
      </div>`;
  }).join("\n");
  const changed =
    policy.updatedBy === "deployment-default"
      ? "Never changed: this is the deployment's default."
      : `Last changed by ${escapeHtmlV1(policy.updatedBy)} at ${when(
          policy.updatedAt,
        )} (revision ${policy.revision}).`;
  return `<section>
  <h2>New accounts</h2>
  <p class="lede">Who may start using FrockBot. An account that already has
  access keeps it in every mode, and no mode lifts a pause, an end or a block.</p>
  <div class="rows">${rows}</div>
  <p class="who spaced">${changed}</p>
</section>`;
}

function invitation(): string {
  return `<section>
  <h2>Invite an email</h2>
  <p class="lede">Redeemed only by a sign-in whose identity provider verified
  that exact address. Inviting the same address twice changes nothing.</p>
  <form method="post" action="/" class="inline spaced">
    <input type="hidden" name="action" value="invite-email">
    <div class="field">
      <label for="invite-email">Email address</label>
      <input id="invite-email" type="email" name="email" required
        autocomplete="off" spellcheck="false" size="32"
        placeholder="person@example.com">
    </div>
    <button type="submit">Invite</button>
  </form>
</section>`;
}

function accessPanel(account: AdminUserViewV1): string {
  if (isAccountAccessUnavailable(account.access)) {
    return `<div class="panel">
      <h3>Access</h3>
      <p class="unreadable">The authority could not be reached for this
      account, so its access is not known. Reload to try again.</p>
    </div>`;
  }
  const record = account.access.access;
  const revision = record?.revision ?? 0;
  const state = record?.state;
  const tone =
    state === "active"
      ? "pill-good"
      : state === "invited"
        ? "pill-quiet"
        : state === "paused"
          ? "pill-warn"
          : state === undefined
            ? "pill-quiet"
            : "pill-bad";
  const field = `access-state-${escapeHtmlV1(account.userId)}`;
  const options = ACCOUNT_ACCESS_STATES_V1.map(
    (option) =>
      `<option value="${option}"${option === state ? " selected" : ""}>${
        ACCESS_COPY[option]
      }</option>`,
  ).join("");
  return `<div class="panel">
    <h3>Access <span class="pill ${tone}">${
      state ? ACCESS_COPY[state] : "No record"
    }</span></h3>
    <p class="credit">${
      record
        ? `Set by ${escapeHtmlV1(record.updatedBy)} at ${when(
            record.updatedAt,
          )} (revision ${revision}).`
        : "This account has no access record. The admission mode decides it."
    }</p>
    <form method="post" action="/" class="inline">
      <input type="hidden" name="action" value="account-access">
      <input type="hidden" name="userId" value="${escapeHtmlV1(
        account.userId,
      )}">
      <input type="hidden" name="revision" value="${revision}">
      <div class="field">
        <label for="${field}">Set access to</label>
        <select id="${field}" name="state">${options}</select>
      </div>
      <button type="submit" class="quiet">Save access</button>
    </form>
  </div>`;
}

function featuresPanel(
  account: AdminUserViewV1,
  gatedPlugins: AdminUserListViewV1["gatedPlugins"],
): string {
  if (isUserFeaturesUnavailable(account.features)) {
    return `<div class="panel">
      <h3>Settings</h3>
      <p class="unreadable">This account's own record could not be read, so
      what it holds is not known — not off. Reload to try again.</p>
    </div>`;
  }
  const features = account.features;
  const id = escapeHtmlV1(account.userId);
  const opened = new Set(features.plugins);
  const plugins = gatedPlugins
    .map(
      (plugin) =>
        `<label class="check"><input type="checkbox" name="plugin"
          value="${escapeHtmlV1(plugin.pluginId)}"${
            opened.has(plugin.pluginId) ? " checked" : ""
          }> ${escapeHtmlV1(plugin.displayName)}</label>`,
    )
    .join("\n");
  return `<div class="panel">
    <h3>Settings</h3>
    <form method="post" action="/">
      <input type="hidden" name="action" value="account-features">
      <input type="hidden" name="userId" value="${id}">
      <fieldset>
        <legend>What this account holds</legend>
        <label class="check"><input type="checkbox" name="applets"${
          features.applets ? " checked" : ""
        }> Applets</label>
        <label class="check"><input type="checkbox" name="pluginAuthoring"${
          features.pluginAuthoring ? " checked" : ""
        }> Bots may write Plugins</label>
        ${plugins}
      </fieldset>
      <button type="submit" class="quiet spaced">Save settings</button>
    </form>
    <p class="credit">${
      features.updatedBy === USER_FEATURES_DEFAULT_UPDATED_BY
        ? "Never set: this account holds the deployment's defaults."
        : `Last set by ${escapeHtmlV1(features.updatedBy)} at ${when(
            features.updatedAt,
          )}.`
    }</p>
  </div>`;
}

function creditPanel(account: AdminUserViewV1, grantId: string): string {
  const id = escapeHtmlV1(account.userId);
  const line = isUserBillingUnavailable(account.billing)
    ? `<p class="unreadable">This account's credit could not be read.</p>`
    : `<p class="credit">${[
        account.billing.subscribed ? "Subscribed" : "No subscription",
        `${money(account.billing.complimentaryMicros)} complimentary`,
        ...(account.billing.includedMicros > 0
          ? [`${money(account.billing.includedMicros)} monthly`]
          : []),
        ...(account.billing.purchasedMicros > 0
          ? [`${money(account.billing.purchasedMicros)} purchased`]
          : []),
        ...(account.billing.suspended ? ["suspended"] : []),
        ...(account.billing.canSpend ? [] : ["can’t reply"]),
      ]
        .map(escapeHtmlV1)
        .join(" · ")}</p>`;
  const maximum = (GRANT_USER_CREDIT_MAXIMUM_CENTS / 100).toFixed(2);
  return `<div class="panel">
    <h3>Credit</h3>
    ${line}
    <details>
      <summary>Add credit</summary>
      <form method="post" action="/" class="inline">
        <input type="hidden" name="action" value="grant-credit">
        <input type="hidden" name="userId" value="${id}">
        <input type="hidden" name="grantId" value="${escapeHtmlV1(grantId)}">
        <div class="field">
          <label for="amount-${id}">Amount, US dollars</label>
          <input id="amount-${id}" type="number" name="dollars" required
            min="0.01" max="${maximum}" step="0.01" inputmode="decimal"
            size="8">
        </div>
        <div class="field">
          <label for="reason-${id}">Reason</label>
          <input id="reason-${id}" type="text" name="reason" required
            maxlength="200" size="24" autocomplete="off"
            placeholder="Kept with the grant">
        </div>
        <button type="submit">Add credit</button>
      </form>
    </details>
  </div>`;
}

function account(
  view: AdminUserViewV1,
  gatedPlugins: AdminUserListViewV1["gatedPlugins"],
  grantId: string,
): string {
  const title = view.name || view.email || view.userId;
  const detail = [
    ...(view.email && view.email !== title ? [view.email] : []),
    view.userId,
  ].join(" · ");
  return `<article class="account">
  <div class="account-head">
    <h3>${escapeHtmlV1(title)}</h3>
    <span class="identifier">${escapeHtmlV1(detail)}</span>
  </div>
  <div class="account-grid">
    ${accessPanel(view)}
    ${featuresPanel(view, gatedPlugins)}
    ${creditPanel(view, grantId)}
  </div>
</article>`;
}

function accounts(page: AdminPageV1): string {
  const body =
    page.accounts.users.length === 0
      ? `<p class="lede spaced">No accounts yet. An account
      appears here once someone has signed in.</p>`
      : `<div class="rows">${page.accounts.users
          .map((view) =>
            account(view, page.accounts.gatedPlugins, page.grantId),
          )
          .join("\n")}</div>`;
  return `<section>
  <h2>Accounts</h2>
  <p class="lede">Every account this deployment's identity store holds, newest
  first, with its access, what it holds, and what it can spend. Complimentary
  credit never expires and is spendable without a subscription.</p>
  ${body}
</section>`;
}

export function renderAdminPageV1(page: AdminPageV1): string {
  return htmlDocumentV1({
    title: "FrockBot administration",
    nonce: page.nonce,
    body: `<header class="masthead">
  <h1>FrockBot administration</h1>
  <p class="who">Signed in as ${escapeHtmlV1(page.email)}</p>
</header>
${notice(page.notice)}
${admission(page.policy)}
${invitation()}
${accounts(page)}
<footer>
  <p>Administration is this portal, not the app: the product has no
  administrative surface. Everything here is the deployment's, never one
  account's own settings.</p>
</footer>`,
  });
}

/** What someone Access let through but the admin list does not name sees. */
export function renderRefusalV1(options: {
  nonce: string;
  title: string;
  detail: string;
}): string {
  return htmlDocumentV1({
    title: options.title,
    nonce: options.nonce,
    body: `<header class="masthead"><h1>${escapeHtmlV1(
      options.title,
    )}</h1></header>
<section>
  <p class="lede">${escapeHtmlV1(options.detail)}</p>
</section>`,
  });
}
