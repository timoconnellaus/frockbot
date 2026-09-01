/**
 * The versioned wire protocol between FrockBot's backend and a registered
 * machine of the User's — the parity register's "registered Mac" (§2.16).
 *
 * The machine is not the Computer and not the Workspace: it is a separate
 * filesystem the backend can never dial. `127.0.0.1` from the box is the box,
 * and a laptop behind NAT has no inbound address, so every exchange here is
 * one the *machine* starts: it enrolls, it long-polls for work, it claims a
 * command, it posts a result. Nothing in this module opens a socket, reads a
 * clock it was not handed, or touches storage; it is DTOs, their decoders, and
 * the arithmetic that turns a stored timestamp into `connected`.
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
  /** How stale `lastSeenAt` may be before a machine reads as disconnected. */
  presenceTtlMs: 90_000,
  /** How long a pairing offer stands before it is spent or expires. */
  pairingTtlMs: 5 * 60_000,
  /** The longest a long poll is held before it answers empty. */
  pollMaxWaitSeconds: 25,
  /** How long a claim holds a command before the lease may be reclaimed. */
  leaseMs: 120_000,
} as const;

/** `now - lastSeenAt` past this and the machine is no longer connected. */
export const MACHINE_PRESENCE_TTL_MS = MACHINE_LIMITS_V1.presenceTtlMs;
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
 * Every other identifier the protocol carries. Colons are legal because a
 * `commandId` *is* the Bot Durable Object's `effectId`
 * (`tool:<turn>:<step>:<ordinal>`) — that identity is what makes a retried
 * dispatch idempotent.
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
 * `exec` refuses visibly against a machine that did not report it, and only a
 * `macos` agent may report `messages`.
 */
export type MachineCapabilityV1 = "exec" | "files" | "messages";

export const MACHINE_CAPABILITIES_V1: readonly MachineCapabilityV1[] = [
  "exec",
  "files",
  "messages",
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
// Messages.app (register row 57g)
// ---------------------------------------------------------------------------

/**
 * What a Messages call may carry.
 *
 * Separate from `MACHINE_LIMITS_V1` because these are the *content* bounds of
 * one capability rather than the transport's: a search term, a chat id, the
 * body of a message somebody is about to send. They are declared here, in the
 * protocol, for the same reason every other bound is — the tool, the queue and
 * the agent that reads `chat.db` must all refuse at the same size.
 */
export const MACHINE_MESSAGES_LIMITS_V1 = {
  /** A search term, or a chat filter. */
  query: 512,
  /** A chat's guid or its `chat_identifier`. */
  chatId: 256,
  /** A handle a message is addressed to — a phone number, an Apple ID, a guid. */
  recipient: 256,
  /** The body of one outbound message. */
  text: 4_096,
  /** An attachment's row id or guid, as a chat item reports it. */
  attachmentId: 256,
  /** The most rows one read may ask for, and the default it takes without one. */
  rows: 200,
  defaultRows: 50,
  /** The most one attachment may return. */
  attachmentBytes: 8 * 1_024 * 1_024,
  /** Free text on a permission report, e.g. the macOS error that named it. */
  detail: 512,
} as const;

export interface MachineMessagesCheckPermissionsCallV1 {
  kind: "check-permissions";
}

export interface MachineMessagesFindChatsCallV1 {
  kind: "find-chats";
  query?: string;
  limit: number;
}

export interface MachineMessagesChatItemsCallV1 {
  kind: "chat-items";
  chatId: string;
  limit: number;
  /** Page backwards: only items older than this `message.ROWID`. */
  beforeRowId?: number;
}

export interface MachineMessagesSearchCallV1 {
  kind: "search";
  query: string;
  limit: number;
}

export interface MachineMessagesActivityCallV1 {
  kind: "activity";
  limit: number;
}

export interface MachineMessagesFetchAttachmentCallV1 {
  kind: "fetch-attachment";
  attachmentId: string;
  maxBytes: number;
}

export interface MachineMessagesSendCallV1 {
  kind: "send";
  to: string;
  text: string;
}

/**
 * The seven Messages calls of §4.2, one per GrokBot tool:
 * `CheckIMessagePermissions`, `FindIMessageChats`, `ChatItems`,
 * `SearchIMessages`, `IMessageActivity`, `FetchIMessageAttachment`,
 * `SendIMessage`.
 *
 * They ride the *same* command queue as `exec` and `read`. That is what keeps
 * the register's "per-platform Package" from meaning "second protocol": the
 * Messages Package builds one of these, wraps it in `{kind:"messages"}` and
 * hands it to the transport that already exists.
 */
export type MachineMessagesCallV1 =
  | MachineMessagesCheckPermissionsCallV1
  | MachineMessagesFindChatsCallV1
  | MachineMessagesChatItemsCallV1
  | MachineMessagesSearchCallV1
  | MachineMessagesActivityCallV1
  | MachineMessagesFetchAttachmentCallV1
  | MachineMessagesSendCallV1;

export type MachineMessagesCallKindV1 = MachineMessagesCallV1["kind"];

export const MACHINE_MESSAGES_CALL_KINDS_V1: readonly MachineMessagesCallKindV1[] =
  [
    "check-permissions",
    "find-chats",
    "chat-items",
    "search",
    "activity",
    "fetch-attachment",
    "send",
  ];

/**
 * Whether a call reads or acts.
 *
 * The whole of the plan's open decision 4 turns on this one predicate: the six
 * reads are exempt from a per-call approval card, and `send` — an outbound
 * external message — always takes one.
 */
export function machineMessagesCallIsReadV1(
  call: MachineMessagesCallV1,
): boolean {
  return call.kind !== "send";
}

export function decodeMachineMessagesCallV1(
  input: unknown,
  label = "messages call",
): MachineMessagesCallV1 {
  const value = object(input, label);
  const kind = literal(
    value.kind,
    MACHINE_MESSAGES_CALL_KINDS_V1,
    `${label} kind`,
  );
  const rows = (candidate: unknown): number =>
    boundedInteger(
      candidate,
      1,
      MACHINE_MESSAGES_LIMITS_V1.rows,
      `${label} limit`,
    );
  if (kind === "check-permissions") {
    exactly(value, ["kind"], `${label} check-permissions`);
    return { kind };
  }
  if (kind === "find-chats") {
    exactly(value, ["kind", "query", "limit"], `${label} find-chats`);
    return {
      kind,
      ...(value.query === undefined
        ? {}
        : {
            query: boundedString(
              value.query,
              MACHINE_MESSAGES_LIMITS_V1.query,
              `${label} query`,
            ),
          }),
      limit: rows(value.limit),
    };
  }
  if (kind === "chat-items") {
    exactly(
      value,
      ["kind", "chatId", "limit", "beforeRowId"],
      `${label} chat-items`,
    );
    return {
      kind,
      chatId: boundedString(
        value.chatId,
        MACHINE_MESSAGES_LIMITS_V1.chatId,
        `${label} chatId`,
      ),
      limit: rows(value.limit),
      ...(value.beforeRowId === undefined
        ? {}
        : {
            beforeRowId: boundedInteger(
              value.beforeRowId,
              1,
              Number.MAX_SAFE_INTEGER,
              `${label} beforeRowId`,
            ),
          }),
    };
  }
  if (kind === "search") {
    exactly(value, ["kind", "query", "limit"], `${label} search`);
    return {
      kind,
      query: boundedString(
        value.query,
        MACHINE_MESSAGES_LIMITS_V1.query,
        `${label} query`,
      ),
      limit: rows(value.limit),
    };
  }
  if (kind === "activity") {
    exactly(value, ["kind", "limit"], `${label} activity`);
    return { kind, limit: rows(value.limit) };
  }
  if (kind === "fetch-attachment") {
    exactly(
      value,
      ["kind", "attachmentId", "maxBytes"],
      `${label} fetch-attachment`,
    );
    return {
      kind,
      attachmentId: boundedString(
        value.attachmentId,
        MACHINE_MESSAGES_LIMITS_V1.attachmentId,
        `${label} attachmentId`,
      ),
      maxBytes: boundedInteger(
        value.maxBytes,
        1,
        MACHINE_MESSAGES_LIMITS_V1.attachmentBytes,
        `${label} maxBytes`,
      ),
    };
  }
  exactly(value, ["kind", "to", "text"], `${label} send`);
  return {
    kind,
    to: boundedString(
      value.to,
      MACHINE_MESSAGES_LIMITS_V1.recipient,
      `${label} to`,
    ),
    text: boundedString(
      value.text,
      MACHINE_MESSAGES_LIMITS_V1.text,
      `${label} text`,
    ),
  };
}

/**
 * What macOS has granted the agent, as the agent reports it.
 *
 * Row 57g's third gate. Neither flag can be *granted* from here — TCC consent
 * is the User's, given in System Settings — so the protocol carries only what
 * was observed and when: reading `~/Library/Messages/chat.db` needs Full Disk
 * Access, and telling Messages.app to send needs Automation rights.
 */
export interface MachineMessagesPermissionsV1 {
  schemaVersion: 1;
  fullDiskAccess: boolean;
  automation: boolean;
  checkedAt: string;
  /** Whatever macOS said, when it said anything. Never a path to a secret. */
  detail?: string;
}

export function decodeMachineMessagesPermissionsV1(
  input: unknown,
  label = "messages permissions",
): MachineMessagesPermissionsV1 {
  const value = object(input, label);
  exactly(
    value,
    ["schemaVersion", "fullDiskAccess", "automation", "checkedAt", "detail"],
    label,
  );
  return {
    schemaVersion: schemaVersion(value, label),
    fullDiskAccess: boolean(value.fullDiskAccess, `${label} fullDiskAccess`),
    automation: boolean(value.automation, `${label} automation`),
    checkedAt: timestamp(value.checkedAt, `${label} checkedAt`),
    ...(value.detail === undefined
      ? {}
      : {
          detail: boundedString(
            value.detail,
            MACHINE_MESSAGES_LIMITS_V1.detail,
            `${label} detail`,
          ),
        }),
  };
}

/**
 * Whether the last report clears a call to run at all.
 *
 * A report that was never taken is not a grant: an unknown permission refuses
 * exactly as a denied one does, and the remediation is the same sentence —
 * run the permission check.
 */
export function machineMessagesPermittedV1(
  call: MachineMessagesCallV1,
  permissions: MachineMessagesPermissionsV1 | undefined,
): boolean {
  if (call.kind === "check-permissions") return true;
  if (!permissions) return false;
  return call.kind === "send"
    ? permissions.fullDiskAccess && permissions.automation
    : permissions.fullDiskAccess;
}

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

/**
 * One Messages.app call, addressed to the registered Mac (register row 57g).
 *
 * It is an op like any other, which is the point: the Messages Package builds
 * one and hands it to this queue, so there is no second transport, no second
 * claim, and no second idempotency story.
 */
export interface MachineMessagesOpV1 {
  kind: "messages";
  call: MachineMessagesCallV1;
}

/**
 * What one command asks the machine to do.
 *
 * The `{kind:"messages"}` variant is row 57g's, added additively: widening this
 * union does not move the protocol version, which is the whole reason the
 * Messages Package needs no transport of its own.
 */
export type MachineOpV1 =
  | MachineExecOpV1
  | MachineReadOpV1
  | MachineCopyToComputerOpV1
  | MachineCopyFromComputerOpV1
  | MachineMessagesOpV1;

export type MachineOpKindV1 = MachineOpV1["kind"];

export const MACHINE_OP_KINDS_V1: readonly MachineOpKindV1[] = [
  "exec",
  "read",
  "copy-to-computer",
  "copy-from-computer",
  "messages",
];

/**
 * The capability an op requires of the machine that will run it.
 *
 * `messages` is its own capability rather than a flavour of `files`, and the
 * enrollment decoder refuses it from anything but a macOS agent: that is row
 * 57g's second gate, held in the one place every runtime already decodes.
 */
export function machineOpCapabilityV1(op: MachineOpV1): MachineCapabilityV1 {
  if (op.kind === "exec") return "exec";
  if (op.kind === "messages") return "messages";
  return "files";
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
  if (kind === "messages") {
    exactly(value, ["kind", "call"], `${label} messages`);
    return {
      kind,
      call: decodeMachineMessagesCallV1(value.call, `${label} call`),
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

function capabilities(
  input: unknown,
  platform: MachinePlatformV1,
  label: string,
): MachineCapabilityV1[] {
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
    // Row 57g's second gate: Messages.app is a macOS fact, so no other
    // platform's agent may claim it however loudly it asks.
    if (capability === "messages" && platform !== "macos") {
      fail(`${label} may only report messages on macos`);
    }
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
    capabilities: capabilities(
      value.capabilities,
      platform,
      `${label} capabilities`,
    ),
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
 * never the secret. `connected` is absent on purpose — it is arithmetic over
 * `lastSeenAt` (see `machineConnectedV1`), so a machine that stops polling
 * goes offline by itself with nothing to clean up after an eviction.
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
  /**
   * The last Messages permission report this machine sent (row 57g's third
   * gate). Absent until the permission check has been run once, and absent is
   * a refusal rather than a grant.
   */
  messagesPermissions?: MachineMessagesPermissionsV1;
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
      "messagesPermissions",
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
    capabilities: capabilities(
      value.capabilities,
      platform,
      `${label} capabilities`,
    ),
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
    ...(value.messagesPermissions === undefined
      ? {}
      : {
          messagesPermissions: decodeMachineMessagesPermissionsV1(
            value.messagesPermissions,
            `${label} messagesPermissions`,
          ),
        }),
  };
}

/**
 * `connected`, derived and never stored.
 *
 * A stored flag would need a writer on every disconnection, and the one event
 * that matters — a laptop that closes its lid — sends nothing. Presence is
 * therefore the absence of a revocation and the freshness of the last poll,
 * which is still true after an eviction with no recovery step at all.
 */
export function machineConnectedV1(
  record: Pick<MachineRecordV1, "lastSeenAt" | "revokedAt">,
  now: number | Date,
  ttlMs: number = MACHINE_PRESENCE_TTL_MS,
): boolean {
  if (record.revokedAt !== undefined) return false;
  const seen = Date.parse(record.lastSeenAt);
  if (Number.isNaN(seen)) return false;
  const at = typeof now === "number" ? now : now.getTime();
  const age = at - seen;
  // Two clocks are involved, so a `lastSeenAt` slightly ahead of the reader is
  // ordinary skew and still counts as present — but only within the same TTL,
  // so a wildly future timestamp cannot read as connected forever.
  return age >= -ttlMs && age <= ttlMs;
}

// ---------------------------------------------------------------------------
// The command queue
// ---------------------------------------------------------------------------

/**
 * One queued command.
 *
 * `commandId` is the Bot Durable Object's `effectId`, which is what makes the
 * whole path idempotent: a dispatch replayed after an eviction addresses the
 * same queue key, a second claim answers `already-claimed`, and a result for a
 * command already terminal answers `replayed` and changes nothing.
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

/**
 * What a long poll answers with. `serverTime` is carried so the agent can hold
 * its own backoff against the backend's clock rather than its laptop's, which
 * may have been asleep.
 */
export interface MachinePollResultV1 {
  schemaVersion: 1;
  commands: MachineCommandV1[];
  serverTime: string;
}

export function decodeMachinePollResultV1(
  input: unknown,
  label = "machine poll result",
): MachinePollResultV1 {
  const value = object(input, label);
  exactly(value, ["schemaVersion", "commands", "serverTime"], label);
  if (!Array.isArray(value.commands))
    fail(`${label} commands must be an array`);
  if (value.commands.length > MACHINE_LIMITS_V1.maxQueue) {
    throw new MachineDecodeError(
      `${label} exceeds ${MACHINE_LIMITS_V1.maxQueue} commands`,
      "limit-exceeded",
    );
  }
  return {
    schemaVersion: schemaVersion(value, label),
    commands: value.commands.map((command, index) =>
      decodeMachineCommandV1(command, `${label} command ${index}`),
    ),
    serverTime: timestamp(value.serverTime, `${label} serverTime`),
  };
}

/**
 * The answer to a claim. `already-claimed` is not an error: a duplicate
 * delivery is expected on a protocol that survives dropped polls, and saying
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
  /** The last Messages permission report, when one has been taken. */
  messagesPermissions?: MachineMessagesPermissionsV1;
}

export interface MachineListViewV1 {
  schemaVersion: 1;
  machines: MachineListEntryV1[];
  serverTime: string;
}

/** The projection, pure: the same record and clock give the same row. */
export function machineListEntryV1(
  record: MachineRecordV1,
  now: number | Date,
  ttlMs: number = MACHINE_PRESENCE_TTL_MS,
): MachineListEntryV1 {
  return {
    machineId: record.machineId,
    label: record.label,
    platform: record.platform,
    capabilities: [...record.capabilities],
    connected: machineConnectedV1(record, now, ttlMs),
    lastSeenAt: record.lastSeenAt,
    registeredAt: record.registeredAt,
    ...(record.revokedAt === undefined ? {} : { revokedAt: record.revokedAt }),
    ...(record.messagesPermissions === undefined
      ? {}
      : { messagesPermissions: record.messagesPermissions }),
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
      "messagesPermissions",
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
    capabilities: capabilities(
      value.capabilities,
      platform,
      `${label} capabilities`,
    ),
    connected: boolean(value.connected, `${label} connected`),
    lastSeenAt: timestamp(value.lastSeenAt, `${label} lastSeenAt`),
    registeredAt: timestamp(value.registeredAt, `${label} registeredAt`),
    ...(value.revokedAt === undefined
      ? {}
      : { revokedAt: timestamp(value.revokedAt, `${label} revokedAt`) }),
    ...(value.messagesPermissions === undefined
      ? {}
      : {
          messagesPermissions: decodeMachineMessagesPermissionsV1(
            value.messagesPermissions,
            `${label} messagesPermissions`,
          ),
        }),
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

// ---------------------------------------------------------------------------
// What a Messages call answers with
// ---------------------------------------------------------------------------

/**
 * A Messages reply rides the result DTO that already exists: the rows are JSON
 * in `stdout`, an attachment's bytes are in `bytesBase64`, and a refusal is
 * the `refused` outcome with its remediation in `message`. Nothing about the
 * result envelope changes, which is why row 57g moves no version.
 *
 * Only one shape is *decoded* rather than rendered — the permission report,
 * because the backend acts on it. Chats and messages are read out of somebody's
 * Messages.app and are tool-result content, fenced like every other tool result
 * and never instructions; decoding them strictly would buy nothing and would
 * make an unfamiliar row an error instead of a line the Bot can read.
 */
export const MACHINE_MESSAGES_REPLY_KINDS_V1 = [
  "permissions",
  "chats",
  "items",
  "attachment",
  "sent",
] as const;

export type MachineMessagesReplyKindV1 =
  (typeof MACHINE_MESSAGES_REPLY_KINDS_V1)[number];

/** The JSON body a Messages result carries in `stdout`. */
export interface MachineMessagesReplyEnvelopeV1 {
  kind: MachineMessagesReplyKindV1;
  [field: string]: unknown;
}

/**
 * The permission report a finished command carries, when it was one.
 *
 * Pure, and total: anything that is not an `ok` permission check answers
 * `undefined`, so the caller's rule is one line — a report updates the record,
 * and everything else leaves it exactly as it was. A machine that answers
 * nonsense to a permission check has *not* reported permissions, which is a
 * refusal, because "absent is not a grant".
 */
export function machineMessagesPermissionsFromResultV1(
  op: MachineOpV1,
  result: Pick<MachineCommandResultV1, "outcome" | "stdout">,
): MachineMessagesPermissionsV1 | undefined {
  if (op.kind !== "messages" || op.call.kind !== "check-permissions") {
    return undefined;
  }
  if (result.outcome !== "ok" || typeof result.stdout !== "string") {
    return undefined;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout) as unknown;
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return undefined;
  }
  const body = parsed as Record<string, unknown>;
  if (body.kind !== "permissions") return undefined;
  try {
    return decodeMachineMessagesPermissionsV1(
      body.permissions,
      "reported messages permissions",
    );
  } catch {
    return undefined;
  }
}
