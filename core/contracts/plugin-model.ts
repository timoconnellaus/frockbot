// The model-provider Plugin protocol: one Plugin contribution that serves a
// model provider, and the host transport that carries its one upstream call.
//
// A Plugin in this deployment may serve the model provider its descriptor
// declares. The kernel hands it a normalized model request and it returns
// normalized stream events, so nothing provider-specific crosses the seam
// except the events themselves. What it never holds is the credential: its
// upstream call goes through the host, which resolves the Connection, sends
// to the one endpoint and route the deployment's catalog names, attaches the
// secret server-side and streams the bytes back.
//
// Everything the worker sends back is untrusted and decoded where it crosses.
import {
  decodeLlmStreamEventV1,
  decodeNormalizedModelRequestV1,
  type LlmStreamEvent,
  type NormalizedModelRequest,
} from "./types.js";
import {
  MODEL_PROVIDER_FAILURE_REASON_MAX_LENGTH_V1,
  type ModelProviderFailureClassV1,
} from "./model-invocation.js";
import { exactKeysV1, recordV1 } from "./records.js";

/**
 * The version of this protocol a Plugin contribution names. A descriptor may
 * only name one this deployment serves; adding a version is a deliberate
 * change to the wire, not a side effect of a feature.
 */
export const PLUGIN_MODEL_PROTOCOL_VERSION_V1 = 1;
export const PLUGIN_MODEL_PROTOCOL_VERSIONS_V1: readonly number[] = [
  PLUGIN_MODEL_PROTOCOL_VERSION_V1,
];

/**
 * One model provider a Plugin serves. `id` is the provider type a model
 * binding names, so a Bot that selects that provider is served by this
 * contribution and by nothing else.
 *
 * The declaration is a claim, not a grant. Whether a provider may be served
 * at all, by which Plugin id, at which endpoint and along which route, is
 * compiled into the deployment's provider catalog; a Plugin that declares a
 * provider the deployment does not open to it fails to mount. Nothing here
 * can widen what the transport will do.
 */
export interface PluginModelProviderV1 {
  id: string;
  protocolVersion: number;
}

/**
 * What a person is told when a Bot's model is served by a provider Plugin this
 * account does not hold. It is user-facing copy, in the register the model
 * deadlines use: what happened, and what to do about it. The words are the
 * product's own — "model", "Plugin", "Models" — because the sentence reaches a
 * chat bubble, where the machine's vocabulary (`runFailureCopyV1` forbids it)
 * never does.
 */
export const PLUGIN_MODEL_PROVIDER_UNAVAILABLE_REASON_V1 =
  "This Bot's model needs a Plugin this account has not installed, so the reply could not start. Add it in Models, or choose a different model.";

/**
 * The longest silence a model invocation may name between two events. It is
 * the isolate contract's own ceiling (`ISOLATE_MAX_DEADLINE_MS`): after the
 * answer has started, a minute of silence is a dead socket, and the isolate
 * contract is what bounds one call.
 */
export const PLUGIN_MODEL_DEADLINE_MAX_MS_V1 = 60_000;

/**
 * The longest a model invocation may wait for its *first* event. It is the
 * model protocol's own first-byte allowance, and it is deliberately larger
 * than one isolate call: the Plugin is waiting on a provider that has
 * accepted the request and not yet answered, which is the one allowance a
 * Package's provider gets too.
 */
export const PLUGIN_MODEL_FIRST_EVENT_DEADLINE_MAX_MS_V1 = 120_000;

/** Longest route the provider catalog may name. */
export const PLUGIN_MODEL_TRANSPORT_PATH_MAX_LENGTH_V1 = 512;
/** Largest request body a Plugin may hand the host transport. */
export const PLUGIN_MODEL_TRANSPORT_BODY_MAX_BYTES_V1 = 8 * 1024 * 1024;

/**
 * The one URL a transport call may go to: the endpoint in force, the route
 * the deployment's provider catalog names, and nothing else.
 *
 * Neither half comes from the Plugin. The endpoint is the Connection's own
 * `api-base-url` when it set one — the User's declaration, made on the
 * Connections page — or the catalog's endpoint; the route is compiled. So a
 * Plugin cannot name another origin, another route on the same origin (the
 * endpoint's file and billing routes are not reachable at all), a query, or
 * a fragment, and it cannot smuggle one in by encoding.
 */
export function pluginModelTransportUrlV1(
  endpoint: unknown,
  route: unknown,
  label = "plugin model endpoint",
): { status: "ok"; url: string } | { status: "refused"; reason: string } {
  if (typeof endpoint !== "string" || endpoint.length > 2_048) {
    return { status: "refused", reason: `${label} is not a URL` };
  }
  if (
    typeof route !== "string" ||
    route.length === 0 ||
    route.length > PLUGIN_MODEL_TRANSPORT_PATH_MAX_LENGTH_V1 ||
    !route.startsWith("/") ||
    route.includes("//") ||
    route.includes("..") ||
    route.includes("?") ||
    route.includes("#") ||
    route.includes("\\") ||
    /[\u0000-\u001f\u007f\s]/.test(route)
  ) {
    return {
      status: "refused",
      reason: "the model transport route is not the one this deployment serves",
    };
  }
  let base: URL;
  try {
    base = new URL(endpoint);
  } catch {
    return { status: "refused", reason: `${label} is not an absolute URL` };
  }
  if (base.protocol !== "https:" || base.username || base.password) {
    return {
      status: "refused",
      reason: `${label} must be https and carry no credentials`,
    };
  }
  if (base.search || base.hash) {
    return {
      status: "refused",
      reason: `${label} must not carry a query or a fragment`,
    };
  }
  const prefix = base.pathname.replace(/\/+$/, "");
  const candidate = new URL(`${base.origin}${prefix}${route}`);
  if (candidate.origin !== base.origin || candidate.search || candidate.hash) {
    return {
      status: "refused",
      reason: "the model transport route leaves the provider endpoint",
    };
  }
  return { status: "ok", url: candidate.toString() };
}

/**
 * One model call handed to a Plugin (ADR 0032). The request is the same
 * normalized request the kernel would have given a Package — with its
 * Connection binding removed, because a Plugin names no Connection: the host
 * holds the authority the transport ticket resolves.
 */
export interface PluginModelInvocationV1 {
  schemaVersion: 1;
  pluginId: string;
  /** The provider this call serves; the same id the binding named. */
  provider: string;
  protocolVersion: number;
  request: NormalizedModelRequest;
  /**
   * The one-shot ticket the host minted for this dispatch. The Plugin hands
   * it back on its one upstream call. It is not a credential and it names
   * nothing a Plugin can forge: the host drops it when the dispatch ends, so
   * a reused or invented ticket reaches no upstream.
   */
  transportId: string;
  botId: string;
  sessionId: string;
  runId: string;
  turnId: string;
  generationId: string;
  /**
   * The model protocol's silence allowance, in milliseconds: the longest gap
   * the host tolerates between two events once the answer has started. It is
   * the same allowance the host applies to a Package's stream, so a Plugin
   * that stops producing events is stopped rather than held open.
   */
  deadlineMs: number;
  /**
   * The first-event allowance: how long the Plugin may wait before anything
   * at all arrives. Larger than `deadlineMs` on purpose — a provider that has
   * accepted a request and not answered yet gets the model protocol's
   * first-byte allowance, not the idle one.
   */
  firstEventDeadlineMs: number;
}

/**
 * What one Plugin asks the host transport to send. It names no destination:
 * the endpoint and the route are the deployment's, and the body is the only
 * thing the Plugin composes.
 */
export interface PluginModelTransportRequestV1 {
  schemaVersion: 1;
  transportId: string;
  body: string;
}

/** What the host transport answers with. */
export type PluginModelTransportOutcomeV1 =
  | {
      status: "streaming";
      httpStatus: number;
      body: ReadableStream<Uint8Array>;
    }
  | {
      status: "refused";
      httpStatus: number;
      /** The host's own words; a raw upstream body is never forwarded. */
      reason: string;
      retryAfterMs?: number;
    }
  | { status: "unavailable"; reason: string };

/**
 * A provider failure a Plugin states in its own words, so the loop's retry
 * policy can tell a rejected key from a busy provider without reading prose.
 */
export interface PluginModelFailureEventV1 {
  type: "provider-failure";
  classification: ModelProviderFailureClassV1;
  reason: string;
  retryAfterMs?: number;
}

/**
 * The replay state a Plugin states: the provider's own opaque content, and
 * nothing else. Which provider, model and Connection it belongs to is the
 * host's to say — a Plugin never holds the Connection — so the event the
 * Plugin sends is not the kernel's `provider-state`, which carries that
 * identity, but the content the kernel will replay under it.
 */
export interface PluginModelReplayStateV1 {
  content: string;
}

/**
 * A heartbeat: the Plugin is reading real upstream bytes that are none of the
 * kernel's business — a reasoning model's thinking, or an argument fragment
 * that is not yet a tool call. It carries nothing and reaches no one: the
 * host uses it to know the answer is still coming, so an answer that is
 * streaming thought is not cut off by a silence deadline, and an answer that
 * has genuinely gone quiet still is. Emitting one is the Plugin's statement
 * that bytes arrived; a Plugin that lies about that can already lie in the
 * text it sends.
 */
export interface PluginModelProgressEventV1 {
  type: "progress";
}

/** One line of a Plugin's model answer: a normalized event, or its failure. */
export type PluginModelEventV1 =
  | PluginModelProgressEventV1
  | { type: "provider-state"; state: PluginModelReplayStateV1 }
  | Exclude<LlmStreamEvent, { type: "provider-state" }>
  | PluginModelFailureEventV1;

/**
 * What `streamModel` answers with: the events as an NDJSON byte stream, or a
 * refusal it made before any upstream call.
 */
export type PluginWorkerModelResultV1 =
  | {
      schemaVersion: 1;
      status: "streaming";
      events: ReadableStream<Uint8Array>;
    }
  | { schemaVersion: 1; status: "refused"; reason: string };

export function encodePluginModelEventLineV1(
  event: PluginModelEventV1,
): string {
  return `${JSON.stringify(event)}\n`;
}

const PLUGIN_ID = /^[a-z][a-z0-9-]{0,63}$/;
/** The replay content's bound, matching what a session event may carry. */
const MAX_REPLAY_CONTENT_CHARS_V1 = 524_288;
const PROVIDER_TYPE = /^[a-z][a-z0-9-]{0,63}$/;
const MAX_DELTA_CHARS_V1 = 1_000_000;

function record(value: unknown, label: string): Record<string, unknown> {
  return recordV1(value, label);
}

function exactKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  label: string,
  optional: readonly string[] = [],
): void {
  exactKeysV1(value, required, optional, label);
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

export function decodePluginModelInvocationV1(
  input: unknown,
  label = "plugin model invocation",
): PluginModelInvocationV1 {
  const value = record(input, label);
  exactKeys(
    value,
    [
      "schemaVersion",
      "pluginId",
      "provider",
      "protocolVersion",
      "request",
      "transportId",
      "botId",
      "sessionId",
      "runId",
      "turnId",
      "generationId",
      "deadlineMs",
      "firstEventDeadlineMs",
    ],
    label,
  );
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const pluginId = boundedString(value.pluginId, `${label}.pluginId`, 64);
  if (!PLUGIN_ID.test(pluginId))
    throw new Error(`${label}.pluginId is invalid`);
  const provider = boundedString(value.provider, `${label}.provider`, 64);
  if (!PROVIDER_TYPE.test(provider)) {
    throw new Error(`${label}.provider is invalid`);
  }
  if (
    value.protocolVersion !== PLUGIN_MODEL_PROTOCOL_VERSION_V1 &&
    !PLUGIN_MODEL_PROTOCOL_VERSIONS_V1.includes(value.protocolVersion as number)
  ) {
    throw new Error(`${label}.protocolVersion is not served`);
  }
  const request = decodeNormalizedModelRequestV1(
    value.request,
    `${label}.request`,
  );
  if (request.provider !== provider) {
    throw new Error(`${label}.request does not name the provider`);
  }
  if (request.modelBinding !== undefined) {
    throw new Error(`${label}.request must not carry a Connection binding`);
  }
  const deadlineMs = value.deadlineMs;
  if (
    !Number.isSafeInteger(deadlineMs) ||
    (deadlineMs as number) <= 0 ||
    (deadlineMs as number) > PLUGIN_MODEL_DEADLINE_MAX_MS_V1
  ) {
    throw new Error(`${label}.deadlineMs is out of range`);
  }
  const firstEventDeadline = value.firstEventDeadlineMs;
  if (
    !Number.isSafeInteger(firstEventDeadline) ||
    (firstEventDeadline as number) < (deadlineMs as number) ||
    (firstEventDeadline as number) > PLUGIN_MODEL_FIRST_EVENT_DEADLINE_MAX_MS_V1
  ) {
    throw new Error(`${label}.firstEventDeadlineMs is out of range`);
  }
  return {
    schemaVersion: 1,
    pluginId,
    provider,
    protocolVersion: value.protocolVersion as number,
    request,
    transportId: boundedString(value.transportId, `${label}.transportId`, 128),
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
    firstEventDeadlineMs: firstEventDeadline as number,
  };
}

export function decodePluginModelTransportRequestV1(
  input: unknown,
  label = "plugin model transport request",
): PluginModelTransportRequestV1 {
  const value = record(input, label);
  exactKeys(value, ["schemaVersion", "transportId", "body"], label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  const body = boundedString(
    value.body,
    `${label}.body`,
    PLUGIN_MODEL_TRANSPORT_BODY_MAX_BYTES_V1,
    true,
  );
  if (
    new TextEncoder().encode(body).length >
    PLUGIN_MODEL_TRANSPORT_BODY_MAX_BYTES_V1
  ) {
    throw new Error(`${label}.body exceeds its bound`);
  }
  return {
    schemaVersion: 1,
    transportId: boundedString(value.transportId, `${label}.transportId`, 128),
    body,
  };
}

export function decodePluginModelFailureEventV1(
  input: unknown,
  label = "plugin model failure",
): PluginModelFailureEventV1 {
  const value = record(input, label);
  exactKeys(value, ["type", "classification", "reason"], label, [
    "retryAfterMs",
  ]);
  if (
    value.classification !== "transient" &&
    value.classification !== "permanent" &&
    value.classification !== "unknown"
  ) {
    throw new Error(`${label}.classification is invalid`);
  }
  const retryAfterMs = value.retryAfterMs;
  if (
    retryAfterMs !== undefined &&
    (!Number.isSafeInteger(retryAfterMs) || (retryAfterMs as number) < 0)
  ) {
    throw new Error(`${label}.retryAfterMs is invalid`);
  }
  return {
    type: "provider-failure",
    classification: value.classification,
    reason: boundedString(
      value.reason,
      `${label}.reason`,
      MODEL_PROVIDER_FAILURE_REASON_MAX_LENGTH_V1,
    ),
    ...(retryAfterMs === undefined
      ? {}
      : { retryAfterMs: retryAfterMs as number }),
  };
}

/** One NDJSON line a Plugin's model stream carried, strictly decoded. */
export function decodePluginModelEventLineV1(
  line: string,
  label = "plugin model event",
): PluginModelEventV1 {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`${label} is not JSON`);
  }
  const value = record(parsed, label);
  if (value.type === "provider-failure") {
    return decodePluginModelFailureEventV1(value, label);
  }
  if (value.type === "progress") {
    exactKeys(value, ["type"], label);
    return { type: "progress" };
  }
  if (value.type === "provider-state") {
    exactKeys(value, ["type", "state"], label);
    const state = record(value.state, `${label}.state`);
    exactKeys(state, ["content"], `${label}.state`);
    const content = boundedString(
      state.content,
      `${label}.state.content`,
      MAX_REPLAY_CONTENT_CHARS_V1,
    );
    try {
      JSON.parse(content);
    } catch {
      throw new Error(`${label}.state.content is not JSON`);
    }
    return { type: "provider-state", state: { content } };
  }
  const event = decodeLlmStreamEventV1(value, label);
  // A delta is the one event whose size is the provider's to choose; the
  // kernel's own bound keeps a single line from being a megabyte of prose.
  if (event.type === "text-delta" && event.text.length > MAX_DELTA_CHARS_V1) {
    throw new Error(`${label}.text exceeds its bound`);
  }
  return event;
}

export function decodePluginWorkerModelResultV1(
  input: unknown,
  label = "plugin model result",
): PluginWorkerModelResultV1 {
  const value = record(input, label);
  if (value.schemaVersion !== 1) {
    throw new Error(`${label}.schemaVersion is unsupported`);
  }
  if (value.status === "refused") {
    exactKeys(value, ["schemaVersion", "status", "reason"], label);
    return {
      schemaVersion: 1,
      status: "refused",
      reason: boundedString(value.reason, `${label}.reason`, 1_024),
    };
  }
  exactKeys(value, ["schemaVersion", "status", "events"], label);
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
    schemaVersion: 1,
    status: "streaming",
    events: events as ReadableStream<Uint8Array>,
  };
}
