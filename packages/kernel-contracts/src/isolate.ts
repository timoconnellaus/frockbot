// The Bot isolate boundary: every DTO that crosses between the Bot's Durable
// Object and a Dynamic Worker loaded for a non-first-party Package, plus the
// narrow interfaces the kernel declares for the host that mounts it.
//
// The shape follows `docs/plans/kernel-and-isolate.md` Step 4 with the three
// contract changes the Worker Loader spike forced
// (`docs/research/spike-worker-loader-from-do.md`):
//
//  1. `CAPABILITIES` cannot be an `RpcTarget` placed in `env` — workerd rejects
//     it with `DataCloneError`. It is a loopback service binding minted with
//     `ctx.exports.BotCapabilities({ props })`, so `BotCapabilitiesStub` is the
//     call surface of a `WorkerEntrypoint`, not of an `RpcTarget`. Per-invocation
//     narrowed objects are `RpcTarget`s *returned* from its methods.
//  2. `.get()` never throws; a broken artifact fails on the first RPC, so mount
//     and `health()` are one guarded phase.
//  3. A reused loader id silently serves the first code, so the id is derived
//     from the content address of the mounted modules and nothing else.
//
// Everything decoded here is untrusted: Bot-authored code produces the results
// and the capability requests, and the isolate produces the health report.
import type { TurnAdmissionV1 } from "./tool-execution.js";
import {
  BOT_ISOLATE_HOOK_EVENTS_V1,
  isBotIsolateHookEventNameV1,
  type BotIsolateHookEventNameV1,
  type LoopEventPayloadMapV1,
} from "./loop-events.js";
import {
  decodeTurnTypeV1,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type ToolSchema,
} from "./types.js";

/**
 * The wire contract version the kernel wrapper emits. Version 2 added
 * per-tool turn admission. Version 3 added declared loop hooks and hook RPC.
 */
export const ISOLATE_CONTRACT_VERSION = 3;

/** Every contract version the kernel still decodes. */
export type IsolateContractVersion = 1 | 2 | 3;

const ISOLATE_CONTRACT_VERSIONS: readonly IsolateContractVersion[] = [1, 2, 3];

/** The upper bound on a single isolate invocation, enforced on both sides. */
export const ISOLATE_MAX_DEADLINE_MS = 60_000;

const MAX_ISOLATE_TOOLS = 64;
const MAX_ISOLATE_CONNECTIONS = 100;
const MAX_ISOLATE_CONTENT = 1_000_000;
const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;

export interface IsolateToolDescriptorV1 {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  idempotent: boolean;
  /** Contract version 2 and later. Absent means every turn type. */
  admission?: TurnAdmissionV1;
}

export interface IsolateToolInvocationV1 {
  schemaVersion: 1;
  tool: string;
  input: unknown;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  deadlineMs: number;
}

export interface IsolateToolResultV1 {
  schemaVersion: 1;
  content: string;
  isError: boolean;
}

export interface IsolateHookInvocationV1<
  Event extends BotIsolateHookEventNameV1 = BotIsolateHookEventNameV1,
> {
  schemaVersion: 1;
  event: Event;
  payload: LoopEventPayloadMapV1[Event];
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  deadlineMs: number;
}

export type IsolateHookResultV1 =
  | { schemaVersion: 1; status: "unchanged" }
  | { schemaVersion: 1; status: "replaced"; replacement: unknown };

export interface IsolateHealthV1 {
  schemaVersion: 1;
  ok: boolean;
  packageId: string;
  contractVersion: IsolateContractVersion;
  tools: IsolateToolDescriptorV1[];
  /** Contract version 3 and later. */
  hooks?: BotIsolateHookEventNameV1[];
}

/** What `IDENTITY` carries into the isolate. Structured-clonable, never a stub. */
export interface IsolateIdentityV1 {
  botId: string;
  generationId: string;
  packageId: string;
}

/**
 * A capability call the authority could not serve. It is a declared variant,
 * not an exception: an error thrown across the loopback binding would surface
 * inside Bot code as an arbitrary host message, and Bot code has no contract
 * for that. The reason is normalized and bounded.
 */
export interface IsolateCapabilityFailureV1 {
  status: "unavailable";
  reason: string;
}

/** One safe Connection projection. Credentials and credential references never cross. */
export interface IsolateConnectionV1 {
  connectionId: string;
  packageId: string;
  connectionTypeId: string;
  displayName: string;
  generation: string;
  safeMetadata: Record<string, unknown>;
}

/** The Bot's configured model, resolved through one of its ready Connections. */
export interface IsolateModelBindingV1 {
  connectionId: string;
  packageId: string;
  provider: string;
  providerModelId: string;
  connectionGeneration: string;
  catalogGeneration?: string;
}

/** The per-Bot authority every Package in one Composition sees identically. */
export interface IsolateCapabilityListV1 {
  status: "available";
  connections: IsolateConnectionV1[];
  model?: IsolateModelBindingV1;
  tools: true;
  memory: boolean;
  workspace: boolean;
  notify: true;
  schedule: true;
}

export type IsolateCapabilityListOutcomeV1 =
  IsolateCapabilityListV1 | IsolateCapabilityFailureV1;

/** An opaque, short-lived reference to a Connection — never its credential. */
export interface IsolateConnectionLeaseV1 {
  status: "available";
  leaseId: string;
  connectionId: string;
  generation: string;
  expiresAt: string;
}

export type IsolateConnectionOutcomeV1 =
  IsolateConnectionLeaseV1 | IsolateCapabilityFailureV1;

export interface IsolateToolRequestV1 {
  callId: string;
  name: string;
  input: unknown;
}

export type IsolateToolOutcomeV1 =
  | { status: "completed"; content: string; isError: boolean }
  | IsolateCapabilityFailureV1;

export type IsolateMemoryScopeV1 = "bot" | "user" | "project";
export type IsolateMemoryTierV1 = "profile" | "log" | "note";
export interface IsolateMemoryReadRequestV1 {
  scope: IsolateMemoryScopeV1;
  projectId?: string;
}
export interface IsolateMemoryWriteRequestV1 extends IsolateMemoryReadRequestV1 {
  tier?: IsolateMemoryTierV1;
  fact: string;
}
export type IsolateMemoryOutcomeV1 =
  { status: "available"; value: unknown } | IsolateCapabilityFailureV1;

/** A root selector without a User id; the authority supplies its own User. */
export type IsolateWorkspaceRootV1 =
  | { kind: "bot-instructions"; botId: string }
  | { kind: "user-instructions" }
  | { kind: "package-declared"; packageId: string; rootId: string };
export interface IsolateWorkspacePathV1 {
  root: IsolateWorkspaceRootV1;
  path: string;
}
export interface IsolateWorkspaceListRequestV1 {
  root: IsolateWorkspaceRootV1;
  prefix?: string;
  cursor?: string;
  limit?: number;
}
export interface IsolateWorkspaceWriteRequestV1 {
  path: IsolateWorkspacePathV1;
  bytes: Uint8Array;
  expectedGenerationId: string | null;
  mediaType?: string;
}
export interface IsolateWorkspaceDeleteRequestV1 {
  path: IsolateWorkspacePathV1;
  expectedGenerationId: string;
}
export type IsolateWorkspaceOutcomeV1 =
  { status: "available"; value: unknown } | IsolateCapabilityFailureV1;

export interface IsolateNotificationRequestV1 {
  notificationId: string;
  title: string;
  body: string;
}
export type IsolateNotificationOutcomeV1 =
  { status: "recorded" } | IsolateCapabilityFailureV1;

/** A durable Routine operation attributed to one Package call. */
export interface IsolateScheduleRequestV1 {
  callId: string;
  input: unknown;
}
export type IsolateScheduleOutcomeV1 = IsolateToolOutcomeV1;

/**
 * Model invocation through the Bot's configured model binding. Events cross the RPC
 * boundary as an NDJSON byte stream — see `decodeIsolateModelEventV1`. A
 * `ReadableStream` of JavaScript objects is not transferable over workerd RPC;
 * a byte stream is, so the kernel encodes and the isolate decodes.
 */
export type IsolateModelInvocationV1 =
  | {
      status: "streaming";
      requestId: string;
      events: ReadableStream<Uint8Array>;
    }
  | IsolateCapabilityFailureV1;

export type IsolateModelOutcomeV1 = IsolateModelInvocationV1;

/**
 * The wrapper `WorkerEntrypoint` the kernel generates. Bot code never
 * implements this; it exports `tools` and `execute` and the wrapper adapts.
 */
export interface BotIsolateEntrypoint {
  health(): Promise<IsolateHealthV1>;
  execute(invocation: IsolateToolInvocationV1): Promise<IsolateToolResultV1>;
  hook(invocation: IsolateHookInvocationV1): Promise<IsolateHookResultV1>;
}

/**
 * The loopback service binding the Bot's Durable Object mints for one isolate.
 * Every method is Bot-authority-derived: nothing here can hand out authority
 * the Bot does not already hold.
 */
export interface BotCapabilitiesStub {
  list(): Promise<IsolateCapabilityListOutcomeV1>;
  invokeModel(request: NormalizedModelRequest): Promise<IsolateModelOutcomeV1>;
  invokeTool(request: IsolateToolRequestV1): Promise<IsolateToolOutcomeV1>;
  memoryRead(
    request: IsolateMemoryReadRequestV1,
  ): Promise<IsolateMemoryOutcomeV1>;
  memoryWrite(
    request: IsolateMemoryWriteRequestV1,
  ): Promise<IsolateMemoryOutcomeV1>;
  memoryForget(
    request: IsolateMemoryWriteRequestV1,
  ): Promise<IsolateMemoryOutcomeV1>;
  workspaceRead(
    path: IsolateWorkspacePathV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;
  workspaceList(
    request: IsolateWorkspaceListRequestV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;
  workspaceStat(
    path: IsolateWorkspacePathV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;
  workspaceWrite(
    request: IsolateWorkspaceWriteRequestV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;
  workspaceDelete(
    request: IsolateWorkspaceDeleteRequestV1,
  ): Promise<IsolateWorkspaceOutcomeV1>;
  connection(connectionId: string): Promise<IsolateConnectionOutcomeV1>;
  notify(
    request: IsolateNotificationRequestV1,
  ): Promise<IsolateNotificationOutcomeV1>;
  schedule(
    request: IsolateScheduleRequestV1,
  ): Promise<IsolateScheduleOutcomeV1>;
}

/** The model outcome Bot-authored `package.js` receives after wrapper narrowing. */
export type BotPackageModelOutcomeV1 =
  | {
      status: "streaming";
      requestId: string;
      events: AsyncIterable<LlmStreamEvent>;
    }
  | IsolateCapabilityFailureV1;

/**
 * The common exact `ctx` passed to a Bot-authored Package's tool and hook.
 * The model-facing declarations are generated from these interfaces, and the
 * wrapper's implementation is compile- and test-checked against the same
 * keys.
 */
export interface BotPackageContextV1 {
  readonly tool?: string;
  readonly event?: BotIsolateHookEventNameV1;
  readonly botId: string;
  readonly sessionId: string;
  readonly runId: string;
  readonly turnId: string;
  readonly generationId: string;
  readonly packageId: string;
  readonly deadlineMs: number;
  readonly bindings: string[];
  readonly capabilities: {
    list(): Promise<IsolateCapabilityListOutcomeV1>;
  };
  readonly model: {
    invoke(
      request: NormalizedModelRequest,
    ): Promise<BotPackageModelOutcomeV1>;
  };
  readonly tools: {
    /** Runs through the trusted registry's active-Composition and deny guards. */
    invoke(request: IsolateToolRequestV1): Promise<IsolateToolOutcomeV1>;
  };
  readonly memory: {
    read(request: IsolateMemoryReadRequestV1): Promise<IsolateMemoryOutcomeV1>;
    write(
      request: IsolateMemoryWriteRequestV1,
    ): Promise<IsolateMemoryOutcomeV1>;
    forget(
      request: IsolateMemoryWriteRequestV1,
    ): Promise<IsolateMemoryOutcomeV1>;
  };
  readonly workspace: {
    read(path: IsolateWorkspacePathV1): Promise<IsolateWorkspaceOutcomeV1>;
    list(
      request: IsolateWorkspaceListRequestV1,
    ): Promise<IsolateWorkspaceOutcomeV1>;
    stat(path: IsolateWorkspacePathV1): Promise<IsolateWorkspaceOutcomeV1>;
    write(
      request: IsolateWorkspaceWriteRequestV1,
    ): Promise<IsolateWorkspaceOutcomeV1>;
    delete(
      request: IsolateWorkspaceDeleteRequestV1,
    ): Promise<IsolateWorkspaceOutcomeV1>;
  };
  connection(connectionId: string): Promise<IsolateConnectionOutcomeV1>;
  notify(
    request: IsolateNotificationRequestV1,
  ): Promise<IsolateNotificationOutcomeV1>;
  schedule(request: IsolateScheduleRequestV1): Promise<IsolateScheduleOutcomeV1>;
}

export interface BotPackageExecutionContextV1 extends BotPackageContextV1 {
  readonly tool: string;
  readonly event?: never;
}

export interface BotPackageHookContextV1 extends BotPackageContextV1 {
  readonly tool?: never;
  readonly event: BotIsolateHookEventNameV1;
}

/**
 * Everything Bot code can see. Nothing else is in scope: `globalOutbound` is
 * null, so `Object.keys(env)` inside the isolate is exactly
 * `["CAPABILITIES", "IDENTITY"]`.
 */
export interface BotIsolateEnv {
  IDENTITY: IsolateIdentityV1;
  CAPABILITIES: BotCapabilitiesStub;
}

export interface IsolateModuleMap {
  [path: string]: { js: string };
}

export interface IsolateLoadInputV1 {
  loaderId: string;
  modules: IsolateModuleMap;
  env: BotIsolateEnv;
  limits: { cpuMs: number; subRequests: number };
  compatibilityDate: string;
}

/** The kernel-declared isolate host. A runtime adapter implements it. */
export interface IsolateHost {
  load(input: IsolateLoadInputV1): BotIsolateEntrypoint;
}

/**
 * D2. The loader identity, and nothing else — a reused id silently serves the
 * first code and `env`, so every component here is content- or owner-derived.
 * The hash covers the mounted wrapper and Package artifact plus the digest of
 * every baked-in binding: User, Bot, Composition generation, Connections, and
 * resolved model. The User prefix independently prevents cross-User reuse.
 */
export function isolateLoaderIdV1(input: {
  userId: string;
  artifactSetHash: string;
}): string {
  const userId = boundedString(input.userId, "isolate loader userId", 256);
  const hash = boundedString(
    input.artifactSetHash,
    "isolate loader artifactSetHash",
    128,
  );
  if (/[:\s]/.test(userId) || !/^[0-9a-f]+$/.test(hash)) {
    throw new Error("isolate loader id components are invalid");
  }
  return `bot-package:${userId}:${hash}`;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  const allowed = new Set<string>([...required, ...optional]);
  if (
    !required.every((key) => Object.hasOwn(value, key)) ||
    !Object.keys(value).every((key) => allowed.has(key))
  ) {
    throw new Error(`${label} has invalid fields`);
  }
}

function boundedString(
  value: unknown,
  label: string,
  maximum: number,
  allowEmpty = false,
): string {
  if (
    typeof value !== "string" ||
    (!allowEmpty && value.length === 0) ||
    value.length > maximum
  ) {
    throw new Error(`${label} must be a bounded string`);
  }
  return value;
}

function jsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 16) throw new Error(`${label} is nested too deeply`);
  if (value === null) return;
  const kind = typeof value;
  if (kind === "string" || kind === "boolean") return;
  if (kind === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} must be finite`);
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry, index) =>
      jsonValue(entry, `${label}[${index}]`, depth + 1),
    );
    return;
  }
  if (kind === "object") {
    for (const [key, entry] of Object.entries(value as object)) {
      jsonValue(entry, `${label}.${key}`, depth + 1);
    }
    return;
  }
  throw new Error(`${label} must be JSON`);
}

/** The exact decoder for one turn admission declaration crossing the seam. */
export function decodeIsolateAdmissionV1(
  input: unknown,
  label = "isolate admission",
): TurnAdmissionV1 {
  const value = record(input, label);
  exactKeys(value, ["turnTypes"], label, ["subagentRoles"]);
  if (!Array.isArray(value.turnTypes)) {
    throw new Error(`${label}.turnTypes must be an array`);
  }
  if (value.turnTypes.length === 0) {
    throw new Error(`${label}.turnTypes must not be empty`);
  }
  const turnTypes = value.turnTypes.map((turnType, index) =>
    decodeTurnTypeV1(turnType, `${label}.turnTypes[${index}]`),
  );
  if (new Set(turnTypes).size !== turnTypes.length) {
    throw new Error(`${label}.turnTypes contains duplicates`);
  }
  if (value.subagentRoles === undefined) return { turnTypes };
  if (
    !Array.isArray(value.subagentRoles) ||
    value.subagentRoles.length === 0 ||
    value.subagentRoles.length > ISOLATE_SUBAGENT_ROLE_LIMIT
  ) {
    throw new Error(`${label}.subagentRoles must be a bounded array`);
  }
  const subagentRoles = value.subagentRoles.map((role, index) => {
    if (
      typeof role !== "string" ||
      role.trim().length === 0 ||
      role.length > ISOLATE_SUBAGENT_ROLE_MAX
    ) {
      throw new Error(`${label}.subagentRoles[${index}] is invalid`);
    }
    return role;
  });
  if (new Set(subagentRoles).size !== subagentRoles.length) {
    throw new Error(`${label}.subagentRoles contains duplicates`);
  }
  return { turnTypes, subagentRoles };
}

/**
 * How many roles one declaration may name, and how long a role name may be.
 * The kernel bounds the string and reads no meaning into it: a role is a name
 * a Package chose, exactly as a turn type is a name the kernel chose.
 */
const ISOLATE_SUBAGENT_ROLE_LIMIT = 16;
const ISOLATE_SUBAGENT_ROLE_MAX = 64;

export function decodeIsolateToolDescriptorV1(
  input: unknown,
  label = "isolate tool descriptor",
  contractVersion: IsolateContractVersion = 1,
): IsolateToolDescriptorV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "name",
      "description",
      "inputSchema",
      "idempotent",
      ...(contractVersion >= 2 && Object.hasOwn(value, "admission")
        ? ["admission"]
        : []),
    ],
    label,
  );
  const name = boundedString(value.name, `${label}.name`, 64);
  if (!TOOL_NAME.test(name)) throw new Error(`${label}.name is invalid`);
  const description = boundedString(
    value.description,
    `${label}.description`,
    2048,
    true,
  );
  const inputSchema = record(value.inputSchema, `${label}.inputSchema`);
  jsonValue(inputSchema, `${label}.inputSchema`);
  if (typeof value.idempotent !== "boolean") {
    throw new Error(`${label}.idempotent must be a boolean`);
  }
  return {
    name,
    description,
    inputSchema,
    idempotent: value.idempotent,
    ...(contractVersion >= 2 && value.admission !== undefined
      ? {
          admission: decodeIsolateAdmissionV1(
            value.admission,
            `${label}.admission`,
          ),
        }
      : {}),
  };
}

export function decodeIsolateToolInvocationV1(
  input: unknown,
  label = "isolate tool invocation",
): IsolateToolInvocationV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "tool",
      "input",
      "botId",
      "sessionId",
      "runId",
      "turnId",
      "generationId",
      "deadlineMs",
    ],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const tool = boundedString(value.tool, `${label}.tool`, 64);
  if (!TOOL_NAME.test(tool)) throw new Error(`${label}.tool is invalid`);
  jsonValue(value.input, `${label}.input`);
  const deadlineMs = value.deadlineMs;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    (deadlineMs as number) <= 0 ||
    (deadlineMs as number) > ISOLATE_MAX_DEADLINE_MS
  ) {
    throw new Error(`${label}.deadlineMs is out of range`);
  }
  return {
    schemaVersion: 1,
    tool,
    input: value.input,
    botId: boundedString(value.botId, `${label}.botId`, 256),
    sessionId: boundedString(value.sessionId, `${label}.sessionId`, 257),
    runId: boundedString(value.runId, `${label}.runId`, 128),
    turnId: boundedString(value.turnId, `${label}.turnId`, 128),
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      256,
    ),
    deadlineMs: deadlineMs as number,
  };
}

export function decodeIsolateToolResultV1(
  input: unknown,
  label = "isolate tool result",
): IsolateToolResultV1 {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", "content", "isError"], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (typeof value.isError !== "boolean") {
    throw new Error(`${label}.isError must be a boolean`);
  }
  return {
    schemaVersion: 1,
    content: boundedString(
      value.content,
      `${label}.content`,
      MAX_ISOLATE_CONTENT,
      true,
    ),
    isError: value.isError,
  };
}

export function decodeIsolateHookInvocationV1(
  input: unknown,
  label = "isolate hook invocation",
): IsolateHookInvocationV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "event",
      "payload",
      "botId",
      "sessionId",
      "runId",
      "turnId",
      "generationId",
      "deadlineMs",
    ],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (!isBotIsolateHookEventNameV1(value.event)) {
    throw new Error(`${label}.event is invalid`);
  }
  // The host authored the event snapshot. The event-specific replacement is
  // decoded on the return seam; here JSON validation prevents a live object
  // from being smuggled into Bot code by a future host caller.
  jsonValue(value.payload, `${label}.payload`);
  const deadlineMs = value.deadlineMs;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    (deadlineMs as number) <= 0 ||
    (deadlineMs as number) > ISOLATE_MAX_DEADLINE_MS
  ) {
    throw new Error(`${label}.deadlineMs is out of range`);
  }
  return {
    schemaVersion: 1,
    event: value.event,
    payload: value.payload as LoopEventPayloadMapV1[BotIsolateHookEventNameV1],
    botId: boundedString(value.botId, `${label}.botId`, 256),
    sessionId: boundedString(value.sessionId, `${label}.sessionId`, 257),
    runId: boundedString(value.runId, `${label}.runId`, 128),
    turnId: boundedString(value.turnId, `${label}.turnId`, 128),
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      256,
    ),
    deadlineMs: deadlineMs as number,
  };
}

export function decodeIsolateHookResultV1(
  input: unknown,
  label = "isolate hook result",
): IsolateHookResultV1 {
  const value = record(input, label);
  if (value.status === "unchanged") {
    exactKeys(value, ["schemaVersion", "status"], label);
    if (value.schemaVersion !== 1) {
      throw new Error(`${label}.schemaVersion is unsupported`);
    }
    return { schemaVersion: 1, status: "unchanged" };
  }
  exactKeys(value, ["schemaVersion", "status", "replacement"], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status !== "replaced") {
    throw new Error(`${label}.status is invalid`);
  }
  jsonValue(value.replacement, `${label}.replacement`);
  return {
    schemaVersion: 1,
    status: "replaced",
    replacement: value.replacement,
  };
}

export function decodeIsolateHealthV1(
  input: unknown,
  label = "isolate health",
): IsolateHealthV1 {
  const value = record(input, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const contractVersion = ISOLATE_CONTRACT_VERSIONS.find(
    (candidate) => candidate === value.contractVersion,
  );
  if (contractVersion === undefined) {
    throw new Error(`${label}.contractVersion is unsupported`);
  }
  exactKeys(
    value,
    [
      "schemaVersion",
      "ok",
      "packageId",
      "contractVersion",
      "tools",
      ...(contractVersion >= 3 ? ["hooks"] : []),
    ],
    label,
  );
  if (typeof value.ok !== "boolean") {
    throw new Error(`${label}.ok must be a boolean`);
  }
  if (!Array.isArray(value.tools)) {
    throw new Error(`${label}.tools must be an array`);
  }
  if (value.tools.length > MAX_ISOLATE_TOOLS) {
    throw new Error(`${label}.tools exceeds its bound`);
  }
  const tools = value.tools.map((tool, index) =>
    decodeIsolateToolDescriptorV1(
      tool,
      `${label}.tools[${index}]`,
      contractVersion,
    ),
  );
  if (new Set(tools.map((tool) => tool.name)).size !== tools.length) {
    throw new Error(`${label}.tools contains duplicate names`);
  }
  if (
    contractVersion >= 3 &&
    (!Array.isArray(value.hooks) ||
      value.hooks.length > BOT_ISOLATE_HOOK_EVENTS_V1.length)
  ) {
    throw new Error(`${label}.hooks must be a bounded array`);
  }
  const hooks =
    contractVersion < 3
      ? []
      : (value.hooks as unknown[]).map((hook, index) => {
          if (!isBotIsolateHookEventNameV1(hook)) {
            throw new Error(`${label}.hooks[${index}] is invalid`);
          }
          return hook;
        });
  if (new Set(hooks).size !== hooks.length) {
    throw new Error(`${label}.hooks contains duplicates`);
  }
  return {
    schemaVersion: 1,
    ok: value.ok,
    packageId: boundedString(value.packageId, `${label}.packageId`, 128),
    contractVersion,
    tools,
    hooks,
  };
}

export function decodeIsolateIdentityV1(
  input: unknown,
  label = "isolate identity",
): IsolateIdentityV1 {
  const value = record(input, label);
  exactKeys(value, ["botId", "generationId", "packageId"], label);
  return {
    botId: boundedString(value.botId, `${label}.botId`, 256),
    generationId: boundedString(
      value.generationId,
      `${label}.generationId`,
      256,
    ),
    packageId: boundedString(value.packageId, `${label}.packageId`, 128),
  };
}

export function decodeIsolateConnectionV1(
  input: unknown,
  label = "isolate Connection",
): IsolateConnectionV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "connectionId",
      "packageId",
      "connectionTypeId",
      "displayName",
      "generation",
      "safeMetadata",
    ],
    label,
  );
  const safeMetadata = record(value.safeMetadata, `${label}.safeMetadata`);
  jsonValue(safeMetadata, `${label}.safeMetadata`);
  return {
    connectionId: boundedString(
      value.connectionId,
      `${label}.connectionId`,
      256,
    ),
    packageId: boundedString(value.packageId, `${label}.packageId`, 128),
    connectionTypeId: boundedString(
      value.connectionTypeId,
      `${label}.connectionTypeId`,
      128,
    ),
    displayName: boundedString(value.displayName, `${label}.displayName`, 256),
    generation: boundedString(value.generation, `${label}.generation`, 256),
    safeMetadata,
  };
}

export function decodeIsolateModelBindingV1(
  input: unknown,
  label = "isolate model binding",
): IsolateModelBindingV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "connectionId",
      "packageId",
      "provider",
      "providerModelId",
      "connectionGeneration",
    ],
    label,
    ["catalogGeneration"],
  );
  return {
    connectionId: boundedString(
      value.connectionId,
      `${label}.connectionId`,
      256,
    ),
    packageId: boundedString(value.packageId, `${label}.packageId`, 128),
    provider: boundedString(value.provider, `${label}.provider`, 128),
    providerModelId: boundedString(
      value.providerModelId,
      `${label}.providerModelId`,
      256,
    ),
    connectionGeneration: boundedString(
      value.connectionGeneration,
      `${label}.connectionGeneration`,
      256,
    ),
    ...(value.catalogGeneration === undefined
      ? {}
      : {
          catalogGeneration: boundedString(
            value.catalogGeneration,
            `${label}.catalogGeneration`,
            256,
          ),
        }),
  };
}

export function decodeIsolateCapabilityListV1(
  input: unknown,
  label = "isolate capability list",
): IsolateCapabilityListV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "status",
      "connections",
      "tools",
      "memory",
      "workspace",
      "notify",
      "schedule",
    ],
    label,
    ["model"],
  );
  if (
    value.status !== "available" ||
    value.tools !== true ||
    value.notify !== true ||
    value.schedule !== true ||
    typeof value.memory !== "boolean" ||
    typeof value.workspace !== "boolean" ||
    !Array.isArray(value.connections) ||
    value.connections.length > MAX_ISOLATE_CONNECTIONS
  ) {
    throw new Error(`${label} is invalid`);
  }
  return {
    status: "available",
    connections: value.connections.map((connection, index) =>
      decodeIsolateConnectionV1(connection, `${label}.connections[${index}]`),
    ),
    ...(value.model === undefined
      ? {}
      : { model: decodeIsolateModelBindingV1(value.model, `${label}.model`) }),
    tools: true,
    memory: value.memory,
    workspace: value.workspace,
    notify: true,
    schedule: true,
  };
}

export function decodeIsolateToolRequestV1(
  input: unknown,
  label = "isolate tool request",
): IsolateToolRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["callId", "name", "input"], label);
  jsonValue(value.input, `${label}.input`);
  return {
    callId: boundedString(value.callId, `${label}.callId`, 256),
    name: boundedString(value.name, `${label}.name`, 128),
    input: value.input,
  };
}

export function decodeIsolateScheduleRequestV1(
  input: unknown,
  label = "isolate schedule request",
): IsolateScheduleRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["callId", "input"], label);
  jsonValue(value.input, `${label}.input`);
  return {
    callId: boundedString(value.callId, `${label}.callId`, 256),
    input: value.input,
  };
}

const MEMORY_SCOPES = ["bot", "user", "project"] as const;
const MEMORY_TIERS = ["profile", "log", "note"] as const;

export function decodeIsolateMemoryReadRequestV1(
  input: unknown,
  label = "isolate Memory read request",
): IsolateMemoryReadRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["scope"], label, ["projectId"]);
  const scope = MEMORY_SCOPES.find((candidate) => candidate === value.scope);
  if (!scope) throw new Error(`${label}.scope is invalid`);
  if (scope === "project" && value.projectId === undefined) {
    throw new Error(`${label}.projectId is required`);
  }
  return {
    scope,
    ...(value.projectId === undefined
      ? {}
      : {
          projectId: boundedString(value.projectId, `${label}.projectId`, 128),
        }),
  };
}

export function decodeIsolateMemoryWriteRequestV1(
  input: unknown,
  label = "isolate Memory write request",
): IsolateMemoryWriteRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["scope", "fact"], label, ["projectId", "tier"]);
  const scope = MEMORY_SCOPES.find((candidate) => candidate === value.scope);
  const tier =
    value.tier === undefined
      ? undefined
      : MEMORY_TIERS.find((candidate) => candidate === value.tier);
  if (!scope || (value.tier !== undefined && !tier)) {
    throw new Error(`${label} is invalid`);
  }
  if (scope === "project" && value.projectId === undefined) {
    throw new Error(`${label}.projectId is required`);
  }
  return {
    scope,
    ...(value.projectId === undefined
      ? {}
      : {
          projectId: boundedString(value.projectId, `${label}.projectId`, 128),
        }),
    ...(tier ? { tier } : {}),
    fact: boundedString(value.fact, `${label}.fact`, 2_000),
  };
}

function decodeIsolateWorkspaceRootV1(
  input: unknown,
  label: string,
): IsolateWorkspaceRootV1 {
  const value = record(input, label);
  if (value.kind === "user-instructions") {
    exactKeys(value, ["kind"], label);
    return { kind: "user-instructions" };
  }
  if (value.kind === "bot-instructions") {
    exactKeys(value, ["kind", "botId"], label);
    return {
      kind: "bot-instructions",
      botId: boundedString(value.botId, `${label}.botId`, 256),
    };
  }
  if (value.kind === "package-declared") {
    exactKeys(value, ["kind", "packageId", "rootId"], label);
    return {
      kind: "package-declared",
      packageId: boundedString(value.packageId, `${label}.packageId`, 128),
      rootId: boundedString(value.rootId, `${label}.rootId`, 128),
    };
  }
  throw new Error(`${label}.kind is invalid`);
}

export function decodeIsolateWorkspacePathV1(
  input: unknown,
  label = "isolate Workspace path",
): IsolateWorkspacePathV1 {
  const value = record(input, label);
  exactKeys(value, ["root", "path"], label);
  return {
    root: decodeIsolateWorkspaceRootV1(value.root, `${label}.root`),
    path: boundedString(value.path, `${label}.path`, 1_024, true),
  };
}

export function decodeIsolateWorkspaceListRequestV1(
  input: unknown,
  label = "isolate Workspace list request",
): IsolateWorkspaceListRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["root"], label, ["prefix", "cursor", "limit"]);
  const limit = value.limit;
  if (
    limit !== undefined &&
    (!Number.isSafeInteger(limit) ||
      (limit as number) <= 0 ||
      (limit as number) > 1_000)
  ) {
    throw new Error(`${label}.limit is invalid`);
  }
  return {
    root: decodeIsolateWorkspaceRootV1(value.root, `${label}.root`),
    ...(value.prefix === undefined
      ? {}
      : {
          prefix: boundedString(value.prefix, `${label}.prefix`, 1_024, true),
        }),
    ...(value.cursor === undefined
      ? {}
      : { cursor: boundedString(value.cursor, `${label}.cursor`, 1_024) }),
    ...(limit === undefined ? {} : { limit: limit as number }),
  };
}

export function decodeIsolateWorkspaceWriteRequestV1(
  input: unknown,
  label = "isolate Workspace write request",
): IsolateWorkspaceWriteRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["path", "bytes", "expectedGenerationId"], label, [
    "mediaType",
  ]);
  if (!(value.bytes instanceof Uint8Array)) {
    throw new Error(`${label}.bytes must be bytes`);
  }
  if (
    value.expectedGenerationId !== null &&
    typeof value.expectedGenerationId !== "string"
  ) {
    throw new Error(`${label}.expectedGenerationId is invalid`);
  }
  return {
    path: decodeIsolateWorkspacePathV1(value.path, `${label}.path`),
    bytes: value.bytes,
    expectedGenerationId: value.expectedGenerationId as string | null,
    ...(value.mediaType === undefined
      ? {}
      : {
          mediaType: boundedString(value.mediaType, `${label}.mediaType`, 256),
        }),
  };
}

export function decodeIsolateWorkspaceDeleteRequestV1(
  input: unknown,
  label = "isolate Workspace delete request",
): IsolateWorkspaceDeleteRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["path", "expectedGenerationId"], label);
  return {
    path: decodeIsolateWorkspacePathV1(value.path, `${label}.path`),
    expectedGenerationId: boundedString(
      value.expectedGenerationId,
      `${label}.expectedGenerationId`,
      256,
    ),
  };
}

export function decodeIsolateNotificationRequestV1(
  input: unknown,
  label = "isolate notification request",
): IsolateNotificationRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["notificationId", "title", "body"], label);
  return {
    notificationId: boundedString(
      value.notificationId,
      `${label}.notificationId`,
      256,
    ),
    title: boundedString(value.title, `${label}.title`, 160),
    body: boundedString(value.body, `${label}.body`, 500),
  };
}

/** The exact decoder for the declared failure variant. */
export function decodeIsolateCapabilityFailureV1(
  input: unknown,
  label = "isolate capability failure",
): IsolateCapabilityFailureV1 {
  const value = record(input, label);
  exactKeys(value, ["status", "reason"], label);
  if (value.status !== "unavailable") {
    throw new Error(`${label}.status must be unavailable`);
  }
  return {
    status: "unavailable",
    reason: boundedString(value.reason, `${label}.reason`, 512),
  };
}

/**
 * One line of the `invokeModel` NDJSON stream. The isolate decodes each line
 * before handing it to Bot code, and the kernel decodes nothing on the way out
 * because it authored the event.
 */
export function decodeIsolateModelEventV1(
  input: unknown,
  label = "isolate model event",
): LlmStreamEvent {
  const value = record(input, label);
  if (value.type === "text-delta") {
    exactKeys(value, ["type", "text"], label);
    return {
      type: "text-delta",
      text: boundedString(
        value.text,
        `${label}.text`,
        MAX_ISOLATE_CONTENT,
        true,
      ),
    };
  }
  if (value.type === "finish") {
    exactKeys(value, ["type", "reason"], label);
    if (
      value.reason !== "completed" &&
      value.reason !== "tool-calls" &&
      value.reason !== "max-tokens"
    ) {
      throw new Error(`${label}.reason is invalid`);
    }
    return { type: "finish", reason: value.reason };
  }
  if (value.type === "tool-call") {
    exactKeys(value, ["type", "call"], label);
    const call = record(value.call, `${label}.call`);
    exactKeys(call, ["id", "name", "input"], `${label}.call`);
    jsonValue(call.input, `${label}.call.input`);
    return {
      type: "tool-call",
      call: {
        id: boundedString(call.id, `${label}.call.id`, 256),
        name: boundedString(call.name, `${label}.call.name`, 128),
        input: call.input,
      },
    };
  }
  throw new Error(`${label}.type is invalid`);
}

export function decodeIsolateModelInvocationV1(
  input: unknown,
  label = "isolate model invocation",
): IsolateModelInvocationV1 {
  const value = record(input, label);
  if (value.status === "unavailable") {
    return decodeIsolateCapabilityFailureV1(value, label);
  }
  exactKeys(value, ["status", "requestId", "events"], label);
  if (value.status !== "streaming") {
    throw new Error(`${label}.status is invalid`);
  }
  const events = value.events;
  if (
    !events ||
    typeof events !== "object" ||
    typeof (events as ReadableStream).getReader !== "function"
  ) {
    throw new Error(`${label}.events must be a readable stream`);
  }
  return {
    status: "streaming",
    requestId: boundedString(value.requestId, `${label}.requestId`, 256),
    events: events as ReadableStream<Uint8Array>,
  };
}

/** Encodes one model event as a line of the isolate's NDJSON stream. */
export function encodeIsolateModelEventLineV1(event: LlmStreamEvent): string {
  return `${JSON.stringify(event)}\n`;
}

/** A tool descriptor projected onto the kernel's tool schema. */
export function isolateToolSchemaV1(
  descriptor: IsolateToolDescriptorV1,
): ToolSchema {
  return {
    name: descriptor.name,
    description: descriptor.description,
    inputSchema: descriptor.inputSchema,
  };
}
