export interface PromptRequest {
  runId: string;
  text: string;
}

/**
 * The header every hosted answer carries, naming the application it came from.
 *
 * The value is the application hash the served document also stamps into
 * `data-frockbot-user-application`, so a page that has been open across a
 * release can compare what it is running against what just answered it. It
 * lives here rather than in either end because the Worker writes it and the
 * client reads it, and neither owns the other.
 */
export const DEPLOYMENT_HEADER_V1 = "x-frockbot-application-v1";

/**
 * Version 1 of the Bot-state observer protocol. Frames are invalidations, not
 * authority: a client that receives one re-reads the owning HTTP projection.
 */
export const BOT_STATE_CHANNEL_VERSION = 1 as const;

/**
 * What a frame says has moved. `computer` is the Computer projection;
 * `runs` is this Bot's durable run records — a Turn started, said more, or
 * settled — so a client that is not holding the Turn's POST still learns.
 */
export type BotStateTopicV1 = "computer" | "runs";

export type BotStateChannelFrameV1 =
  | {
      schemaVersion: 1;
      type: "state/event";
      cursor: string;
      topic: BotStateTopicV1;
    }
  | {
      schemaVersion: 1;
      type: "state/reset";
      cursor: string;
      reason: "initial" | "gap" | "cursor-ahead";
    }
  | {
      schemaVersion: 1;
      type: "state/ready";
      cursor: string;
    };

const BOT_STATE_CURSOR_PATTERN = /^(?:0|[1-9][0-9]{0,15})$/u;

export function decodeBotStateCursorV1(value: unknown): string {
  if (
    typeof value !== "string" ||
    !BOT_STATE_CURSOR_PATTERN.test(value) ||
    !Number.isSafeInteger(Number(value))
  ) {
    throw new Error("invalid Bot-state cursor");
  }
  return value;
}

function exactObject(
  value: unknown,
  required: readonly string[],
): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("invalid Bot-state frame");
  }
  const record = value as Record<string, unknown>;
  const allowed = new Set(required);
  if (
    !required.every((key) => Object.hasOwn(record, key)) ||
    Object.keys(record).some((key) => !allowed.has(key))
  ) {
    throw new Error("invalid Bot-state frame");
  }
  return record;
}

export function decodeBotStateChannelFrameV1(
  value: unknown,
): BotStateChannelFrameV1 {
  if (typeof value !== "string" || value.length > 4_096) {
    throw new Error("invalid Bot-state frame");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid Bot-state frame");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error("invalid Bot-state frame");
  }
  const type = (parsed as Record<string, unknown>).type;
  if (type === "state/event") {
    const frame = exactObject(parsed, [
      "schemaVersion",
      "type",
      "cursor",
      "topic",
    ]);
    if (
      frame.schemaVersion !== 1 ||
      (frame.topic !== "computer" && frame.topic !== "runs")
    ) {
      throw new Error("invalid Bot-state frame");
    }
    return {
      schemaVersion: 1,
      type,
      cursor: decodeBotStateCursorV1(frame.cursor),
      topic: frame.topic,
    };
  }
  if (type === "state/reset") {
    const frame = exactObject(parsed, [
      "schemaVersion",
      "type",
      "cursor",
      "reason",
    ]);
    if (
      frame.schemaVersion !== 1 ||
      (frame.reason !== "initial" &&
        frame.reason !== "gap" &&
        frame.reason !== "cursor-ahead")
    ) {
      throw new Error("invalid Bot-state frame");
    }
    return {
      schemaVersion: 1,
      type,
      cursor: decodeBotStateCursorV1(frame.cursor),
      reason: frame.reason,
    };
  }
  if (type === "state/ready") {
    const frame = exactObject(parsed, ["schemaVersion", "type", "cursor"]);
    if (frame.schemaVersion !== 1) throw new Error("invalid Bot-state frame");
    return {
      schemaVersion: 1,
      type,
      cursor: decodeBotStateCursorV1(frame.cursor),
    };
  }
  throw new Error("invalid Bot-state frame");
}

export type AgentCommand =
  | { type: "prompt"; runId: string; text: string }
  | { type: "abort"; runId: string }
  | { type: "shutdown" };

export interface AgentModelSummary {
  provider: string;
  id: string;
}

export type AgentEvent =
  | { type: "worker-ready"; model?: AgentModelSummary }
  | { type: "run-started"; runId: string }
  | { type: "text-delta"; runId: string; text: string }
  | {
      type: "tool-start";
      runId: string;
      toolCallId: string;
      name: string;
      input: unknown;
    }
  | {
      type: "tool-end";
      runId: string;
      toolCallId: string;
      name: string;
      text: string;
      isError: boolean;
    }
  | { type: "settled"; runId: string; reason: "completed" | "aborted" }
  | { type: "error"; runId?: string; phase: "startup" | "run"; message: string }
  | { type: "worker-exit"; code: number | null };

export interface PromptResponse {
  accepted: boolean;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function isPromptRequest(value: unknown): value is PromptRequest {
  return (
    isRecord(value) &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  );
}

export function isAgentCommand(value: unknown): value is AgentCommand {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  if (value.type === "shutdown") return true;
  if (value.type === "abort")
    return typeof value.runId === "string" && value.runId.length > 0;
  return (
    value.type === "prompt" &&
    typeof value.runId === "string" &&
    value.runId.length > 0 &&
    typeof value.text === "string" &&
    value.text.trim().length > 0
  );
}

export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!isRecord(value) || typeof value.type !== "string") return false;
  switch (value.type) {
    case "worker-ready":
      return value.model === undefined || isRecord(value.model);
    case "worker-exit":
      return value.code === null || typeof value.code === "number";
    case "error":
      return (
        typeof value.message === "string" &&
        (value.phase === "startup" || value.phase === "run")
      );
    case "run-started":
      return typeof value.runId === "string";
    case "text-delta":
      return typeof value.runId === "string" && typeof value.text === "string";
    case "tool-start":
      return (
        typeof value.runId === "string" &&
        typeof value.toolCallId === "string" &&
        typeof value.name === "string"
      );
    case "tool-end":
      return (
        typeof value.runId === "string" &&
        typeof value.toolCallId === "string" &&
        typeof value.name === "string" &&
        typeof value.text === "string" &&
        typeof value.isError === "boolean"
      );
    case "settled":
      return (
        typeof value.runId === "string" &&
        (value.reason === "completed" || value.reason === "aborted")
      );
    default:
      return false;
  }
}

const MAX_EXTERNAL_AUTHORIZATION_URL_BYTES = 4_096;
const EXTERNAL_AUTHORIZATION_URL_UNSAFE_CHARACTER =
  /[\u0000-\u0020\u007f-\u009f]|\s/u;
const HTTPS_AUTHORIZATION_PREFIX = /^https:\/\/[^/?#]/iu;
const DNS_HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/iu;

function validAuthorizationHostname(hostname: string): boolean {
  if (hostname.startsWith("[") && hostname.endsWith("]")) return true;
  const normalized = hostname.endsWith(".") ? hostname.slice(0, -1) : hostname;
  return (
    normalized.length > 0 &&
    normalized.length <= 253 &&
    normalized.split(".").every((label) => DNS_HOST_LABEL.test(label))
  );
}

export function decodeExternalAuthorizationUrl(value: unknown): string {
  if (
    typeof value !== "string" ||
    !HTTPS_AUTHORIZATION_PREFIX.test(value) ||
    EXTERNAL_AUTHORIZATION_URL_UNSAFE_CHARACTER.test(value) ||
    value.includes("\\") ||
    value.includes("#") ||
    new TextEncoder().encode(value).byteLength >
      MAX_EXTERNAL_AUTHORIZATION_URL_BYTES
  ) {
    throw new Error("invalid external authorization URL");
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      !validAuthorizationHostname(url.hostname)
    ) {
      throw new Error();
    }
  } catch {
    throw new Error("invalid external authorization URL");
  }
  return value;
}

export * from "./voice-assistant.js";
export * from "./voice-dictation.js";
