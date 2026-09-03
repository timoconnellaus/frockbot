// The Package Authoring DTOs.
//
// Modelled on the DeepSeek Harness `cordis_define` / `cordis_run` split
// (`docs/research/deepseek-harness-extension.md` §2): authoring *defines* a
// Package — it mints its identity, records its source, and produces an
// immutable artifact and a pending Composition generation. Activation is a
// separate event, at the next admitted Turn. A model never overwrites a
// version; re-authoring the same `packageId` appends the next one.
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  isBotIsolateHookEventNameV1,
  iframePageSlotAllowedV1,
  PACKAGE_BUNDLE_MAX_SOURCE_BYTES,
  PACKAGE_IFRAME_ENTRY_LABEL_MAX_V1,
  PACKAGE_IFRAME_ENTRY_SLOT_V1,
  PACKAGE_IFRAME_ID_V1,
  PACKAGE_IFRAME_MAX_ENTRIES_V1,
  PACKAGE_IFRAME_MAX_PAGES_V1,
  type BotIsolateHookEventNameV1,
} from "@frockbot/kernel-contracts";

/** The `package_author` tool input. */
export interface AuthorPackageInputV1 {
  /** Stable Plugin identity; re-authoring appends a version. */
  packageId: string;
  displayName: string;
  /** Every tool the immutable Package artifact is expected to export. */
  tools: Array<{ name: string; description: string; inputSchema: unknown }>;
  /** Waterfall events the immutable artifact is expected to hook. */
  hooks?: BotIsolateHookEventNameV1[];
  /** TypeScript text; exactly one `package.ts`. */
  source: string;
  /** Optional sandboxed pages. All CSS and JavaScript must be inline. */
  ui?: {
    pages: Array<{
      id: string;
      html: string;
      mounts: Array<{ slot: string; order?: number }>;
    }>;
    entries?: Array<{
      id: string;
      slot: "frockbot.sidebar-actions";
      order?: number;
      label: string;
      icon: string;
      opens: { kind: "surface"; page: string };
    }>;
  };
}

export type AuthorPackageOutcomeV1 =
  | {
      status: "authored";
      packageId: string;
      version: string;
      contentHash: string;
      generationId: string;
      /** True when a prior version of this Package was superseded. */
      supersededVersion?: string;
    }
  | {
      status: "refused";
      reason: string;
      /** The durable failure record the User can inspect. */
      failureId: string;
    };

export interface PackageUndoInputV1 {
  /** Absent means the generation before the most recent authored change. */
  generationId?: string;
}

export type PackageUndoOutcomeV1 =
  | {
      status: "recorded";
      effectId: string;
      generationId: string;
      targetGenerationId: string;
    }
  | { status: "refused"; reason: string; failureId: string };

export interface PackageInspectMemberV1 {
  packageId: string;
  version: string;
  provenance: Record<string, unknown>;
  declaredTools: string[];
  source?: string;
}

export interface PackageInspectFailureV1 {
  packageId: string;
  authoring?: {
    failureId: string;
    phase: string;
    reason: string;
    diagnostics: string[];
    recordedAt: string;
  };
  activation?: {
    generationId: string;
    attempt: number;
    phase: string;
    message: string;
    diagnostics: string[];
    at: string;
    quarantined: boolean;
  };
}

export interface PackageInspectSelfOutcomeV1 {
  contextContract: string;
  composition: {
    generationId: string;
    status: string;
    members: PackageInspectMemberV1[];
  };
  failures: PackageInspectFailureV1[];
}

export const AUTHORED_PACKAGE_ID = /^[a-z][a-z0-9-]{2,63}$/;
export const AUTHORED_TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
export const AUTHORED_TOOLS_MAX = 64;
/**
 * The shape of an authored id, not its authority: a Bot may not shadow a
 * first-party or User Package, and that rule is enforced against the Bot's
 * current Composition by the authoring host, which knows each member's
 * provenance.
 */
export const AUTHORED_PACKAGE_ID_MAX_LENGTH = 64;

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[],
  label: string,
): void {
  const allowed = new Set<string>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(value: unknown, label: string, maximum: number): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function requireJsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 16) throw new Error(`${label} is too deeply nested`);
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value))
  ) {
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 256) throw new Error(`${label} has too many entries`);
    for (const entry of value) requireJsonValue(entry, label, depth + 1);
    return;
  }
  const source = record(value, label);
  const entries = Object.entries(source);
  if (entries.length > 256) throw new Error(`${label} has too many fields`);
  for (const [, entry] of entries) requireJsonValue(entry, label, depth + 1);
}

/** The exact v1 decoder for the `package_author` tool input. */
export function decodeAuthorPackageInputV1(
  input: unknown,
  label = "package_author input",
): AuthorPackageInputV1 {
  const value = record(input, label);
  // `tool` is accepted for one compatibility release, but the decoded shape
  // is always the plural declaration the manifest and mount path enforce.
  exactKeys(
    value,
    ["packageId", "displayName", "source"],
    ["tools", "tool", "hooks", "ui"],
    label,
  );
  if (
    (value.tools === undefined && value.tool === undefined) ||
    (value.tools !== undefined && value.tool !== undefined)
  ) {
    throw new Error(`${label} must declare exactly one of tools or tool`);
  }
  const packageId = boundedString(
    value.packageId,
    `${label}.packageId`,
    AUTHORED_PACKAGE_ID_MAX_LENGTH,
  );
  if (!AUTHORED_PACKAGE_ID.test(packageId)) {
    throw new Error(`${label}.packageId is invalid`);
  }
  const displayName = boundedString(
    value.displayName,
    `${label}.displayName`,
    128,
  );
  const declaredTools = value.tools === undefined ? [value.tool] : value.tools;
  if (
    !Array.isArray(declaredTools) ||
    declaredTools.length === 0 ||
    declaredTools.length > AUTHORED_TOOLS_MAX
  ) {
    throw new Error(`${label}.tools must be a non-empty bounded array`);
  }
  const tools = declaredTools.map((candidate, index) => {
    const toolLabel = `${label}.tools[${index}]`;
    const tool = record(candidate, toolLabel);
    exactKeys(tool, ["name", "description", "inputSchema"], [], toolLabel);
    const name = boundedString(tool.name, `${toolLabel}.name`, 64);
    if (!AUTHORED_TOOL_NAME.test(name)) {
      throw new Error(`${toolLabel}.name is invalid`);
    }
    const description = boundedString(
      tool.description,
      `${toolLabel}.description`,
      1_024,
    );
    const inputSchema = record(tool.inputSchema, `${toolLabel}.inputSchema`);
    requireJsonValue(inputSchema, `${toolLabel}.inputSchema`);
    return { name, description, inputSchema };
  });
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error(`${label}.tools contains duplicate names`);
  }
  let hooks: BotIsolateHookEventNameV1[] | undefined;
  if (value.hooks !== undefined) {
    if (
      !Array.isArray(value.hooks) ||
      value.hooks.length === 0 ||
      value.hooks.length > BOT_ISOLATE_HOOK_EVENTS_V1.length
    ) {
      throw new Error(`${label}.hooks must be a non-empty bounded array`);
    }
    hooks = value.hooks.map((hook, index) => {
      if (!isBotIsolateHookEventNameV1(hook)) {
        throw new Error(`${label}.hooks[${index}] is invalid`);
      }
      return hook;
    });
    if (new Set(hooks).size !== hooks.length) {
      throw new Error(`${label}.hooks contains duplicate events`);
    }
  }
  const source = boundedString(
    value.source,
    `${label}.source`,
    PACKAGE_BUNDLE_MAX_SOURCE_BYTES,
  );
  if (
    new TextEncoder().encode(source).byteLength >
    PACKAGE_BUNDLE_MAX_SOURCE_BYTES
  ) {
    throw new Error(`${label}.source exceeds the per-Package source quota`);
  }
  let ui: AuthorPackageInputV1["ui"];
  if (value.ui !== undefined) {
    const rawUi = record(value.ui, `${label}.ui`);
    exactKeys(rawUi, ["pages"], ["entries"], `${label}.ui`);
    if (
      !Array.isArray(rawUi.pages) ||
      rawUi.pages.length === 0 ||
      rawUi.pages.length > PACKAGE_IFRAME_MAX_PAGES_V1
    ) {
      throw new Error(`${label}.ui.pages must be a non-empty bounded array`);
    }
    const pageIds = rawUi.pages.map((candidate, index) => {
      const page = record(candidate, `${label}.ui.pages[${index}]`);
      const id = boundedString(page.id, `${label}.ui.pages[${index}].id`, 32);
      if (!PACKAGE_IFRAME_ID_V1.test(id)) {
        throw new Error(`${label}.ui.pages[${index}].id is invalid`);
      }
      return id;
    });
    if (new Set(pageIds).size !== pageIds.length) {
      throw new Error(`${label}.ui.pages contains duplicate ids`);
    }
    const declaredTools = tools.map((tool) => tool.name);
    const pages = rawUi.pages.map((candidate, index) => {
      const pageLabel = `${label}.ui.pages[${index}]`;
      const page = record(candidate, pageLabel);
      exactKeys(page, ["id", "html", "mounts"], [], pageLabel);
      const html = boundedString(
        page.html,
        `${pageLabel}.html`,
        PACKAGE_BUNDLE_MAX_SOURCE_BYTES,
      );
      if (
        new TextEncoder().encode(html).byteLength >
        PACKAGE_BUNDLE_MAX_SOURCE_BYTES
      ) {
        throw new Error(
          `${pageLabel}.html exceeds the per-Package source quota`,
        );
      }
      if (
        /<(?:script|iframe|img|audio|video|source|embed|input)\b[^>]*\bsrc\s*=\s*["'](?!data:)/i.test(
          html,
        ) ||
        /<object\b[^>]*\bdata\s*=\s*["'](?!data:)/i.test(html) ||
        /\bsrcset\s*=/i.test(html) ||
        /<link\b/i.test(html) ||
        /@import\b/i.test(html) ||
        /<meta\b[^>]*http-equiv\s*=\s*["']?refresh/i.test(html) ||
        /url\(\s*["']?(?!data:|["']?\s*\))/i.test(html)
      ) {
        throw new Error(`${pageLabel}.html may contain inline resources only`);
      }
      if (
        !Array.isArray(page.mounts) ||
        page.mounts.length === 0 ||
        page.mounts.length > 64
      ) {
        throw new Error(
          `${pageLabel}.mounts must be a non-empty bounded array`,
        );
      }
      const mounts = page.mounts.map((candidateMount, mountIndex) => {
        const mount = record(
          candidateMount,
          `${pageLabel}.mounts[${mountIndex}]`,
        );
        exactKeys(
          mount,
          ["slot"],
          ["order"],
          `${pageLabel}.mounts[${mountIndex}]`,
        );
        const slot = boundedString(
          mount.slot,
          `${pageLabel}.mounts[${mountIndex}].slot`,
          160,
        );
        if (!iframePageSlotAllowedV1(slot, { declaredTools, pageIds })) {
          throw new Error(
            `${pageLabel}.mounts[${mountIndex}].slot is not iframe-safe`,
          );
        }
        const order = mount.order;
        if (
          order !== undefined &&
          (typeof order !== "number" || !Number.isFinite(order))
        ) {
          throw new Error(
            `${pageLabel}.mounts[${mountIndex}].order must be finite`,
          );
        }
        return { slot, ...(order === undefined ? {} : { order }) };
      });
      return { id: pageIds[index]!, html, mounts };
    });
    let entries: NonNullable<AuthorPackageInputV1["ui"]>["entries"];
    if (rawUi.entries !== undefined) {
      if (
        !Array.isArray(rawUi.entries) ||
        rawUi.entries.length > PACKAGE_IFRAME_MAX_ENTRIES_V1
      ) {
        throw new Error(`${label}.ui.entries must be a bounded array`);
      }
      entries = rawUi.entries.map((candidate, index) => {
        const entryLabel = `${label}.ui.entries[${index}]`;
        const entry = record(candidate, entryLabel);
        exactKeys(
          entry,
          ["id", "slot", "label", "icon", "opens"],
          ["order"],
          entryLabel,
        );
        const id = boundedString(entry.id, `${entryLabel}.id`, 32);
        if (!PACKAGE_IFRAME_ID_V1.test(id)) {
          throw new Error(`${entryLabel}.id is invalid`);
        }
        if (entry.slot !== PACKAGE_IFRAME_ENTRY_SLOT_V1) {
          throw new Error(`${entryLabel}.slot is invalid`);
        }
        const order = entry.order;
        if (
          order !== undefined &&
          (typeof order !== "number" || !Number.isFinite(order))
        ) {
          throw new Error(`${entryLabel}.order must be finite`);
        }
        const opens = record(entry.opens, `${entryLabel}.opens`);
        exactKeys(opens, ["kind", "page"], [], `${entryLabel}.opens`);
        if (opens.kind !== "surface") {
          throw new Error(`${entryLabel}.opens.kind is invalid`);
        }
        const page = boundedString(opens.page, `${entryLabel}.opens.page`, 32);
        const target = pages.find((candidatePage) => candidatePage.id === page);
        if (
          !target ||
          !target.mounts.some(
            (mount) => mount.slot === `frockbot.surface:${page}`,
          )
        ) {
          throw new Error(
            `${entryLabel}.opens.page names no page with a matching surface mount`,
          );
        }
        return {
          id,
          slot: PACKAGE_IFRAME_ENTRY_SLOT_V1 as "frockbot.sidebar-actions",
          ...(order === undefined ? {} : { order }),
          label: boundedString(
            entry.label,
            `${entryLabel}.label`,
            PACKAGE_IFRAME_ENTRY_LABEL_MAX_V1,
          ),
          icon: boundedString(entry.icon, `${entryLabel}.icon`, 64),
          opens: { kind: "surface" as const, page },
        };
      });
      if (new Set(entries.map((entry) => entry.id)).size !== entries.length) {
        throw new Error(`${label}.ui.entries contains duplicate ids`);
      }
    }
    ui = { pages, ...(entries ? { entries } : {}) };
  }
  return {
    packageId,
    displayName,
    tools,
    ...(hooks === undefined ? {} : { hooks }),
    source,
    ...(ui ? { ui } : {}),
  };
}

/** The JSON Schema the model sees for `package_author`. */
export const AUTHOR_PACKAGE_INPUT_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  required: ["packageId", "displayName", "tools", "source"],
  properties: {
    packageId: {
      type: "string",
      description:
        "Stable lowercase Package identity. Re-authoring it appends a version.",
    },
    displayName: { type: "string" },
    tools: {
      type: "array",
      minItems: 1,
      maxItems: AUTHORED_TOOLS_MAX,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["name", "description", "inputSchema"],
        properties: {
          name: { type: "string" },
          description: { type: "string" },
          inputSchema: { type: "object" },
        },
      },
    },
    hooks: {
      type: "array",
      minItems: 1,
      maxItems: BOT_ISOLATE_HOOK_EVENTS_V1.length,
      uniqueItems: true,
      items: { type: "string", enum: BOT_ISOLATE_HOOK_EVENTS_V1 },
      description:
        "Waterfall loop events exported from `hooks`; names must match exactly.",
    },
    source: {
      type: "string",
      description:
        "TypeScript for one package.ts that exports `tools` and `execute(tool, input, ctx)`. No imports: the isolate has no network and no npm. `ctx.model.invoke(request)` uses the Bot's configured model binding.",
    },
    ui: {
      type: "object",
      additionalProperties: false,
      required: ["pages"],
      properties: {
        pages: {
          type: "array",
          minItems: 1,
          maxItems: PACKAGE_IFRAME_MAX_PAGES_V1,
          description:
            "Up to 8 sandboxed HTML pages, each mounted into one or more slots.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "html", "mounts"],
            properties: {
              id: {
                type: "string",
                description:
                  "Lowercase page id, /^[a-z][a-z0-9-]{0,31}$/, unique in this Package.",
              },
              html: {
                type: "string",
                description:
                  "One HTML page (maximum 256 KB). CSS and JavaScript must be inline; images may use data: URLs.",
              },
              mounts: {
                type: "array",
                minItems: 1,
                maxItems: 64,
                items: {
                  type: "object",
                  additionalProperties: false,
                  required: ["slot"],
                  properties: {
                    slot: {
                      type: "string",
                      description:
                        "frockbot.bot-settings-sections, frockbot.tool-result:<declaredToolName>, frockbot.right-panel, or frockbot.surface:<pageId>",
                    },
                    order: { type: "number" },
                  },
                },
              },
            },
          },
        },
        entries: {
          type: "array",
          maxItems: PACKAGE_IFRAME_MAX_ENTRIES_V1,
          description:
            "Up to 4 sidebar launchers. Each opens one of your pages as an overlay surface; that page must mount frockbot.surface:<its own id>.",
          items: {
            type: "object",
            additionalProperties: false,
            required: ["id", "slot", "label", "icon", "opens"],
            properties: {
              id: {
                type: "string",
                description:
                  "Lowercase entry id, /^[a-z][a-z0-9-]{0,31}$/, unique in this Package.",
              },
              slot: { type: "string", enum: [PACKAGE_IFRAME_ENTRY_SLOT_V1] },
              order: { type: "number" },
              label: {
                type: "string",
                maxLength: PACKAGE_IFRAME_ENTRY_LABEL_MAX_V1,
              },
              icon: { type: "string", description: "A FrockBot UiIcon name." },
              opens: {
                type: "object",
                additionalProperties: false,
                required: ["kind", "page"],
                properties: {
                  kind: { type: "string", enum: ["surface"] },
                  page: { type: "string" },
                },
              },
            },
          },
        },
      },
    },
  },
} as const;

export function decodePackageUndoInputV1(
  input: unknown,
  label = "package_undo input",
): PackageUndoInputV1 {
  const value = record(input, label);
  exactKeys(value, [], ["generationId"], label);
  return value.generationId === undefined
    ? {}
    : {
        generationId: boundedString(
          value.generationId,
          `${label}.generationId`,
          256,
        ),
      };
}

export const PACKAGE_UNDO_INPUT_SCHEMA_V1 = {
  type: "object",
  additionalProperties: false,
  properties: {
    generationId: {
      type: "string",
      description:
        "Optional earlier Composition generation. Omit to undo your most recent Package change.",
    },
  },
} as const;

export async function sha256HexV1(value: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(value),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The idempotency key for one authoring effect. Deterministic in the admitted
 * run and every independently bundled or declared execution dimension, so a
 * resumed Turn that re-executes the same tool call lands on the same effect
 * instead of bundling a second time.
 */
export async function authoringEffectIdV1(input: {
  runId: string;
  packageId: string;
  sourceHash: string;
  /** Every page the bundler is asked for, in declaration order. */
  uiPageHashes?: Array<{ id: string; htmlHash: string }>;
  hooks?: BotIsolateHookEventNameV1[];
}): Promise<string> {
  const digest = await sha256HexV1(
    JSON.stringify([
      input.runId,
      input.packageId,
      input.sourceHash,
      (input.uiPageHashes ?? []).map((page) => [page.id, page.htmlHash]),
      input.hooks ?? [],
    ]),
  );
  return `author-${digest.slice(0, 32)}`;
}

/** One undo effect per admitted run and requested target (or default target). */
export async function packageUndoEffectIdV1(input: {
  runId: string;
  generationId?: string;
}): Promise<string> {
  const digest = await sha256HexV1(
    JSON.stringify([input.runId, input.generationId ?? "latest"]),
  );
  return `undo-${digest.slice(0, 32)}`;
}

/** `0.0.1`, `0.0.2`, … — a version is appended, never overwritten. */
export function authoredVersionV1(ordinal: number): string {
  if (!Number.isSafeInteger(ordinal) || ordinal < 1) {
    throw new Error("authored version ordinal must be a positive integer");
  }
  return `0.0.${ordinal}`;
}

/** The specifier a Bot-authored Package is recorded under. */
export function authoredSpecifierV1(packageId: string): string {
  return `bot-authored:${packageId}`;
}

/**
 * The manifest an authored Package is content-addressed by. It is synthesized
 * rather than authored so a Bot cannot declare a Contribution host the kernel
 * did not offer it: exactly one Bot isolate runtime Contribution and the exact
 * tool names mount health must report. Model access is a method on the narrow
 * Package context, not a separate manifest Contribution.
 */
export function authoredManifestV1(input: {
  packageId: string;
  displayName: string;
  version: string;
  tools: AuthorPackageInputV1["tools"];
  hooks?: AuthorPackageInputV1["hooks"];
  ui?: {
    pages: Array<{
      id: string;
      artifact: {
        contentHash: string;
        size: number;
        mediaType: "text/html";
        bundlerVersion: string;
      };
      mounts: Array<{ slot: string; order?: number }>;
    }>;
    entries?: NonNullable<AuthorPackageInputV1["ui"]>["entries"];
  };
}): Record<string, unknown> {
  return {
    schemaVersion: 5,
    id: input.packageId,
    displayName: input.displayName,
    version: input.version,
    compatibility: { frockbot: ">=0.0.1" },
    dependencies: {},
    contributions: {
      runtime: { entry: "./package.js", host: "bot-isolate" },
      ...(input.ui
        ? {
            client: {
              kind: "iframe",
              pages: input.ui.pages.map((page) => ({
                id: page.id,
                artifact: { ...page.artifact },
                mounts: page.mounts.map((mount) => ({ ...mount })),
              })),
              ...(input.ui.entries
                ? {
                    entries: input.ui.entries.map((entry) => ({
                      ...entry,
                      opens: { ...entry.opens },
                    })),
                  }
                : {}),
            },
          }
        : {}),
    },
    tools: input.tools.map((tool) => ({ ...tool })),
    ...(input.hooks === undefined ? {} : { hooks: [...input.hooks] }),
    permissions: [],
  };
}
