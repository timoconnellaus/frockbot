// The Connected apps list, generated from the provider's public app data.
//
// `app/connect/catalog.ts` is the list a person connects from; this writes
// the part of it no one should type by hand — every app the hosted sign-in
// can reach, with how it signs in — to `app/connect/apps.generated.ts`.
// Featured apps keep their own words in `catalog.ts`; this file only says
// which apps exist and how each one connects.
//
// An app is in when the provider's hosted page can finish its sign-in with
// nothing of ours: an OAuth app the provider runs, dynamic client
// registration, a key, token or password the person types on that page, or
// no sign-in at all. An app that needs an OAuth app or a developer credential
// of our own is left out, and so are AI model providers — models are chosen
// in Models, not connected as apps.
//
// Run with no arguments to fetch the provider's data, or `--source <file>`
// to read a saved copy. Nothing fetches this at build time.
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { format } from "prettier";

const root = resolve(import.meta.dirname, "..");
const outputPath = resolve(root, "app/connect/apps.generated.ts");
const SOURCE_URL = "https://docs.composio.dev/data/toolkits.json";

/** How an app signs in, in the order a scheme is preferred when it has several. */
const KEY_SCHEMES = ["API_KEY", "BEARER_TOKEN", "BASIC"] as const;

/** Model providers, wherever the provider files them. */
const AI_PROVIDER_CATEGORIES = new Set(["ai models"]);
const AI_PROVIDERS = new Set([
  "ai_ml_api",
  "aivoov",
  "apiframe",
  "assemblyai",
  "camb_ai",
  "deepgram",
  "dreamstudio",
  "eden_ai",
  "elevenlabs",
  "fal_ai",
  "fireworks_ai",
  "fish_audio",
  "gan_ai",
  "gemini",
  "gladia",
  "gradium",
  "grok",
  "heygen",
  "hugging_face",
  "imagerouter",
  "inworld_ai",
  "jigsawstack",
  "kieai",
  "lmnt",
  "luma_labs",
  "metatextai",
  "mistral_ai",
  "muapi",
  "openai",
  "openrouter",
  "perplexityai",
  "replicate",
  "rev",
  "rev_ai",
  "runway",
  "speechmatics",
  "textcortex",
  "typecast",
  "v0",
  "veo",
  "writer",
]);
/**
 * Not apps a person connects: every Google app in one (each is already its
 * own row), the provider's own tools, and a name the product already uses
 * for something else.
 */
const EXCLUDED = new Set(["googlesuper", "browser_tool", "jev"]);

interface Field {
  required?: unknown[];
}
interface SourceApp {
  slug: string;
  name: string;
  description?: string;
  category?: string;
  authSchemes?: string[] | null;
  composioManagedAuthSchemes?: string[] | null;
  toolCount?: number;
  authConfigDetails?: {
    mode: string;
    fields: { auth_config_creation: Field };
  }[];
}

type Auth = "managed" | "DCR_OAUTH" | "NO_AUTH" | (typeof KEY_SCHEMES)[number];

function authOf(app: SourceApp): Auth | undefined {
  const schemes = app.authSchemes ?? [];
  const managed = app.composioManagedAuthSchemes ?? [];
  if (managed.includes("OAUTH2") || managed.includes("OAUTH1")) {
    return "managed";
  }
  // A scheme whose auth config needs a value of ours at creation — a client
  // id, a developer key — cannot be offered from a shared deployment.
  const needsNothing = (mode: string) => {
    const detail = app.authConfigDetails?.find((entry) => entry.mode === mode);
    return (
      detail !== undefined &&
      (detail.fields.auth_config_creation.required ?? []).length === 0
    );
  };
  if (schemes.includes("DCR_OAUTH") && needsNothing("DCR_OAUTH")) {
    return "DCR_OAUTH";
  }
  if (schemes.includes("NO_AUTH")) return "NO_AUTH";
  return KEY_SCHEMES.find(
    (scheme) => schemes.includes(scheme) && needsNothing(scheme),
  );
}

/** The provider's blurb as one sentence a Connectors row can carry. */
function describe(app: SourceApp): string {
  const text = (app.description ?? "").replace(/\s+/g, " ").trim();
  const first = text.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? text;
  let sentence = first.replace(/[.!?]+$/, "").trim();
  if (sentence.length > 180) {
    sentence = `${sentence.slice(0, 177).replace(/\s+\S*$/, "")}…`;
    return sentence;
  }
  if (!sentence) sentence = `Connect ${app.name}`;
  return `${sentence}.`;
}

function mentionsProvider(app: SourceApp): boolean {
  return /composio/i.test(`${app.slug} ${app.name} ${app.description ?? ""}`);
}

async function source(): Promise<SourceApp[]> {
  const flag = process.argv.indexOf("--source");
  if (flag !== -1) {
    return JSON.parse(readFileSync(process.argv[flag + 1]!, "utf8"));
  }
  const response = await fetch(SOURCE_URL);
  if (!response.ok) throw new Error(`${SOURCE_URL}: ${response.status}`);
  return (await response.json()) as SourceApp[];
}

const apps = (await source())
  .flatMap((app) => {
    if (!/^[a-z][a-z0-9_]{0,48}$/.test(app.slug)) return [];
    if (!app.toolCount) return [];
    if (AI_PROVIDERS.has(app.slug)) return [];
    if (AI_PROVIDER_CATEGORIES.has(app.category ?? "")) return [];
    if (EXCLUDED.has(app.slug) || mentionsProvider(app)) return [];
    const auth = authOf(app);
    if (!auth) return [];
    const name = app.name.trim();
    return [{ slug: app.slug, name, description: describe(app), auth }];
  })
  .toSorted(
    (left, right) =>
      left.name.localeCompare(right.name, "en", { sensitivity: "base" }) ||
      left.slug.localeCompare(right.slug),
  );

// Two apps the provider names alike are told apart by their slug, so a
// Connectors row and an account's default label never collide.
const seen = new Map<string, number>();
for (const app of apps) {
  const key = app.name.toLowerCase();
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
for (const app of apps) {
  if ((seen.get(app.name.toLowerCase()) ?? 0) > 1) {
    app.name = `${app.name} (${app.slug})`;
  }
}

const rows = apps.map((app) =>
  JSON.stringify([app.slug, app.name, app.description, app.auth]),
);
const body = `// Generated by scripts/generate-connect-catalog.ts. Do not edit by hand.
// [slug, name, description, how it signs in]
import type { ConnectGeneratedAppV1 } from "./catalog.js";

export const CONNECT_GENERATED_APPS_V1: readonly ConnectGeneratedAppV1[] = [
${rows.join(",\n")}
];
`;
writeFileSync(outputPath, await format(body, { filepath: outputPath }), "utf8");
const counts = new Map<string, number>();
for (const app of apps) counts.set(app.auth, (counts.get(app.auth) ?? 0) + 1);
console.log(
  `wrote ${apps.length} apps to ${outputPath}: ${[...counts]
    .map(([auth, count]) => `${count} ${auth}`)
    .join(", ")}`,
);
