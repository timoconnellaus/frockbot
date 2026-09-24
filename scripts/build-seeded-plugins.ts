// Builds the Plugins this deployment seeds, and writes them into the bundle.
//
// A seeded Plugin is untrusted code like any other — an artifact, a content
// hash, a descriptor — but nobody publishes it: it is the deployment's, so it
// is built here, from source in the repository, and travels in the Worker
// bundle rather than in R2. That is the one difference from a Plugin a Bot
// writes, and it is why the catalog can name an artifact at all (ADR 0030
// step 6; the catalog was empty until this script existed).
//
// One directory per Plugin under `app/plugins/seeded/`:
//
//   plugin.json   the descriptor, minus its Skills
//   plugin.ts     the module, written against `@frockbot/applet-sdk/plugin`
//   *.html        the pages its `conversation.panel` views name, stored with
//                 the bridge helper injected exactly as a publish stores one
//   SKILL.md      optional: the Skill it ships, spliced into the descriptor as
//                 `skills[0]` so the authored Markdown stays Markdown, with
//                 optional `references/*.md` loaded on their own by
//                 `skill_load`. A Plugin with nothing to teach the Bot ships
//                 none — the five locked card Plugins draw `send_to_user`
//                 members the Bot is already told about, and a Skill each
//                 would be five entries in every prompt saying what the send
//                 tool already says.
//
// The build is `runPluginBuildV1` — the same four stages an authored Plugin
// goes through, type checker and Miniflare boot included — and its manifest is
// compared with the descriptor by the same `pluginManifestDisagreementV1` the
// publish path uses. Nothing is seeded that would be refused if a Bot had
// written it.
//
// Freshness is proved by `--check`, which `bun run typecheck` runs: the
// generated module carries the digest of its own sources, so a plugin edited
// without a rebuild fails the typecheck rather than shipping the old artifact.
import { existsSync, readdirSync } from "node:fs";
import { format } from "prettier";
import { runPluginBuildV1 } from "../applets/sdk/src/build/plugin.ts";
import { decodePluginDescriptorV1 } from "../core/contracts/plugin-descriptor.ts";
import {
  pluginManifestDisagreementV1,
  pluginPagesFromSourceV1,
} from "../app/plugins/authoring.ts";
import { seededPluginWordsV1 } from "../app/plugins/catalog.ts";
import { skillDirectory } from "./build-applets-assets.ts";

const root = new URL("../", import.meta.url);
const at = (path: string): URL => new URL(path, root);

const SEEDED_DIRECTORY = "app/plugins/seeded/";
const OUTPUT = "app/plugins/seeded/artifacts.generated.ts";
/** The bundler this deployment built its seeded artifacts with. */
const BUNDLER_VERSION_V1 = "applet-build/plugin@1";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function base64(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

const DECODE_HELPER = [
  "const TEXT_V1 = new TextDecoder();",
  "function fromBase64V1(value: string): string {",
  "  return TEXT_V1.decode(",
  "    Uint8Array.from(atob(value), (character) => character.charCodeAt(0)),",
  "  );",
  "}",
].join("\n");

/** The Plugin directories to build, in the order the catalog lists them. */
function seededPluginIds(): string[] {
  return readdirSync(at(SEEDED_DIRECTORY), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .toSorted();
}

interface BuiltSeededPlugin {
  pluginId: string;
  descriptor: Record<string, unknown>;
  module: string;
  contentHash: string;
  size: number;
  /** The digest of the sources this artifact was built from. */
  sourceHash: string;
  pages: { path: string; contentHash: string; size: number; html: string }[];
}

/** The page files a descriptor's views name, in the order they are named. */
function pagePathsV1(descriptor: { views?: unknown }): string[] {
  const views = Array.isArray(descriptor.views) ? descriptor.views : [];
  return [
    ...new Set(
      views.flatMap((view: { page?: unknown }) =>
        typeof view.page === "string" ? [view.page] : [],
      ),
    ),
  ];
}

async function loadSeededSkillV1(
  directory: URL,
): Promise<
  { text: string; references?: { path: string; text: string }[] } | undefined
> {
  if (existsSync(new URL("SKILL.md", directory))) {
    const loaded = await skillDirectory(directory);
    return loaded.references.length > 0
      ? { text: loaded.text, references: loaded.references }
      : { text: loaded.text };
  }
  const legacy = Bun.file(new URL("skill.md", directory));
  if (await legacy.exists()) {
    return { text: await legacy.text() };
  }
  return undefined;
}

async function buildSeededPlugin(pluginId: string): Promise<BuiltSeededPlugin> {
  // Asked before the build rather than after it: a Plugin the catalog has no
  // words for would otherwise be an artifact nothing can describe, and the
  // catalog is read at module load by every Composition read.
  seededPluginWordsV1(pluginId);
  const directory = at(`${SEEDED_DIRECTORY}${pluginId}/`);
  const [descriptorText, moduleText, skill] = await Promise.all([
    Bun.file(new URL("plugin.json", directory)).text(),
    Bun.file(new URL("plugin.ts", directory)).text(),
    loadSeededSkillV1(directory),
  ]);
  const declared = JSON.parse(descriptorText) as Record<string, unknown>;
  // The Skill is authored as Markdown and lives in the descriptor: a Plugin
  // that ships a card ships the Skill that says when to use it (ADR 0030) —
  // when there is anything to say the card's own tool does not.
  const descriptor = decodePluginDescriptorV1(
    {
      ...declared,
      ...(skill === undefined
        ? {}
        : {
            skills: [
              {
                slug: pluginId,
                text: skill.text,
                ...(skill.references ? { references: skill.references } : {}),
              },
            ],
          }),
    },
    `seeded plugin "${pluginId}" descriptor`,
  );
  const outcome = await runPluginBuildV1(directory.pathname, {
    mode: "build",
    id: pluginId,
  });
  if (outcome.status !== "built") {
    const diagnostics =
      outcome.status === "failed"
        ? outcome.diagnostics
            .map(
              (diagnostic) =>
                `${diagnostic.file}:${diagnostic.line}:${diagnostic.column} ${diagnostic.message}`,
            )
            .join("\n")
        : "the build produced no module";
    throw new Error(
      `seeded plugin "${pluginId}" failed at ${
        outcome.status === "failed" ? outcome.stage : "build"
      }:\n${diagnostics}`,
    );
  }
  const disagreement = pluginManifestDisagreementV1(
    descriptor,
    outcome.manifest,
  );
  if (disagreement) {
    throw new Error(`seeded plugin "${pluginId}": ${disagreement}`);
  }
  const pages = await pluginPagesFromSourceV1(
    descriptor,
    await Promise.all(
      pagePathsV1(descriptor).map(async (path) => ({
        path,
        text: await Bun.file(new URL(path, directory)).text(),
      })),
    ),
  );
  if ("failure" in pages) {
    throw new Error(`seeded plugin "${pluginId}": ${pages.failure}`);
  }
  const contentHash = await sha256Hex(outcome.module);
  if (contentHash !== outcome.manifest.hashes.module) {
    throw new Error(
      `seeded plugin "${pluginId}" hashed differently than its manifest says`,
    );
  }
  return {
    pluginId,
    descriptor: descriptor as unknown as Record<string, unknown>,
    module: outcome.module,
    contentHash,
    size: new TextEncoder().encode(outcome.module).byteLength,
    sourceHash: await sourceHashV1(pluginId),
    pages: pages.pages.map(({ artifact, html }) => ({ ...artifact, html })),
  };
}

async function artifactsModule(): Promise<string> {
  const built = await Promise.all(seededPluginIds().map(buildSeededPlugin));
  const entries = built
    .map((plugin) =>
      [
        "  {",
        `    pluginId: ${JSON.stringify(plugin.pluginId)},`,
        `    contentHash: ${JSON.stringify(plugin.contentHash)},`,
        `    size: ${plugin.size},`,
        `    bundlerVersion: ${JSON.stringify(BUNDLER_VERSION_V1)},`,
        `    sourceHash: ${JSON.stringify(plugin.sourceHash)},`,
        `    descriptor: ${JSON.stringify(plugin.descriptor)},`,
        `    module: fromBase64V1(${JSON.stringify(base64(plugin.module))}),`,
        ...(plugin.pages.length === 0
          ? []
          : [
              "    pages: [",
              ...plugin.pages.map(
                (page) =>
                  `      { path: ${JSON.stringify(page.path)}, contentHash: ${JSON.stringify(page.contentHash)}, size: ${page.size}, html: fromBase64V1(${JSON.stringify(base64(page.html))}) },`,
              ),
              "    ],",
            ]),
        "  },",
      ].join("\n"),
    )
    .join("\n");
  return await format(
    [
      "// Generated by scripts/build-seeded-plugins.ts. Do not edit.",
      "//",
      "// The Plugins this deployment seeds, built from `app/plugins/seeded/`.",
      "// The module text travels in the bundle because a seeded artifact has",
      "// no publisher to put it in R2; `sourceHash` is what `--check` compares,",
      "// so an edited Plugin that was not rebuilt fails the typecheck.",
      "",
      "import type { PluginDescriptorV1 } from '@frockbot/core/contracts';",
      "",
      DECODE_HELPER,
      "",
      "export interface SeededPluginArtifactV1 {",
      "  pluginId: string;",
      "  contentHash: string;",
      "  size: number;",
      "  bundlerVersion: string;",
      "  sourceHash: string;",
      "  descriptor: PluginDescriptorV1;",
      "  /** The built module, exactly as the worker loads it. */",
      "  module: string;",
      "  /** Its pages, bridge injected, exactly as the page route serves them. */",
      "  pages?: readonly {",
      "    path: string;",
      "    contentHash: string;",
      "    size: number;",
      "    html: string;",
      "  }[];",
      "}",
      "",
      "export const SEEDED_PLUGIN_ARTIFACTS_V1: readonly SeededPluginArtifactV1[] =",
      "  [",
      entries,
      "  ];",
      "",
    ].join("\n"),
    { parser: "typescript" },
  );
}

/**
 * The digest of one Plugin's sources, without building it.
 *
 * `--check` runs inside `bun run typecheck`, which is a thing people run all
 * day; a type checker and a Miniflare boot per Plugin is not. So the gate
 * compares the sources against the digest the generated module carries, which
 * catches the mistake it exists to catch — a Plugin edited and not rebuilt —
 * and leaves the artifact itself to the build.
 */
async function sourceHashV1(pluginId: string): Promise<string> {
  const directory = at(`${SEEDED_DIRECTORY}${pluginId}/`);
  const files = ["plugin.json", "plugin.ts", "SKILL.md", "skill.md"];
  files.push(
    ...pagePathsV1(
      JSON.parse(await Bun.file(new URL("plugin.json", directory)).text()),
    ),
  );
  const referencesDirectory = new URL("references/", directory);
  if (existsSync(referencesDirectory)) {
    files.push(
      ...readdirSync(referencesDirectory)
        .filter((name) => name.endsWith(".md"))
        .sort()
        .map((name) => `references/${name}`),
    );
  }
  // `Bun.file().exists()` follows the volume's case folding, so on macOS
  // `skill.md` is `SKILL.md` and the skill is hashed twice.
  const present = new Set(readdirSync(directory));
  const sources = await Promise.all(
    files.map(async (file) => {
      const name = file.split("/").at(-1)!;
      const folder = file.includes("/")
        ? new URL(`${file.slice(0, file.lastIndexOf("/"))}/`, directory)
        : directory;
      const names =
        folder === directory ? present : new Set(readdirSync(folder));
      if (!names.has(name)) return "";
      return Bun.file(new URL(file, directory)).text();
    }),
  );
  return sha256Hex(sources.join("\0"));
}

if (import.meta.main) {
  if (process.argv.includes("--check")) {
    const { SEEDED_PLUGIN_ARTIFACTS_V1 } = (await import(
      at(OUTPUT).pathname
    )) as typeof import("../app/plugins/seeded/artifacts.generated.ts");
    const ids = seededPluginIds();
    const generated = SEEDED_PLUGIN_ARTIFACTS_V1.map(
      (artifact) => artifact.pluginId,
    );
    const stale =
      ids.join(",") !== generated.join(",") ||
      (
        await Promise.all(
          SEEDED_PLUGIN_ARTIFACTS_V1.map(
            async (artifact) =>
              (await sourceHashV1(artifact.pluginId)) === artifact.sourceHash,
          ),
        )
      ).includes(false);
    if (stale) {
      console.error(
        `${OUTPUT} is stale; run \`bun scripts/build-seeded-plugins.ts\`.`,
      );
      process.exit(1);
    }
    console.log("Seeded Plugin artifacts are fresh.");
  } else {
    await Bun.write(at(OUTPUT), await artifactsModule());
    console.log("Built the seeded Plugin artifacts.");
  }
}
