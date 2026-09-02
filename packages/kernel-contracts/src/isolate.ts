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
  decodeTurnTypeV1,
  type LlmStreamEvent,
  type NormalizedModelRequest,
  type ToolSchema,
} from "./types.js";

/**
 * The wire contract version the kernel wrapper emits. Version 2 added
 * per-tool turn admission; a version 1 isolate declares no admission and its
 * tools are therefore offered on every turn type.
 */
export const ISOLATE_CONTRACT_VERSION = 2;

/** Every contract version the kernel still decodes. */
export type IsolateContractVersion = 1 | 2;

const ISOLATE_CONTRACT_VERSIONS: readonly IsolateContractVersion[] = [1, 2];

/** The upper bound on a single isolate invocation, enforced on both sides. */
export const ISOLATE_MAX_DEADLINE_MS = 60_000;

const MAX_ISOLATE_TOOLS = 64;
const MAX_ISOLATE_CAPABILITIES = 256;
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

export interface IsolateHealthV1 {
  schemaVersion: 1;
  ok: boolean;
  packageId: string;
  contractVersion: IsolateContractVersion;
  tools: IsolateToolDescriptorV1[];
}

/** What `IDENTITY` carries into the isolate. Structured-clonable, never a stub. */
export interface IsolateIdentityV1 {
  botId: string;
  generationId: string;
  packageId: string;
}

export type IsolateCapabilityKindV1 =
  "tool" | "model" | "memory" | "notification" | "computer";

export interface IsolateCapabilityDescriptorV1 {
  capabilityId: string;
  kind: IsolateCapabilityKindV1;
}

export interface IsolateAuthorityRequestV1 {
  capabilityId: string;
  reason: string;
}

/** Self-modification never widens authority: the answer is always pending. */
export interface IsolatePendingDecisionV1 {
  status: "pending-user-decision";
  decisionId: string;
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

export type IsolateAuthorityOutcomeV1 =
  IsolatePendingDecisionV1 | IsolateCapabilityFailureV1;

export type IsolateCapabilityListOutcomeV1 =
  IsolateCapabilityDescriptorV1[] | IsolateCapabilityFailureV1;

/**
 * D6: model invocation as an enabled-capability binding. Events cross the RPC
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
  | IsolatePendingDecisionV1;

export type IsolateModelOutcomeV1 =
  IsolateModelInvocationV1 | IsolateCapabilityFailureV1;

/**
 * The wrapper `WorkerEntrypoint` the kernel generates. Bot code never
 * implements this; it exports `tools` and `execute` and the wrapper adapts.
 */
export interface BotIsolateEntrypoint {
  health(): Promise<IsolateHealthV1>;
  execute(invocation: IsolateToolInvocationV1): Promise<IsolateToolResultV1>;
}

/**
 * The loopback service binding the Bot's Durable Object mints for one isolate.
 * Every method derives from enabled capabilities: nothing here can hand out authority the
 * Bot does not already hold.
 */
export interface BotCapabilitiesStub {
  list(): Promise<IsolateCapabilityListOutcomeV1>;
  /**
   * D6 addendum. The kernel records the normalized request and acquires the
   * credential lease through the existing provider path *before* forwarding.
   * Without a matching enabled model capability the answer is a pending
   * decision, never a grant.
   */
  invokeModel(request: NormalizedModelRequest): Promise<IsolateModelOutcomeV1>;
  requestAuthority(
    request: IsolateAuthorityRequestV1,
  ): Promise<IsolateAuthorityOutcomeV1>;
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
 * every baked-in binding: User, Bot, Composition generation, and enabled set.
 * Identical artifacts reuse an isolate only under identical authority; the
 * User prefix independently prevents cross-User reuse (AGENTS.md Package
 * composition; ADR 0019).
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

export function decodeIsolateHealthV1(
  input: unknown,
  label = "isolate health",
): IsolateHealthV1 {
  const value = record(input, label);
  exactKeys(
    value,
    ["schemaVersion", "ok", "packageId", "contractVersion", "tools"],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const contractVersion = ISOLATE_CONTRACT_VERSIONS.find(
    (candidate) => candidate === value.contractVersion,
  );
  if (contractVersion === undefined) {
    throw new Error(`${label}.contractVersion is unsupported`);
  }
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
  return {
    schemaVersion: 1,
    ok: value.ok,
    packageId: boundedString(value.packageId, `${label}.packageId`, 128),
    contractVersion,
    tools,
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

const CAPABILITY_KINDS: readonly IsolateCapabilityKindV1[] = [
  "tool",
  "model",
  "memory",
  "notification",
  "computer",
];

export function decodeIsolateCapabilityDescriptorV1(
  input: unknown,
  label = "isolate capability",
): IsolateCapabilityDescriptorV1 {
  const value = record(input, label);
  exactKeys(value, ["capabilityId", "kind"], label);
  const kind = CAPABILITY_KINDS.find((candidate) => candidate === value.kind);
  if (!kind) throw new Error(`${label}.kind is invalid`);
  return {
    capabilityId: boundedString(
      value.capabilityId,
      `${label}.capabilityId`,
      256,
    ),
    kind,
  };
}

export function decodeIsolateCapabilityListV1(
  input: unknown,
  label = "isolate capability list",
): IsolateCapabilityDescriptorV1[] {
  if (!Array.isArray(input)) throw new Error(`${label} must be an array`);
  if (input.length > MAX_ISOLATE_CAPABILITIES) {
    throw new Error(`${label} exceeds its bound`);
  }
  return input.map((entry, index) =>
    decodeIsolateCapabilityDescriptorV1(entry, `${label}[${index}]`),
  );
}

export function decodeIsolateAuthorityRequestV1(
  input: unknown,
  label = "isolate authority request",
): IsolateAuthorityRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["capabilityId", "reason"], label);
  return {
    capabilityId: boundedString(
      value.capabilityId,
      `${label}.capabilityId`,
      256,
    ),
    reason: boundedString(value.reason, `${label}.reason`, 2048, true),
  };
}

export function decodeIsolatePendingDecisionV1(
  input: unknown,
  label = "isolate pending decision",
): IsolatePendingDecisionV1 {
  const value = record(input, label);
  exactKeys(value, ["status", "decisionId"], label);
  if (value.status !== "pending-user-decision") {
    throw new Error(`${label}.status must be pending-user-decision`);
  }
  return {
    status: "pending-user-decision",
    decisionId: boundedString(value.decisionId, `${label}.decisionId`, 256),
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
  if (value.status === "pending-user-decision") {
    return decodeIsolatePendingDecisionV1(value, label);
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
