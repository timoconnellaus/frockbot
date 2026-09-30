import {
  clearSavedSetupV1,
  defaultSetupChoicesV1,
  defaultSetupModelV1,
  frockJobsV1,
  normalizeSetupChoicesV1,
  presetChoicesV1,
  readSavedSetupV1,
  saveSetupV1,
  setupFragmentV1,
  setupJobV1,
  setupProviderV1,
} from "./choices.generated.js";
import options from "./options.generated.js";
import { describeSetup } from "./result.js";
import {
  renderPanelList,
  renderPresets,
  renderQuestions,
  renderResult,
} from "./view.js";

// Choices only, never keys, and only in this browser.
const storage = () => window.localStorage;

// What "Dress it up" starts on when a part was still FrockBot's.
const FIRST_CUSTOM = {
  host: "own",
  computer: "server",
  search: "brave",
  apps: "composio",
};

const SELF_HOSTED_NOTICE =
  "Frock AI still works on a self-hosted install, through your linked FrockBot account. Your install also comes with Cloudflare Workers AI: choose Your providers to use it.";

/** Whether two setups choose the same thing, so a preset reads as picked. */
export function sameSetup(left, right) {
  return (
    ["host", "computer", "search", "apps", "ai"].every(
      (key) => left[key] === right[key],
    ) &&
    options.jobs.every((job) => {
      const a = left.jobs[job.id];
      const b = right.jobs[job.id];
      return (
        a.provider === b.provider &&
        (a.provider === "same" || a.model === b.model)
      );
    })
  );
}

/** The app link that carries a setup, in the fragment no server sees. */
export function carryHref(href, choices, carry) {
  if (!carry) return href;
  const carried = carry === "cloud" ? { ...choices, host: "cloud" } : choices;
  return `${href}#${setupFragmentV1(carried)}`;
}

function initialise(root) {
  const questions = root.querySelector("[data-setup-questions]");
  const result = root.querySelector("[data-setup-result]");
  const presets = root.querySelector("[data-setup-presets]");
  const saved = root.querySelector("[data-setup-saved]");
  root.querySelector("[data-setup-nojs]")?.remove();

  const stored = readSavedSetupV1(storage);
  const restored = normalizeSetupChoicesV1(stored, options);
  let state = {
    choices: restored.choices,
    restored: stored !== undefined,
    notices: restored.notes,
    open: null,
    query: "",
  };
  // The homepage's starting points link here as #preset=<id>.
  const asked = new URLSearchParams(location.hash.slice(1)).get("preset");
  const preset = options.presets.find((entry) => entry.id === asked);
  if (preset) {
    history.replaceState(null, "", location.pathname);
    state = {
      ...state,
      choices: presetChoicesV1(options, preset),
      restored: false,
      notices: [],
    };
    saveSetupV1(storage, state.choices);
  }

  const render = () => {
    const focused = document.activeElement?.getAttribute?.("data-focus");
    const described = describeSetup(state.choices, options);
    presets.innerHTML = renderPresets(
      state,
      options,
      options.presets.map((preset) => ({
        id: preset.id,
        name: preset.name,
        on: sameSetup(presetChoicesV1(options, preset), state.choices),
      })),
    );
    questions.innerHTML = renderQuestions(state, options);
    result.innerHTML = renderResult(described, state.notices, {
      primary: carryHref(
        described.cta.href,
        state.choices,
        described.cta.carry,
      ),
      secondary: carryHref(
        described.cta.secondary.href,
        state.choices,
        described.cta.secondary.carry,
      ),
    });
    saved.hidden = false;
    saved.innerHTML = `${state.restored ? "<strong>Welcome back.</strong> " : ""}Saved on this device · <button type="button" class="setup-link" data-action="start-over" data-focus="start-over">Start over</button>`;
    if (focused) root.querySelector(`[data-focus="${focused}"]`)?.focus();
  };

  // Every change comes through here, so the page can say what it changed.
  const change = (next, { keepOpen = false } = {}) => {
    const notices = [];
    if (
      next.host !== "cloud" &&
      state.choices.host === "cloud" &&
      next.ai === "frock"
    )
      notices.push(SELF_HOSTED_NOTICE);
    state = {
      ...state,
      choices: next,
      restored: false,
      notices,
      open: keepOpen ? state.open : null,
      query: keepOpen ? state.query : "",
    };
    saveSetupV1(storage, next);
    render();
  };

  const setJob = (jobId, choice) =>
    change({
      ...state.choices,
      ai: "custom",
      jobs: { ...state.choices.jobs, [jobId]: choice },
    });

  const actions = {
    preset(target) {
      const preset = options.presets.find(
        (entry) => entry.id === target.dataset.value,
      );
      if (preset) change(presetChoicesV1(options, preset));
    },
    top(target) {
      const { part, value } = target.dataset;
      const choices = state.choices;
      if (part === "ai") {
        change(
          value === "ours"
            ? { ...choices, ai: "frock", jobs: frockJobsV1(options) }
            : { ...choices, ai: "custom" },
        );
        return;
      }
      const ours = options[part].find((entry) => entry.ours).id;
      if (value === "ours") change({ ...choices, [part]: ours });
      else if (choices[part] === ours)
        change({ ...choices, [part]: FIRST_CUSTOM[part] });
    },
    option(target) {
      change({ ...state.choices, [target.dataset.part]: target.dataset.value });
    },
    open(target) {
      const { job, kind } = target.dataset;
      const same = state.open?.job === job && state.open.kind === kind;
      state = { ...state, open: same ? null : { job, kind }, query: "" };
      render();
      if (!same) root.querySelector(`[data-focus="query-${job}"]`)?.focus();
    },
    provider(target) {
      const job = setupJobV1(options, target.dataset.job);
      const id = target.dataset.value;
      if (id === "same") return setJob(job.id, { provider: "same" });
      const provider = setupProviderV1(options, job, id);
      setJob(job.id, {
        provider: id,
        model: defaultSetupModelV1(job, provider),
      });
      root.querySelector(`[data-focus="pick-${job.id}-provider"]`)?.focus();
    },
    model(target) {
      const job = target.dataset.job;
      const current = state.choices.jobs[job];
      setJob(job, { provider: current.provider, model: target.dataset.value });
      root.querySelector(`[data-focus="pick-${job}-model"]`)?.focus();
    },
    "start-over"() {
      clearSavedSetupV1(storage);
      state = {
        choices: defaultSetupChoicesV1(options),
        restored: false,
        notices: [],
        open: null,
        query: "",
      };
      render();
      saved.hidden = true;
    },
  };

  root.addEventListener("click", (event) => {
    const target = event.target.closest?.("[data-action]");
    if (target && root.contains(target) && actions[target.dataset.action]) {
      actions[target.dataset.action](target);
      return;
    }
    // A click outside an open picker closes it.
    if (state.open && !event.target.closest?.(".setup-panel")) {
      state = { ...state, open: null, query: "" };
      render();
    }
  });
  root.addEventListener("input", (event) => {
    if (event.target.dataset?.action !== "query") return;
    state = { ...state, query: event.target.value };
    const list = root.querySelector("[data-panel-list]");
    if (list) list.innerHTML = renderPanelList(state, options);
  });
  root.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !state.open) return;
    const { job, kind } = state.open;
    state = { ...state, open: null, query: "" };
    render();
    root.querySelector(`[data-focus="pick-${job}-${kind}"]`)?.focus();
  });
  render();
  // Only a returning visitor sees "Saved on this device" before choosing.
  saved.hidden = !state.restored;
}

if (typeof document !== "undefined") {
  document.querySelectorAll("[data-setup]").forEach(initialise);
}
