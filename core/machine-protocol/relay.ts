/**
 * The local model relay: a model request the cloud sends a registered Mac,
 * which the Mac's device host forwards to a model server on its own loopback
 * and streams back over the socket it already holds.
 *
 * It is a narrow relay, not network access. The one destination rule lives
 * here, so the cloud refuses to send and the Mac refuses to fetch the same
 * addresses: `http` or `https` to `localhost`, `127.0.0.1` or `[::1]`, with no
 * credentials, query or fragment. Nothing else is a local model.
 *
 * Down (cloud → Mac), on the socket: `relay` asks, `relay-cancel` stops.
 * Up (Mac → cloud), on the same socket: `relay-head` once, `relay-data` any
 * number of times, then exactly one of `relay-end` or `relay-fail`.
 */

import { MACHINE_LIMITS_V1, MachineDecodeError } from "./protocol.js";

export const MACHINE_RELAY_LIMITS_V1 = {
  /** A request body: the whole conversation a local model is sent. */
  requestBytes: 1_024 * 1_024,
  /** One `relay-data` frame's text. */
  dataChars: 64 * 1_024,
  /** A whole response, counted by the cloud as it arrives. */
  responseBytes: 16 * 1_024 * 1_024,
  /** The reason a relay failed. */
  error: 2_000,
  /** The response's content type. */
  contentType: 200,
  /** An endpoint as a person enters it. */
  url: 2_048,
  /** Relays one Mac runs at once. */
  concurrent: 4,
} as const;

/** What a person reads when the Mac a local model runs on is not connected. */
export const LOCAL_MODEL_OFFLINE_V1 =
  "Your Mac is offline, so your local model can't answer.";

/** What a person reads when the Mac drops off part-way through an answer. */
export const LOCAL_MODEL_DROPPED_V1 =
  "Your Mac went offline before your local model finished answering.";

/** One request the cloud relays to a Mac, before it becomes a frame. */
export interface MachineModelRelayRequestV1 {
  machineId: string;
  relayId: string;
  method: "GET" | "POST";
  url: string;
  body: string | null;
  /** How long the Mac has to start answering. */
  firstByteMs: number;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A loopback address a local model may be reached at, normalised without a
 * trailing slash, or a refusal. Used for the endpoint a person saves and for
 * every URL a relay carries.
 */
export function decodeLocalModelUrlV1(input: unknown, label = "url"): string {
  if (typeof input !== "string" || input.trim().length === 0) {
    throw new MachineDecodeError(`${label} must be a non-empty string`);
  }
  const text = input.trim();
  if (text.length > MACHINE_RELAY_LIMITS_V1.url) {
    throw new MachineDecodeError(
      `${label} exceeds ${MACHINE_RELAY_LIMITS_V1.url} characters`,
      "limit-exceeded",
    );
  }
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    throw new MachineDecodeError(`${label} is not a URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new MachineDecodeError(`${label} must be an http address`);
  }
  if (!LOOPBACK_HOSTS.has(url.hostname)) {
    throw new MachineDecodeError(
      `${label} must be on this computer: localhost, 127.0.0.1 or [::1]`,
    );
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new MachineDecodeError(
      `${label} must not carry credentials, a query or a fragment`,
    );
  }
  return url.toString().replace(/\/+$/, "");
}

/** The cloud asking the Mac to forward one request. */
export interface MachineRelayFrameV1 {
  type: "relay";
  relayId: string;
  method: "GET" | "POST";
  url: string;
  /** JSON text for a POST; null for a GET. */
  body: string | null;
  /** The first byte must arrive before this, measured against `serverTime`. */
  deadline: string;
  serverTime: string;
}

/** The cloud no longer wants a relay's answer: the Turn stopped. */
export interface MachineRelayCancelFrameV1 {
  type: "relay-cancel";
  relayId: string;
}

/** What the Mac sends back on the socket, in order. */
export type MachineRelayUpFrameV1 =
  | {
      type: "relay-head";
      relayId: string;
      status: number;
      contentType?: string;
    }
  | { type: "relay-data"; relayId: string; data: string }
  | { type: "relay-end"; relayId: string }
  | { type: "relay-fail"; relayId: string; error: string };

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:@-]*$/;

function fail(message: string): never {
  throw new MachineDecodeError(message);
}

function record(input: unknown, label: string): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail(`${label} must be an object`);
  }
  return input as Record<string, unknown>;
}

function exactly(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(`${label} has an unknown field: ${key}`);
  }
}

function relayId(input: unknown, label: string): string {
  if (
    typeof input !== "string" ||
    input.length === 0 ||
    input.length > MACHINE_LIMITS_V1.identifier ||
    !IDENTIFIER.test(input)
  ) {
    fail(`${label} relayId is invalid`);
  }
  return input;
}

function timestamp(input: unknown, label: string): string {
  if (
    typeof input !== "string" ||
    input.length > 64 ||
    Number.isNaN(Date.parse(input))
  ) {
    fail(`${label} must be a timestamp`);
  }
  return input;
}

function text(input: unknown, maximum: number, label: string): string {
  if (typeof input !== "string") fail(`${label} must be a string`);
  if (input.length > maximum) {
    throw new MachineDecodeError(
      `${label} exceeds ${maximum} characters`,
      "limit-exceeded",
    );
  }
  return input;
}

export function decodeMachineRelayFrameV1(
  input: unknown,
  label = "relay frame",
): MachineRelayFrameV1 | MachineRelayCancelFrameV1 {
  const value = record(input, label);
  if (value.type === "relay-cancel") {
    exactly(value, ["type", "relayId"], label);
    return { type: "relay-cancel", relayId: relayId(value.relayId, label) };
  }
  if (value.type !== "relay") fail(`${label} type is unsupported`);
  exactly(
    value,
    ["type", "relayId", "method", "url", "body", "deadline", "serverTime"],
    label,
  );
  if (value.method !== "GET" && value.method !== "POST") {
    fail(`${label} method must be GET or POST`);
  }
  const body =
    value.body === null
      ? null
      : text(value.body, MACHINE_RELAY_LIMITS_V1.requestBytes, `${label} body`);
  if (value.method === "GET" && body !== null) {
    fail(`${label} GET carries no body`);
  }
  return {
    type: "relay",
    relayId: relayId(value.relayId, label),
    method: value.method,
    url: decodeLocalModelUrlV1(value.url, `${label} url`),
    body,
    deadline: timestamp(value.deadline, `${label} deadline`),
    serverTime: timestamp(value.serverTime, `${label} serverTime`),
  };
}

export function decodeMachineRelayUpFrameV1(
  input: unknown,
  label = "relay reply",
): MachineRelayUpFrameV1 {
  const value = record(input, label);
  const id = relayId(value.relayId, label);
  switch (value.type) {
    case "relay-head": {
      exactly(value, ["type", "relayId", "status", "contentType"], label);
      if (
        !Number.isSafeInteger(value.status) ||
        (value.status as number) < 100 ||
        (value.status as number) > 599
      ) {
        fail(`${label} status is invalid`);
      }
      return {
        type: "relay-head",
        relayId: id,
        status: value.status as number,
        ...(value.contentType === undefined
          ? {}
          : {
              contentType: text(
                value.contentType,
                MACHINE_RELAY_LIMITS_V1.contentType,
                `${label} contentType`,
              ),
            }),
      };
    }
    case "relay-data":
      exactly(value, ["type", "relayId", "data"], label);
      return {
        type: "relay-data",
        relayId: id,
        data: text(
          value.data,
          MACHINE_RELAY_LIMITS_V1.dataChars,
          `${label} data`,
        ),
      };
    case "relay-end":
      exactly(value, ["type", "relayId"], label);
      return { type: "relay-end", relayId: id };
    case "relay-fail":
      exactly(value, ["type", "relayId", "error"], label);
      return {
        type: "relay-fail",
        relayId: id,
        error: text(
          value.error,
          MACHINE_RELAY_LIMITS_V1.error,
          `${label} error`,
        ).slice(0, MACHINE_RELAY_LIMITS_V1.error),
      };
    default:
      return fail(`${label} type is unsupported`);
  }
}
