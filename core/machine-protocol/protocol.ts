/**
 * The versioned wire protocol between FrockBot's backend and a registered
 * machine of the User's — the parity register's "registered Mac" (§2.16).
 *
 * The machine is not the Computer and not the Workspace: it is a separate
 * filesystem the backend can never dial. `127.0.0.1` from the box is the box,
 * and a laptop behind NAT has no inbound address, so every exchange here is
 * one the *machine* starts: it enrolls, it opens the socket work is pushed
 * down, it claims a command, it posts a result. Nothing in this module opens a
 * socket, reads a clock it was not handed, or touches storage; it is DTOs and
 * their decoders.
 *
 * "Cross-runtime communication uses narrow, versioned DTOs, and every inbound
 * value is decoded at its seam." Three runtimes import this one module and
 * none keeps a second copy: the gateway Worker decodes what the machine sends,
 * the User Durable Object decodes what the gateway forwards, and the desktop
 * agent decodes what the backend answers.
 *
 * Every decoder is exact-key: a field the schema does not declare is a
 * refusal, not a field that is ignored, so a caller cannot smuggle one past a
 * seam and have a later version start honouring it.
 */

/** Bumped only for a breaking change; a new command op is additive. */
export const MACHINE_PROTOCOL_VERSION = 1;

/**
 * Every bound the protocol enforces, declared once so the gateway, the Durable
 * Object, the desktop agent and their tests all refuse at the same size, and
 * so changing a limit is one edit at one seam.
 */
export const MACHINE_LIMITS_V1 = {
  /** Identifiers: machine, user, bot, run, command, approval. */
  identifier: 200,
  /** The machine's own name for itself — a hostname, user-editable later. */
  label: 200,
  /** Reported agent version, e.g. `0.4.1`. */
  agentVersion: 64,
  /**
   * A pairing code as it is presented on enrollment. It is a *signed token*
   * carrying the User it was minted for — enrollment runs before gateway
   * authentication, so the code is the only thing that can name a Durable
   * Object — which is why the bound is a token's and not a passphrase's.
   */
  pairingCode: 512,
  /** Capabilities one agent may report. */
  capabilities: 8,
  /** A path on the machine. Not a Computer path: no absolute-form rule. */
  path: 4_096,
  /** A Workspace path a copy names on the FrockBot side. */
  workspacePath: 4_096,
  /** One shell command line. */
  command: 16_384,
  /** Working directory for one exec. */
  cwd: 4_096,
  /** Failure or refusal text carried on a result. */
  message: 2_048,
  /** The most output one exec may return, and the ceiling it may ask for. */
  outputBytes: 1_024 * 1_024,
  /** The most one file read may return, and the ceiling it may ask for. */
  readBytes: 8 * 1_024 * 1_024,
  /** Base64 payload on a result, encoded length. */
  payloadBase64: 16 * 1_024 * 1_024,
  /** The whole JSON request body, at any machine route. */
  requestBytes: 16 * 1_024 * 1_024,
  /** The longest an exec may run, and the ceiling a request may ask for. */
  execTimeoutMs: 600_000,
  /** Commands one machine may hold queued at once. */
  maxQueue: 16,
  /** Machines one User may hold registered at once. */
  maxMachinesPerUser: 8,
  /** Commands one User may dispatch across all machines in a day. */
  commandsPerDay: 500,
  /** How long a pairing offer stands before it is spent or expires. */
  pairingTtlMs: 5 * 60_000,
  /** How long a claim holds a command before the lease may be reclaimed. */
  leaseMs: 120_000,
  /** Device modules one frame may list: every member's, at four each. */
  modules: 64,
  /** Entries in one of a module's declared lists. */
  moduleDeclarations: 32,
  /** The largest module artifact a frame may name. */
  moduleBytes: 32 * 1_024 * 1_024,
  /** Reports one post may carry. */
  moduleReports: 50,
  /** A report's text or a crash's detail. */
  moduleReportText: 2_000,
  /** A module call's input, and its answer's value, as JSON text. */
  moduleCallJson: 256 * 1_024,
  /** The error a module call answers with. */
  moduleCallError: 2_000,
} as const;

/**
 * How long a Plugin's `device.call` waits for its module's answer (ADR 0037).
 * Shorter than a Plugin tool's own deadline, so the tool that asked still
 * hears how the call ended and can say so.
 */
export const DEVICE_CALL_WAIT_MS = 10_000;

/** Commands one machine may hold queued at once. */
export const MACHINE_MAX_QUEUE = MACHINE_LIMITS_V1.maxQueue;
/** Machines one User may hold registered at once. */
export const MACHINE_MAX_PER_USER = MACHINE_LIMITS_V1.maxMachinesPerUser;
/** Commands one User may dispatch in a day. */
export const MACHINE_COMMANDS_PER_DAY = MACHINE_LIMITS_V1.commandsPerDay;

export type MachineErrorCodeV1 = "invalid-request" | "limit-exceeded";

export class MachineDecodeError extends Error {
  // Plain fields rather than parameter properties: this module is also loaded
  // by the desktop shell's type-stripping runtime, which erases types and
  // transforms nothing.
  readonly code: MachineErrorCodeV1;

  constructor(message: string, code: MachineErrorCodeV1 = "invalid-request") {
    super(message);
    this.name = "MachineDecodeError";
    this.code = code;
  }
}

function fail(message: string): never {
  throw new MachineDecodeError(message);
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
    throw new MachineDecodeError(
      `${label} exceeds ${maximumLength} characters`,
      "limit-exceeded",
    );
  }
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
    throw new MachineDecodeError(
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

/**
 * A machine identifier is an opaque id, never the hostname: §2.16 shows the
 * split (`994dc2ee-…` with `Tims-M5-MacBook-Pro.local` as the label), the
 * label is user-editable, and the id is a storage key, a path segment, and the
 * tail of `plugin-audit`'s `machine:<id>` target — whose own identifier rule
 * (`plugin-audit/src/classify.ts`) this pattern matches, so every id minted
 * here can be audited.
 */
const MACHINE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

/**
 * Every other identifier the protocol carries. A `commandId` is derived from
 * the Bot Durable Object's durable tool-call occurrence — that identity is
 * what makes a retried dispatch idempotent.
 */
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

export function decodeMachineIdV1(input: unknown, label = "machineId"): string {
  const value = boundedString(input, MACHINE_LIMITS_V1.identifier, label);
  if (!MACHINE_ID.test(value)) fail(`${label} is not a valid machine id`);
  return value;
}

function identifier(input: unknown, label: string): string {
  const value = boundedString(input, MACHINE_LIMITS_V1.identifier, label);
  if (!IDENTIFIER.test(value)) fail(`${label} is not a valid identifier`);
  return value;
}

function timestamp(input: unknown, label: string): string {
  const value = boundedString(input, 64, label);
  if (Number.isNaN(Date.parse(value))) fail(`${label} must be a timestamp`);
  return value;
}

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * A path on the machine. Deliberately looser than `decodeComputerPathV1`: the
 * machine is somebody's laptop, where `~/Documents` and a Windows drive letter
 * are both ordinary, and the backend has no filesystem to normalize against.
 * What is refused is what a path can never legitimately carry — emptiness and
 * control characters, which is how a path smuggles a second argument.
 */
export function decodeMachinePathV1(input: unknown, label = "path"): string {
  const value = boundedString(input, MACHINE_LIMITS_V1.path, label);
  if (CONTROL_CHARACTERS.test(value)) {
    fail(`${label} must not contain control characters`);
  }
  return value;
}

const BASE64 =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

function base64Field(input: unknown, label: string): string {
  if (typeof input !== "string") fail(`${label} must be a base64 string`);
  const value = input as string;
  if (value.length > MACHINE_LIMITS_V1.payloadBase64) {
    throw new MachineDecodeError(
      `${label} exceeds ${MACHINE_LIMITS_V1.payloadBase64} encoded bytes`,
      "limit-exceeded",
    );
  }
  if (!BASE64.test(value)) fail(`${label} is not valid base64`);
  return value;
}

function literal<T extends string>(
  input: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (typeof input !== "string" || !allowed.includes(input as T)) {
    fail(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return input as T;
}

function schemaVersion(input: Record<string, unknown>, label: string): 1 {
  if (input.schemaVersion !== 1) {
    fail(`${label} schemaVersion is unsupported`);
  }
  return 1;
}

// ---------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------

export type MachinePlatformV1 = "macos" | "windows" | "linux";

export const MACHINE_PLATFORMS_V1: readonly MachinePlatformV1[] = [
  "macos",
  "windows",
  "linux",
];

/**
 * What an agent says it can do. The backend never assumes: a tool that needs
 * `exec` refuses visibly against a machine that did not report it.
 */
export type MachineCapabilityV1 = "exec" | "files";

export const MACHINE_CAPABILITIES_V1: readonly MachineCapabilityV1[] = [
  "exec",
  "files",
];

/**
 * Where one command stands.
 *
 * `unknown` is load-bearing rather than a fallback, exactly as it is in
 * `plugin-audit`: a lease that expires returns its command to `queued` once,
 * and if the second lease also lapses the command ends `unknown` — the backend
 * does not know whether it ran on the machine, and inventing an answer is what
 * the reconciliation rule forbids.
 */
export type MachineCommandStatusV1 =
  "queued" | "claimed" | "done" | "expired" | "unknown";

export const MACHINE_COMMAND_STATUSES_V1: readonly MachineCommandStatusV1[] = [
  "queued",
  "claimed",
  "done",
  "expired",
  "unknown",
];

export type MachineCommandOutcomeV1 = "ok" | "error" | "refused" | "timeout";

export const MACHINE_COMMAND_OUTCOMES_V1: readonly MachineCommandOutcomeV1[] = [
  "ok",
  "error",
  "refused",
  "timeout",
];

// ---------------------------------------------------------------------------
// Operations
// ---------------------------------------------------------------------------

export interface MachineExecOpV1 {
  kind: "exec";
  command: string;
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface MachineReadOpV1 {
  kind: "read";
  path: string;
  maxBytes: number;
}

/** `CopyToBox`: the machine reads `path` and the bytes land in the Workspace. */
export interface MachineCopyToComputerOpV1 {
  kind: "copy-to-computer";
  path: string;
  workspacePath: string;
}

/** `CopyFromBox`: bytes from the Workspace are written to `path`. */
export interface MachineCopyFromComputerOpV1 {
  kind: "copy-from-computer";
  path: string;
  workspacePath: string;
}

/** What one command asks the machine to do. */
export type MachineOpV1 =
  | MachineExecOpV1
  | MachineReadOpV1
  | MachineCopyToComputerOpV1
  | MachineCopyFromComputerOpV1;

export type MachineOpKindV1 = MachineOpV1["kind"];

export const MACHINE_OP_KINDS_V1: readonly MachineOpKindV1[] = [
  "exec",
  "read",
  "copy-to-computer",
  "copy-from-computer",
];

/** The capability an op requires of the machine that will run it. */
export function machineOpCapabilityV1(op: MachineOpV1): MachineCapabilityV1 {
  return op.kind === "exec" ? "exec" : "files";
}

export function decodeMachineOpV1(
  input: unknown,
  label = "machine op",
): MachineOpV1 {
  const value = object(input, label);
  const kind = literal(value.kind, MACHINE_OP_KINDS_V1, `${label} kind`);
  if (kind === "exec") {
    exactly(
      value,
      ["kind", "command", "cwd", "timeoutMs", "maxOutputBytes"],
      `${label} exec`,
    );
    return {
      kind,
      command: boundedString(
        value.command,
        MACHINE_LIMITS_V1.command,
        `${label} command`,
      ),
      ...(value.cwd === undefined
        ? {}
        : {
            cwd: boundedString(
              value.cwd,
              MACHINE_LIMITS_V1.cwd,
              `${label} cwd`,
            ),
          }),
      timeoutMs: boundedInteger(
        value.timeoutMs,
        1,
        MACHINE_LIMITS_V1.execTimeoutMs,
        `${label} timeoutMs`,
      ),
      maxOutputBytes: boundedInteger(
        value.maxOutputBytes,
        1,
        MACHINE_LIMITS_V1.outputBytes,
        `${label} maxOutputBytes`,
      ),
    };
  }
  if (kind === "read") {
    exactly(value, ["kind", "path", "maxBytes"], `${label} read`);
    return {
      kind,
      path: decodeMachinePathV1(value.path, `${label} path`),
      maxBytes: boundedInteger(
        value.maxBytes,
        1,
        MACHINE_LIMITS_V1.readBytes,
        `${label} maxBytes`,
      ),
    };
  }
  exactly(value, ["kind", "path", "workspacePath"], `${label} copy`);
  return {
    kind,
    path: decodeMachinePathV1(value.path, `${label} path`),
    workspacePath: boundedString(
      value.workspacePath,
      MACHINE_LIMITS_V1.workspacePath,
      `${label} workspacePath`,
    ),
  };
}

// ---------------------------------------------------------------------------
// Pairing and enrollment
// ---------------------------------------------------------------------------

/** What the browser asks for. The label is the machine's if it omits one. */
export interface MachinePairingRequestV1 {
  label?: string;
}

export function decodeMachinePairingRequestV1(
  input: unknown,
  label = "machine pairing request",
): MachinePairingRequestV1 {
  const value = object(input, label);
  exactly(value, ["label"], label);
  return value.label === undefined
    ? {}
    : {
        label: boundedString(
          value.label,
          MACHINE_LIMITS_V1.label,
          `${label} label`,
        ),
      };
}

/**
 * The one-time offer the browser shows and the machine presents.
 *
 * The code is the only secret a browser ever holds for a machine, and it is
 * spent on first use and dead in five minutes; the long-lived machine token is
 * minted on the far side of enrollment and never reaches a browser bundle.
 */
export interface MachinePairingOfferV1 {
  schemaVersion: 1;
  code: string;
  machineId: string;
  expiresAt: string;
}

export function decodeMachinePairingOfferV1(
  input: unknown,
  label = "machine pairing offer",
): MachinePairingOfferV1 {
  const value = object(input, label);
  exactly(value, ["schemaVersion", "code", "machineId", "expiresAt"], label);
  return {
    schemaVersion: schemaVersion(value, label),
    code: boundedString(
      value.code,
      MACHINE_LIMITS_V1.pairingCode,
      `${label} code`,
    ),
    machineId: decodeMachineIdV1(value.machineId, `${label} machineId`),
    expiresAt: timestamp(value.expiresAt, `${label} expiresAt`),
  };
}

/** What the machine presents to enroll, bearing the pairing code. */
export interface MachineEnrollmentV1 {
  schemaVersion: 1;
  code: string;
  label: string;
  platform: MachinePlatformV1;
  agentVersion: string;
  capabilities: MachineCapabilityV1[];
}

function capabilities(input: unknown, label: string): MachineCapabilityV1[] {
  if (!Array.isArray(input)) fail(`${label} must be an array`);
  if (input.length > MACHINE_LIMITS_V1.capabilities) {
    throw new MachineDecodeError(
      `${label} exceeds ${MACHINE_LIMITS_V1.capabilities} entries`,
      "limit-exceeded",
    );
  }
  const decoded: MachineCapabilityV1[] = [];
  for (const entry of input) {
    const capability = literal(
      entry,
      MACHINE_CAPABILITIES_V1,
      `${label} entry`,
    );
    if (decoded.includes(capability)) fail(`${label} repeats ${capability}`);
    decoded.push(capability);
  }
  return decoded;
}

export function decodeMachineEnrollmentV1(
  input: unknown,
  label = "machine enrollment",
): MachineEnrollmentV1 {
  const value = object(input, label);
  exactly(
    value,
    [
      "schemaVersion",
      "code",
      "label",
      "platform",
      "agentVersion",
      "capabilities",
    ],
    label,
  );
  const platform = literal(
    value.platform,
    MACHINE_PLATFORMS_V1,
    `${label} platform`,
  );
  return {
    schemaVersion: schemaVersion(value, label),
    code: boundedString(
      value.code,
      MACHINE_LIMITS_V1.pairingCode,
      `${label} code`,
    ),
    label: boundedString(
      value.label,
      MACHINE_LIMITS_V1.label,
      `${label} label`,
    ),
    platform,
    agentVersion: boundedString(
      value.agentVersion,
      MACHINE_LIMITS_V1.agentVersion,
      `${label} agentVersion`,
    ),
    capabilities: capabilities(value.capabilities, `${label} capabilities`),
  };
}

/**
 * The one moment a machine token exists outside the machine. The backend keeps
 * only `SHA-256(token)`; this response is the sole delivery, and a machine
 * that loses it pairs again rather than asking for it back.
 */
export interface MachineEnrollmentReceiptV1 {
  schemaVersion: 1;
  machineId: string;
  token: string;
  keyVersion: number;
}

export function decodeMachineEnrollmentReceiptV1(
  input: unknown,
  label = "machine enrollment receipt",
): MachineEnrollmentReceiptV1 {
  const value = object(input, label);
  exactly(value, ["schemaVersion", "machineId", "token", "keyVersion"], label);
  return {
    schemaVersion: schemaVersion(value, label),
    machineId: decodeMachineIdV1(value.machineId, `${label} machineId`),
    token: boundedString(value.token, 2_048, `${label} token`),
    keyVersion: boundedInteger(
      value.keyVersion,
      1,
      1_000_000,
      `${label} keyVersion`,
    ),
  };
}

// ---------------------------------------------------------------------------
// The durable machine record
// ---------------------------------------------------------------------------

/**
 * One registered machine, as the User Durable Object holds it.
 *
 * `tokenDigest` and not the token: "no secrets client-side" has a mirror on
 * the server, which is that durable state holds what *proves* a secret and
 * never the secret. `connected` is absent on purpose — it is whether the
 * machine holds an open socket to the User Durable Object, which the object's
 * own socket list answers and which an eviction cannot leave stale.
 * `lastSeenAt` is the last time the machine connected, disconnected, claimed
 * or reported.
 */
export interface MachineRecordV1 {
  schemaVersion: 1;
  machineId: string;
  userId: string;
  label: string;
  platform: MachinePlatformV1;
  agentVersion: string;
  capabilities: MachineCapabilityV1[];
  registeredAt: string;
  lastSeenAt: string;
  keyVersion: number;
  tokenDigest: string;
  revokedAt?: string;
}

const DIGEST = /^[0-9a-f]{64}$/;

export function decodeMachineRecordV1(
  input: unknown,
  label = "machine record",
): MachineRecordV1 {
  const value = object(input, label);
  exactly(
    value,
    [
      "schemaVersion",
      "machineId",
      "userId",
      "label",
      "platform",
      "agentVersion",
      "capabilities",
      "registeredAt",
      "lastSeenAt",
      "keyVersion",
      "tokenDigest",
      "revokedAt",
    ],
    label,
  );
  const platform = literal(
    value.platform,
    MACHINE_PLATFORMS_V1,
    `${label} platform`,
  );
  if (
    typeof value.tokenDigest !== "string" ||
    !DIGEST.test(value.tokenDigest)
  ) {
    fail(`${label} tokenDigest is invalid`);
  }
  return {
    schemaVersion: schemaVersion(value, label),
    machineId: decodeMachineIdV1(value.machineId, `${label} machineId`),
    userId: identifier(value.userId, `${label} userId`),
    label: boundedString(
      value.label,
      MACHINE_LIMITS_V1.label,
      `${label} label`,
    ),
    platform,
    agentVersion: boundedString(
      value.agentVersion,
      MACHINE_LIMITS_V1.agentVersion,
      `${label} agentVersion`,
    ),
    capabilities: capabilities(value.capabilities, `${label} capabilities`),
    registeredAt: timestamp(value.registeredAt, `${label} registeredAt`),
    lastSeenAt: timestamp(value.lastSeenAt, `${label} lastSeenAt`),
    keyVersion: boundedInteger(
      value.keyVersion,
      1,
      1_000_000,
      `${label} keyVersion`,
    ),
    tokenDigest: value.tokenDigest,
    ...(value.revokedAt === undefined
      ? {}
      : { revokedAt: timestamp(value.revokedAt, `${label} revokedAt`) }),
  };
}

// ---------------------------------------------------------------------------
// The command queue
// ---------------------------------------------------------------------------

/**
 * One queued command.
 *
 * `commandId` is derived from the Bot Durable Object's durable tool-call
 * occurrence, which is what makes the whole path idempotent: a dispatch
 * replayed after an eviction addresses the same queue key, a second claim
 * answers `already-claimed`, and a result for a command already terminal
 * answers `replayed` and changes nothing.
 */
export interface MachineCommandV1 {
  schemaVersion: 1;
  commandId: string;
  machineId: string;
  botId: string;
  runId: string;
  turn: number;
  approvalId: string;
  op: MachineOpV1;
  issuedAt: string;
  status: MachineCommandStatusV1;
  claimedAt?: string;
  leaseExpiresAt?: string;
}

export function decodeMachineCommandV1(
  input: unknown,
  label = "machine command",
): MachineCommandV1 {
  const value = object(input, label);
  exactly(
    value,
    [
      "schemaVersion",
      "commandId",
      "machineId",
      "botId",
      "runId",
      "turn",
      "approvalId",
      "op",
      "issuedAt",
      "status",
      "claimedAt",
      "leaseExpiresAt",
    ],
    label,
  );
  return {
    schemaVersion: schemaVersion(value, label),
    commandId: identifier(value.commandId, `${label} commandId`),
    machineId: decodeMachineIdV1(value.machineId, `${label} machineId`),
    botId: identifier(value.botId, `${label} botId`),
    runId: identifier(value.runId, `${label} runId`),
    turn: boundedInteger(value.turn, 0, 1_000_000, `${label} turn`),
    approvalId: identifier(value.approvalId, `${label} approvalId`),
    op: decodeMachineOpV1(value.op, `${label} op`),
    issuedAt: timestamp(value.issuedAt, `${label} issuedAt`),
    status: literal(
      value.status,
      MACHINE_COMMAND_STATUSES_V1,
      `${label} status`,
    ),
    ...(value.claimedAt === undefined
      ? {}
      : { claimedAt: timestamp(value.claimedAt, `${label} claimedAt`) }),
    ...(value.leaseExpiresAt === undefined
      ? {}
      : {
          leaseExpiresAt: timestamp(
            value.leaseExpiresAt,
            `${label} leaseExpiresAt`,
          ),
        }),
  };
}

/** The close code a revoked machine's socket is ended with. */
export const MACHINE_SOCKET_REVOKED_CODE_V1 = 4001;

/**
 * One device module the desktop should run (ADR 0037): a member's stored
 * artifact joined with what its descriptor declares, so the desktop builds
 * both boundaries from the same frame that names the bytes.
 */
export interface MachineModuleV1 {
  pluginId: string;
  moduleId: string;
  /** sha-256 hex of the artifact the module route serves. */
  contentHash: string;
  size: number;
  read: string[];
  net: string[];
  appleEvents: string[];
  calls: string[];
  events: string[];
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
const MODULE_ID = /^[a-z][a-z0-9-]{0,31}$/;
const CONTENT_HASH = /^[0-9a-f]{64}$/;

function pattern(input: unknown, rule: RegExp, label: string): string {
  const value = boundedString(input, MACHINE_LIMITS_V1.identifier, label);
  if (!rule.test(value)) fail(`${label} is invalid`);
  return value;
}

/** A declared list: the descriptor decoded each entry, this bounds the wire. */
function declared(input: unknown, label: string): string[] {
  if (!Array.isArray(input)) fail(`${label} must be an array`);
  const values = input as unknown[];
  if (values.length > MACHINE_LIMITS_V1.moduleDeclarations) {
    throw new MachineDecodeError(
      `${label} exceeds ${MACHINE_LIMITS_V1.moduleDeclarations} entries`,
      "limit-exceeded",
    );
  }
  return values.map((entry, index) => {
    const value = boundedString(entry, 512, `${label} ${index}`);
    if (CONTROL_CHARACTERS.test(value)) {
      fail(`${label} ${index} must not contain control characters`);
    }
    return value;
  });
}

export function decodeMachineModuleV1(
  input: unknown,
  label = "machine module",
): MachineModuleV1 {
  const value = object(input, label);
  exactly(
    value,
    [
      "pluginId",
      "moduleId",
      "contentHash",
      "size",
      "read",
      "net",
      "appleEvents",
      "calls",
      "events",
    ],
    label,
  );
  return {
    pluginId: pattern(value.pluginId, PLUGIN_ID, `${label} pluginId`),
    moduleId: pattern(value.moduleId, MODULE_ID, `${label} moduleId`),
    contentHash: pattern(
      value.contentHash,
      CONTENT_HASH,
      `${label} contentHash`,
    ),
    size: boundedInteger(
      value.size,
      0,
      MACHINE_LIMITS_V1.moduleBytes,
      `${label} size`,
    ),
    read: declared(value.read, `${label} read`),
    net: declared(value.net, `${label} net`),
    appleEvents: declared(value.appleEvents, `${label} appleEvents`),
    calls: declared(value.calls, `${label} calls`),
    events: declared(value.events, `${label} events`),
  };
}

/**
 * A frame the User Durable Object sends down a machine's socket.
 *
 * The channel is server-push only, so this is the one direction that carries
 * frames. `commands` is sent on connect with everything still waiting, and
 * after each dispatch or lease lapse with what became claimable. A command may
 * arrive twice; the claim is what stops it running twice. `modules` follows it
 * on connect and is sent again whenever the account's active Composition
 * generation changes; each one is the whole list, so the latest replaces what
 * came before. `call` carries one Plugin's call to its device module, sent
 * to the one machine chosen to run it. `serverTime` is the backend's clock, since the laptop's may
 * have been asleep.
 */
export type MachineSocketFrameV1 =
  | { type: "commands"; commands: MachineCommandV1[]; serverTime: string }
  | { type: "modules"; modules: MachineModuleV1[]; serverTime: string }
  | MachineModuleCallFrameV1;

/**
 * One call a Plugin's cloud code makes to its device module (ADR 0037). It is
 * sent once, to one machine; the claim is what stops it running twice, and a
 * call claimed at or after `deadline` is refused. The desktop measures the
 * deadline against `serverTime`, not its own clock.
 */
export interface MachineModuleCallFrameV1 {
  type: "call";
  callId: string;
  pluginId: string;
  moduleId: string;
  call: string;
  input: unknown;
  deadline: string;
  serverTime: string;
}

/** A JSON value no larger than `moduleCallJson` once serialized. */
function moduleCallJson(input: unknown, label: string): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(input);
  } catch {
    fail(`${label} must be JSON`);
  }
  if (text === undefined) fail(`${label} must be JSON`);
  if (text!.length > MACHINE_LIMITS_V1.moduleCallJson) {
    throw new MachineDecodeError(
      `${label} exceeds ${MACHINE_LIMITS_V1.moduleCallJson} characters of JSON`,
      "limit-exceeded",
    );
  }
  return input;
}

export function decodeMachineModuleCallFrameV1(
  input: unknown,
  label = "module call frame",
): MachineModuleCallFrameV1 {
  const value = object(input, label);
  exactly(
    value,
    [
      "type",
      "callId",
      "pluginId",
      "moduleId",
      "call",
      "input",
      "deadline",
      "serverTime",
    ],
    label,
  );
  if (value.type !== "call") fail(`${label} type must be call`);
  const call = boundedString(value.call, 64, `${label} call`);
  if (CONTROL_CHARACTERS.test(call)) fail(`${label} call is invalid`);
  return {
    type: "call",
    callId: identifier(value.callId, `${label} callId`),
    pluginId: pattern(value.pluginId, PLUGIN_ID, `${label} pluginId`),
    moduleId: pattern(value.moduleId, MODULE_ID, `${label} moduleId`),
    call,
    input: moduleCallJson(value.input ?? null, `${label} input`),
    deadline: timestamp(value.deadline, `${label} deadline`),
    serverTime: timestamp(value.serverTime, `${label} serverTime`),
  };
}

function boundedList(
  input: unknown,
  maximum: number,
  label: string,
): unknown[] {
  if (!Array.isArray(input)) fail(`${label} must be an array`);
  const values = input as unknown[];
  if (values.length > maximum) {
    throw new MachineDecodeError(
      `${label} exceeds ${maximum} entries`,
      "limit-exceeded",
    );
  }
  return values;
}

export function decodeMachineSocketFrameV1(
  input: unknown,
  label = "machine socket frame",
): MachineSocketFrameV1 {
  const value = object(input, label);
  if (value.type === "call")
    return decodeMachineModuleCallFrameV1(value, label);
  if (value.type === "modules") {
    exactly(value, ["type", "modules", "serverTime"], label);
    return {
      type: "modules",
      modules: boundedList(
        value.modules,
        MACHINE_LIMITS_V1.modules,
        `${label} modules`,
      ).map((module, index) =>
        decodeMachineModuleV1(module, `${label} module ${index}`),
      ),
      serverTime: timestamp(value.serverTime, `${label} serverTime`),
    };
  }
  exactly(value, ["type", "commands", "serverTime"], label);
  if (value.type !== "commands") fail(`${label} type is unsupported`);
  return {
    type: "commands",
    commands: boundedList(
      value.commands,
      MACHINE_LIMITS_V1.maxQueue,
      `${label} commands`,
    ).map((command, index) =>
      decodeMachineCommandV1(command, `${label} command ${index}`),
    ),
    serverTime: timestamp(value.serverTime, `${label} serverTime`),
  };
}

// ---------------------------------------------------------------------------
// Module reports
// ---------------------------------------------------------------------------

export type MachineModuleStateV1 =
  "starting" | "running" | "crashed" | "stopped";

export const MACHINE_MODULE_STATES_V1: readonly MachineModuleStateV1[] = [
  "starting",
  "running",
  "crashed",
  "stopped",
];

export const MACHINE_MODULE_LOG_LEVELS_V1 = ["log", "error"] as const;

/**
 * What the desktop's module host says about one module: a state change, or a
 * line the module logged. The vocabulary is the supervisor's own
 * (`apps/device-host/src/supervisor.ts`), addressed by Plugin and module.
 */
export type MachineModuleReportV1 =
  | {
      pluginId: string;
      moduleId: string;
      kind: "state";
      state: MachineModuleStateV1;
      detail?: string;
    }
  | {
      pluginId: string;
      moduleId: string;
      kind: "log";
      level: (typeof MACHINE_MODULE_LOG_LEVELS_V1)[number];
      text: string;
    };

export interface MachineModuleReportsV1 {
  reports: MachineModuleReportV1[];
}

function reportText(input: unknown, label: string): string {
  return boundedString(input, MACHINE_LIMITS_V1.moduleReportText, label);
}

export function decodeMachineModuleReportV1(
  input: unknown,
  label = "module report",
): MachineModuleReportV1 {
  const value = object(input, label);
  const pluginId = pattern(value.pluginId, PLUGIN_ID, `${label} pluginId`);
  const moduleId = pattern(value.moduleId, MODULE_ID, `${label} moduleId`);
  if (value.kind === "state") {
    exactly(value, ["pluginId", "moduleId", "kind", "state", "detail"], label);
    return {
      pluginId,
      moduleId,
      kind: "state",
      state: literal(value.state, MACHINE_MODULE_STATES_V1, `${label} state`),
      ...(value.detail === undefined
        ? {}
        : { detail: reportText(value.detail, `${label} detail`) }),
    };
  }
  exactly(value, ["pluginId", "moduleId", "kind", "level", "text"], label);
  if (value.kind !== "log") fail(`${label} kind must be state or log`);
  return {
    pluginId,
    moduleId,
    kind: "log",
    level: literal(value.level, MACHINE_MODULE_LOG_LEVELS_V1, `${label} level`),
    text: reportText(value.text, `${label} text`),
  };
}

export function decodeMachineModuleReportsV1(
  input: unknown,
  label = "module reports",
): MachineModuleReportsV1 {
  const value = object(input, label);
  exactly(value, ["reports"], label);
  return {
    reports: boundedList(
      value.reports,
      MACHINE_LIMITS_V1.moduleReports,
      `${label} reports`,
    ).map((report, index) =>
      decodeMachineModuleReportV1(report, `${label} report ${index}`),
    ),
  };
}

/**
 * The answer to posted reports. `dropped` counts reports for a Plugin or
 * module the active generation does not carry: a desktop still running the
 * last generation says so for a moment, and it is not an error.
 */
export interface MachineModuleReportsReceiptV1 {
  schemaVersion: 1;
  recorded: number;
  dropped: number;
}

export function decodeMachineModuleReportsReceiptV1(
  input: unknown,
  label = "module reports receipt",
): MachineModuleReportsReceiptV1 {
  const value = object(input, label);
  exactly(value, ["schemaVersion", "recorded", "dropped"], label);
  return {
    schemaVersion: schemaVersion(value, label),
    recorded: boundedInteger(
      value.recorded,
      0,
      MACHINE_LIMITS_V1.moduleReports,
      `${label} recorded`,
    ),
    dropped: boundedInteger(
      value.dropped,
      0,
      MACHINE_LIMITS_V1.moduleReports,
      `${label} dropped`,
    ),
  };
}

/**
 * The answer to a module call's claim. `refused` means do not run it: the
 * call is past its deadline, already claimed, or not this machine's.
 */
export interface MachineModuleCallClaimReceiptV1 {
  schemaVersion: 1;
  status: "claimed" | "refused";
  callId: string;
}

export const MACHINE_MODULE_CALL_CLAIM_STATUSES_V1 = [
  "claimed",
  "refused",
] as const;

export function decodeMachineModuleCallClaimReceiptV1(
  input: unknown,
  label = "module call claim receipt",
): MachineModuleCallClaimReceiptV1 {
  const value = object(input, label);
  exactly(value, ["schemaVersion", "status", "callId"], label);
  return {
    schemaVersion: schemaVersion(value, label),
    status: literal(
      value.status,
      MACHINE_MODULE_CALL_CLAIM_STATUSES_V1,
      `${label} status`,
    ),
    callId: identifier(value.callId, `${label} callId`),
  };
}

/** What the module answered, as the desktop posts it. */
export type MachineModuleCallResultV1 =
  { ok: true; value: unknown } | { ok: false; error: string };

export function decodeMachineModuleCallResultV1(
  input: unknown,
  label = "module call result",
): MachineModuleCallResultV1 {
  const value = object(input, label);
  if (value.ok === true) {
    exactly(value, ["ok", "value"], label);
    return {
      ok: true,
      value: moduleCallJson(value.value ?? null, `${label} value`),
    };
  }
  exactly(value, ["ok", "error"], label);
  if (value.ok !== false) fail(`${label} ok must be a boolean`);
  return {
    ok: false,
    error: boundedString(
      value.error,
      MACHINE_LIMITS_V1.moduleCallError,
      `${label} error`,
    ),
  };
}

/**
 * The answer to a posted module result. `late` means it arrived after the
 * call's deadline: it is kept for the Work view and never reaches the model.
 */
export interface MachineModuleCallResultReceiptV1 {
  schemaVersion: 1;
  status: "recorded" | "late" | "replayed";
  callId: string;
}

export const MACHINE_MODULE_CALL_RESULT_STATUSES_V1 = [
  "recorded",
  "late",
  "replayed",
] as const;

export function decodeMachineModuleCallResultReceiptV1(
  input: unknown,
  label = "module call result receipt",
): MachineModuleCallResultReceiptV1 {
  const value = object(input, label);
  exactly(value, ["schemaVersion", "status", "callId"], label);
  return {
    schemaVersion: schemaVersion(value, label),
    status: literal(
      value.status,
      MACHINE_MODULE_CALL_RESULT_STATUSES_V1,
      `${label} status`,
    ),
    callId: identifier(value.callId, `${label} callId`),
  };
}

/**
 * The answer to a claim. `already-claimed` is not an error: a duplicate
 * delivery is expected on a protocol that survives dropped sockets, and saying
 * so plainly is what stops the same command running twice.
 */
export interface MachineClaimReceiptV1 {
  schemaVersion: 1;
  status: "claimed" | "already-claimed";
  commandId: string;
  leaseExpiresAt: string;
}

export const MACHINE_CLAIM_STATUSES_V1 = [
  "claimed",
  "already-claimed",
] as const;

export function decodeMachineClaimReceiptV1(
  input: unknown,
  label = "machine claim receipt",
): MachineClaimReceiptV1 {
  const value = object(input, label);
  exactly(
    value,
    ["schemaVersion", "status", "commandId", "leaseExpiresAt"],
    label,
  );
  return {
    schemaVersion: schemaVersion(value, label),
    status: literal(value.status, MACHINE_CLAIM_STATUSES_V1, `${label} status`),
    commandId: identifier(value.commandId, `${label} commandId`),
    leaseExpiresAt: timestamp(value.leaseExpiresAt, `${label} leaseExpiresAt`),
  };
}

/**
 * What the machine reports back. `truncated` is required rather than implied:
 * output cut at a bound is a different fact from output that ended, and the
 * Bot is told which.
 */
export interface MachineCommandResultV1 {
  schemaVersion: 1;
  commandId: string;
  finishedAt: string;
  outcome: MachineCommandOutcomeV1;
  truncated: boolean;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
  bytesBase64?: string;
  message?: string;
}

export function decodeMachineCommandResultV1(
  input: unknown,
  label = "machine command result",
): MachineCommandResultV1 {
  const value = object(input, label);
  exactly(
    value,
    [
      "schemaVersion",
      "commandId",
      "finishedAt",
      "outcome",
      "truncated",
      "exitCode",
      "stdout",
      "stderr",
      "bytesBase64",
      "message",
    ],
    label,
  );
  const stream = (key: "stdout" | "stderr"): string => {
    const held = value[key];
    if (typeof held !== "string") fail(`${label} ${key} must be a string`);
    if ((held as string).length > MACHINE_LIMITS_V1.outputBytes) {
      throw new MachineDecodeError(
        `${label} ${key} exceeds ${MACHINE_LIMITS_V1.outputBytes} bytes`,
        "limit-exceeded",
      );
    }
    return held as string;
  };
  return {
    schemaVersion: schemaVersion(value, label),
    commandId: identifier(value.commandId, `${label} commandId`),
    finishedAt: timestamp(value.finishedAt, `${label} finishedAt`),
    outcome: literal(
      value.outcome,
      MACHINE_COMMAND_OUTCOMES_V1,
      `${label} outcome`,
    ),
    truncated: boolean(value.truncated, `${label} truncated`),
    ...(value.exitCode === undefined
      ? {}
      : {
          exitCode: boundedInteger(
            value.exitCode,
            -256,
            256,
            `${label} exitCode`,
          ),
        }),
    ...(value.stdout === undefined ? {} : { stdout: stream("stdout") }),
    ...(value.stderr === undefined ? {} : { stderr: stream("stderr") }),
    ...(value.bytesBase64 === undefined
      ? {}
      : {
          bytesBase64: base64Field(value.bytesBase64, `${label} bytesBase64`),
        }),
    ...(value.message === undefined
      ? {}
      : {
          message: boundedString(
            value.message,
            MACHINE_LIMITS_V1.message,
            `${label} message`,
          ),
        }),
  };
}

/** The answer to a posted result. A replay is recorded once and reported. */
export interface MachineResultReceiptV1 {
  schemaVersion: 1;
  status: "recorded" | "replayed";
  commandId: string;
}

export const MACHINE_RESULT_STATUSES_V1 = ["recorded", "replayed"] as const;

export function decodeMachineResultReceiptV1(
  input: unknown,
  label = "machine result receipt",
): MachineResultReceiptV1 {
  const value = object(input, label);
  exactly(value, ["schemaVersion", "status", "commandId"], label);
  return {
    schemaVersion: schemaVersion(value, label),
    status: literal(
      value.status,
      MACHINE_RESULT_STATUSES_V1,
      `${label} status`,
    ),
    commandId: identifier(value.commandId, `${label} commandId`),
  };
}

// ---------------------------------------------------------------------------
// The registry projection
// ---------------------------------------------------------------------------

/**
 * One row of `ListMachines` (§2.16), and one row of the Computer settings
 * section. It carries no digest, no key version and no user id: a projection
 * hands out what the surface renders and nothing that proves anything.
 */
export interface MachineListEntryV1 {
  machineId: string;
  label: string;
  platform: MachinePlatformV1;
  capabilities: MachineCapabilityV1[];
  connected: boolean;
  lastSeenAt: string;
  registeredAt: string;
  revokedAt?: string;
}

export interface MachineListViewV1 {
  schemaVersion: 1;
  machines: MachineListEntryV1[];
  serverTime: string;
}

/**
 * The projection, pure. `connected` is the caller's: whether the machine holds
 * an open socket is something only the User Durable Object can see.
 */
export function machineListEntryV1(
  record: MachineRecordV1,
  connected: boolean,
): MachineListEntryV1 {
  return {
    machineId: record.machineId,
    label: record.label,
    platform: record.platform,
    capabilities: [...record.capabilities],
    connected: record.revokedAt === undefined && connected,
    lastSeenAt: record.lastSeenAt,
    registeredAt: record.registeredAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
  };
}

export function decodeMachineListEntryV1(
  input: unknown,
  label = "machine list entry",
): MachineListEntryV1 {
  const value = object(input, label);
  exactly(
    value,
    [
      "machineId",
      "label",
      "platform",
      "capabilities",
      "connected",
      "lastSeenAt",
      "registeredAt",
      "revokedAt",
    ],
    label,
  );
  const platform = literal(
    value.platform,
    MACHINE_PLATFORMS_V1,
    `${label} platform`,
  );
  return {
    machineId: decodeMachineIdV1(value.machineId, `${label} machineId`),
    label: boundedString(
      value.label,
      MACHINE_LIMITS_V1.label,
      `${label} label`,
    ),
    platform,
    capabilities: capabilities(value.capabilities, `${label} capabilities`),
    connected: boolean(value.connected, `${label} connected`),
    lastSeenAt: timestamp(value.lastSeenAt, `${label} lastSeenAt`),
    registeredAt: timestamp(value.registeredAt, `${label} registeredAt`),
    ...(value.revokedAt === undefined
      ? {}
      : { revokedAt: timestamp(value.revokedAt, `${label} revokedAt`) }),
  };
}

export function decodeMachineListViewV1(
  input: unknown,
  label = "machine list view",
): MachineListViewV1 {
  const value = object(input, label);
  exactly(value, ["schemaVersion", "machines", "serverTime"], label);
  if (!Array.isArray(value.machines))
    fail(`${label} machines must be an array`);
  if (value.machines.length > MACHINE_LIMITS_V1.maxMachinesPerUser) {
    throw new MachineDecodeError(
      `${label} exceeds ${MACHINE_LIMITS_V1.maxMachinesPerUser} machines`,
      "limit-exceeded",
    );
  }
  return {
    schemaVersion: schemaVersion(value, label),
    machines: value.machines.map((entry, index) =>
      decodeMachineListEntryV1(entry, `${label} entry ${index}`),
    ),
    serverTime: timestamp(value.serverTime, `${label} serverTime`),
  };
}
