import { transform } from "esbuild";
import {
  catalogProvidersV1,
  oauthProviderIdsV1,
} from "../../../providers/catalog/registry";
import { providerModelsV1 } from "../../../providers/catalog/models";
import {
  defaultSetupChoicesV1,
  presetChoicesV1,
  type SetupOptionsV1,
  type SetupProviderV1,
} from "../../../core/setup-choices/index";

const STATUSES = ["available", "coming-soon"] as const;
const KINDS = ["chat", "jev", "voice", "dictation", "image"] as const;
const SINGLE = ["host", "computer", "search", "apps"] as const;
const GROUPS = [
  "FrockBot",
  "Popular",
  "All providers",
  "Your accounts",
  "Your own",
];

function fail(message: string): never {
  throw new Error(`setup-options.json: ${message}`);
}
function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    fail(`${label} must be an object`);
  return value as Record<string, unknown>;
}
function list(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value) || value.length === 0)
    fail(`${label} must be a non-empty array`);
  return value;
}
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim())
    fail(`${label} must be a non-empty string`);
  return value;
}
function status(value: unknown, label: string) {
  if (!STATUSES.includes(value as never))
    fail(`${label} must be available or coming-soon`);
  return value as (typeof STATUSES)[number];
}
function oneOurs(entries: { id: string; ours?: boolean }[], label: string) {
  const ids = entries.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) fail(`${label} ids must be unique`);
  const own = entries.filter((entry) => entry.ours);
  if (own.length !== 1 || entries[0] !== own[0])
    fail(`${label} must list FrockBot's own option first, and only one`);
}

const OPTIONAL_FLAGS = ["ours", "free", "includedWhenSelfHosted"] as const;
function flags(entry: Record<string, unknown>, label: string) {
  const out: Record<string, unknown> = {};
  for (const flag of OPTIONAL_FLAGS) {
    if (entry[flag] === undefined) continue;
    if (entry[flag] !== true) fail(`${label} ${flag} is true or omitted`);
    out[flag] = true;
  }
  if (entry.connect !== undefined) {
    if (entry.connect !== "key" && entry.connect !== "sign-in")
      fail(`${label} connect is key or sign-in`);
    out.connect = entry.connect;
  }
  if (entry.account !== undefined)
    out.account = text(entry.account, `${label} account`);
  return out;
}

/** The catalog's models, newest-looking ids first, as the chooser lists them. */
function catalogModels(id: string): SetupProviderV1["models"] {
  const provider = catalogProvidersV1.find((entry) => entry.id === id);
  if (!provider) fail(`${id} is not in the provider catalog`);
  return providerModelsV1(provider)
    .map((model): [string, string, boolean, boolean] => [
      model.id,
      model.name,
      model.input.includes("image"),
      !!model.reasoning,
    ])
    .sort(([left], [right]) => right.localeCompare(left));
}

export function buildSetupOptions(input: unknown): SetupOptionsV1 {
  const data = object(input, "The document");
  if (data.version !== 1) fail("version must be 1");
  const single = (key: (typeof SINGLE)[number]) => {
    const entries = list(data[key], key).map((item, index) => {
      const entry = object(item, `${key}[${index}]`);
      const id = text(entry.id, `${key}[${index}].id`);
      return {
        id,
        name: text(entry.name, `${id} name`),
        description: text(entry.description, `${id} description`),
        status: status(entry.status, `${id} status`),
        ...flags(entry, id),
      };
    });
    oneOurs(entries, key);
    if (entries[0]!.status !== "available")
      fail(`FrockBot's own ${key} must be available`);
    return entries;
  };
  const jobs = list(data.jobs, "jobs").map((item, index) => {
    const entry = object(item, `jobs[${index}]`);
    const id = text(entry.id, `jobs[${index}].id`);
    if (!KINDS.includes(entry.kind as never)) fail(`${id} kind is unknown`);
    if (
      entry.needs !== undefined &&
      entry.needs !== "vision" &&
      entry.needs !== "reasoning"
    )
      fail(`${id} needs is vision or reasoning`);
    return {
      id,
      name: text(entry.name, `${id} name`),
      description: text(entry.description, `${id} description`),
      kind: entry.kind as (typeof KINDS)[number],
      status: status(entry.status, `${id} status`),
      ...(entry.frockModel !== undefined
        ? { frockModel: text(entry.frockModel, `${id} frockModel`) }
        : {}),
      ...(entry.follows === true ? { follows: true } : {}),
      ...(entry.needs ? { needs: entry.needs as "vision" | "reasoning" } : {}),
    };
  });
  if (jobs[0]?.id !== "chat") fail("chat must be the first job");
  const oauth = new Set<string>(oauthProviderIdsV1);
  const providersInput = object(data.providers, "providers");
  const providers = Object.fromEntries(
    KINDS.map((kind) => {
      const entries = list(providersInput[kind], `providers.${kind}`).map(
        (item, index): SetupProviderV1 => {
          const entry = object(item, `providers.${kind}[${index}]`);
          const id = text(entry.id, `providers.${kind}[${index}].id`);
          const label = `${kind} provider ${id}`;
          const group = text(entry.group, `${label} group`);
          if (!GROUPS.includes(group)) fail(`${label} group is unknown`);
          if (entry.catalog === true) {
            const catalog = catalogProvidersV1.find(
              (provider) => provider.id === id,
            );
            if (!catalog) fail(`${label} is not in the provider catalog`);
            return {
              id,
              name: catalog.name,
              group,
              status: status(entry.status, `${label} status`),
              ...flags(entry, label),
              connect: oauth.has(id) ? "sign-in" : "key",
              ...(catalog.connectionSettings.length
                ? { needsSettings: true }
                : {}),
              models: catalogModels(id),
            };
          }
          const models =
            entry.models === undefined
              ? undefined
              : list(entry.models, `${label} models`).map((model) => {
                  if (
                    !Array.isArray(model) ||
                    typeof model[0] !== "string" ||
                    typeof model[1] !== "string" ||
                    model.slice(2).some((flag) => typeof flag !== "boolean")
                  )
                    fail(`${label} models are [id, name, vision?, reasoning?]`);
                  return model as [string, string, boolean?, boolean?];
                });
          return {
            id,
            name: text(entry.name, `${label} name`),
            group,
            status: status(entry.status, `${label} status`),
            ...flags(entry, label),
            ...(models ? { models } : {}),
          };
        },
      );
      oneOurs(entries, `providers.${kind}`);
      return [kind, entries];
    }),
  ) as SetupOptionsV1["providers"];
  const options: SetupOptionsV1 = {
    version: 1,
    host: single("host"),
    computer: single("computer"),
    jobs,
    providers,
    search: single("search"),
    apps: single("apps"),
    presets: list(data.presets, "presets").map((item, index) => {
      const entry = object(item, `presets[${index}]`);
      const id = text(entry.id, `presets[${index}].id`);
      const preset = {
        id,
        name: text(entry.name, `${id} name`),
        host: text(entry.host, `${id} host`),
        computer: text(entry.computer, `${id} computer`),
        search: text(entry.search, `${id} search`),
        apps: text(entry.apps, `${id} apps`),
        ...(entry.jobs
          ? {
              jobs: Object.fromEntries(
                Object.entries(object(entry.jobs, `${id} jobs`)).map(
                  ([job, value]) => [
                    job,
                    list(value, `${id} ${job}`).map((part) =>
                      text(part, `${id} ${job}`),
                    ),
                  ],
                ),
              ),
            }
          : {}),
      };
      return preset;
    }),
  };
  defaultSetupChoicesV1(options);
  for (const preset of options.presets) {
    const choices = presetChoicesV1(options, preset);
    for (const key of SINGLE) {
      if (!options[key].some((entry) => entry.id === choices[key]))
        fail(`preset ${preset.id} names an unknown ${key}`);
    }
    for (const [job, choice] of Object.entries(choices.jobs)) {
      if (choice.provider === "same") continue;
      const provider = options.providers[
        options.jobs.find((entry) => entry.id === job)!.kind
      ].find((entry) => entry.id === choice.provider)!;
      if (
        provider.models &&
        !provider.models.some(([id]) => id === choice.model)
      )
        fail(
          `preset ${preset.id} names ${choice.model}, which ${provider.name} does not list`,
        );
    }
  }
  return options;
}

const SOURCE = new URL("../content/setup-options.json", import.meta.url);
const CORE = new URL("../../../core/setup-choices/index.ts", import.meta.url);
const OUT = new URL("../public/setup/", import.meta.url);
const APP_OPTIONS = new URL(
  "../../../app/setup/options.generated.ts",
  import.meta.url,
);
const HEADER =
  "// Generated by apps/marketing/scripts/render-setup.ts. Do not edit.\n";

export async function renderChoicesModule(): Promise<string> {
  const { code } = await transform(await Bun.file(CORE).text(), {
    loader: "ts",
    format: "esm",
    target: "es2022",
  });
  return `${HEADER}// The shared setup format, from core/setup-choices/index.ts.\n${code}`;
}

export function renderOptionsModule(options: SetupOptionsV1): string {
  return `${HEADER}export default ${JSON.stringify(options)};\n`;
}

/** The same options for the app, which reviews a setup carried into it. */
export function renderAppOptionsModule(options: SetupOptionsV1): string {
  return `${HEADER}import type { SetupOptionsV1 } from "@frockbot/core/setup-choices";\n\nexport const SETUP_OPTIONS_V1: SetupOptionsV1 = ${JSON.stringify(options)};\n`;
}

const START = "<!-- setup:start -->";
const END = "<!-- setup:end -->";
export function replaceSetupRegion(html: string, rendered: string): string {
  if (html.split(START).length !== 2 || html.split(END).length !== 2)
    throw new Error(
      "The page must contain exactly one setup:start / setup:end pair",
    );
  const start = html.indexOf(START) + START.length;
  const end = html.indexOf(END);
  if (end < start) throw new Error("Setup markers are in the wrong order");
  const markerLine = html.slice(
    html.lastIndexOf("\n", start - START.length) + 1,
    start - START.length,
  );
  const indent = /^\s*$/.test(markerLine) ? markerLine : "";
  return `${html.slice(0, start)}\n${indent}<!-- prettier-ignore -->\n${indent}${rendered}\n${indent}${html.slice(end)}`;
}

/** The chooser as a visitor without JavaScript sees it: FrockBot's setup. */
export async function renderDefaultSetup(
  options: SetupOptionsV1,
): Promise<string> {
  const view = await import(new URL("view.js", OUT).href);
  const { describeSetup, APP_SETUP_URL } = await import(
    new URL("result.js", OUT).href
  );
  const choices = defaultSetupChoicesV1(options);
  const state = { choices, open: null, query: "" };
  const presets = options.presets.map((preset) => ({
    id: preset.id,
    name: preset.name,
    on: preset.id === options.presets[0]!.id,
  }));
  const result = describeSetup(choices, options);
  return `<div class="setup-app" data-setup><div class="setup-toolbar"><span class="setup-toolbar-label">Start from</span><div class="setup-presets" data-setup-presets>${view.renderPresets(state, options, presets)}</div><p class="setup-saved" data-setup-saved hidden></p><p class="setup-nojs" data-setup-nojs>Turn on JavaScript to change these choices. This is FrockBot’s own setup.</p></div><div class="setup-layout"><div class="setup-questions" data-setup-questions>${view.renderQuestions(state, options)}</div><aside class="setup-result" aria-labelledby="setup-result-title" aria-live="polite" data-setup-result>${view.renderResult(result, [], { primary: APP_SETUP_URL })}</aside></div></div>`;
}

if (import.meta.main) {
  const arguments_ = Bun.argv.slice(2);
  if (arguments_.some((argument) => argument !== "--check"))
    throw new Error("Usage: bun scripts/render-setup.ts [--check]");
  const check = arguments_.includes("--check");
  const options = buildSetupOptions(await Bun.file(SOURCE).json());
  const files: [URL, string][] = [
    [new URL("choices.generated.js", OUT), await renderChoicesModule()],
    [new URL("options.generated.js", OUT), renderOptionsModule(options)],
    [APP_OPTIONS, renderAppOptionsModule(options)],
  ];
  const stale: string[] = [];
  const write = async (url: URL, content: string) => {
    const file = Bun.file(url);
    const before = (await file.exists()) ? await file.text() : "";
    if (before === content) return;
    stale.push(url.pathname.split("/frockbot/").at(-1)!);
    if (!check) await Bun.write(url, content);
  };
  for (const [url, content] of files) await write(url, content);
  const page = new URL("index.html", OUT);
  const html = await Bun.file(page).text();
  await write(
    page,
    replaceSetupRegion(html, await renderDefaultSetup(options)),
  );
  if (check && stale.length) {
    console.error(
      `The setup chooser is stale (${stale.join(", ")}). Run bun scripts/render-setup.ts in apps/marketing.`,
    );
    process.exitCode = 1;
  } else
    console.log(
      check ? "Setup chooser is up to date." : "Rendered the setup chooser.",
    );
}
