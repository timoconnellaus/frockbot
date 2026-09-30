import {
  resolveSetupJobsV1,
  selfHostedV1,
  setupModelsV1,
  setupProviderV1,
  setupProvidersV1,
} from "./choices.generated.js";

// The page is rendered from strings both at build time, for the setup a
// visitor without JavaScript sees, and in the browser. Everything that is not
// markup goes through here.
export function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
const e = escapeHtml;

const GROUP_ORDER = [
  "FrockBot",
  "Popular",
  "All providers",
  "Your accounts",
  "Your own",
];
const CHEVRON =
  '<svg aria-hidden="true" viewBox="0 0 24 24" width="14" height="14"><path d="m6 9 6 6 6-6" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';
const SOON = '<span class="setup-soon">Coming soon</span>';

const QUESTIONS = [
  {
    part: "host",
    title: "Where FrockBot runs",
    lede: "The app itself: your bots, their memory and their conversations.",
    custom: "Run FrockBot yourself.",
  },
  {
    part: "computer",
    title: "Where your computer runs",
    lede: "Every bot shares one computer. It browses, runs code and downloads things.",
    custom: "Run the computer on your own account or machine.",
  },
  {
    part: "ai",
    title: "AI",
    lede: "Let Frock AI handle it, or choose the provider and model for each job.",
    custom: "Choose the provider and model for each job.",
  },
  {
    part: "search",
    title: "Web search",
    lede: "How your bots search the web.",
    custom: "Use your own search service.",
  },
  {
    part: "apps",
    title: "Connected apps",
    lede: "Gmail, Calendar, Notion and the rest.",
    custom: "Use your own connected-apps account.",
  },
];

const VIA_LINKED = "Through your linked FrockBot account, paid from credit.";

function chip({ label, name, description, soon, pressed, action, attributes }) {
  return `<button type="button" class="setup-chip${pressed ? " is-on" : ""}" aria-pressed="${pressed}" data-action="${action}" ${attributes}><span class="setup-radio" aria-hidden="true"></span><span class="setup-chip-body">${label ? `<span class="setup-chip-label">${e(label)}</span>` : ""}<span class="setup-chip-name">${e(name)}${soon ? ` ${SOON}` : ""}</span><span class="setup-chip-description">${e(description)}</span></span></button>`;
}

function ours(list) {
  return list.find((entry) => entry.ours);
}

function isCustom(part, choices, options) {
  if (part === "ai") return choices.ai === "custom";
  return choices[part] !== ours(options[part]).id;
}

function readyToWear(part, choices, options) {
  const own = selfHostedV1(choices);
  if (part === "ai") {
    return {
      name: "Frock AI",
      description: own
        ? `${VIA_LINKED} We pick and run every model.`
        : "We pick and run the right model for every job. Nothing to set up.",
      soon: own,
    };
  }
  const option = ours(options[part]);
  const linked = own && part !== "host";
  return {
    name: option.name,
    description: linked
      ? part === "apps"
        ? `Through your linked FrockBot account. ${option.description}`
        : VIA_LINKED
      : option.description,
    soon: linked || option.status === "coming-soon",
  };
}

function renderQuestion(question, index, state, options) {
  const { choices } = state;
  const custom = isCustom(question.part, choices, options);
  const ready = readyToWear(question.part, choices, options);
  const id = `setup-q-${question.part}`;
  const top = [
    chip({
      label: "Ready to wear",
      name: ready.name,
      description: ready.description,
      soon: ready.soon,
      pressed: !custom,
      action: "top",
      attributes: `data-part="${question.part}" data-value="ours" data-focus="top-${question.part}-ours"`,
    }),
    chip({
      label: "Dress it up",
      name: question.part === "ai" ? "Your providers" : "Your own",
      description: question.custom,
      soon: false,
      pressed: custom,
      action: "top",
      attributes: `data-part="${question.part}" data-value="custom" data-focus="top-${question.part}-custom"`,
    }),
  ].join("");
  let reveal = "";
  if (custom && question.part === "ai") reveal = renderJobs(state, options);
  else if (custom) {
    reveal = `<div class="setup-options">${options[question.part]
      .filter((option) => !option.ours)
      .map((option) =>
        chip({
          name: option.name,
          description: option.description,
          soon: option.status === "coming-soon",
          pressed: choices[question.part] === option.id,
          action: "option",
          attributes: `data-part="${question.part}" data-value="${e(option.id)}" data-focus="option-${question.part}-${e(option.id)}"`,
        }),
      )
      .join("")}</div>`;
  }
  return `<section class="setup-question" aria-labelledby="${id}"><div class="setup-question-head"><span class="setup-number" aria-hidden="true">${index + 1}</span><div><h2 id="${id}">${e(question.title)}</h2><p>${e(question.lede)}</p></div></div><div class="setup-top">${top}</div>${reveal}</section>`;
}

function providerSoon(provider, own) {
  if (own && provider.includedWhenSelfHosted) return false;
  return provider.status === "coming-soon" || (own && !!provider.ours);
}

function payLine(job, provider, own, followsChat) {
  let pay = provider.ours
    ? job.id === "jev" && !own
      ? "Included in every plan"
      : "From FrockBot credit"
    : provider.free
      ? "Free, on your own hardware"
      : own && provider.includedWhenSelfHosted
        ? "Comes with your install"
        : `Your ${provider.name} account`;
  if (followsChat) pay = `Follows chat · ${pay}`;
  return pay;
}

function providerGroups(job, options, own) {
  const list = setupProvidersV1(options, job);
  const groups = GROUP_ORDER.map((label) => ({
    label,
    options: list
      .filter((provider) => provider.group === label)
      .map((provider) => ({
        id: provider.id,
        label: `${provider.name}${providerSoon(provider, own) ? " (coming soon)" : ""}`,
      })),
  })).filter((group) => group.options.length);
  if (job.follows)
    groups.unshift({
      label: "Follow chat",
      options: [{ id: "same", label: "Same as chat" }],
    });
  return groups;
}

/** The grouped, filtered list inside an open provider or model picker. */
export function renderPanelList(state, options) {
  const { open, query, choices } = state;
  if (!open) return "";
  const job = options.jobs.find((entry) => entry.id === open.job);
  const own = selfHostedV1(choices);
  const resolved = resolveSetupJobsV1(choices, options)[job.id];
  const provider = setupProviderV1(options, job, resolved.provider);
  const terms = (query ?? "").trim().toLowerCase();
  const match = (text) => !terms || text.toLowerCase().includes(terms);
  const current = choices.jobs[job.id]?.provider;
  let groups;
  if (open.kind === "provider") {
    groups = providerGroups(job, options, own).map((group) => ({
      label: group.label,
      options: group.options
        .filter((option) => match(option.label))
        .map((option) => ({
          ...option,
          on: option.id === current,
          action: "provider",
        })),
    }));
  } else {
    const models = setupModelsV1(job, provider);
    groups = [
      {
        label: `${provider.name} models`,
        options: models
          .filter(([, name]) => match(name))
          .map(([id, name]) => ({
            id,
            label: name,
            on: id === resolved.model,
            action: "model",
          })),
      },
    ];
  }
  groups = groups.filter((group) => group.options.length);
  if (!groups.length) {
    return `<p class="setup-panel-empty">${
      open.kind === "model" && !provider.models
        ? "Models appear once you connect."
        : "Nothing matches. Custom endpoint works with any OpenAI-compatible provider."
    }</p>`;
  }
  return groups
    .map(
      (group) =>
        `<div class="setup-panel-group" role="group" aria-label="${e(group.label)}"><span class="setup-panel-label">${e(group.label)}</span>${group.options
          .map(
            (option) =>
              `<button type="button" class="setup-panel-option${option.on ? " is-on" : ""}" aria-pressed="${option.on}" data-action="${option.action}" data-job="${e(job.id)}" data-value="${e(option.id)}">${e(option.label)}</button>`,
          )
          .join("")}</div>`,
    )
    .join("");
}

function renderJobs(state, options) {
  const { choices, open, query } = state;
  const own = selfHostedV1(choices);
  const resolved = resolveSetupJobsV1(choices, options);
  const row = (job) => {
    const choice = choices.jobs[job.id];
    const current = resolved[job.id];
    const provider = setupProviderV1(options, job, current.provider);
    const modelName =
      provider.models?.find(([id]) => id === current.model)?.[1] ??
      (provider.models ? current.model : "Models appear once you connect");
    const providerLabel =
      choice?.provider === "same"
        ? `Same as chat (${provider.name})`
        : provider.name;
    const isOpen = (kind) => open?.job === job.id && open.kind === kind;
    const soon =
      providerSoon(provider, own) ||
      (job.status === "coming-soon" && !current.followsChat && !provider.ours);
    const title = isOpen("provider")
      ? `Choose a provider for ${job.name.toLowerCase()}`
      : `Choose the ${provider.name} model for ${job.name.toLowerCase()}`;
    const panel =
      isOpen("provider") || isOpen("model")
        ? `<div class="setup-panel" role="dialog" aria-label="${e(title)}"><label class="setup-panel-search"><span>${e(title)}</span><input type="search" placeholder="Search" autocomplete="off" value="${e(query ?? "")}" data-action="query" data-focus="query-${e(job.id)}"></label><div class="setup-panel-list" data-panel-list>${renderPanelList(state, options)}</div></div>`
        : "";
    return `<div class="setup-job"><div class="setup-job-name"><span class="setup-chip-name">${e(job.name)}${job.status === "coming-soon" ? ` ${SOON}` : ""}</span><span class="setup-chip-description">${e(job.description)}</span></div><div class="setup-pickers"><button type="button" class="setup-pick" aria-expanded="${isOpen("provider")}" aria-label="Provider for ${e(job.name)}: ${e(providerLabel)}" data-action="open" data-job="${e(job.id)}" data-kind="provider" data-focus="pick-${e(job.id)}-provider"><span>${e(providerLabel)}</span>${CHEVRON}</button><button type="button" class="setup-pick" aria-expanded="${isOpen("model")}" aria-label="Model for ${e(job.name)}: ${e(modelName)}" data-action="open" data-job="${e(job.id)}" data-kind="model" data-focus="pick-${e(job.id)}-model"${choice?.provider === "same" || !provider.models ? " disabled" : ""}><span>${e(modelName)}</span>${CHEVRON}</button></div><span class="setup-pay">${e(payLine(job, provider, own, current.followsChat))}${soon ? " · coming soon" : ""}</span>${panel}</div>`;
  };
  const chat = options.jobs.filter((job) => job.kind === "chat");
  const services = options.jobs.filter((job) => job.kind !== "chat");
  return `<div class="setup-jobs"><p class="setup-jobs-lede">Pick a provider, then a model, for each job. Writing, coding and the rest follow chat until you change them.</p><div class="setup-job-group"><h3>Chat and jobs</h3>${chat.map(row).join("")}</div><div class="setup-job-group"><h3>Jev, voice and images</h3>${services.map(row).join("")}</div></div>`;
}

export function renderQuestions(state, options) {
  return QUESTIONS.map((question, index) =>
    renderQuestion(question, index, state, options),
  ).join("");
}

export function renderPresets(state, options, presets) {
  return presets
    .map(
      (preset) =>
        `<button type="button" class="setup-preset${preset.on ? " is-on" : ""}" aria-pressed="${preset.on}" data-action="preset" data-value="${e(preset.id)}" data-focus="preset-${e(preset.id)}">${e(preset.name)}</button>`,
    )
    .join("");
}

export function renderResult(result, notices = [], hrefs = {}) {
  const node = (entry) =>
    `<div class="setup-node${entry.yours ? " is-yours" : ""}"><span class="setup-node-title">${e(entry.title)}</span><span class="setup-node-where">${e(entry.where)}</span><span class="setup-node-who">${e(entry.who)}</span>${entry.soon ? '<span class="setup-node-soon">Coming soon</span>' : ""}</div>`;
  const [app, ...rest] = result.nodes;
  const secondary = result.cta.secondary;
  return `<div class="setup-result-head"><p class="section-label">Your setup</p><h2 id="setup-result-title">${e(result.headline)}</h2><p>${e(result.subline)}</p></div>${
    notices.length
      ? `<div class="setup-notices">${notices.map((text) => `<p class="setup-notice"><span aria-hidden="true">i</span>${e(text)}</p>`).join("")}</div>`
      : ""
  }<div class="setup-plan"><div><span class="setup-plan-label">Suggested plan</span><span class="setup-plan-name">${e(result.plan.name)}</span><span class="setup-plan-note">${e(result.plan.note)}</span></div><span class="setup-plan-price">${e(result.plan.price)}</span></div><figure class="setup-diagram" aria-label="Who runs what"><div class="setup-diagram-top"><div class="setup-node"><span class="setup-node-title">Your apps</span><span class="setup-node-where">Phone, Mac or browser</span></div><span class="setup-wire" aria-hidden="true"></span>${node(app)}</div><span class="setup-wire setup-wire-down" aria-hidden="true"></span><div class="setup-diagram-grid">${rest.map(node).join("")}</div><figcaption class="setup-legend"><span class="setup-legend-ours">FrockBot’s</span><span class="setup-legend-yours">Yours</span></figcaption></figure><div class="setup-block"><h3>What it costs</h3><dl class="setup-costs">${result.costs
    .map(
      (cost) => `<div><dt>${e(cost.label)}</dt><dd>${e(cost.value)}</dd></div>`,
    )
    .join(
      "",
    )}</dl></div><div class="setup-block"><h3>What you get, and what to know</h3><ul class="setup-gains">${result.gains
    .map(
      (gain) =>
        `<li class="${gain.plus ? "is-plus" : "is-minus"}"><span aria-hidden="true">${gain.plus ? "+" : "–"}</span><span class="sr-only">${gain.plus ? "You get: " : "Know: "}</span>${e(gain.text)}</li>`,
    )
    .join(
      "",
    )}</ul></div><div class="setup-block"><h3>How to start</h3><ol class="setup-steps">${result.steps
    .map((step) => `<li>${e(step.text)}</li>`)
    .join("")}</ol>${
    result.later.length
      ? `<h3 class="setup-later-title">Not ready yet</h3><ul class="setup-later">${result.later
          .map((item) => `<li>${SOON}<span>${e(item.text)}</span></li>`)
          .join(
            "",
          )}</ul><p class="setup-later-note">Start with FrockBot’s version of those parts today, and switch in setup when yours are ready. Nothing you chose is lost.</p>`
      : ""
  }</div><p class="setup-cta-note">${e(result.cta.note)}</p><div class="setup-cta"><a class="button" href="${e(hrefs.primary ?? result.cta.href)}" data-cta="primary">${e(result.cta.label)} <span aria-hidden="true">→</span></a><a class="button button-outline" href="${e(hrefs.secondary ?? secondary.href)}" data-cta="secondary">${e(secondary.label)}</a></div>`;
}
