/**
 * The versioned wire protocol between the app Worker and the Plugin build
 * service.
 *
 * Both sides of the seam import this module and neither owns a second copy:
 * the app Worker encodes a request here, the Node container decodes it here,
 * and the container's answer travels back through the same decoders.
 *
 * A Plugin (ADR 0026) — `plugin.ts` beside a `plugin.json` — comes back as one
 * ESM module and a manifest of what that module exports, read by running it.
 *
 * Source travels inline. The service holds no storage authority — it is given
 * bytes and returns bytes, and the caller hash-verifies and stores them — so
 * the request carries the whole Plugin and the response carries the whole
 * artifact, both bounded here.
 *
 * The module declares its own types and imports nothing. It is copied into the
 * container image beside the SDK, and a dependency would be a second thing to
 * copy and a second thing to keep in step.
 */

export const PLUGIN_BUILD_PROTOCOL_VERSION = 1;

/**
 * Header carrying `APPLET_BUILD_TOKEN`, the shared secret between the two
 * Workers and the container. It keeps the deployed service's name.
 */
export const APPLET_BUILD_TOKEN_HEADER = "x-frockbot-applet-build-token";

/** The one route the service serves. */
export const PLUGIN_BUILD_ROUTE = "/build";

/**
 * Bounds every decoder enforces. Declared rather than inlined so the caller,
 * the container and their tests refuse at the same size, and so a limit change
 * is one edit at one seam.
 */
export const PLUGIN_BUILD_LIMITS = {
  /** Identifiers: the effect id. */
  identifier: 200,
  /** A Plugin id, as `PluginDescriptorV1.id` bounds one. */
  pluginId: 64,
  /** A source path relative to the Plugin's root. */
  path: 256,
  /** One source file. */
  fileText: 512 * 1_024,
  /** How many source files one Plugin may post. */
  files: 64,
  /** Every posted file together. */
  sourceBytes: 1_024 * 1_024,
  /** The whole JSON request body. */
  requestBytes: 2 * 1_024 * 1_024,
  /**
   * The artifacts. Enforced here, in the service, rather than after a caller
   * has already paid for the round trip.
   */
  manifestBytes: 64 * 1_024,
  /** Declared tools, matching the Plugin descriptor. */
  tools: 64,
  toolName: 64,
  toolDescription: 1_024,
  /** The built module. One file, bundled, no imports. */
  moduleBytes: 2 * 1_024 * 1_024,
  /** Hooks, services, triggers and views one Plugin module may export. */
  hooks: 7,
  services: 32,
  triggers: 16,
  views: 16,
  /** Cards one Plugin may draw, matching the descriptor's bound. */
  cards: 16,
  /** Model providers one Plugin may serve, matching the descriptor's bound. */
  modelProviders: 4,
  /** Device modules one Plugin may ship, matching the descriptor's bound. */
  modules: 4,
  /** Calls one device module may export. */
  moduleCalls: 32,
  /** Diagnostics one failure may carry. */
  diagnostics: 200,
  /** Failure text on a diagnostic or a problem response. */
  message: 2_048,
} as const;

/** A Plugin id, as `PluginDescriptorV1.id` is shaped. */
const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const SERVICE_NAME = /^[a-z][a-z0-9-]{0,63}$/;
const TRIGGER_NAME = /^[a-z][a-z0-9_-]{0,63}$/;
/** The `Identifier` a `ViewDocument.surfaceId` accepts; matches the Plugin descriptor. */
const SURFACE_ID = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
/** A card id, as the Plugin descriptor bounds one. */
const CARD_ID = /^[a-z][a-z0-9_]{0,31}$/;
/** A model provider type, as the Plugin descriptor bounds one (ADR 0032). */
const PROVIDER_NAME = /^[a-z][a-z0-9-]{0,63}$/;
/** The loop events a Plugin may hook, as `BOT_ISOLATE_HOOK_EVENTS_V1` lists them. */
export const PLUGIN_BUILD_HOOK_EVENTS_V1 = [
  "system-prompt/assemble",
  "agent/tool-exposure",
  "agent/request",
  "tools/pre-execute",
  "tools/post-execute",
  "agent/turn-stopping",
  "theme/assemble",
] as const;
export type PluginBuildHookEventV1 =
  (typeof PLUGIN_BUILD_HOOK_EVENTS_V1)[number];
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type PluginBuildErrorCodeV1 =
  | "invalid-request"
  | "not-authorized"
  | "not-found"
  | "limit-exceeded"
  | "provider-failure";

const ERROR_CODES: readonly PluginBuildErrorCodeV1[] = [
  "invalid-request",
  "not-authorized",
  "not-found",
  "limit-exceeded",
  "provider-failure",
];

/**
 * `check` stops after the type checker; `build` goes on to bundle and to run
 * the module to read what it exports.
 */
export type PluginBuildModeV1 = "check" | "build";

/** Where a failed run stopped. */
export type PluginBuildStageV1 =
  "descriptor" | "typecheck" | "bundle" | "describe";

const MODES: readonly PluginBuildModeV1[] = ["check", "build"];
const STAGES: readonly PluginBuildStageV1[] = [
  "descriptor",
  "typecheck",
  "bundle",
  "describe",
];

export interface PluginBuildSourceFileV1 {
  /** Relative, normalized, no traversal: `plugin.ts`, `lib/dates.ts`. */
  path: string;
  text: string;
}

export interface PluginBuildRequestV1 {
  version: typeof PLUGIN_BUILD_PROTOCOL_VERSION;
  /**
   * The idempotency key the caller recorded before it called. The container is
   * stateless and the build is pure, so it is carried rather than journalled:
   * a retry under the same key re-derives the same artifact.
   */
  effectId: string;
  /** The Plugin's id, as its `plugin.json` names it. */
  id: string;
  mode: PluginBuildModeV1;
  files: PluginBuildSourceFileV1[];
}

export type PluginBuildJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | PluginBuildJsonValueV1[]
  | { [key: string]: PluginBuildJsonValueV1 };

export interface PluginBuildToolDeclarationV1 {
  name: string;
  description: string;
  inputSchema: { [key: string]: PluginBuildJsonValueV1 };
}

/**
 * What a built Plugin module exports, read by running it. The app compares
 * this with the Plugin's own `plugin.json` before anything is stored: a
 * descriptor that promises a tool the module does not export is refused at
 * publish, not discovered at mount.
 */
export interface PluginBuildManifestV1 {
  contract: 1;
  tools: PluginBuildToolDeclarationV1[];
  hooks: PluginBuildHookEventV1[];
  services: string[];
  triggers: string[];
  /** The surface ids the module exports a view for, one function each. */
  views: string[];
  /** The card ids the module draws, one `render` each (ADR 0030). */
  cards: string[];
  /** The model providers the module serves, by provider id (ADR 0032). */
  modelProviders: string[];
  /** Each device module (ADR 0037): the calls it exports and its hash. */
  modules: PluginBuildModuleDeclarationV1[];
  hashes: { module: string };
}

/** What one built device module exports, and the hash of its code. */
export interface PluginBuildModuleDeclarationV1 {
  id: string;
  calls: string[];
  hash: string;
}

/** One built device module's code. */
export interface PluginBuildModuleArtifactV1 {
  id: string;
  code: string;
}

export interface PluginBuildDiagnosticV1 {
  /** Path relative to the Plugin's root. */
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
}

/**
 * A passing check. It stopped after the type checker, so it has nothing to
 * carry and says so by absence rather than by an empty module.
 */
export interface PluginCheckedResponseV1 {
  status: "built";
}

/** A build that produced its module. */
export interface PluginBuiltResponseV1 {
  status: "built";
  manifest: PluginBuildManifestV1;
  module: string;
  /** One per device module the manifest declares, in the same order. */
  modules: PluginBuildModuleArtifactV1[];
}

export interface PluginBuildFailedResponseV1 {
  status: "failed";
  stage: PluginBuildStageV1;
  diagnostics: PluginBuildDiagnosticV1[];
}

/** A run that finished, either way. */
export type PluginBuildResponseV1 =
  PluginCheckedResponseV1 | PluginBuiltResponseV1 | PluginBuildFailedResponseV1;

/** True for a response that carries a built module. */
export function isPluginBuiltResponseV1(
  response: PluginBuildResponseV1,
): response is PluginBuiltResponseV1 {
  return response.status === "built" && "module" in response;
}

/** The one failure shape the service returns on every non-2xx answer. */
export interface PluginBuildProblemV1 {
  version: typeof PLUGIN_BUILD_PROTOCOL_VERSION;
  code: PluginBuildErrorCodeV1;
  message: string;
  retryable: boolean;
}

export class PluginBuildDecodeError extends Error {
  constructor(
    message: string,
    readonly code: PluginBuildErrorCodeV1 = "invalid-request",
  ) {
    super(message);
    this.name = "PluginBuildDecodeError";
  }
}

function fail(message: string): never {
  throw new PluginBuildDecodeError(message);
}

function exceeded(message: string): never {
  throw new PluginBuildDecodeError(message, "limit-exceeded");
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    fail(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

/** Refuses a field the schema does not declare, so a caller cannot smuggle one. */
function exactly(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has an unknown field: ${key}`);
  }
}

function boundedString(
  input: unknown,
  maximumLength: number,
  label: string,
): string {
  if (typeof input !== "string" || input.length === 0) {
    fail(`${label} must be a non-empty string`);
  }
  const value = input as string;
  if (value.length > maximumLength) {
    exceeded(`${label} exceeds ${maximumLength} characters`);
  }
  return value;
}

function boundedText(
  input: unknown,
  maximumLength: number,
  label: string,
): string {
  if (typeof input !== "string") fail(`${label} must be a string`);
  const value = input as string;
  if (value.length > maximumLength) {
    exceeded(`${label} exceeds ${maximumLength} characters`);
  }
  return value;
}

function positiveInteger(input: unknown, label: string): number {
  if (!Number.isSafeInteger(input) || (input as number) < 1) {
    fail(`${label} must be a positive integer`);
  }
  return input as number;
}

/**
 * A relative, normalized source path. Absolute paths, traversal, backslashes
 * and control characters are refused here rather than at the `mkdir` that
 * would otherwise write outside the build's own temp directory.
 */
export function decodePluginSourcePathV1(input: unknown): string {
  const value = boundedString(input, PLUGIN_BUILD_LIMITS.path, "Plugin path");
  if (
    value.startsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    value.endsWith("/") ||
    CONTROL_CHARACTERS.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    fail("Plugin path must be relative and normalized");
  }
  return value;
}

function decodeFiles(input: unknown): PluginBuildSourceFileV1[] {
  if (!Array.isArray(input)) fail("Plugin build files must be an array");
  if (input.length === 0) fail("Plugin build files must not be empty");
  if (input.length > PLUGIN_BUILD_LIMITS.files) {
    exceeded(`Plugin build files exceed ${PLUGIN_BUILD_LIMITS.files} entries`);
  }
  const seen = new Set<string>();
  let total = 0;
  const files = input.map((entry) => {
    const value = object(entry, "Plugin build file");
    exactly(value, ["path", "text"], "Plugin build file");
    const path = decodePluginSourcePathV1(value.path);
    if (seen.has(path)) fail(`Plugin build files repeat ${path}`);
    seen.add(path);
    const text = boundedText(
      value.text,
      PLUGIN_BUILD_LIMITS.fileText,
      `Plugin build file ${path}`,
    );
    total += text.length;
    if (total > PLUGIN_BUILD_LIMITS.sourceBytes) {
      exceeded(
        `Plugin source exceeds ${PLUGIN_BUILD_LIMITS.sourceBytes} characters`,
      );
    }
    return { path, text };
  });
  return files;
}

export function decodePluginBuildRequestV1(
  input: unknown,
): PluginBuildRequestV1 {
  const value = object(input, "Plugin build request");
  exactly(
    value,
    ["version", "effectId", "id", "mode", "files"],
    "Plugin build request",
  );
  if (value.version !== PLUGIN_BUILD_PROTOCOL_VERSION) {
    fail("Plugin build request version is not 1");
  }
  const effectId = boundedString(
    value.effectId,
    PLUGIN_BUILD_LIMITS.identifier,
    "Plugin build effect id",
  );
  if (!IDENTIFIER.test(effectId)) fail("Plugin build effect id is invalid");
  const id = boundedString(
    value.id,
    PLUGIN_BUILD_LIMITS.pluginId,
    "Plugin build id",
  );
  if (!PLUGIN_ID.test(id)) fail("Plugin build id is invalid");
  if (!MODES.includes(value.mode as PluginBuildModeV1)) {
    fail("Plugin build mode must be check or build");
  }
  return {
    version: PLUGIN_BUILD_PROTOCOL_VERSION,
    effectId,
    id,
    mode: value.mode as PluginBuildModeV1,
    files: decodeFiles(value.files),
  };
}

export function encodePluginBuildRequestV1(
  request: PluginBuildRequestV1,
): Record<string, unknown> {
  return {
    version: PLUGIN_BUILD_PROTOCOL_VERSION,
    effectId: request.effectId,
    id: request.id,
    mode: request.mode,
    files: request.files.map((file) => ({ path: file.path, text: file.text })),
  };
}

export type PluginBuildDecodedRequestV1 =
  { ok: true; value: PluginBuildRequestV1 } | { ok: false; response: Response };

/**
 * Decodes an inbound HTTP request at the service's seam: route, method, body
 * size, JSON, then the DTO. Every refusal is a `problem()` rather than an
 * exception, so the container's handler has one shape to return.
 */
export async function decodePluginBuildHttpRequestV1(
  request: Request,
): Promise<PluginBuildDecodedRequestV1> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return {
      ok: false,
      response: pluginBuildProblemResponseV1(
        400,
        "invalid-request",
        "invalid-url",
      ),
    };
  }
  if (pathname !== PLUGIN_BUILD_ROUTE) {
    return {
      ok: false,
      response: pluginBuildProblemResponseV1(
        404,
        "not-found",
        "no such Plugin build route",
      ),
    };
  }
  if (request.method !== "POST") {
    return {
      ok: false,
      response: pluginBuildProblemResponseV1(
        405,
        "invalid-request",
        "the Plugin build route accepts POST",
      ),
    };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      response: pluginBuildProblemResponseV1(
        400,
        "invalid-request",
        "unreadable body",
      ),
    };
  }
  if (text.length > PLUGIN_BUILD_LIMITS.requestBytes) {
    return {
      ok: false,
      response: pluginBuildProblemResponseV1(
        413,
        "limit-exceeded",
        "request body too large",
      ),
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: pluginBuildProblemResponseV1(
        400,
        "invalid-request",
        "body is not JSON",
      ),
    };
  }
  try {
    return { ok: true, value: decodePluginBuildRequestV1(body) };
  } catch (error) {
    const code =
      error instanceof PluginBuildDecodeError ? error.code : "invalid-request";
    return {
      ok: false,
      response: pluginBuildProblemResponseV1(
        code === "limit-exceeded" ? 413 : 400,
        code,
        error instanceof Error ? error.message : "invalid request",
      ),
    };
  }
}

// --- responses -------------------------------------------------------------

function decodeJsonValue(
  input: unknown,
  label: string,
  depth = 0,
): PluginBuildJsonValueV1 {
  if (depth > 16) fail(`${label} is too deeply nested`);
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return input as PluginBuildJsonValueV1;
  }
  if (Array.isArray(input)) {
    if (input.length > 256) exceeded(`${label} has too many entries`);
    return input.map((entry) => decodeJsonValue(entry, label, depth + 1));
  }
  const value = object(input, label);
  const keys = Object.keys(value);
  if (keys.length > 256) exceeded(`${label} has too many fields`);
  const decoded: { [key: string]: PluginBuildJsonValueV1 } = {};
  for (const key of keys) {
    decoded[key] = decodeJsonValue(value[key], label, depth + 1);
  }
  return decoded;
}

export function decodePluginBuildToolDeclarationV1(
  input: unknown,
  label: string,
): PluginBuildToolDeclarationV1 {
  const value = object(input, label);
  exactly(value, ["name", "description", "inputSchema"], label);
  const name = boundedString(
    value.name,
    PLUGIN_BUILD_LIMITS.toolName,
    `${label} name`,
  );
  if (!TOOL_NAME.test(name)) fail(`${label} name is invalid`);
  return {
    name,
    description: boundedString(
      value.description,
      PLUGIN_BUILD_LIMITS.toolDescription,
      `${label} description`,
    ),
    inputSchema: decodeJsonValue(
      object(value.inputSchema, `${label} input schema`),
      `${label} input schema`,
    ) as { [key: string]: PluginBuildJsonValueV1 },
  };
}

const SHA256 = /^[0-9a-f]{64}$/;

function hash(input: unknown, label: string): string {
  const value = boundedString(input, 64, label);
  if (!SHA256.test(value)) fail(`${label} is not a sha256 digest`);
  return value;
}

function boundedNames(
  input: unknown,
  pattern: RegExp,
  limit: number,
  label: string,
): string[] {
  if (!Array.isArray(input)) fail(`${label} must be an array`);
  const entries = input as unknown[];
  if (entries.length > limit) exceeded(`${label} exceeds ${limit} entries`);
  const names = entries.map((entry, index) => {
    const name = boundedString(entry, 64, `${label}[${index}]`);
    if (!pattern.test(name)) fail(`${label}[${index}] is invalid`);
    return name;
  });
  if (new Set(names).size !== names.length) fail(`${label} repeats a name`);
  return names;
}

export function decodePluginBuildManifestV1(
  input: unknown,
): PluginBuildManifestV1 {
  const label = "Plugin build manifest";
  const value = object(input, label);
  exactly(
    value,
    [
      "contract",
      "tools",
      "hooks",
      "services",
      "triggers",
      "views",
      "cards",
      // A build that predates model providers reports none, which is what a
      // Plugin that serves none also reports.
      "modelProviders",
      "modules",
      "hashes",
    ],
    label,
  );
  if (value.contract !== 1) fail(`${label} contract is not 1`);
  if (!Array.isArray(value.tools)) fail(`${label} tools must be an array`);
  if (value.tools.length > PLUGIN_BUILD_LIMITS.tools) {
    exceeded(`${label} declares more than ${PLUGIN_BUILD_LIMITS.tools} tools`);
  }
  const tools = value.tools.map((tool, index) =>
    decodePluginBuildToolDeclarationV1(tool, `Plugin build tool ${index}`),
  );
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    fail(`${label} repeats a tool name`);
  }
  if (!Array.isArray(value.hooks)) fail(`${label} hooks must be an array`);
  if (value.hooks.length > PLUGIN_BUILD_LIMITS.hooks) {
    exceeded(`${label} declares more than ${PLUGIN_BUILD_LIMITS.hooks} hooks`);
  }
  const hooks = value.hooks.map((hook) => {
    if (!PLUGIN_BUILD_HOOK_EVENTS_V1.includes(hook as PluginBuildHookEventV1)) {
      fail(`${label} names a hook this contract does not serve`);
    }
    return hook as PluginBuildHookEventV1;
  });
  if (new Set(hooks).size !== hooks.length) fail(`${label} repeats a hook`);
  const hashes = object(value.hashes, `${label} hashes`);
  exactly(hashes, ["module"], `${label} hashes`);
  return {
    contract: 1,
    tools,
    hooks,
    services: boundedNames(
      value.services,
      SERVICE_NAME,
      PLUGIN_BUILD_LIMITS.services,
      `${label} services`,
    ),
    triggers: boundedNames(
      value.triggers,
      TRIGGER_NAME,
      PLUGIN_BUILD_LIMITS.triggers,
      `${label} triggers`,
    ),
    views: boundedNames(
      value.views,
      SURFACE_ID,
      PLUGIN_BUILD_LIMITS.views,
      `${label} views`,
    ),
    // A build that predates cards reports none, which is what a Plugin that
    // draws none also reports.
    cards: boundedNames(
      value.cards ?? [],
      CARD_ID,
      PLUGIN_BUILD_LIMITS.cards,
      `${label} cards`,
    ),
    modelProviders: boundedNames(
      value.modelProviders ?? [],
      PROVIDER_NAME,
      PLUGIN_BUILD_LIMITS.modelProviders,
      `${label} model providers`,
    ),
    modules: decodeModuleDeclarationsV1(value.modules ?? [], label),
    hashes: { module: hash(hashes.module, `${label} module hash`) },
  };
}

const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const MODULE_CALL = /^[a-z][a-z0-9_-]{0,63}$/;

function decodeModuleDeclarationsV1(
  input: unknown,
  label: string,
): PluginBuildModuleDeclarationV1[] {
  if (!Array.isArray(input)) fail(`${label} modules must be an array`);
  if (input.length > PLUGIN_BUILD_LIMITS.modules) {
    exceeded(
      `${label} declares more than ${PLUGIN_BUILD_LIMITS.modules} modules`,
    );
  }
  const modules = input.map((entry, index) => {
    const itemLabel = `${label} module ${index}`;
    const value = object(entry, itemLabel);
    exactly(value, ["id", "calls", "hash"], itemLabel);
    const id = boundedString(value.id, 32, `${itemLabel} id`);
    if (!MODULE_ID.test(id)) fail(`${itemLabel} id is invalid`);
    return {
      id,
      calls: boundedNames(
        value.calls,
        MODULE_CALL,
        PLUGIN_BUILD_LIMITS.moduleCalls,
        `${itemLabel} calls`,
      ),
      hash: hash(value.hash, `${itemLabel} hash`),
    };
  });
  if (new Set(modules.map((module) => module.id)).size !== modules.length) {
    fail(`${label} repeats a module id`);
  }
  return modules;
}

export function decodePluginBuildDiagnosticV1(
  input: unknown,
  label: string,
): PluginBuildDiagnosticV1 {
  const value = object(input, label);
  exactly(value, ["file", "line", "column", "message", "severity"], label);
  if (value.severity !== "error" && value.severity !== "warning") {
    fail(`${label} severity must be error or warning`);
  }
  return {
    file: boundedString(value.file, PLUGIN_BUILD_LIMITS.path, `${label} file`),
    line: positiveInteger(value.line, `${label} line`),
    column: positiveInteger(value.column, `${label} column`),
    message: boundedString(
      value.message,
      PLUGIN_BUILD_LIMITS.message,
      `${label} message`,
    ),
    severity: value.severity,
  };
}

export function decodePluginBuildResponseV1(
  input: unknown,
): PluginBuildResponseV1 {
  const label = "Plugin build response";
  const value = object(input, label);
  if (value.status === "failed") {
    exactly(value, ["status", "stage", "diagnostics"], label);
    if (!STAGES.includes(value.stage as PluginBuildStageV1)) {
      fail(`${label} stage is invalid`);
    }
    if (!Array.isArray(value.diagnostics)) {
      fail(`${label} diagnostics must be an array`);
    }
    if (value.diagnostics.length > PLUGIN_BUILD_LIMITS.diagnostics) {
      exceeded(
        `${label} carries more than ${PLUGIN_BUILD_LIMITS.diagnostics} diagnostics`,
      );
    }
    return {
      status: "failed",
      stage: value.stage as PluginBuildStageV1,
      diagnostics: value.diagnostics.map((diagnostic, index) =>
        decodePluginBuildDiagnosticV1(
          diagnostic,
          `Plugin build diagnostic ${index}`,
        ),
      ),
    };
  }
  if (value.status !== "built") fail(`${label} status is invalid`);
  if (!Object.hasOwn(value, "manifest") && !Object.hasOwn(value, "module")) {
    exactly(value, ["status"], label);
    return { status: "built" };
  }
  exactly(value, ["status", "manifest", "module", "modules"], label);
  const manifest = decodePluginBuildManifestV1(value.manifest);
  const module = boundedText(
    value.module,
    PLUGIN_BUILD_LIMITS.moduleBytes,
    "Plugin build module artifact",
  );
  const code = value.modules ?? [];
  if (!Array.isArray(code) || code.length !== manifest.modules.length) {
    fail(`${label} modules must carry one artifact per declared module`);
  }
  return {
    status: "built",
    manifest,
    module,
    modules: code.map((entry, index) => {
      const itemLabel = `Plugin build device module ${index}`;
      const artifact = object(entry, itemLabel);
      exactly(artifact, ["id", "code"], itemLabel);
      if (artifact.id !== manifest.modules[index]!.id) {
        fail(`${itemLabel} is not the module the manifest declares there`);
      }
      return {
        id: manifest.modules[index]!.id,
        code: boundedText(
          artifact.code,
          PLUGIN_BUILD_LIMITS.moduleBytes,
          `${itemLabel} code`,
        ),
      };
    }),
  };
}

/** Encodes one response as the body the service returns. */
export function encodePluginBuildResponseV1(
  response: PluginBuildResponseV1,
): Record<string, unknown> {
  if (response.status === "failed") {
    return {
      status: "failed",
      stage: response.stage,
      diagnostics: response.diagnostics.map((diagnostic) => ({
        file: diagnostic.file,
        line: diagnostic.line,
        column: diagnostic.column,
        message: diagnostic.message,
        severity: diagnostic.severity,
      })),
    };
  }
  if (!isPluginBuiltResponseV1(response)) return { status: "built" };
  return {
    status: "built",
    manifest: response.manifest,
    module: response.module,
    modules: response.modules,
  };
}

export function pluginBuildProblemV1(
  code: PluginBuildErrorCodeV1,
  message: string,
  retryable = code === "limit-exceeded" || code === "provider-failure",
): PluginBuildProblemV1 {
  return {
    version: PLUGIN_BUILD_PROTOCOL_VERSION,
    code,
    message: message.slice(0, PLUGIN_BUILD_LIMITS.message),
    retryable,
  };
}

export function pluginBuildProblemResponseV1(
  status: number,
  code: PluginBuildErrorCodeV1,
  message: string,
  retryable?: boolean,
): Response {
  return Response.json(pluginBuildProblemV1(code, message, retryable), {
    status,
  });
}

export function decodePluginBuildProblemV1(
  input: unknown,
): PluginBuildProblemV1 {
  const label = "Plugin build problem";
  const value = object(input, label);
  exactly(value, ["version", "code", "message", "retryable"], label);
  if (value.version !== PLUGIN_BUILD_PROTOCOL_VERSION) {
    fail(`${label} version is not 1`);
  }
  if (!ERROR_CODES.includes(value.code as PluginBuildErrorCodeV1)) {
    fail(`${label} code is invalid`);
  }
  if (typeof value.retryable !== "boolean") {
    fail(`${label} retryable must be a boolean`);
  }
  return {
    version: PLUGIN_BUILD_PROTOCOL_VERSION,
    code: value.code as PluginBuildErrorCodeV1,
    message: boundedString(
      value.message,
      PLUGIN_BUILD_LIMITS.message,
      `${label} message`,
    ),
    retryable: value.retryable,
  };
}
