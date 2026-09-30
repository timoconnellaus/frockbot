/**
 * The setup a person chose on frockbot.com, carried into the app.
 *
 * One versioned format is read by the marketing chooser, the deploy page and
 * the setup app. It holds choices only, never a key, and travels in local
 * storage on frockbot.com and in a URL fragment into the app, which no server
 * sees. What each choice means, and whether it can be used yet, belongs to the
 * options document the caller passes in, so the format outlives any one
 * option: a value the options no longer offer falls back to FrockBot's
 * version of that part, with a note saying so.
 *
 * This module imports nothing. The marketing site serves a transpiled copy of
 * it as-is, under a CSP that allows no inline or third-party script.
 */

export const SETUP_CHOICES_VERSION_V1 = 1;
export const SETUP_STORAGE_KEY_V1 = "frockbot-setup-v1";
/** The fragment parameter a setup travels in: `#setup=<base64url JSON>`. */
export const SETUP_FRAGMENT_PARAMETER_V1 = "setup";

export type SetupStatusV1 = "available" | "coming-soon";
export type SetupAiModeV1 = "frock" | "custom";
export type SetupJobKindV1 = "chat" | "jev" | "voice" | "dictation" | "image";
export type SetupPlanV1 = "standard" | "byo" | "none";
export type SetupSinglePartV1 = "host" | "computer" | "search" | "apps";

/**
 * A job's provider and model. The provider `same` makes a chat job follow
 * chat, and carries no model.
 */
export interface SetupJobChoiceV1 {
  provider: string;
  model?: string;
}

export interface SetupChoicesV1 {
  host: string;
  computer: string;
  ai: SetupAiModeV1;
  jobs: Record<string, SetupJobChoiceV1>;
  search: string;
  apps: string;
}

export interface SetupOptionV1 {
  id: string;
  name: string;
  description: string;
  status: SetupStatusV1;
  /** FrockBot's own option for this part: its default and its fallback. */
  ours?: boolean;
  /** The account the person pays for it with, when it is theirs. */
  account?: string;
  /** Runs on the person's own hardware, at no cost. */
  free?: boolean;
  /** How the person connects it: a key, a sign-in, or nothing. */
  connect?: "key" | "sign-in";
}

/** `[id, name, vision, reasoning]`, as the provider catalog describes it. */
export type SetupModelV1 = [string, string, boolean?, boolean?];

export interface SetupProviderV1 {
  id: string;
  name: string;
  group: string;
  status: SetupStatusV1;
  ours?: boolean;
  free?: boolean;
  /** A self-hosted install has it already: its own Cloudflare account. */
  includedWhenSelfHosted?: boolean;
  connect?: "key" | "sign-in";
  /** Omitted when the models are only known once the person connects. */
  models?: SetupModelV1[];
}

export interface SetupJobV1 {
  id: string;
  name: string;
  description: string;
  kind: SetupJobKindV1;
  /** Whether a person can choose this job's provider apart from chat yet. */
  status: SetupStatusV1;
  /** Frock AI's model for a chat job. */
  frockModel?: string;
  /** Follows chat until the person changes it. */
  follows?: boolean;
  needs?: "vision" | "reasoning";
}

export interface SetupPresetV1 {
  id: string;
  name: string;
  host: string;
  computer: string;
  search: string;
  apps: string;
  /** Jobs that differ from Frock AI: `[provider]` or `[provider, model]`. */
  jobs?: Record<string, string[]>;
}

export interface SetupOptionsV1 {
  version: 1;
  host: SetupOptionV1[];
  computer: SetupOptionV1[];
  jobs: SetupJobV1[];
  providers: Record<SetupJobKindV1, SetupProviderV1[]>;
  search: SetupOptionV1[];
  apps: SetupOptionV1[];
  presets: SetupPresetV1[];
}

export interface ResolvedJobV1 {
  provider: string;
  model: string;
  followsChat: boolean;
}

const SINGLE_PARTS: readonly SetupSinglePartV1[] = [
  "host",
  "computer",
  "search",
  "apps",
];
const PART_NAMES: Record<SetupSinglePartV1, string> = {
  host: "Where FrockBot runs",
  computer: "The computer",
  search: "Web search",
  apps: "Connected apps",
};

function ours<T extends { ours?: boolean }>(list: readonly T[]): T {
  const found = list.find((entry) => entry.ours);
  if (!found) throw new Error("Every setup part needs FrockBot's own option");
  return found;
}

export function setupJobV1(options: SetupOptionsV1, id: string): SetupJobV1 {
  const job = options.jobs.find((entry) => entry.id === id);
  if (!job) throw new Error(`Unknown setup job ${id}`);
  return job;
}

export function setupProvidersV1(
  options: SetupOptionsV1,
  job: SetupJobV1,
): SetupProviderV1[] {
  return options.providers[job.kind];
}

export function setupProviderV1(
  options: SetupOptionsV1,
  job: SetupJobV1,
  id: string,
): SetupProviderV1 | undefined {
  return setupProvidersV1(options, job).find((entry) => entry.id === id);
}

/** The models a job can use from a provider: vision or reasoning when it needs one. */
export function setupModelsV1(
  job: SetupJobV1,
  provider: SetupProviderV1,
): SetupModelV1[] {
  const models = provider.models ?? [];
  const fit = models.filter((model) =>
    job.needs === "vision"
      ? model[2] !== false
      : job.needs === "reasoning"
        ? model[3] !== false
        : true,
  );
  return fit.length ? fit : models;
}

/** The model a job starts on when the person picks a provider for it. */
export function defaultSetupModelV1(
  job: SetupJobV1,
  provider: SetupProviderV1,
): string {
  if (provider.ours && job.frockModel) return job.frockModel;
  return setupModelsV1(job, provider)[0]?.[0] ?? "";
}

function frockJob(options: SetupOptionsV1, job: SetupJobV1): SetupJobChoiceV1 {
  if (job.follows) return { provider: "same" };
  const provider = ours(setupProvidersV1(options, job));
  return { provider: provider.id, model: defaultSetupModelV1(job, provider) };
}

/** Every job on Frock AI, the other jobs following chat. */
export function frockJobsV1(
  options: SetupOptionsV1,
): Record<string, SetupJobChoiceV1> {
  return Object.fromEntries(
    options.jobs.map((job) => [job.id, frockJob(options, job)]),
  );
}

/** FrockBot runs everything: what a person gets with nothing chosen. */
export function defaultSetupChoicesV1(options: SetupOptionsV1): SetupChoicesV1 {
  return {
    host: ours(options.host).id,
    computer: ours(options.computer).id,
    ai: "frock",
    jobs: frockJobsV1(options),
    search: ours(options.search).id,
    apps: ours(options.apps).id,
  };
}

export function presetChoicesV1(
  options: SetupOptionsV1,
  preset: SetupPresetV1,
): SetupChoicesV1 {
  const jobs = frockJobsV1(options);
  for (const [id, [provider, model]] of Object.entries(preset.jobs ?? {})) {
    const job = setupJobV1(options, id);
    if (provider === "same") {
      jobs[id] = { provider: "same" };
      continue;
    }
    const entry = setupProviderV1(options, job, provider ?? "");
    if (!entry) throw new Error(`Preset ${preset.id} names ${provider}`);
    jobs[id] = {
      provider: entry.id,
      model: model ?? defaultSetupModelV1(job, entry),
    };
  }
  const custom = Object.keys(preset.jobs ?? {}).length > 0;
  return {
    host: preset.host,
    computer: preset.computer,
    ai: custom ? "custom" : "frock",
    jobs,
    search: preset.search,
    apps: preset.apps,
  };
}

export interface NormalizedSetupV1 {
  choices: SetupChoicesV1;
  /** What fell back to FrockBot's version, one line each. */
  notes: string[];
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Reads a stored or linked setup against the options offered now. Anything
 * unknown, retired or malformed becomes FrockBot's version of that part, and
 * says so; nothing here throws on what a browser or a link handed it.
 */
export function normalizeSetupChoicesV1(
  input: unknown,
  options: SetupOptionsV1,
): NormalizedSetupV1 {
  const defaults = defaultSetupChoicesV1(options);
  const source = record(input);
  if (!source || source.v !== SETUP_CHOICES_VERSION_V1) {
    return {
      choices: defaults,
      notes: source
        ? [
            "This setup was saved in a format we no longer read, so it starts from FrockBot’s setup.",
          ]
        : [],
    };
  }
  const notes: string[] = [];
  const choices: SetupChoicesV1 = { ...defaults, jobs: { ...defaults.jobs } };
  for (const part of SINGLE_PARTS) {
    const value = source[part];
    if (value === undefined) continue;
    if (
      typeof value === "string" &&
      options[part].some((entry) => entry.id === value)
    ) {
      choices[part] = value;
    } else {
      notes.push(
        `${PART_NAMES[part]}: the choice you saved isn’t offered any more, so it’s on FrockBot’s for now.`,
      );
    }
  }
  choices.ai = source.ai === "custom" ? "custom" : "frock";
  if (choices.ai === "frock") return { choices, notes };
  const jobs = record(source.jobs) ?? {};
  for (const job of options.jobs) {
    const saved = record(jobs[job.id]);
    if (!saved) continue;
    if (saved.provider === "same" && job.follows) {
      choices.jobs[job.id] = { provider: "same" };
      continue;
    }
    const provider =
      typeof saved.provider === "string"
        ? setupProviderV1(options, job, saved.provider)
        : undefined;
    const model = typeof saved.model === "string" ? saved.model : undefined;
    const known =
      provider &&
      (model === undefined ||
        !provider.models ||
        (provider.ours && model === job.frockModel) ||
        provider.models.some(([id]) => id === model));
    if (!provider || !known) {
      notes.push(
        `${job.name}: the ${provider ? "model" : "provider"} you saved isn’t offered any more, so it’s on Frock AI for now.`,
      );
      continue;
    }
    choices.jobs[job.id] = {
      provider: provider.id,
      model: model ?? defaultSetupModelV1(job, provider),
    };
  }
  return { choices, notes };
}

/** The stored and linked shape: choices only, with the format's version. */
export function serializeSetupChoicesV1(
  choices: SetupChoicesV1,
): Record<string, unknown> {
  return { v: SETUP_CHOICES_VERSION_V1, ...choices };
}

function toBase64Url(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(text: string): string {
  const padded = text.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return new TextDecoder().decode(
    Uint8Array.from(binary, (character) => character.charCodeAt(0)),
  );
}

/** The fragment, without `#`, that carries a setup into the app. */
export function setupFragmentV1(choices: SetupChoicesV1): string {
  return `${SETUP_FRAGMENT_PARAMETER_V1}=${toBase64Url(
    JSON.stringify(serializeSetupChoicesV1(choices)),
  )}`;
}

/**
 * The raw setup in a URL fragment, or undefined when the fragment carries
 * none. Pass the result to {@link normalizeSetupChoicesV1}.
 */
export function readSetupFragmentV1(hash: string): unknown {
  const parameters = new URLSearchParams(hash.replace(/^#/, ""));
  const encoded = parameters.get(SETUP_FRAGMENT_PARAMETER_V1);
  if (!encoded) return undefined;
  try {
    return JSON.parse(fromBase64Url(encoded));
  } catch {
    // A mangled link reads as a setup in no format we know.
    return { v: 0 };
  }
}

/** The part of a Storage these functions use, so tests can pass a Map. */
export interface SetupStorageV1 {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/**
 * The saved setup, or undefined. Storage can be missing, blocked or full in
 * a private window, so every access is guarded and failure reads as nothing
 * saved.
 */
export function readSavedSetupV1(
  storage: () => SetupStorageV1 | undefined,
): unknown {
  try {
    const text = storage()?.getItem(SETUP_STORAGE_KEY_V1);
    return text ? JSON.parse(text) : undefined;
  } catch {
    return undefined;
  }
}

export function saveSetupV1(
  storage: () => SetupStorageV1 | undefined,
  choices: SetupChoicesV1,
): boolean {
  try {
    const target = storage();
    if (!target) return false;
    target.setItem(
      SETUP_STORAGE_KEY_V1,
      JSON.stringify(serializeSetupChoicesV1(choices)),
    );
    return true;
  } catch {
    return false;
  }
}

export function clearSavedSetupV1(
  storage: () => SetupStorageV1 | undefined,
): void {
  try {
    storage()?.removeItem(SETUP_STORAGE_KEY_V1);
  } catch {
    // Nothing saved is the state asked for.
  }
}

/** Every job with a concrete provider and model, "same as chat" resolved. */
export function resolveSetupJobsV1(
  choices: SetupChoicesV1,
  options: SetupOptionsV1,
): Record<string, ResolvedJobV1> {
  const chat = choices.jobs.chat;
  const resolved: Record<string, ResolvedJobV1> = {};
  for (const job of options.jobs) {
    const choice = choices.jobs[job.id] ?? frockJob(options, job);
    if (choice.provider !== "same") {
      resolved[job.id] = {
        provider: choice.provider,
        model: choice.model ?? "",
        followsChat: false,
      };
      continue;
    }
    const chatChoice = chat && chat.provider !== "same" ? chat : undefined;
    const provider = chatChoice
      ? setupProviderV1(options, job, chatChoice.provider)
      : undefined;
    if (!provider || !chatChoice) {
      const frock = ours(setupProvidersV1(options, job));
      resolved[job.id] = {
        provider: frock.id,
        model: defaultSetupModelV1(job, frock),
        followsChat: true,
      };
      continue;
    }
    let model = provider.ours
      ? (job.frockModel ?? chatChoice.model ?? "")
      : (chatChoice.model ?? "");
    const fit = setupModelsV1(job, provider);
    if (job.needs && fit.length && !fit.some(([id]) => id === model)) {
      model = fit[0]![0];
    }
    resolved[job.id] = { provider: provider.id, model, followsChat: true };
  }
  return resolved;
}

export function selfHostedV1(choices: SetupChoicesV1): boolean {
  return choices.host !== "cloud";
}

/**
 * The plan a setup suggests; the person picks. Standard when FrockBot's
 * computer or Frock AI for chat is in use, BYO otherwise. A self-hosted
 * install needs no plan, except that connected apps through FrockBot need at
 * least BYO there too.
 */
export function suggestSetupPlanV1(
  choices: SetupChoicesV1,
  options: SetupOptionsV1,
): SetupPlanV1 {
  const resolved = resolveSetupJobsV1(choices, options);
  const frockApps = choices.apps === ours(options.apps).id;
  if (selfHostedV1(choices)) return frockApps ? "byo" : "none";
  const frockChat = options.jobs.some(
    (job) =>
      job.kind === "chat" &&
      setupProviderV1(options, job, resolved[job.id]!.provider)?.ours,
  );
  if (choices.computer === ours(options.computer).id || frockChat)
    return "standard";
  return "byo";
}

/** A part of the setup, what was chosen for it, and whether it works yet. */
export interface SetupPartV1 {
  /** `host`, `computer`, `search`, `apps`, or `job:<id>`. */
  key: string;
  name: string;
  choice: string;
  ours: boolean;
  status: SetupStatusV1;
  connect?: "key" | "sign-in";
  account?: string;
  free: boolean;
  followsChat: boolean;
}

function providerStatus(
  provider: SetupProviderV1,
  selfHosted: boolean,
): SetupStatusV1 {
  if (selfHosted && provider.includedWhenSelfHosted) return "available";
  // FrockBot's own parts reach a self-hosted install through a linked
  // FrockBot account, which is not built yet.
  if (selfHosted && provider.ours) return "coming-soon";
  return provider.status;
}

/**
 * Each part of a setup with its status. A coming-soon part is one the person
 * cannot follow yet: they start on FrockBot's version of it.
 */
export function setupPartsV1(
  choices: SetupChoicesV1,
  options: SetupOptionsV1,
): SetupPartV1[] {
  const selfHosted = selfHostedV1(choices);
  const single = (part: SetupSinglePartV1): SetupPartV1 => {
    const option =
      options[part].find((entry) => entry.id === choices[part]) ??
      ours(options[part]);
    const status: SetupStatusV1 =
      selfHosted && option.ours && part !== "host"
        ? "coming-soon"
        : option.status;
    return {
      key: part,
      name: PART_NAMES[part],
      choice: option.name,
      ours: !!option.ours,
      status,
      ...(option.connect ? { connect: option.connect } : {}),
      ...(option.account ? { account: option.account } : {}),
      free: !!option.free,
      followsChat: false,
    };
  };
  const resolved = resolveSetupJobsV1(choices, options);
  const jobs = options.jobs.map((job): SetupPartV1 => {
    const { provider: id, model, followsChat } = resolved[job.id]!;
    const provider =
      setupProviderV1(options, job, id) ?? ours(setupProvidersV1(options, job));
    const modelName =
      provider.models?.find(([candidate]) => candidate === model)?.[1] ?? model;
    const chosenApart =
      !followsChat && !(provider.ours && choices.ai === "frock");
    const jobStatus =
      chosenApart && !provider.ours && job.status === "coming-soon"
        ? "coming-soon"
        : "available";
    const status =
      providerStatus(provider, selfHosted) === "coming-soon"
        ? "coming-soon"
        : jobStatus;
    return {
      key: `job:${job.id}`,
      name: job.name,
      choice:
        provider.ours || !modelName
          ? provider.name
          : `${provider.name}, ${modelName}`,
      ours: !!provider.ours,
      status,
      ...(provider.connect ? { connect: provider.connect } : {}),
      ...(provider.ours || provider.free ? {} : { account: provider.name }),
      free: !!provider.free,
      followsChat,
    };
  });
  return [
    single("host"),
    single("computer"),
    ...jobs,
    single("search"),
    single("apps"),
  ];
}
