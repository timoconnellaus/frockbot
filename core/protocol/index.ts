import {
  decodeProtocol,
  STATE_FRAME_MAX_BYTES,
  type StateFrame,
} from "../protocol-schemas/index.js";

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
 * Version 1 of the Bot-state observer protocol. Frames are committed
 * conversation updates, snapshots, and Computer invalidations.
 */
export const BOT_STATE_CHANNEL_VERSION = 1 as const;

export type BotStateChannelFrameV1 = StateFrame;

const BOT_STATE_CURSOR_PATTERN = /^(?:0|[1-9][0-9]{0,15})$/u;
const utf8 = new TextEncoder();

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

export function decodeBotStateChannelFrameV1(
  value: unknown,
): BotStateChannelFrameV1 {
  if (typeof value !== "string" || utf8.encode(value).length > STATE_FRAME_MAX_BYTES) {
    throw new Error("invalid Bot-state frame");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error("invalid Bot-state frame");
  }
  try {
    return decodeProtocol("StateFrame", parsed);
  } catch {
    throw new Error("invalid Bot-state frame");
  }
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
