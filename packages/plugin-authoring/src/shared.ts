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
  PACKAGE_BUNDLE_MAX_SOURCE_BYTES,
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
  /** Optional sandboxed page. All CSS and JavaScript must be inline. */
  ui?: {
    html: string;
    mounts: Array<{ slot: string; order?: number }>;
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
    exactKeys(rawUi, ["html", "mounts"], [], `${label}.ui`);
    const html = boundedString(
      rawUi.html,
      `${label}.ui.html`,
      PACKAGE_BUNDLE_MAX_SOURCE_BYTES,
    );
    if (
      new TextEncoder().encode(html).byteLength >
      PACKAGE_BUNDLE_MAX_SOURCE_BYTES
    ) {
      throw new Error(`${label}.ui.html exceeds the per-Package source quota`);
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
      throw new Error(`${label}.ui.html may contain inline resources only`);
    }
    if (
      !Array.isArray(rawUi.mounts) ||
      rawUi.mounts.length === 0 ||
      rawUi.mounts.length > 64
    ) {
      throw new Error(`${label}.ui.mounts must be a non-empty bounded array`);
    }
    const mounts = rawUi.mounts.map((candidate, index) => {
      const mount = record(candidate, `${label}.ui.mounts[${index}]`);
      exactKeys(mount, ["slot"], ["order"], `${label}.ui.mounts[${index}]`);
      const slot = boundedString(
        mount.slot,
        `${label}.ui.mounts[${index}].slot`,
        160,
      );
      if (
        slot !== "frockbot.bot-settings-sections" &&
        !slot.startsWith("frockbot.tool-result:")
      ) {
        throw new Error(`${label}.ui.mounts[${index}].slot is not iframe-safe`);
      }
      const order = mount.order;
      if (
        order !== undefined &&
        (typeof order !== "number" || !Number.isFinite(order))
      ) {
        throw new Error(`${label}.ui.mounts[${index}].order must be finite`);
      }
      return { slot, ...(order === undefined ? {} : { order }) };
    });
    ui = { html, mounts };
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
        "TypeScript for one package.ts that exports `tools` and `execute(tool, input, ctx)`. No imports: the isolate has no network and no npm. `ctx.invokeModel(request)` is the only model path.",
    },
    ui: {
      type: "object",
      additionalProperties: false,
      required: ["html", "mounts"],
      properties: {
        html: {
          type: "string",
          description:
            "One ui.html page (maximum 256 KB). CSS and JavaScript must be inline; images may use data: URLs.",
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
                  "frockbot.bot-settings-sections or frockbot.tool-result:<declaredToolName>",
              },
              order: { type: "number" },
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
 * run and the exact source, so a resumed Turn that re-executes the same tool
 * call lands on the same effect instead of bundling a second time.
 */
export async function authoringEffectIdV1(input: {
  runId: string;
  packageId: string;
  sourceHash: string;
}): Promise<string> {
  const digest = await sha256HexV1(
    JSON.stringify([input.runId, input.packageId, input.sourceHash]),
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
    artifact: {
      contentHash: string;
      size: number;
      mediaType: "text/html";
      bundlerVersion: string;
    };
    mounts: Array<{ slot: string; order?: number }>;
  };
}): Record<string, unknown> {
  return {
    schemaVersion: 3,
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
              artifact: { ...input.ui.artifact },
              mounts: input.ui.mounts.map((mount) => ({ ...mount })),
            },
          }
        : {}),
    },
    tools: input.tools.map((tool) => ({ ...tool })),
    ...(input.hooks === undefined ? {} : { hooks: [...input.hooks] }),
    permissions: [],
  };
}
