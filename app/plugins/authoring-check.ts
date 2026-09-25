import type { PluginBuildSourceFileV1 } from "@frockbot/applets/build-contract";
import {
  pluginNetworkAdmitsHostV1,
  type PluginDescriptorV1,
} from "@frockbot/core/contracts";

// The advisory check a Bot-written Plugin gets before the User is asked to
// run it. Code reads facts off the source and lints what the SDK documents;
// a judge, when there is one, says whether it does what was asked and which
// of its parts that gives no reason for. Nothing here blocks a publish: what
// it finds goes on the approval card and back to the Bot. Only the User grants.

/** One thing the Plugin asks to hold or do, as the User would name it. */
export interface PluginPartV1 {
  readonly kind: "tool" | "hook" | "grant" | "host" | "network" | "device";
  readonly label: string;
}

/** What a judge is shown about one Plugin. */
export interface PluginFitEvidenceV1 {
  /** What the person said this Turn, oldest first. */
  readonly request: string;
  /** What the Bot says the Plugin is for. */
  readonly purpose: string;
  readonly displayName: string;
  readonly parts: readonly PluginPartV1[];
  /** The Plugin's own code, `plugin.ts` first, bounded. */
  readonly code: string;
}

export interface PluginFitVerdictV1 {
  /** Whether it does what was asked, by the judge's reading. */
  readonly fits: "likely" | "unclear" | "unlikely";
  /** Parts the judge found no reason for in what was asked. */
  readonly unneeded: readonly PluginPartV1[];
  readonly model?: string;
}

/** Answers `undefined` when no judge could be asked. */
export interface PluginFitJudgeV1 {
  judge(
    evidence: PluginFitEvidenceV1,
    signal?: AbortSignal,
  ): Promise<PluginFitVerdictV1 | undefined>;
}

export interface PluginAuthoringCheckV1 {
  /** Lint findings, each one sentence the Bot can act on. */
  readonly findings: readonly string[];
  readonly fit?: PluginFitVerdictV1;
}

/** The most parts a judge is asked about, in the order the card lists them. */
export const PLUGIN_FIT_PARTS_MAX_V1 = 16;

/** How much of the Plugin's code a judge is shown. */
export const PLUGIN_FIT_CODE_CHARS_V1 = 12_000;

const HOOK_LABELS_V1: Readonly<Record<string, string>> = {
  "system-prompt/assemble": "changes the Bot's instructions",
  "agent/tool-exposure": "changes which tools the Bot is offered",
  "tools/pre-execute":
    "sees and can change the Bot's tool calls before they run",
  "tools/post-execute": "sees and can change what the Bot's tools return",
  "agent/turn-stopping": "decides whether a Turn stops",
  "agent/request": "sees and can change each model request",
  "theme/assemble": "changes the Bot's look",
};

/** Everything the Plugin asks to hold or do, as the approval card names it. */
export function pluginPartsV1(descriptor: PluginDescriptorV1): PluginPartV1[] {
  const parts: PluginPartV1[] = [
    ...descriptor.tools.map((tool) => ({
      kind: "tool" as const,
      label: `tool ${tool.name}: ${tool.description}`,
    })),
    ...descriptor.hooks.map((hook) => ({
      kind: "hook" as const,
      label: `hook ${hook}: ${HOOK_LABELS_V1[hook] ?? hook}`,
    })),
    ...descriptor.grants
      .filter((grant) => grant !== "http" && grant !== "device")
      .map((grant) => ({ kind: "grant" as const, label: `grant ${grant}` })),
  ];
  const network = descriptor.network;
  if (network && "open" in network) {
    parts.push({ kind: "network", label: "open network access" });
  } else if (network) {
    parts.push(
      ...network.hosts.map((host) => ({
        kind: "host" as const,
        label: `network host ${host}`,
      })),
    );
  }
  for (const ability of descriptor.device?.abilities ?? []) {
    parts.push({ kind: "device", label: `device ${ability}` });
  }
  for (const module of descriptor.device?.modules ?? []) {
    const reach = [
      module.read.length > 0 ? `reads ${module.read.join(", ")}` : "",
      module.appleEvents.length > 0
        ? `scripts ${module.appleEvents.join(", ")}`
        : "",
    ].filter(Boolean);
    parts.push({
      kind: "device",
      label: `device module ${module.id}${reach.length > 0 ? `: ${reach.join("; ")}` : ""}`,
    });
  }
  return parts.slice(0, PLUGIN_FIT_PARTS_MAX_V1);
}

/** The code a judge reads: `plugin.ts`, then the rest, bounded. */
export function pluginFitCodeV1(
  files: readonly PluginBuildSourceFileV1[],
): string {
  const ordered = [
    ...files.filter((file) => file.path === "plugin.ts"),
    ...files.filter(
      (file) => file.path !== "plugin.ts" && file.path !== "plugin.json",
    ),
  ];
  const code = ordered
    .map((file) => `// ${file.path}\n${file.text}`)
    .join("\n\n");
  return code.length <= PLUGIN_FIT_CODE_CHARS_V1
    ? code
    : `${code.slice(0, PLUGIN_FIT_CODE_CHARS_V1)}…`;
}

function pagePaths(descriptor: PluginDescriptorV1): Set<string> {
  return new Set(
    (descriptor.views ?? []).flatMap((view) =>
      view.page === undefined ? [] : [view.page],
    ),
  );
}

/** The CSS a page carries: its `<style>` blocks and `style` attributes. */
function pageCss(html: string): string[] {
  const blocks = [...html.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)].map(
    (match) => match[1] ?? "",
  );
  const attributes = [...html.matchAll(/\sstyle\s*=\s*"([^"]*)"/gi)].map(
    (match) => match[1] ?? "",
  );
  return [...blocks, ...attributes];
}

/** CSS with each `var(…)` removed, however deeply its fallback nests. */
function withoutVars(css: string): string {
  let out = "";
  let index = 0;
  for (;;) {
    const start = css.indexOf("var(", index);
    if (start < 0) return out + css.slice(index);
    out += css.slice(index, start);
    let depth = 0;
    let end = start + 3;
    for (; end < css.length; end++) {
      if (css[end] === "(") depth++;
      else if (css[end] === ")" && --depth === 0) break;
    }
    index = end + 1;
  }
}

/** Colours written out rather than read from the theme's variables. */
function literalColours(chunks: readonly string[]): string[] {
  // A fallback inside `var(--frockbot-…, #fff)` is still the theme's, and a
  // `#name` outside a declaration's value is a selector.
  const values = chunks.flatMap((chunk) =>
    [...withoutVars(chunk).matchAll(/:([^;{}]*)(?=[;}]|$)/g)].map(
      (match) => match[1] ?? "",
    ),
  );
  return [
    ...new Set(
      values.flatMap(
        (value) =>
          value.match(/#[0-9a-fA-F]{3,8}\b|\b(?:rgba?|hsla?)\([^)]*\)/g) ?? [],
      ),
    ),
  ];
}

const REMOTE_PAGE_LOAD =
  /(?:\s(?:src|href)\s*=\s*["']https?:\/\/|url\(\s*["']?https?:\/\/|\bfetch\s*\(|new\s+WebSocket\s*\()/i;

/** The hosts code names in `https://host` literals. */
function literalHosts(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/["'`]https?:\/\/([a-z0-9.-]+)/gi)].map((match) =>
        (match[1] ?? "").toLowerCase(),
      ),
    ),
  ];
}

/**
 * What code can say about a Plugin's source without running it: a page that
 * ignores the theme or reaches for the network it cannot have, and cloud
 * code naming a host `plugin.json` does not declare.
 */
export function lintPluginSourceV1(
  descriptor: PluginDescriptorV1,
  files: readonly PluginBuildSourceFileV1[],
): string[] {
  const findings: string[] = [];
  const pages = pagePaths(descriptor);
  for (const file of files) {
    if (!pages.has(file.path)) continue;
    const colours = literalColours(pageCss(file.text));
    if (colours.length > 0) {
      findings.push(
        `The page ${file.path} sets colours directly (${colours.slice(0, 3).join(", ")}); style it with the --frockbot-* theme variables so it follows the Bot's look in light and dark.`,
      );
    }
    if (REMOTE_PAGE_LOAD.test(file.text)) {
      findings.push(
        `The page ${file.path} loads from the network, which the page's frame blocks; inline it, or call one of the Plugin's own tools with frockbot.callTool.`,
      );
    }
  }
  const network = descriptor.network ?? { hosts: [] };
  const undeclared = new Set<string>();
  for (const file of files) {
    if (pages.has(file.path) || !/\.(?:ts|js|mjs)$/.test(file.path)) continue;
    if (file.path.startsWith("modules/")) continue;
    for (const host of literalHosts(file.text)) {
      if (!pluginNetworkAdmitsHostV1(network, host)) undeclared.add(host);
    }
  }
  if (undeclared.size > 0) {
    findings.push(
      `The code reaches ${[...undeclared].join(", ")}, which plugin.json does not declare, so those calls will be refused; add ${undeclared.size === 1 ? "it" : "them"} to network.hosts with the http grant.`,
    );
  }
  return findings;
}

/**
 * The check a publish runs. A judge that cannot be asked leaves the lint
 * standing on its own.
 */
export async function checkPluginAuthoringV1(input: {
  readonly descriptor: PluginDescriptorV1;
  readonly files: readonly PluginBuildSourceFileV1[];
  readonly request: string;
  readonly purpose: string;
  readonly judge?: PluginFitJudgeV1;
  readonly signal?: AbortSignal;
}): Promise<PluginAuthoringCheckV1> {
  const findings = lintPluginSourceV1(input.descriptor, input.files);
  const fit = await input.judge?.judge(
    {
      request: input.request,
      purpose: input.purpose,
      displayName: input.descriptor.displayName,
      parts: pluginPartsV1(input.descriptor),
      code: pluginFitCodeV1(input.files),
    },
    input.signal,
  );
  return { findings, ...(fit ? { fit } : {}) };
}

/** The check as the approval card's rationale ends, or `undefined` if clean. */
export function pluginCheckRationaleV1(
  check: PluginAuthoringCheckV1,
): string | undefined {
  const lines: string[] = [];
  if (check.fit?.fits === "unlikely") {
    lines.push("- It may not do what you asked for.");
  } else if (check.fit?.fits === "unclear") {
    lines.push("- It is unclear whether it does what you asked for.");
  }
  if (check.fit && check.fit.unneeded.length > 0) {
    lines.push(
      `- What you asked for gives no reason for: ${check.fit.unneeded.map((part) => part.label.split(":")[0]).join("; ")}.`,
    );
  }
  lines.push(...check.findings.map((finding) => `- ${finding}`));
  if (lines.length === 0) return undefined;
  return ["**Before you approve**", ...lines].join("\n");
}
