/**
 * The versioned wire protocol between the app Worker and the Applet build
 * service.
 *
 * Both sides of the seam import this module and neither owns a second copy:
 * the app Worker encodes a request here, the Node container decodes it here,
 * and the container's answer travels back through the same decoders.
 *
 * Source travels inline. The service holds no storage authority — it is given
 * bytes and returns bytes, and the caller hash-verifies and stores them — so
 * the request carries the whole Applet and the response carries the whole
 * artifact, both bounded here.
 *
 * The module declares its own types and imports nothing. It is copied into the
 * container image beside the SDK, and a dependency would be a second thing to
 * copy and a second thing to keep in step.
 */

export const APPLET_BUILD_PROTOCOL_VERSION = 1;

/** Header carrying the shared secret between the two Workers and the container. */
export const APPLET_BUILD_TOKEN_HEADER = "x-frockbot-applet-build-token";

/** The one route the service serves. */
export const APPLET_BUILD_ROUTE = "/build";

/**
 * Bounds every decoder enforces. Declared rather than inlined so the caller,
 * the container and their tests refuse at the same size, and so a limit change
 * is one edit at one seam.
 */
export const APPLET_BUILD_LIMITS = {
  /** Identifiers: the effect id. */
  identifier: 200,
  /** `<ownerUserId>.<slug>`, as `APPLET_ID_V1` mints it. */
  appletId: 129,
  /** A source path relative to the Applet's root. */
  path: 256,
  /** One source file. */
  fileText: 512 * 1_024,
  /** How many source files one Applet may post. */
  files: 64,
  /** Every posted file together. Applet source is two files and a descriptor. */
  sourceBytes: 1_024 * 1_024,
  /** The whole JSON request body. */
  requestBytes: 2 * 1_024 * 1_024,
  /**
   * The artifacts. Enforced here, in the service, rather than after a caller
   * has already paid for the round trip.
   *
   * The UI bound is the Applet one: its page is one self-contained file
   * carrying React, TanStack DB and the kit — roughly half a megabyte before
   * the Applet's own code.
   */
  serverBytes: 2 * 1_024 * 1_024,
  uiBytes: 4 * 1_024 * 1_024,
  manifestBytes: 64 * 1_024,
  /** Declared tools, matching `APPLET_MAX_TOOLS_V1`. */
  tools: 64,
  toolName: 64,
  toolDescription: 1_024,
  /** Diagnostics one failure may carry. */
  diagnostics: 200,
  /** Failure text on a diagnostic or a problem response. */
  message: 2_048,
} as const;

const APPLET_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,95}\.[a-z0-9-]{1,64}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export type AppletBuildErrorCodeV1 =
  | "invalid-request"
  | "not-authorized"
  | "not-found"
  | "limit-exceeded"
  | "provider-failure";

const ERROR_CODES: readonly AppletBuildErrorCodeV1[] = [
  "invalid-request",
  "not-authorized",
  "not-found",
  "limit-exceeded",
  "provider-failure",
];

/**
 * `check` stops after the type checker and the linter; `build` goes on to
 * bundle and to ask the built Durable Object what it declares.
 */
export type AppletBuildModeV1 = "check" | "build";

/** Where a failed run stopped. */
export type AppletBuildStageV1 =
  "descriptor" | "typecheck" | "lint" | "bundle" | "describe";

const MODES: readonly AppletBuildModeV1[] = ["check", "build"];
const STAGES: readonly AppletBuildStageV1[] = [
  "descriptor",
  "typecheck",
  "lint",
  "bundle",
  "describe",
];

export interface AppletBuildSourceFileV1 {
  /** Relative, normalized, no traversal: `server.ts`, `lib/dates.ts`. */
  path: string;
  text: string;
}

export interface AppletBuildRequestV1 {
  version: typeof APPLET_BUILD_PROTOCOL_VERSION;
  /**
   * The idempotency key the caller recorded before it called. The container is
   * stateless and the build is pure, so it is carried rather than journalled:
   * a retry under the same key re-derives the same artifact.
   */
  effectId: string;
  appletId: string;
  mode: AppletBuildModeV1;
  files: AppletBuildSourceFileV1[];
}

export type AppletJsonValueV1 =
  | null
  | boolean
  | number
  | string
  | AppletJsonValueV1[]
  | { [key: string]: AppletJsonValueV1 };

export interface AppletBuildToolDeclarationV1 {
  name: string;
  description: string;
  inputSchema: { [key: string]: AppletJsonValueV1 };
}

export interface AppletBuildManifestV1 {
  contract: 1;
  tools: AppletBuildToolDeclarationV1[];
  hashes: { server: string; ui: string };
}

export interface AppletBuildDiagnosticV1 {
  /** Path relative to the Applet's root. */
  file: string;
  line: number;
  column: number;
  message: string;
  severity: "error" | "warning";
}

export interface AppletBuiltResponseV1 {
  status: "built";
  /**
   * The three artifacts, present exactly when the run bundled — `mode:
   * "build"`. A `check` stops at the linter, so it has nothing to carry and
   * says so by absence rather than by an empty string that would decode as a
   * zero-length artifact.
   */
  manifest?: AppletBuildManifestV1;
  /** `dist/server.js`, as text. */
  server?: string;
  /** `dist/ui.html`, as text. */
  ui?: string;
}

export interface AppletBuildFailedResponseV1 {
  status: "failed";
  stage: AppletBuildStageV1;
  diagnostics: AppletBuildDiagnosticV1[];
}

/** A run that finished, either way. */
export type AppletBuildResponseV1 =
  AppletBuiltResponseV1 | AppletBuildFailedResponseV1;

/** The one failure shape the service returns on every non-2xx answer. */
export interface AppletBuildProblemV1 {
  version: typeof APPLET_BUILD_PROTOCOL_VERSION;
  code: AppletBuildErrorCodeV1;
  message: string;
  retryable: boolean;
}

export class AppletBuildDecodeError extends Error {
  constructor(
    message: string,
    readonly code: AppletBuildErrorCodeV1 = "invalid-request",
  ) {
    super(message);
    this.name = "AppletBuildDecodeError";
  }
}

function fail(message: string): never {
  throw new AppletBuildDecodeError(message);
}

function exceeded(message: string): never {
  throw new AppletBuildDecodeError(message, "limit-exceeded");
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
export function decodeAppletSourcePathV1(input: unknown): string {
  const value = boundedString(input, APPLET_BUILD_LIMITS.path, "Applet path");
  if (
    value.startsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    value.endsWith("/") ||
    CONTROL_CHARACTERS.test(value) ||
    value.split("/").some((segment) => segment === "." || segment === "..")
  ) {
    fail("Applet path must be relative and normalized");
  }
  return value;
}

function decodeFiles(input: unknown): AppletBuildSourceFileV1[] {
  if (!Array.isArray(input)) fail("Applet build files must be an array");
  if (input.length === 0) fail("Applet build files must not be empty");
  if (input.length > APPLET_BUILD_LIMITS.files) {
    exceeded(`Applet build files exceed ${APPLET_BUILD_LIMITS.files} entries`);
  }
  const seen = new Set<string>();
  let total = 0;
  const files = input.map((entry) => {
    const value = object(entry, "Applet build file");
    exactly(value, ["path", "text"], "Applet build file");
    const path = decodeAppletSourcePathV1(value.path);
    if (seen.has(path)) fail(`Applet build files repeat ${path}`);
    seen.add(path);
    const text = boundedText(
      value.text,
      APPLET_BUILD_LIMITS.fileText,
      `Applet build file ${path}`,
    );
    total += text.length;
    if (total > APPLET_BUILD_LIMITS.sourceBytes) {
      exceeded(
        `Applet source exceeds ${APPLET_BUILD_LIMITS.sourceBytes} characters`,
      );
    }
    return { path, text };
  });
  return files;
}

export function decodeAppletBuildRequestV1(
  input: unknown,
): AppletBuildRequestV1 {
  const value = object(input, "Applet build request");
  exactly(
    value,
    ["version", "effectId", "appletId", "mode", "files"],
    "Applet build request",
  );
  if (value.version !== APPLET_BUILD_PROTOCOL_VERSION) {
    fail("Applet build request version is not 1");
  }
  const effectId = boundedString(
    value.effectId,
    APPLET_BUILD_LIMITS.identifier,
    "Applet build effect id",
  );
  if (!IDENTIFIER.test(effectId)) fail("Applet build effect id is invalid");
  const appletId = boundedString(
    value.appletId,
    APPLET_BUILD_LIMITS.appletId,
    "Applet build applet id",
  );
  if (!APPLET_ID.test(appletId)) fail("Applet build applet id is invalid");
  if (!MODES.includes(value.mode as AppletBuildModeV1)) {
    fail("Applet build mode must be check or build");
  }
  return {
    version: APPLET_BUILD_PROTOCOL_VERSION,
    effectId,
    appletId,
    mode: value.mode as AppletBuildModeV1,
    files: decodeFiles(value.files),
  };
}

export function encodeAppletBuildRequestV1(
  request: AppletBuildRequestV1,
): Record<string, unknown> {
  return {
    version: APPLET_BUILD_PROTOCOL_VERSION,
    effectId: request.effectId,
    appletId: request.appletId,
    mode: request.mode,
    files: request.files.map((file) => ({ path: file.path, text: file.text })),
  };
}

export type AppletBuildDecodedRequestV1 =
  { ok: true; value: AppletBuildRequestV1 } | { ok: false; response: Response };

/**
 * Decodes an inbound HTTP request at the service's seam: route, method, body
 * size, JSON, then the DTO. Every refusal is a `problem()` rather than an
 * exception, so the container's handler has one shape to return.
 */
export async function decodeAppletBuildHttpRequestV1(
  request: Request,
): Promise<AppletBuildDecodedRequestV1> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return {
      ok: false,
      response: appletBuildProblemResponseV1(
        400,
        "invalid-request",
        "invalid-url",
      ),
    };
  }
  if (pathname !== APPLET_BUILD_ROUTE) {
    return {
      ok: false,
      response: appletBuildProblemResponseV1(
        404,
        "not-found",
        "no such Applet build route",
      ),
    };
  }
  if (request.method !== "POST") {
    return {
      ok: false,
      response: appletBuildProblemResponseV1(
        405,
        "invalid-request",
        "the Applet build route accepts POST",
      ),
    };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      response: appletBuildProblemResponseV1(
        400,
        "invalid-request",
        "unreadable body",
      ),
    };
  }
  if (text.length > APPLET_BUILD_LIMITS.requestBytes) {
    return {
      ok: false,
      response: appletBuildProblemResponseV1(
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
      response: appletBuildProblemResponseV1(
        400,
        "invalid-request",
        "body is not JSON",
      ),
    };
  }
  try {
    return { ok: true, value: decodeAppletBuildRequestV1(body) };
  } catch (error) {
    const code =
      error instanceof AppletBuildDecodeError ? error.code : "invalid-request";
    return {
      ok: false,
      response: appletBuildProblemResponseV1(
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
): AppletJsonValueV1 {
  if (depth > 16) fail(`${label} is too deeply nested`);
  if (
    input === null ||
    typeof input === "string" ||
    typeof input === "boolean" ||
    (typeof input === "number" && Number.isFinite(input))
  ) {
    return input as AppletJsonValueV1;
  }
  if (Array.isArray(input)) {
    if (input.length > 256) exceeded(`${label} has too many entries`);
    return input.map((entry) => decodeJsonValue(entry, label, depth + 1));
  }
  const value = object(input, label);
  const keys = Object.keys(value);
  if (keys.length > 256) exceeded(`${label} has too many fields`);
  const decoded: { [key: string]: AppletJsonValueV1 } = {};
  for (const key of keys) {
    decoded[key] = decodeJsonValue(value[key], label, depth + 1);
  }
  return decoded;
}

export function decodeAppletBuildToolDeclarationV1(
  input: unknown,
  label = "Applet build tool",
): AppletBuildToolDeclarationV1 {
  const value = object(input, label);
  exactly(value, ["name", "description", "inputSchema"], label);
  const name = boundedString(
    value.name,
    APPLET_BUILD_LIMITS.toolName,
    `${label} name`,
  );
  if (!TOOL_NAME.test(name)) fail(`${label} name is invalid`);
  return {
    name,
    description: boundedString(
      value.description,
      APPLET_BUILD_LIMITS.toolDescription,
      `${label} description`,
    ),
    inputSchema: decodeJsonValue(
      object(value.inputSchema, `${label} input schema`),
      `${label} input schema`,
    ) as { [key: string]: AppletJsonValueV1 },
  };
}

const SHA256 = /^[0-9a-f]{64}$/;

function hash(input: unknown, label: string): string {
  const value = boundedString(input, 64, label);
  if (!SHA256.test(value)) fail(`${label} is not a sha256 digest`);
  return value;
}

export function decodeAppletBuildManifestV1(
  input: unknown,
): AppletBuildManifestV1 {
  const value = object(input, "Applet build manifest");
  exactly(value, ["contract", "tools", "hashes"], "Applet build manifest");
  if (value.contract !== 1) fail("Applet build manifest contract is not 1");
  if (!Array.isArray(value.tools))
    fail("Applet build manifest tools must be an array");
  if (value.tools.length > APPLET_BUILD_LIMITS.tools) {
    exceeded(
      `Applet build manifest declares more than ${APPLET_BUILD_LIMITS.tools} tools`,
    );
  }
  const tools = value.tools.map((tool, index) =>
    decodeAppletBuildToolDeclarationV1(tool, `Applet build tool ${index}`),
  );
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    fail("Applet build manifest repeats a tool name");
  }
  const hashes = object(value.hashes, "Applet build manifest hashes");
  exactly(hashes, ["server", "ui"], "Applet build manifest hashes");
  return {
    contract: 1,
    tools,
    hashes: {
      server: hash(hashes.server, "Applet build server hash"),
      ui: hash(hashes.ui, "Applet build ui hash"),
    },
  };
}

export function decodeAppletBuildDiagnosticV1(
  input: unknown,
  label = "Applet build diagnostic",
): AppletBuildDiagnosticV1 {
  const value = object(input, label);
  exactly(value, ["file", "line", "column", "message", "severity"], label);
  if (value.severity !== "error" && value.severity !== "warning") {
    fail(`${label} severity must be error or warning`);
  }
  return {
    file: boundedString(value.file, APPLET_BUILD_LIMITS.path, `${label} file`),
    line: positiveInteger(value.line, `${label} line`),
    column: positiveInteger(value.column, `${label} column`),
    message: boundedString(
      value.message,
      APPLET_BUILD_LIMITS.message,
      `${label} message`,
    ),
    severity: value.severity,
  };
}

export function decodeAppletBuildResponseV1(
  input: unknown,
): AppletBuildResponseV1 {
  const value = object(input, "Applet build response");
  if (value.status === "failed") {
    exactly(value, ["status", "stage", "diagnostics"], "Applet build response");
    if (!STAGES.includes(value.stage as AppletBuildStageV1)) {
      fail("Applet build response stage is invalid");
    }
    if (!Array.isArray(value.diagnostics)) {
      fail("Applet build response diagnostics must be an array");
    }
    if (value.diagnostics.length > APPLET_BUILD_LIMITS.diagnostics) {
      exceeded(
        `Applet build response carries more than ${APPLET_BUILD_LIMITS.diagnostics} diagnostics`,
      );
    }
    return {
      status: "failed",
      stage: value.stage as AppletBuildStageV1,
      diagnostics: value.diagnostics.map((diagnostic, index) =>
        decodeAppletBuildDiagnosticV1(
          diagnostic,
          `Applet build diagnostic ${index}`,
        ),
      ),
    };
  }
  if (value.status !== "built") fail("Applet build response status is invalid");
  exactly(
    value,
    ["status", "manifest", "server", "ui"],
    "Applet build response",
  );
  const bundled =
    value.manifest !== undefined ||
    value.server !== undefined ||
    value.ui !== undefined;
  if (!bundled) return { status: "built" };
  return {
    status: "built",
    manifest: decodeAppletBuildManifestV1(value.manifest),
    server: boundedText(
      value.server,
      APPLET_BUILD_LIMITS.serverBytes,
      "Applet build server artifact",
    ),
    ui: boundedText(
      value.ui,
      APPLET_BUILD_LIMITS.uiBytes,
      "Applet build ui artifact",
    ),
  };
}

/** Encodes one response as the body the service returns. */
export function encodeAppletBuildResponseV1(
  response: AppletBuildResponseV1,
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
  if (response.manifest === undefined) return { status: "built" };
  return {
    status: "built",
    manifest: response.manifest,
    server: response.server ?? "",
    ui: response.ui ?? "",
  };
}

export function appletBuildProblemV1(
  code: AppletBuildErrorCodeV1,
  message: string,
  retryable = code === "limit-exceeded" || code === "provider-failure",
): AppletBuildProblemV1 {
  return {
    version: APPLET_BUILD_PROTOCOL_VERSION,
    code,
    message: message.slice(0, APPLET_BUILD_LIMITS.message),
    retryable,
  };
}

export function appletBuildProblemResponseV1(
  status: number,
  code: AppletBuildErrorCodeV1,
  message: string,
  retryable?: boolean,
): Response {
  return Response.json(appletBuildProblemV1(code, message, retryable), {
    status,
  });
}

export function decodeAppletBuildProblemV1(
  input: unknown,
): AppletBuildProblemV1 {
  const value = object(input, "Applet build problem");
  exactly(
    value,
    ["version", "code", "message", "retryable"],
    "Applet build problem",
  );
  if (value.version !== APPLET_BUILD_PROTOCOL_VERSION) {
    fail("Applet build problem version is not 1");
  }
  if (!ERROR_CODES.includes(value.code as AppletBuildErrorCodeV1)) {
    fail("Applet build problem code is invalid");
  }
  if (typeof value.retryable !== "boolean") {
    fail("Applet build problem retryable must be a boolean");
  }
  return {
    version: APPLET_BUILD_PROTOCOL_VERSION,
    code: value.code as AppletBuildErrorCodeV1,
    message: boundedString(
      value.message,
      APPLET_BUILD_LIMITS.message,
      "Applet build problem message",
    ),
    retryable: value.retryable,
  };
}
