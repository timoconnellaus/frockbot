import type { PaymentsPlanV1 } from "@frockbot/core/contracts";
import { COMPUTER_TARIFF } from "./computer.js";

function escaped(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
}

/** Whole dollars where the amount is whole: US$20, not US$20.00. */
function dollars(cents: number): string {
  return cents % 100 === 0
    ? `US$${cents / 100}`
    : `US$${(cents / 100).toFixed(2)}`;
}

/**
 * The Billing page, in the product's name, selling what the deployment's
 * payments Package sells and crediting whoever handles its payments.
 */
export function billingPageV1(options: {
  productName: string;
  plan: PaymentsPlanV1;
  providerName: string | null;
}): string {
  const product = escaped(options.productName);
  const { subscriptions, trial, topUpCents } = options.plan;
  const offered = subscriptions
    .map(
      (each) =>
        `<p class="price">${escaped(each.name)} · ${dollars(each.monthlyCents)} <span>/ month</span></p><p>Includes ${dollars(each.includedMicros / 10_000)} of usage each billing month.</p>`,
    )
    .join("");
  const trialNote = trial
    ? `<p>A first subscription starts with a ${trial.days}-day trial and ${dollars(trial.creditMicros / 10_000)} of credit.</p>`
    : "";
  const plan = subscriptions.length
    ? `<section class="plan"><div><h2>${product}</h2>${offered}${trialNote}<p id="subscription"></p></div><div class="actions"><button id="subscribe" disabled>Subscribe</button><button id="manage" class="secondary" disabled>Manage subscription</button></div></section>`
    : "";
  const topUps = topUpCents.length
    ? `<section><h2>Add a top-up</h2><p>Prepaid credit. No automatic overage charges.${
        options.plan.purchasedCreditNeedsSubscription
          ? " A subscription is required to use credit."
          : ""
      }</p><div class="topups">${topUpCents
        .map(
          (cents) =>
            `<button data-topup="${cents}" disabled>${dollars(cents)}</button>`,
        )
        .join("")}</div></section>`
    : "";
  const provider = options.providerName
    ? ` Payments are securely handled by ${escaped(options.providerName)}.`
    : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Billing · ${product}</title><link rel="stylesheet" href="/billing.css"><script src="/billing.js" defer></script></head>
<body><main><a class="back" href="/">← Open ${product} / sign in</a><header><p class="eyebrow">YOUR ACCOUNT</p><h1>Billing & usage</h1><p>One plan. A shared balance for every Bot.</p></header>
<p id="notice" role="status" aria-live="polite">Loading your balance…</p>
${plan}
<section class="balances" aria-label="Available credit"><article><h2>Monthly credit</h2><strong id="included">—</strong><p>Resets each billing month. Used first.</p></article><article><h2>Complimentary credit</h2><strong id="complimentary">—</strong><p>Granted by ${product}. Spendable without a subscription.</p></article><article><h2>Purchased credit</h2><strong id="purchased">—</strong><p>Carries forward for future usage.</p></article><article><h2>Reserved for work</h2><strong id="reserved">—</strong><p>Unused credit returns when the work settles.</p></article></section>
${topUps}
<section class="explanation"><h2>What uses credit?</h2><p>Hosted models and your cloud computer share this balance. Bring your own model account and pay that provider directly; computer usage still uses ${product} credit.</p><p>Active Computer time is US$${COMPUTER_TARIFF.activeUsdPerHour.toFixed(2)} per hour, charged from prepaid credit. Up to ${COMPUTER_TARIFF.storageIncludedGb} GB of Computer storage while idle is included in the subscription. The initial viewer window is ${COMPUTER_TARIFF.viewerOpenSeconds} seconds; continued viewing renews in ${COMPUTER_TARIFF.viewerRenewSeconds}-second increments. Other Computer work is charged by its active duration.</p><p>When credit runs out, new paid work pauses and an active viewer is disconnected. Your conversations and account remain accessible. Cancelling stops the next renewal; paid access continues until the end of your billing period.</p></section>
<section><h2>Hosted model rates</h2><p>US dollars per million tokens. Each call is charged at the rate of the model that answered it, never more than the rate listed for the model it asked for. Your own model provider sets its own prices.</p><ul id="rates"></ul></section>
<section><h2>Spent in the last 30 days</h2><p><strong id="spent">—</strong> · See where it went under Billing in the ${product} app.</p></section>
<section><h2>Credit history</h2><ul id="payments"></ul></section>
<section><div class="usage-title"><h2>Recent usage</h2><button id="refresh" class="secondary">Refresh</button></div><p id="empty">No usage yet.</p><div class="table-wrap"><table hidden id="usage"><thead><tr><th>When</th><th>Work</th><th>Bot / conversation</th><th>Status</th><th>Charge</th></tr></thead><tbody></tbody></table></div><button id="more" class="secondary" hidden>Load older usage</button></section>
<footer>All amounts are in US dollars. Any applicable tax is shown at checkout.${provider}</footer></main></body></html>`;
}

export const billingStyles = `:root{color-scheme:light;--paper:#faf7f2;--ink:#1e1d27;--muted:#6d6974;--line:#e7e0d9;--accent:#c93a5f}*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.6 system-ui,sans-serif}main{max-width:1000px;margin:auto;padding:36px 24px 64px}a{color:var(--accent)}header{margin:42px 0 30px}h1{font-size:clamp(32px,6vw,48px);letter-spacing:-.04em;margin:0}h2{font-size:20px;margin:0 0 12px}p{color:var(--muted);margin:8px 0}.eyebrow{letter-spacing:.15em;font-size:12px;font-weight:700}.plan,section{padding:28px;border:1px solid var(--line);border-radius:18px;background:#fff;margin:20px 0}.plan{display:flex;justify-content:space-between;align-items:center;gap:24px}.price{font-size:36px;color:var(--ink);font-weight:700}.price span{font-size:16px;font-weight:400}.actions{display:grid;gap:12px}.balances{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:20px;padding:0;border:0;background:transparent}.balances article{min-width:0;border:1px solid var(--line);border-radius:18px;padding:24px;background:#fff}.balances h2{font-size:16px}.balances strong{font-size:30px}.balances p{font-size:14px}button{font:inherit;font-weight:600;border:1px solid var(--accent);border-radius:10px;padding:12px 20px;background:var(--accent);color:#fff;cursor:pointer}button:disabled{opacity:.5;cursor:default}button.secondary{background:transparent;color:var(--accent)}button:focus-visible,a:focus-visible{outline:3px solid #ec386b;outline-offset:4px}.topups{display:flex;gap:12px;flex-wrap:wrap;margin-top:18px}#notice{border-left:3px solid #ec386b;padding:10px 16px;white-space:pre-wrap}.usage-title{display:flex;align-items:center;justify-content:space-between;gap:16px}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:14px}td,th{text-align:left;padding:14px 10px;border-bottom:1px solid var(--line);vertical-align:top;overflow-wrap:anywhere}td small{display:block;color:var(--muted)}footer{color:var(--muted);font-size:13px;margin-top:28px}@media(max-width:650px){main{padding:24px 16px}.balances{grid-template-columns:minmax(0,1fr)}.plan{align-items:stretch;flex-direction:column}section,.plan{padding:22px}.actions{grid-template-columns:minmax(0,1fr)}td,th{min-width:100px}}`;

export const billingScript = `
const el = id => document.getElementById(id);
const money = value => new Intl.NumberFormat('en-US',{style:'currency',currency:'USD',minimumFractionDigits:2,maximumFractionDigits:4}).format(value/1000000);
let state; let busy=false; let cursor;
async function api(path,body){const response=await fetch(path,{credentials:'same-origin',headers:body?{'content-type':'application/json'}:{},...(body?{method:'POST',body:JSON.stringify(body)}:{})});const data=await response.json();if(!response.ok)throw new Error(data.error||'Billing is unavailable. Please try again.');return data;}
function notice(text){el('notice').textContent=text;}
function act(purpose){return (state?.actions||[]).find(action=>action.purpose===purpose);}
function buttons(){const off=busy||!state?.paymentsAvailable;for(const [id,purpose] of [['subscribe','subscribe'],['manage','manage']]){const button=el(id);if(!button)continue;const action=act(purpose);if(action)button.textContent=action.label;button.disabled=off||!action;}document.querySelectorAll('[data-topup]').forEach(b=>b.disabled=off||!act('top-up')||state?.suspended);}
function rows(items,append){const body=el('usage').querySelector('tbody');if(!append)body.replaceChildren();for(const row of items){const tr=document.createElement('tr');const values=[new Date(row.created).toLocaleString(),row.description,[row.botId,row.sessionId].filter(Boolean).join(' / ')||'Account',row.status==='reserved'?'Pending reconciliation':row.status,row.settlement?money(row.settlement.chargeMicros):money(row.reservedMicros)+' reserved'];for(const value of values){const td=document.createElement('td');td.textContent=value;tr.append(td);}if(row.settlement){const detail=document.createElement('details');const label=document.createElement('summary');label.textContent='Usage details';detail.append(label);const quantities=document.createElement('small');quantities.textContent=Object.entries(row.settlement.quantities).map(([key,value])=>key+': '+value.toLocaleString()).join(' · ')||'No billable provider usage';detail.append(quantities);if(row.settlement.servedModel){const served=document.createElement('small');served.textContent='Answered by '+row.settlement.servedModel+(row.settlement.pricing==='cached'?' (from cache, not charged)':'');detail.append(served);}const unitRates=row.settlement.unitRates||row.unitRates;if(unitRates){const rates=document.createElement('small');rates.textContent='Rates charged (micro-US$ per token): '+Object.entries(unitRates).map(([key,value])=>key+': '+value).join(' · ');detail.append(rates);}tr.children[1].append(detail);}body.append(tr);}el('usage').hidden=!body.children.length;el('empty').hidden=!!body.children.length;cursor=items.length?Math.min(...items.map(row=>row.cursor)):undefined;el('more').hidden=items.length<100;}
function list(id,values,empty){const target=el(id);target.replaceChildren();for(const text of values.length?values:[empty]){const li=document.createElement('li');li.textContent=text;target.append(li);}}
async function load(append=false){try{const data=await api('/api/billing'+(append&&cursor?'?before='+cursor:''));state=data;el('included').textContent=money(data.includedMicros);el('complimentary').textContent=money(data.complimentaryMicros);el('purchased').textContent=money(data.purchasedMicros);el('reserved').textContent=money(data.reservedMicros);const sub=data.subscription;if(el('subscription'))el('subscription').textContent=sub?sub.status+' · '+(sub.cancelAtPeriodEnd?'Access ends ':'Current period ends ')+new Date(sub.periodEnd).toLocaleDateString():'No subscription yet';rows(data.usage,append);list('rates',Object.entries(data.modelRates||{}).map(([model,rate])=>model+' — input US$'+rate.inputUsdPerMillion+', cached input US$'+rate.cachedInputUsdPerMillion+', output US$'+rate.outputUsdPerMillion),'Hosted model rates are awaiting launch setup.');el('spent').textContent=money(data.spentLast30DaysMicros||0);list('payments',(data.payments||[]).map(row=>new Date(row.created).toLocaleDateString()+' · '+(row.kind==='included'?'Monthly allowance':row.kind==='jev'?'Jev fair use':row.kind==='complimentary'?'Complimentary credit':'Purchased top-up')+' · '+money(row.creditMicros)+(row.expires?' · expires '+new Date(row.expires).toLocaleDateString():'')),'No credit granted yet.');notice(data.suspended?'Payments need review. Contact support before starting more paid work.':!data.paymentsAvailable?'Payments are not available yet. Your account and usage remain accessible.':data.metered&&!data.canSpend?'Your Bots can’t reply until you subscribe or receive credit.':new URLSearchParams(location.search).get('checkout')==='success'?'Checkout finished. Your verified balance is shown below; a payment may take a moment to appear.':'Your balance is shared across all your Bots.');}catch(error){notice(error.message);}finally{buttons();}}
function allowed(url,action){const target=new URL(url,location.origin);return target.origin===location.origin||(target.protocol==='https:'&&action.hosts.includes(target.hostname));}
async function take(purpose,cents){const action=act(purpose);if(busy||!action)return;busy=true;buttons();const key='frockbot-checkout-'+purpose+'-'+(cents||0);let id=sessionStorage.getItem(key)||crypto.randomUUID();sessionStorage.setItem(key,id);try{const url=action.target.kind==='url'?action.target.url:(await api(action.target.path,{id,...(action.target.body||{}),...(cents?{cents}:{})})).url;if(typeof url!=='string'||!allowed(url,action))throw new Error('The payment page is not one this account can open.');sessionStorage.removeItem(key);location.assign(url);}catch(error){notice(error.message);busy=false;buttons();}}
if(el('subscribe'))el('subscribe').onclick=()=>take('subscribe');if(el('manage'))el('manage').onclick=()=>take('manage');document.querySelectorAll('[data-topup]').forEach(button=>button.onclick=()=>take('top-up',Number(button.dataset.topup)));
// A setup chosen on frockbot.com waits at /setup through checkout.
try{if(new URLSearchParams(location.search).get('checkout')==='success'&&localStorage.getItem('frockbot-setup-pending-v1'))location.replace('/setup/apply');}catch{}
el('refresh').onclick=()=>load();el('more').onclick=()=>load(true);load();
`;
