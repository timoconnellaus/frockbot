/**
 * `/setup/apply` on the app's own origin: where "Start with this setup" on
 * frockbot.com lands. It keeps the chosen setup before anything can redirect
 * (sign-in and checkout both drop a URL fragment), then shows it for review
 * once the person is signed in. Nothing is applied until they say so.
 *
 * It is a page under Setup's own paths that the setup web app does not
 * claim, so either can ship first; that app takes it over by adding the
 * page and deleting this one.
 */

function escaped(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll('"', "&quot;");
}

export function setupPageV1(options: { productName: string }): string {
  const product = escaped(options.productName);
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>Set up ${product}</title><link rel="stylesheet" href="/setup/apply.css"><script src="/setup/apply.js" defer></script></head>
<body><main>
<header class="brand"><span class="wordmark">${product}</span><span class="small">Setup</span></header>
<div class="intro"><span class="small">From the setup you chose on frockbot.com</span><h1>Set up ${product} the way you chose</h1><p id="lede">Here’s everything you picked and what each part still needs. Nothing changes until you apply it.</p></div>
<p id="notice" role="status" aria-live="polite">Loading your setup…</p>
<section id="signin" class="card panel" hidden><h2>Sign in to continue</h2><p>Your choices are saved in this browser. Sign in, or create your account, and they’ll be waiting.</p><button type="button" id="google" class="btn primary">Continue with Google</button></section>
<section id="empty" class="card panel" hidden><h2>No setup to apply</h2><p>Choose how you’d like ${product} set up on frockbot.com, then press Start with this setup.</p><div class="actions"><a class="btn primary" href="https://frockbot.com/setup/">Choose a setup</a><a class="btn outline" href="/">Open ${product}</a></div></section>
<ul id="notes" class="notes" hidden></ul>
<section id="review" class="card" aria-label="Your setup" hidden><ul id="rows" class="rows"></ul></section>
<div id="decide" class="actions" hidden><button type="button" id="apply" class="btn primary">Apply this setup</button><button type="button" id="frock" class="btn outline">Start on Frock AI instead</button><span class="small">Parts that still need a key stay on Frock AI until you add one, and you can finish them later in Setup.</span></div>
<section id="done" class="card panel" hidden><h2>Your setup is applied</h2><p id="done-detail"></p><div class="actions"><a class="btn primary" href="/">Open ${product}</a></div></section>
</main></body></html>`;
}

export const setupStylesV1 = `[hidden]{display:none!important}:root{color-scheme:light;--bg:#f5f6f9;--ink:#15151e;--muted:#5c5f70;--line:#dfe1e8;--pink:#d3266d;--pink-dark:#b9205e}*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.45 Inter,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}main{max-width:1040px;margin:auto;padding:28px 24px 64px;display:flex;flex-direction:column;gap:22px}.brand{display:flex;align-items:baseline;gap:10px}.wordmark{font:800 18px/1 "Archivo Black","Arial Black",system-ui,sans-serif;letter-spacing:-.04em}.small{font-size:12.5px;color:var(--muted)}.intro{display:flex;flex-direction:column;gap:6px}h1{margin:0;font-size:21px;line-height:1.25;letter-spacing:-.4px}h2{margin:0 0 6px;font-size:15px}p{margin:0;color:var(--muted)}#notice:empty{display:none}#notice{padding:10px 14px;border-radius:12px;background:#fff;border:1px solid var(--line)}.card{background:#fff;border:1px solid var(--line);border-radius:16px}.panel{padding:22px;display:flex;flex-direction:column;gap:12px;align-items:flex-start}.rows{list-style:none;margin:0;padding:0}.row{display:grid;grid-template-columns:150px minmax(0,1fr) minmax(0,1.7fr);gap:16px;align-items:center;padding:14px 20px}.row+.row{border-top:1px solid var(--line)}.row-name{font-weight:500}.row-need{display:flex;gap:10px;align-items:center;justify-content:flex-end;flex-wrap:wrap;text-align:right}.pill{display:inline-flex;align-items:center;gap:6px;padding:4px 10px;border-radius:999px;font-weight:600;font-size:12.5px;white-space:nowrap}.pill.ok{color:#1c7a4e;background:rgba(28,122,78,.12)}.pill.warn{color:#8a6000;background:rgba(138,96,0,.12)}.pill.neutral{color:var(--muted);background:rgba(92,95,112,.12)}.btn{display:inline-flex;align-items:center;justify-content:center;min-height:44px;padding:0 18px;border-radius:12px;border:0;font:600 13.5px/1 inherit;font-family:inherit;cursor:pointer;text-decoration:none;white-space:nowrap}.btn.primary{background:var(--pink);color:#fff}.btn.primary:hover{background:var(--pink-dark)}.btn.outline{background:#fff;color:var(--ink);box-shadow:inset 0 0 0 1px var(--line)}.btn:disabled{opacity:.55;cursor:default}.btn:focus-visible,.field:focus-visible,a:focus-visible{outline:2px solid var(--pink);outline-offset:2px}.row-need label{display:flex}.field{min-height:44px;width:220px;max-width:100%;border:1px solid var(--line);border-radius:12px;padding:0 14px;font:inherit;font-size:14px}.actions{display:flex;gap:12px;align-items:center;flex-wrap:wrap}.notes{margin:0;padding:12px 16px 12px 32px;background:#fff;border:1px solid var(--line);border-radius:12px;color:var(--muted)}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}a{color:var(--pink)}@media(max-width:760px){main{padding:20px 16px 48px}.row{grid-template-columns:minmax(0,1fr);gap:6px}.row-need{justify-content:flex-start;text-align:left}.field{width:100%}.actions .btn{flex:1 1 auto}}`;

// Plain script under `script-src 'self'`: no template interpolation below, so
// it reads as the browser runs it.
export const setupScriptV1 = String.raw`
const PENDING = 'frockbot-setup-pending-v1';
const el = (id) => document.getElementById(id);
const store = {
  get() { try { return localStorage.getItem(PENDING); } catch { return null; } },
  set(value) { try { localStorage.setItem(PENDING, value); } catch {} },
  clear() { try { localStorage.removeItem(PENDING); } catch {} },
};
// Before anything else: sign-in and checkout both leave this page, and a
// fragment does not survive either. The choices move into this origin's
// storage and out of the address bar.
(() => {
  const setup = new URLSearchParams(location.hash.slice(1)).get('setup');
  if (!setup) return;
  store.set(setup);
  history.replaceState(null, '', location.pathname + location.search);
})();

let review; let connections; let busy = false;
const commandId = () => 'setup-' + crypto.randomUUID();
function notice(text) { el('notice').textContent = text || ''; }
async function api(path, body) {
  const response = await fetch(path, {
    credentials: 'same-origin',
    headers: body ? { 'content-type': 'application/json' } : {},
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || 'Something went wrong. Please try again.');
    error.status = response.status;
    throw error;
  }
  return data;
}
function show(id, visible) { el(id).hidden = !visible; }
function node(tag, className, text) {
  const made = document.createElement(tag);
  if (className) made.className = className;
  if (text !== undefined) made.textContent = text;
  return made;
}
function pill(kind, text) {
  const made = node('span', 'pill ' + kind, text);
  return made;
}

function connectedProviders(frame) {
  return (frame.accounts || [])
    .filter((account) => account.state === 'ready' && String(account.packageId).startsWith('provider-'))
    .map((account) => account.packageId.slice('provider-'.length));
}
async function facts() {
  connections = await api('/api/settings/connections');
  let plan;
  try {
    const billing = await api('/api/billing');
    const sub = billing.subscription;
    if (sub && ['active', 'trialing'].includes(sub.status)) plan = sub.planId;
  } catch {}
  return { connectedProviders: connectedProviders(connections), plan };
}

async function load() {
  const pending = store.get();
  if (!pending) { notice(''); show('empty', true); return; }
  try { await api('/api/identity'); }
  catch (error) {
    if (error.status === 401) { notice(''); show('signin', true); return; }
    notice(error.message); return;
  }
  try {
    review = await api('/api/setup/review', { setup: pending, ...(await facts()) });
    render();
    notice('');
  } catch (error) { notice(error.message); }
}

function rowFor(entry) {
  const li = node('li', 'row');
  li.append(node('span', 'row-name', entry.name), node('span', '', entry.choice));
  const need = node('div', 'row-need');
  if (entry.need === 'ready') need.append(pill('ok', 'Ready'));
  else if (entry.need === 'coming-soon') need.append(node('span', 'small', entry.note), pill('neutral', 'Coming soon'));
  else if (entry.need === 'checkout') {
    need.append(pill('warn', 'Needs checkout'));
    const button = node('button', 'btn outline', 'Start ' + entry.planName);
    button.type = 'button';
    button.onclick = () => checkout(entry.plan, button);
    need.append(button);
  } else if (entry.finishInApp) {
    need.append(pill('warn', 'Needs your key'), node('span', 'small', 'Finish in the app: Settings, then Models.'));
  } else if (entry.need === 'key') {
    need.append(pill('warn', 'Needs your key'));
    const label = node('label', '');
    const text = node('span', 'sr-only', entry.choice.split(',')[0] + ' API key');
    const input = node('input', 'field');
    input.type = 'password';
    input.autocomplete = 'off';
    input.placeholder = 'Paste your ' + entry.choice.split(',')[0] + ' key';
    label.append(text, input);
    const button = node('button', 'btn outline', 'Connect');
    button.type = 'button';
    button.onclick = () => connectKey(entry.provider, entry.choice.split(',')[0], input, button);
    need.append(label, button);
  } else if (entry.need === 'sign-in') {
    need.append(pill('warn', 'Needs sign-in'));
    const button = node('button', 'btn outline', 'Sign in to ' + entry.choice.split(',')[0]);
    button.type = 'button';
    button.onclick = () => signIn(entry.provider, button);
    need.append(button);
  }
  li.append(need);
  return li;
}
function render() {
  const rows = el('rows');
  rows.replaceChildren();
  if (review.plan.suggested !== 'none') {
    rows.append(rowFor(review.plan.checkout
      ? { name: 'Plan', choice: review.plan.label, need: 'checkout', plan: review.plan.checkout, planName: review.plan.checkout === 'byo' ? 'BYO' : 'Standard' }
      : { name: 'Plan', choice: review.plan.label, need: 'ready' }));
  }
  for (const entry of review.rows) rows.append(rowFor(entry));
  const notes = el('notes');
  notes.replaceChildren(...review.notes.map((text) => node('li', '', text)));
  show('notes', review.notes.length > 0);
  show('review', true);
  show('decide', true);
}

async function settingsRevision() { return (await api('/api/settings')).revision; }
async function installProvider(provider) {
  const packageId = 'provider-' + provider;
  const row = (connections.providers || []).find((entry) => entry.packageId === packageId);
  if (row && row.installed) return;
  const receipt = await api('/api/settings', {
    schemaVersion: 1, commandId: commandId(), expectedRevision: await settingsRevision(),
    type: 'user/choose-model-provider', packageId,
  });
  if (receipt.status !== 'applied') throw new Error(receipt.failure || 'That provider could not be added.');
}
async function waitUntilReady(provider, seconds) {
  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    connections = await api('/api/settings/connections');
    if (connectedProviders(connections).includes(provider)) return true;
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  return false;
}
async function refresh() {
  review = await api('/api/setup/review', { setup: store.get(), ...(await facts()) });
  render();
}
async function guarded(button, work) {
  if (busy) return;
  busy = true; button.disabled = true;
  try { await work(); }
  catch (error) { notice(error.message); }
  finally { busy = false; button.disabled = false; }
}
function connectKey(provider, name, input, button) {
  return guarded(button, async () => {
    const apiKey = input.value.trim();
    if (!apiKey) { input.focus(); return; }
    notice('Connecting ' + name + '…');
    await installProvider(provider);
    // The key goes to this one command and is never shown again.
    input.value = '';
    const receipt = await api('/api/connections', {
      schemaVersion: 1, type: 'connection/create-api-key', commandId: commandId(),
      packageId: 'provider-' + provider, connectionTypeId: provider + '-account', label: name, apiKey,
    });
    if (receipt.status !== 'applied') throw new Error(name + ' did not accept that key.');
    if (!(await waitUntilReady(provider, 60))) throw new Error(name + ' is still connecting. Check it in Settings, then Models.');
    notice(name + ' is connected.');
    await refresh();
  });
}
function signIn(provider, button) {
  return guarded(button, async () => {
    await installProvider(provider);
    const started = await api('/api/plugins/provider-' + provider + '/connections', {
      schemaVersion: 1, type: 'connection/start', commandId: commandId(), connectionTypeId: provider + '-oauth',
    });
    if (started.status === 'authorization-required') {
      const target = new URL(started.redirectUrl, location.origin);
      if (target.origin !== location.origin) throw new Error('That sign-in page is not one this account can open.');
      window.open(target.href, '_blank', 'noopener');
      notice('Finish signing in in the other tab. This page updates when it’s done.');
      if (!(await waitUntilReady(provider, 300))) throw new Error('Signing in didn’t finish. You can try again, or finish it later in Setup.');
    }
    notice('Signed in.');
    await refresh();
  });
}
function checkout(plan, button) {
  return guarded(button, async () => {
    const billing = await api('/api/billing');
    const action = (billing.actions || []).find((entry) => entry.purpose === 'subscribe' && entry.plan === plan);
    if (!action || action.target.kind !== 'command') throw new Error('That plan can’t be started here yet. Open Billing in the app.');
    const key = 'frockbot-checkout-subscribe-' + plan;
    let id; try { id = sessionStorage.getItem(key); } catch {}
    id = id || crypto.randomUUID();
    try { sessionStorage.setItem(key, id); } catch {}
    const { url } = await api(action.target.path, { id, ...(action.target.body || {}) });
    const target = new URL(url, location.origin);
    if (target.origin !== location.origin && !(target.protocol === 'https:' && action.hosts.includes(target.hostname))) throw new Error('The payment page is not one this account can open.');
    try { sessionStorage.removeItem(key); } catch {}
    // Checkout returns to Billing, which sends the person back here while a setup waits.
    location.assign(target.href);
  });
}
function finish(detail) {
  store.clear();
  show('review', false); show('decide', false); show('notes', false);
  el('lede').textContent = 'Done. You can change any of this later in Setup.';
  el('done-detail').textContent = detail;
  show('done', true);
  el('done').querySelector('a').focus();
}
el('apply').onclick = () => guarded(el('apply'), async () => {
  const model = review.defaultModel;
  if (model) {
    const account = (connections.accounts || []).find((entry) => entry.state === 'ready' && entry.packageId === 'provider-' + model.provider);
    if (!account) throw new Error('Connect that provider first, or start on Frock AI instead.');
    const receipt = await api('/api/settings', {
      schemaVersion: 1, commandId: commandId(), expectedRevision: await settingsRevision(),
      type: 'user/set-account-model', model: { connectionId: account.id, providerModelId: model.model },
    });
    if (receipt.status !== 'applied') throw new Error(receipt.failure || 'Your model choice could not be saved.');
  }
  const waiting = review.rows.filter((entry) => entry.need !== 'ready').length;
  finish(waiting
    ? 'Your bots use what’s ready now. The rest runs on FrockBot’s version until you finish it in Setup or it arrives.'
    : 'Your bots use it from their next reply.');
});
el('frock').onclick = () => { store.clear(); location.assign('/'); };
el('google').onclick = () => guarded(el('google'), async () => {
  const back = location.origin + '/setup/apply';
  const { url } = await api('/api/auth/sign-in/social', {
    provider: 'google', callbackURL: back, newUserCallbackURL: back, errorCallbackURL: back,
  });
  location.assign(url);
});
load();
`;
