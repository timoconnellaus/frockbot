/**
 * The versioned wire protocol between a Bot Durable Object and the shared
 * Computer host of ADR 0004.
 *
 * "Cross-runtime communication uses narrow, versioned DTOs, and every inbound
 * value is decoded at its seam." Both sides of the seam import this module and
 * neither owns a second copy: the Durable Object encodes a request here, the
 * Node container decodes it here, and the container's answer travels back
 * through the same decoders.
 *
 * Every request carries the same envelope — `version`, the `effectId` the Bot
 * Durable Object recorded before it called, the `identity` whose Computer this
 * is (ADR 0012: a Computer is keyed by User and by nothing else), the `tenant`
 * Bot making the call, and an opaque `credentialRef`. The reference is
 * resolved on the host and never carries credential material: "Secrets remain
 * server-side and cross interfaces only as opaque references when necessary."
 */

export const COMPUTER_HOST_PROTOCOL_VERSION = 1;

/** Header carrying the shared secret between the two Workers and the container. */
export const COMPUTER_HOST_TOKEN_HEADER = "x-frockbot-host-token";

/** NDJSON media type used by a streaming exec response. */
export const COMPUTER_HOST_STREAM_MEDIA_TYPE = "application/x-ndjson";

/**
 * Bounds every decoder enforces. They are declared rather than inlined so the
 * container, the client, and their tests all refuse at the same size, and so a
 * limit change is one edit at one seam.
 */
export const COMPUTER_HOST_LIMITS = {
  /** Identifiers: effect, user, Bot, viewer session, control owner. */
  identifier: 200,
  credentialRef: 256,
  /** A script shipped over stdin. The 431 that killed argv delivery is why. */
  script: 1_000_000,
  /** An absolute path on the Computer. */
  path: 4_096,
  /** Base64 payload for a file write or exec stdin, encoded length. */
  payloadBase64: 16 * 1_024 * 1_024,
  /** Environment variables handed to one exec. */
  envEntries: 64,
  envKey: 256,
  envValue: 32_768,
  /** Directory listing page. */
  listEntries: 2_000,
  /** The longest an exec may run, and the ceiling a request may ask for. */
  execTimeoutMs: 600_000,
  /** The most output one exec may return, and the ceiling a request may ask. */
  maxOutputBytes: 4 * 1_024 * 1_024,
  /** Human-control lease age a request may ask for, in seconds. */
  controlMaxAgeSeconds: 3_600,
  /** Declared service name. */
  serviceName: 128,
  /** Failure text carried on a frame or a problem response. */
  message: 2_048,
  /** The whole JSON request body. */
  requestBytes: 32 * 1_024 * 1_024,
} as const;

export type ComputerHostErrorCodeV1 =
  | "invalid-request"
  | "not-authorized"
  | "not-found"
  | "conflict"
  | "limit-exceeded"
  | "human-control-active"
  | "aborted"
  | "timeout"
  | "provider-unavailable"
  | "provider-failure";

const ERROR_CODES: readonly ComputerHostErrorCodeV1[] = [
  "invalid-request",
  "not-authorized",
  "not-found",
  "conflict",
  "limit-exceeded",
  "human-control-active",
  "aborted",
  "timeout",
  "provider-unavailable",
  "provider-failure",
];

export interface ComputerHostIdentityV1 {
  userId: string;
}

export interface ComputerHostTenantV1 {
  botId: string;
}

export interface ComputerHostEnvelopeV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  identity: ComputerHostIdentityV1;
  tenant: ComputerHostTenantV1;
  credentialRef: string;
}

export interface ComputerHostOpenOperationV1 {
  kind: "open";
}

export interface ComputerHostExecOperationV1 {
  kind: "exec";
  /** Shell source delivered on the command's stdin. Never on its argv. */
  script: string;
  cwd?: string;
  env?: Record<string, string>;
  /** Extra stdin appended after the script, base64. */
  stdinBase64?: string;
  timeoutMs: number;
  maxOutputBytes: number;
  /** True for an NDJSON frame stream, false for one buffered answer. */
  stream: boolean;
}

export interface ComputerHostFileReadOperationV1 {
  kind: "file/read";
  path: string;
}

export interface ComputerHostFileWriteOperationV1 {
  kind: "file/write";
  path: string;
  bytesBase64: string;
  mode?: number;
}

export interface ComputerHostFileListOperationV1 {
  kind: "file/list";
  path: string;
  recursive: boolean;
}

export interface ComputerHostFileStatOperationV1 {
  kind: "file/stat";
  path: string;
}

export interface ComputerHostFileDeleteOperationV1 {
  kind: "file/delete";
  path: string;
  recursive: boolean;
}

export type ComputerHostControlActionV1 = "acquire" | "renew" | "release";

export interface ComputerHostControlOperationV1 {
  kind: "control";
  action: ComputerHostControlActionV1;
  ownerId: string;
  maxAgeSeconds: number;
}

export interface ComputerHostViewerOperationV1 {
  kind: "viewer";
  action: "open" | "revoke";
  sessionId?: string;
}

export interface ComputerHostServiceOperationV1 {
  kind: "service";
  name: string;
}

/**
 * Cancels the effect the envelope names. There is no second identifier: the
 * envelope's `effectId` is the effect being cancelled, so a cancel cannot
 * disagree with itself about what it is cancelling.
 */
export interface ComputerHostCancelOperationV1 {
  kind: "cancel";
}

export type ComputerHostOperationV1 =
  | ComputerHostOpenOperationV1
  | ComputerHostExecOperationV1
  | ComputerHostFileReadOperationV1
  | ComputerHostFileWriteOperationV1
  | ComputerHostFileListOperationV1
  | ComputerHostFileStatOperationV1
  | ComputerHostFileDeleteOperationV1
  | ComputerHostControlOperationV1
  | ComputerHostViewerOperationV1
  | ComputerHostServiceOperationV1
  | ComputerHostCancelOperationV1;

export interface ComputerHostRequestV1 extends ComputerHostEnvelopeV1 {
  operation: ComputerHostOperationV1;
}

export type ComputerHostOperationKindV1 = ComputerHostOperationV1["kind"];

/** The route each operation is posted to. */
export const COMPUTER_HOST_ROUTES = {
  open: "/v1/computer/open",
  exec: "/v1/computer/exec",
  "file/read": "/v1/computer/file/read",
  "file/write": "/v1/computer/file/write",
  "file/list": "/v1/computer/file/list",
  "file/stat": "/v1/computer/file/stat",
  "file/delete": "/v1/computer/file/delete",
  control: "/v1/computer/control",
  viewer: "/v1/computer/viewer",
  service: "/v1/computer/service",
  cancel: "/v1/computer/cancel",
} as const satisfies Record<ComputerHostOperationKindV1, string>;

const KIND_BY_ROUTE = new Map<string, ComputerHostOperationKindV1>(
  Object.entries(COMPUTER_HOST_ROUTES).map(([kind, route]) => [
    route,
    kind as ComputerHostOperationKindV1,
  ]),
);

/** The operation a pathname addresses, or `undefined` for an unknown route. */
export function computerHostOperationKindV1(
  pathname: string,
): ComputerHostOperationKindV1 | undefined {
  return KIND_BY_ROUTE.get(pathname);
}

// --- responses -------------------------------------------------------------

/**
 * How far provisioning a cold Computer got, and how it ended.
 *
 * Provisioning a Computer installs a desktop stack and is quiet for minutes
 * (ADR 0004), so the phase is on the wire: a client that would otherwise show
 * nothing at all can say "installing the desktop packages (2/5)", and a
 * failure names the phase it failed in rather than the whole install.
 */
export interface ComputerHostProvisioningV1 {
  /** Machine name of the phase reached: a declared phase, or `ready`. */
  phase: string;
  /** The same phase in words, for a client to show. */
  label: string;
  /** 1-based position of `phase`, or 0 before the first one begins. */
  index: number;
  /** How many phases a full provisioning run has. */
  total: number;
  status: "complete" | "running" | "failed";
  /**
   * True when this run completed a Computer that was already part-provisioned
   * — a marker file said so, and the finished phases were not run again.
   */
  resumed: boolean;
}

export interface ComputerHostOpenResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  spriteName: string;
  /** The tenant's durable directory, relative to the Workspace home. */
  directory: string;
  /** The tenant's X display, when the Computer allocated one. */
  display?: string;
  /** The Computer's provisioning generation, bumped on every reprovision. */
  generation: number;
  /**
   * Present when this `open` provisioned or resumed the Computer. Absent when
   * it adopted one that was already provisioned, which is the common case.
   */
  provisioning?: ComputerHostProvisioningV1;
}

export interface ComputerHostExecResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  exitCode: number | null;
  signal?: string;
  stdoutBase64: string;
  stderrBase64: string;
  outputTruncated: boolean;
}

export type ComputerHostFileKindV1 = "file" | "directory" | "other";

export interface ComputerHostFileEntryV1 {
  path: string;
  kind: ComputerHostFileKindV1;
  size: number;
  /** POSIX mode bits, masked to the low twelve. */
  mode: number;
  /** ISO-8601 modification time, absent when the Computer reported none. */
  modifiedAt?: string;
}

export interface ComputerHostFileReadResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  entry: ComputerHostFileEntryV1;
  bytesBase64: string;
}

export interface ComputerHostFileStatResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  entry: ComputerHostFileEntryV1;
}

export interface ComputerHostFileListResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  entries: ComputerHostFileEntryV1[];
  truncated: boolean;
}

export interface ComputerHostFileWriteResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  entry: ComputerHostFileEntryV1;
}

export interface ComputerHostFileDeleteResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  path: string;
  deleted: boolean;
}

export interface ComputerHostControlResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  action: ComputerHostControlActionV1;
  ownerId: string;
  /** ISO-8601 expiry of the lease, absent after a release. */
  expiresAt?: string;
}

export interface ComputerHostViewerResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  /** Absent after a revoke. */
  session?: { id: string; url: string; expiresAt?: string };
}

export interface ComputerHostServiceResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  name: string;
  status: "running" | "unavailable";
}

export interface ComputerHostCancelResultV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  effectId: string;
  /** False when the host held no in-flight effect under that identity. */
  cancelled: boolean;
}

/**
 * A failure the host declares rather than throws. It is the body of every
 * non-2xx answer and of an `error` exec frame, so a caller reads one shape.
 */
export interface ComputerHostProblemV1 {
  version: typeof COMPUTER_HOST_PROTOCOL_VERSION;
  code: ComputerHostErrorCodeV1;
  message: string;
  retryable: boolean;
}

export type ComputerHostExecFrameV1 =
  | { type: "stdout"; dataBase64: string }
  | { type: "stderr"; dataBase64: string }
  | {
      type: "exit";
      exitCode: number | null;
      signal?: string;
      outputTruncated: boolean;
    }
  | {
      type: "error";
      code: ComputerHostErrorCodeV1;
      message: string;
      retryable: boolean;
    };

// --- primitive decoders ----------------------------------------------------

export class ComputerHostDecodeError extends Error {
  // Plain fields rather than parameter properties: this module is loaded by
  // Node's type stripping inside the container, which erases types and
  // transforms nothing.
  readonly code: ComputerHostErrorCodeV1;

  constructor(
    message: string,
    code: ComputerHostErrorCodeV1 = "invalid-request",
  ) {
    super(message);
    this.name = "ComputerHostDecodeError";
    this.code = code;
  }
}

function fail(message: string): never {
  throw new ComputerHostDecodeError(message);
}

function object(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

/** Refuses a field the schema does not declare, so a caller cannot smuggle one. */
function exactly(
  input: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(input)) {
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
    throw new ComputerHostDecodeError(
      `${label} exceeds ${maximumLength} characters`,
      "limit-exceeded",
    );
  }
  return value;
}

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function identifier(input: unknown, label: string): string {
  const value = boundedString(input, COMPUTER_HOST_LIMITS.identifier, label);
  if (!IDENTIFIER.test(value)) fail(`${label} is not a valid identifier`);
  return value;
}

function boundedInteger(
  input: unknown,
  minimum: number,
  maximum: number,
  label: string,
): number {
  if (!Number.isSafeInteger(input)) fail(`${label} must be an integer`);
  const value = input as number;
  if (value < minimum || value > maximum) {
    throw new ComputerHostDecodeError(
      `${label} must be between ${minimum} and ${maximum}`,
      "limit-exceeded",
    );
  }
  return value;
}

function boolean(input: unknown, label: string): boolean {
  if (typeof input !== "boolean") fail(`${label} must be a boolean`);
  return input;
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Base64 with a declared ceiling. An empty payload is legal; a malformed one is not. */
export function decodeBase64FieldV1(
  input: unknown,
  label: string,
  maximumLength = COMPUTER_HOST_LIMITS.payloadBase64,
): string {
  if (typeof input !== "string") fail(`${label} must be a base64 string`);
  const value = input as string;
  if (value.length > maximumLength) {
    throw new ComputerHostDecodeError(
      `${label} exceeds ${maximumLength} encoded bytes`,
      "limit-exceeded",
    );
  }
  if (!BASE64.test(value)) fail(`${label} is not valid base64`);
  return value;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * An absolute, normalized path on the Computer. Relative paths, traversal, and
 * control characters are refused here rather than on the Sprite: the mount
 * path never leaves the provider Package, and a path that reaches the host is
 * already resolved.
 */
export function decodeComputerPathV1(input: unknown, label = "path"): string {
  const value = boundedString(input, COMPUTER_HOST_LIMITS.path, label);
  const segments = value.split("/");
  if (
    !value.startsWith("/") ||
    value.includes("//") ||
    value.includes("\\") ||
    CONTROL_CHARACTERS.test(value) ||
    segments.some((segment, index) =>
      index === 0 ? segment !== "" : segment === "." || segment === "..",
    ) ||
    (value.length > 1 && value.endsWith("/"))
  ) {
    fail(`${label} must be an absolute normalized Computer path`);
  }
  return value;
}

function environment(input: unknown): Record<string, string> {
  const value = object(input, "Computer exec env");
  const keys = Object.keys(value);
  if (keys.length > COMPUTER_HOST_LIMITS.envEntries) {
    throw new ComputerHostDecodeError(
      `Computer exec env exceeds ${COMPUTER_HOST_LIMITS.envEntries} entries`,
      "limit-exceeded",
    );
  }
  const decoded: Record<string, string> = {};
  for (const key of keys) {
    if (
      key.length > COMPUTER_HOST_LIMITS.envKey ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    ) {
      fail(`Computer exec env name is invalid: ${key.slice(0, 64)}`);
    }
    const item = value[key];
    if (typeof item !== "string") {
      fail(`Computer exec env ${key} must be a string`);
    }
    if ((item as string).length > COMPUTER_HOST_LIMITS.envValue) {
      throw new ComputerHostDecodeError(
        `Computer exec env ${key} exceeds ${COMPUTER_HOST_LIMITS.envValue} characters`,
        "limit-exceeded",
      );
    }
    decoded[key] = item as string;
  }
  return decoded;
}

// --- request decoding ------------------------------------------------------

const ENVELOPE_FIELDS = [
  "version",
  "effectId",
  "identity",
  "tenant",
  "credentialRef",
] as const;

function decodeEnvelope(
  value: Record<string, unknown>,
  extra: readonly string[],
): ComputerHostEnvelopeV1 {
  exactly(value, [...ENVELOPE_FIELDS, ...extra], "Computer host request");
  if (value.version !== COMPUTER_HOST_PROTOCOL_VERSION) {
    fail("Computer host request version is not 1");
  }
  const identity = object(value.identity, "Computer identity");
  exactly(identity, ["userId"], "Computer identity");
  const tenant = object(value.tenant, "Computer tenant");
  exactly(tenant, ["botId"], "Computer tenant");
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: identifier(value.effectId, "Computer effect id"),
    identity: { userId: identifier(identity.userId, "Computer user id") },
    tenant: { botId: identifier(tenant.botId, "Computer Bot id") },
    credentialRef: boundedString(
      value.credentialRef,
      COMPUTER_HOST_LIMITS.credentialRef,
      "Computer credential reference",
    ),
  };
}

function decodeOperation(
  kind: ComputerHostOperationKindV1,
  value: Record<string, unknown>,
): ComputerHostOperationV1 {
  switch (kind) {
    case "open":
    case "cancel":
      return { kind };
    case "exec":
      return {
        kind,
        script: boundedString(
          value.script,
          COMPUTER_HOST_LIMITS.script,
          "Computer exec script",
        ),
        ...(value.cwd === undefined
          ? {}
          : { cwd: decodeComputerPathV1(value.cwd, "Computer exec cwd") }),
        ...(value.env === undefined ? {} : { env: environment(value.env) }),
        ...(value.stdinBase64 === undefined
          ? {}
          : {
              stdinBase64: decodeBase64FieldV1(
                value.stdinBase64,
                "Computer exec stdin",
              ),
            }),
        timeoutMs: boundedInteger(
          value.timeoutMs,
          1,
          COMPUTER_HOST_LIMITS.execTimeoutMs,
          "Computer exec timeout",
        ),
        maxOutputBytes: boundedInteger(
          value.maxOutputBytes,
          1,
          COMPUTER_HOST_LIMITS.maxOutputBytes,
          "Computer exec output limit",
        ),
        stream: boolean(value.stream, "Computer exec stream"),
      };
    case "file/read":
    case "file/stat":
      return { kind, path: decodeComputerPathV1(value.path) };
    case "file/write":
      return {
        kind,
        path: decodeComputerPathV1(value.path),
        bytesBase64: decodeBase64FieldV1(
          value.bytesBase64,
          "Computer file bytes",
        ),
        ...(value.mode === undefined
          ? {}
          : {
              mode: boundedInteger(value.mode, 0, 0o7777, "Computer file mode"),
            }),
      };
    case "file/list":
    case "file/delete":
      return {
        kind,
        path: decodeComputerPathV1(value.path),
        recursive:
          value.recursive === undefined
            ? false
            : boolean(value.recursive, "Computer recursive flag"),
      };
    case "control": {
      const action = value.action;
      if (action !== "acquire" && action !== "renew" && action !== "release") {
        fail("Computer control action is invalid");
      }
      return {
        kind,
        action,
        ownerId: identifier(value.ownerId, "Computer control owner"),
        maxAgeSeconds: boundedInteger(
          value.maxAgeSeconds,
          1,
          COMPUTER_HOST_LIMITS.controlMaxAgeSeconds,
          "Computer control lease age",
        ),
      };
    }
    case "viewer": {
      const action = value.action;
      if (action !== "open" && action !== "revoke") {
        fail("Computer viewer action is invalid");
      }
      if (action === "revoke" && value.sessionId === undefined) {
        fail("Computer viewer revoke requires a session id");
      }
      return {
        kind,
        action,
        ...(value.sessionId === undefined
          ? {}
          : {
              sessionId: identifier(value.sessionId, "Computer viewer session"),
            }),
      };
    }
    case "service":
      return {
        kind,
        name: boundedString(
          value.name,
          COMPUTER_HOST_LIMITS.serviceName,
          "Computer service name",
        ),
      };
  }
}

const OPERATION_FIELDS: Record<ComputerHostOperationKindV1, readonly string[]> =
  {
    open: [],
    exec: [
      "script",
      "cwd",
      "env",
      "stdinBase64",
      "timeoutMs",
      "maxOutputBytes",
      "stream",
    ],
    "file/read": ["path"],
    "file/write": ["path", "bytesBase64", "mode"],
    "file/list": ["path", "recursive"],
    "file/stat": ["path"],
    "file/delete": ["path", "recursive"],
    control: ["action", "ownerId", "maxAgeSeconds"],
    viewer: ["action", "sessionId"],
    service: ["name"],
    cancel: [],
  };

/** Decodes one request body already known to address `kind`. */
export function decodeComputerHostRequestV1(
  kind: ComputerHostOperationKindV1,
  input: unknown,
): ComputerHostRequestV1 {
  const value = object(input, "Computer host request");
  const envelope = decodeEnvelope(value, OPERATION_FIELDS[kind]);
  return { ...envelope, operation: decodeOperation(kind, value) };
}

/** Encodes one request as the body posted to `COMPUTER_HOST_ROUTES[kind]`. */
export function encodeComputerHostRequestV1(
  request: ComputerHostRequestV1,
): Record<string, unknown> {
  const { operation, ...envelope } = request;
  const { kind, ...body } = operation;
  void kind;
  return { ...envelope, ...body };
}

export type ComputerHostDecodedRequestV1 =
  | { ok: true; value: ComputerHostRequestV1 }
  | { ok: false; response: Response };

/**
 * Decodes an inbound HTTP request at the container's seam: route, method, body
 * size, JSON, then the DTO. Every refusal is a `problem()` rather than an
 * exception, so the container's handler has one shape to return.
 */
export async function decodeComputerHostHttpRequestV1(
  request: Request,
): Promise<ComputerHostDecodedRequestV1> {
  let pathname: string;
  try {
    pathname = new URL(request.url).pathname;
  } catch {
    return {
      ok: false,
      response: problem(400, "invalid-request", "invalid-url"),
    };
  }
  const kind = computerHostOperationKindV1(pathname);
  if (!kind) {
    return {
      ok: false,
      response: problem(404, "not-found", "no such Computer host route"),
    };
  }
  if (request.method !== "POST") {
    return {
      ok: false,
      response: problem(
        405,
        "invalid-request",
        "Computer host routes accept POST",
      ),
    };
  }
  let text: string;
  try {
    text = await request.text();
  } catch {
    return {
      ok: false,
      response: problem(400, "invalid-request", "unreadable body"),
    };
  }
  if (text.length > COMPUTER_HOST_LIMITS.requestBytes) {
    return {
      ok: false,
      response: problem(413, "limit-exceeded", "request body too large"),
    };
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return {
      ok: false,
      response: problem(400, "invalid-request", "body is not JSON"),
    };
  }
  try {
    return { ok: true, value: decodeComputerHostRequestV1(kind, body) };
  } catch (error) {
    const code =
      error instanceof ComputerHostDecodeError ? error.code : "invalid-request";
    return {
      ok: false,
      response: problem(
        code === "limit-exceeded" ? 413 : 400,
        code,
        error instanceof Error ? error.message : "invalid request",
      ),
    };
  }
}

// --- response encoding and decoding ---------------------------------------

export function computerHostProblemV1(
  code: ComputerHostErrorCodeV1,
  message: string,
  retryable = code === "provider-unavailable" || code === "limit-exceeded",
): ComputerHostProblemV1 {
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    code,
    message: message.slice(0, COMPUTER_HOST_LIMITS.message),
    retryable,
  };
}

/** The one failure shape the host returns, on every non-2xx answer. */
export function problem(
  status: number,
  code: ComputerHostErrorCodeV1,
  message: string,
  retryable = code === "provider-unavailable" || code === "limit-exceeded",
): Response {
  return Response.json(computerHostProblemV1(code, message, retryable), {
    status,
  });
}

export function decodeComputerHostProblemV1(
  input: unknown,
): ComputerHostProblemV1 {
  const value = object(input, "Computer host problem");
  exactly(
    value,
    ["version", "code", "message", "retryable"],
    "Computer host problem",
  );
  if (value.version !== COMPUTER_HOST_PROTOCOL_VERSION) {
    fail("Computer host problem version is not 1");
  }
  if (!ERROR_CODES.includes(value.code as ComputerHostErrorCodeV1)) {
    fail("Computer host problem code is invalid");
  }
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    code: value.code as ComputerHostErrorCodeV1,
    message: boundedString(
      value.message,
      COMPUTER_HOST_LIMITS.message,
      "Computer host problem message",
    ),
    retryable: boolean(value.retryable, "Computer host problem retryable"),
  };
}

function resultEnvelope(
  input: unknown,
  allowed: readonly string[],
  label: string,
): Record<string, unknown> {
  const value = object(input, label);
  exactly(value, ["version", "effectId", ...allowed], label);
  if (value.version !== COMPUTER_HOST_PROTOCOL_VERSION) {
    fail(`${label} version is not 1`);
  }
  identifier(value.effectId, `${label} effect id`);
  return value;
}

export function decodeComputerHostOpenResultV1(
  input: unknown,
): ComputerHostOpenResultV1 {
  const label = "Computer host open result";
  const value = resultEnvelope(
    input,
    ["spriteName", "directory", "display", "generation", "provisioning"],
    label,
  );
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    spriteName: identifier(value.spriteName, `${label} sprite name`),
    directory: boundedString(
      value.directory,
      COMPUTER_HOST_LIMITS.path,
      `${label} directory`,
    ),
    ...(value.display === undefined
      ? {}
      : { display: boundedString(value.display, 16, `${label} display`) }),
    generation: boundedInteger(
      value.generation,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label} generation`,
    ),
    ...(value.provisioning === undefined
      ? {}
      : {
          provisioning: decodeComputerHostProvisioningV1(
            value.provisioning,
            label,
          ),
        }),
  };
}

const PROVISIONING_STATUSES = new Set(["complete", "running", "failed"]);

function decodeComputerHostProvisioningV1(
  input: unknown,
  label: string,
): ComputerHostProvisioningV1 {
  const value = object(input, `${label} provisioning`);
  exactly(
    value,
    ["phase", "label", "index", "total", "status", "resumed"],
    `${label} provisioning`,
  );
  if (!PROVISIONING_STATUSES.has(value.status as string)) {
    fail(`${label} provisioning status is not a provisioning status`);
  }
  if (typeof value.resumed !== "boolean") {
    fail(`${label} provisioning resumed must be a boolean`);
  }
  return {
    phase: identifier(value.phase, `${label} provisioning phase`),
    label: boundedString(value.label, 200, `${label} provisioning label`),
    index: boundedInteger(value.index, 0, 1_000, `${label} provisioning index`),
    total: boundedInteger(value.total, 1, 1_000, `${label} provisioning total`),
    status: value.status as ComputerHostProvisioningV1["status"],
    resumed: value.resumed,
  };
}

export function decodeComputerHostExecResultV1(
  input: unknown,
): ComputerHostExecResultV1 {
  const label = "Computer host exec result";
  const value = resultEnvelope(
    input,
    ["exitCode", "signal", "stdoutBase64", "stderrBase64", "outputTruncated"],
    label,
  );
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    exitCode:
      value.exitCode === null
        ? null
        : boundedInteger(value.exitCode, -1, 255, `${label} exit code`),
    ...(value.signal === undefined
      ? {}
      : { signal: boundedString(value.signal, 32, `${label} signal`) }),
    stdoutBase64: decodeBase64FieldV1(value.stdoutBase64, `${label} stdout`),
    stderrBase64: decodeBase64FieldV1(value.stderrBase64, `${label} stderr`),
    outputTruncated: boolean(value.outputTruncated, `${label} truncation`),
  };
}

function fileEntry(input: unknown, label: string): ComputerHostFileEntryV1 {
  const value = object(input, label);
  exactly(value, ["path", "kind", "size", "mode", "modifiedAt"], label);
  const kind = value.kind;
  if (kind !== "file" && kind !== "directory" && kind !== "other") {
    fail(`${label} kind is invalid`);
  }
  return {
    path: decodeComputerPathV1(value.path, `${label} path`),
    kind,
    size: boundedInteger(
      value.size,
      0,
      Number.MAX_SAFE_INTEGER,
      `${label} size`,
    ),
    mode: boundedInteger(value.mode, 0, 0o7777, `${label} mode`),
    ...(value.modifiedAt === undefined
      ? {}
      : { modifiedAt: boundedString(value.modifiedAt, 64, `${label} time`) }),
  };
}

export function decodeComputerHostFileReadResultV1(
  input: unknown,
): ComputerHostFileReadResultV1 {
  const label = "Computer host file read result";
  const value = resultEnvelope(input, ["entry", "bytesBase64"], label);
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    entry: fileEntry(value.entry, `${label} entry`),
    bytesBase64: decodeBase64FieldV1(value.bytesBase64, `${label} bytes`),
  };
}

export function decodeComputerHostFileStatResultV1(
  input: unknown,
): ComputerHostFileStatResultV1 {
  const label = "Computer host file stat result";
  const value = resultEnvelope(input, ["entry"], label);
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    entry: fileEntry(value.entry, `${label} entry`),
  };
}

export function decodeComputerHostFileWriteResultV1(
  input: unknown,
): ComputerHostFileWriteResultV1 {
  const label = "Computer host file write result";
  const value = resultEnvelope(input, ["entry"], label);
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    entry: fileEntry(value.entry, `${label} entry`),
  };
}

export function decodeComputerHostFileListResultV1(
  input: unknown,
): ComputerHostFileListResultV1 {
  const label = "Computer host file list result";
  const value = resultEnvelope(input, ["entries", "truncated"], label);
  if (!Array.isArray(value.entries)) fail(`${label} entries must be an array`);
  const entries = value.entries as unknown[];
  if (entries.length > COMPUTER_HOST_LIMITS.listEntries) {
    throw new ComputerHostDecodeError(
      `${label} exceeds ${COMPUTER_HOST_LIMITS.listEntries} entries`,
      "limit-exceeded",
    );
  }
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    entries: entries.map((entry) => fileEntry(entry, `${label} entry`)),
    truncated: boolean(value.truncated, `${label} truncation`),
  };
}

export function decodeComputerHostFileDeleteResultV1(
  input: unknown,
): ComputerHostFileDeleteResultV1 {
  const label = "Computer host file delete result";
  const value = resultEnvelope(input, ["path", "deleted"], label);
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    path: decodeComputerPathV1(value.path, `${label} path`),
    deleted: boolean(value.deleted, `${label} deletion`),
  };
}

export function decodeComputerHostControlResultV1(
  input: unknown,
): ComputerHostControlResultV1 {
  const label = "Computer host control result";
  const value = resultEnvelope(
    input,
    ["action", "ownerId", "expiresAt"],
    label,
  );
  const action = value.action;
  if (action !== "acquire" && action !== "renew" && action !== "release") {
    fail(`${label} action is invalid`);
  }
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    action,
    ownerId: identifier(value.ownerId, `${label} owner`),
    ...(value.expiresAt === undefined
      ? {}
      : { expiresAt: boundedString(value.expiresAt, 64, `${label} expiry`) }),
  };
}

export function decodeComputerHostViewerResultV1(
  input: unknown,
): ComputerHostViewerResultV1 {
  const label = "Computer host viewer result";
  const value = resultEnvelope(input, ["session"], label);
  if (value.session === undefined) {
    return {
      version: COMPUTER_HOST_PROTOCOL_VERSION,
      effectId: value.effectId as string,
    };
  }
  const session = object(value.session, `${label} session`);
  exactly(session, ["id", "url", "expiresAt"], `${label} session`);
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    session: {
      id: identifier(session.id, `${label} session id`),
      url: boundedString(session.url, 4_096, `${label} session url`),
      ...(session.expiresAt === undefined
        ? {}
        : {
            expiresAt: boundedString(session.expiresAt, 64, `${label} expiry`),
          }),
    },
  };
}

export function decodeComputerHostServiceResultV1(
  input: unknown,
): ComputerHostServiceResultV1 {
  const label = "Computer host service result";
  const value = resultEnvelope(input, ["name", "status"], label);
  if (value.status !== "running" && value.status !== "unavailable") {
    fail(`${label} status is invalid`);
  }
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    name: boundedString(
      value.name,
      COMPUTER_HOST_LIMITS.serviceName,
      `${label} name`,
    ),
    status: value.status,
  };
}

export function decodeComputerHostCancelResultV1(
  input: unknown,
): ComputerHostCancelResultV1 {
  const label = "Computer host cancel result";
  const value = resultEnvelope(input, ["cancelled"], label);
  return {
    version: COMPUTER_HOST_PROTOCOL_VERSION,
    effectId: value.effectId as string,
    cancelled: boolean(value.cancelled, `${label} cancellation`),
  };
}

// --- exec frames -----------------------------------------------------------

/** One NDJSON line, newline included. */
export function encodeComputerHostExecFrameV1(
  frame: ComputerHostExecFrameV1,
): string {
  return `${JSON.stringify(frame)}\n`;
}

export function decodeComputerHostExecFrameV1(
  line: string,
): ComputerHostExecFrameV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    fail("Computer exec frame is not JSON");
  }
  const value = object(parsed, "Computer exec frame");
  const type = value.type;
  if (type === "stdout" || type === "stderr") {
    exactly(value, ["type", "dataBase64"], "Computer exec frame");
    return {
      type,
      dataBase64: decodeBase64FieldV1(
        value.dataBase64,
        "Computer exec frame data",
      ),
    };
  }
  if (type === "exit") {
    exactly(
      value,
      ["type", "exitCode", "signal", "outputTruncated"],
      "Computer exec frame",
    );
    return {
      type,
      exitCode:
        value.exitCode === null
          ? null
          : boundedInteger(value.exitCode, -1, 255, "Computer exec exit code"),
      ...(value.signal === undefined
        ? {}
        : { signal: boundedString(value.signal, 32, "Computer exec signal") }),
      outputTruncated: boolean(
        value.outputTruncated,
        "Computer exec truncation",
      ),
    };
  }
  if (type === "error") {
    exactly(
      value,
      ["type", "code", "message", "retryable"],
      "Computer exec frame",
    );
    if (!ERROR_CODES.includes(value.code as ComputerHostErrorCodeV1)) {
      fail("Computer exec frame code is invalid");
    }
    return {
      type,
      code: value.code as ComputerHostErrorCodeV1,
      message: boundedString(
        value.message,
        COMPUTER_HOST_LIMITS.message,
        "Computer exec frame message",
      ),
      retryable: boolean(value.retryable, "Computer exec frame retryable"),
    };
  }
  return fail("Computer exec frame type is invalid");
}

/**
 * Reassembles NDJSON frames from a byte stream whose chunk boundaries mean
 * nothing. This is the lesson of the framing incident recorded in ADR 0004: a
 * transport may split or coalesce anywhere, so a frame boundary is the newline
 * this decoder finds and never the chunk the transport delivered.
 */
export class ComputerHostExecFrameReaderV1 {
  private buffer = "";
  private readonly decoder = new TextDecoder();

  /** Frames completed by this chunk, in order. */
  push(chunk: Uint8Array | string): ComputerHostExecFrameV1[] {
    this.buffer +=
      typeof chunk === "string"
        ? chunk
        : this.decoder.decode(chunk, { stream: true });
    const frames: ComputerHostExecFrameV1[] = [];
    let newline = this.buffer.indexOf("\n");
    while (newline >= 0) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) frames.push(decodeComputerHostExecFrameV1(line));
      newline = this.buffer.indexOf("\n");
    }
    return frames;
  }

  /** The trailing frame of a stream that ended without its final newline. */
  end(): ComputerHostExecFrameV1[] {
    const line = this.buffer.trim();
    this.buffer = "";
    return line ? [decodeComputerHostExecFrameV1(line)] : [];
  }
}
