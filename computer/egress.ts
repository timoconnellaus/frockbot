// Credentialed egress from the Computer's terminal.
//
// A CLI on the Computer reaches a connected app's API with a placeholder
// token. The Computer's local proxy sends each request to one of the hosts
// below here instead of to the internet, and this module answers it: which
// connected account it is for, whether it needs Jev's review first, and the
// account's own send, which attaches the credential on the far side of the
// app. The Computer never holds the credential.
//
// AUTHORITY. A request is answered only while the `computer_exec` call that
// made it is running, under that call's Turn: the token names the object and
// the call, the call's handler is registered in this isolate for exactly as
// long as the call runs, and a write is reviewed as a `mutate` call of that
// Turn before it is sent.
//
// EFFECTS. Every request is one effect of its own, keyed under the exec's
// effect id. A request is sent at most once; a transport failure after it
// left is answered as unknown, never retried.

import type {
  ToolCall,
  ToolExecutionContext,
  ToolPreparation,
} from "@frockbot/core/contracts";

/** One API host a connected app is reached through, and the app it belongs to. */
export interface ComputerEgressRouteV1 {
  /** The provider's toolkit slug for the app, as the Connection records it. */
  readonly toolkit: string;
  /** What a person calls the app. */
  readonly label: string;
  readonly host: string;
  /** Path prefixes on a host several apps share; absent is the whole host. */
  readonly pathPrefixes?: readonly string[];
}

/**
 * The APIs a CLI on the Computer can reach with a connected account. Only
 * these hosts are intercepted on the Computer; everything else goes straight
 * out, with no credential. GitHub alone for now: an app joins only with a
 * read classifier that is right for its API, because a read is sent without
 * review.
 */
export const COMPUTER_EGRESS_ROUTES_V1: readonly ComputerEgressRouteV1[] = [
  { toolkit: "github", label: "GitHub", host: "api.github.com" },
];

/** Every host the Computer's proxy intercepts. */
export const COMPUTER_EGRESS_HOSTS_V1: readonly string[] = [
  ...new Set(COMPUTER_EGRESS_ROUTES_V1.map((route) => route.host)),
];

export function computerEgressRouteV1(
  url: URL,
): ComputerEgressRouteV1 | undefined {
  const host = url.hostname.toLowerCase();
  return COMPUTER_EGRESS_ROUTES_V1.find(
    (route) =>
      route.host === host &&
      (!route.pathPrefixes ||
        route.pathPrefixes.some((prefix) => url.pathname.startsWith(prefix))),
  );
}

/** One request a CLI made, as the Computer's proxy forwards it. */
export interface ComputerEgressRequestV1 {
  method: string;
  url: string;
  headers: Record<string, string>;
  bodyBase64?: string;
}

/** The app's answer, as the proxy writes it back to the CLI. */
export interface ComputerEgressResponseV1 {
  status: number;
  headers: Record<string, string>;
  bodyBase64: string;
}

/** Largest request body forwarded. */
export const COMPUTER_EGRESS_REQUEST_MAX_BYTES = 1_000_000;
/** Largest response body written back. */
export const COMPUTER_EGRESS_RESPONSE_MAX_BYTES = 8_000_000;
const MAX_HEADERS = 64;
const MAX_URL_LENGTH = 8192;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);
const READ_METHODS = new Set(["GET", "HEAD"]);

export function decodeComputerEgressRequestV1(
  value: unknown,
): ComputerEgressRequestV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const method =
    typeof record.method === "string" ? record.method.toUpperCase() : "";
  if (!METHODS.has(method)) return undefined;
  if (typeof record.url !== "string" || record.url.length > MAX_URL_LENGTH) {
    return undefined;
  }
  let url: URL;
  try {
    url = new URL(record.url);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:") return undefined;
  const headers: Record<string, string> = {};
  if (record.headers !== undefined) {
    if (
      !record.headers ||
      typeof record.headers !== "object" ||
      Array.isArray(record.headers)
    ) {
      return undefined;
    }
    const entries = Object.entries(record.headers as Record<string, unknown>);
    if (entries.length > MAX_HEADERS) return undefined;
    for (const [name, headerValue] of entries) {
      if (typeof headerValue !== "string") return undefined;
      headers[name.toLowerCase()] = headerValue;
    }
  }
  if (
    record.bodyBase64 !== undefined &&
    typeof record.bodyBase64 !== "string"
  ) {
    return undefined;
  }
  const body = record.bodyBase64 as string | undefined;
  if (body && (body.length * 3) / 4 > COMPUTER_EGRESS_REQUEST_MAX_BYTES) {
    return undefined;
  }
  return {
    method,
    url: url.toString(),
    headers,
    ...(body ? { bodyBase64: body } : {}),
  };
}

export function decodeComputerEgressResponseV1(
  value: unknown,
): ComputerEgressResponseV1 | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.status !== "number" ||
    !Number.isInteger(record.status) ||
    record.status < 100 ||
    record.status > 599 ||
    typeof record.bodyBase64 !== "string" ||
    !record.headers ||
    typeof record.headers !== "object" ||
    Array.isArray(record.headers)
  ) {
    return undefined;
  }
  const headers: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(
    record.headers as Record<string, unknown>,
  )) {
    if (typeof headerValue === "string") headers[name] = headerValue;
  }
  return { status: record.status, headers, bodyBase64: record.bodyBase64 };
}

export function bytesToBase64V1(bytes: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}

export function base64ToBytesV1(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

/** A plain answer the CLI prints: JSON with a `message`, as most APIs answer. */
export function computerEgressMessageV1(
  status: number,
  message: string,
): ComputerEgressResponseV1 {
  return {
    status,
    headers: { "content-type": "application/json" },
    bodyBase64: bytesToBase64V1(
      new TextEncoder().encode(JSON.stringify({ message })),
    ),
  };
}

/**
 * Whether a request only reads, and so is sent without review. GitHub's
 * GraphQL endpoint takes every document as a POST, so a POST there reads only
 * when the document, stripped of comments and strings, names no mutation or
 * subscription anywhere; anything unparseable is a write.
 */
export function computerEgressReadsV1(
  request: ComputerEgressRequestV1,
): boolean {
  if (READ_METHODS.has(request.method)) return true;
  const url = new URL(request.url);
  if (
    request.method === "POST" &&
    url.hostname === "api.github.com" &&
    url.pathname === "/graphql" &&
    request.bodyBase64
  ) {
    try {
      const body = JSON.parse(
        new TextDecoder().decode(base64ToBytesV1(request.bodyBase64)),
      ) as { query?: unknown };
      return (
        typeof body.query === "string" &&
        !/\b(mutation|subscription)\b/.test(graphqlSkeleton(body.query))
      );
    } catch {
      return false;
    }
  }
  return false;
}

/** A GraphQL document with its strings and comments removed. */
function graphqlSkeleton(query: string): string {
  return query
    .replace(/"""[\s\S]*?"""/g, " ")
    .replace(/"(?:[^"\\\n]|\\.)*"/g, " ")
    .replace(/#[^\n]*/g, " ");
}

/** One connected account a Turn may reach from the terminal. */
export interface ComputerEgressAccountV1 {
  /** The toolkit slug, matched against `COMPUTER_EGRESS_ROUTES_V1`. */
  readonly toolkit: string;
  /** What a person calls this account, for the review and the refusals. */
  readonly label: string;
  /** Live permission for the Connection. Absent keeps the admitted snapshot. */
  permit?(): Promise<boolean>;
  /** Sends one request as the account. The credential never leaves the far side. */
  send(
    request: ComputerEgressRequestV1,
    signal: AbortSignal,
  ): Promise<ComputerEgressResponseV1>;
}

const ACCOUNTS = new WeakMap<object, ComputerEgressAccountV1[]>();

/**
 * Offers one account to the terminal of the runtime `key` identifies — the
 * Turn's tool registry — for as long as the returned cleanup has not run.
 */
export function registerComputerEgressAccountV1(
  key: object,
  account: ComputerEgressAccountV1,
): () => void {
  const accounts = ACCOUNTS.get(key) ?? [];
  accounts.push(account);
  ACCOUNTS.set(key, accounts);
  return () => {
    const index = accounts.indexOf(account);
    if (index >= 0) accounts.splice(index, 1);
  };
}

export function computerEgressAccountsV1(
  key: object,
): readonly ComputerEgressAccountV1[] {
  return ACCOUNTS.get(key) ?? [];
}

/** The synthetic call a credentialed write is reviewed as. */
export const COMPUTER_EGRESS_TOOL_NAME = "credentialed_request";
const REVIEW_BODY_CHARS = 2000;

function reviewBody(request: ComputerEgressRequestV1): unknown {
  if (!request.bodyBase64) return undefined;
  const text = new TextDecoder().decode(base64ToBytesV1(request.bodyBase64));
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text.length <= REVIEW_BODY_CHARS
      ? text
      : `${text.slice(0, REVIEW_BODY_CHARS)}…`;
  }
}

export interface ComputerEgressHandlerConfigV1 {
  /** The Turn's connected accounts, read when a request arrives. */
  accounts(): readonly ComputerEgressAccountV1[];
  /** The exec call's own context: its Turn, its effect id, its signal. */
  context: ToolExecutionContext;
  /**
   * Runs a call through the Turn's prepare hooks, where supervision reviews a
   * `mutate` call. Absent, and no write is sent at all.
   */
  review?(
    call: ToolCall,
    context: ToolExecutionContext,
  ): Promise<ToolPreparation>;
}

/**
 * Answers the requests one exec call's CLIs make. Reads go to the account
 * directly; anything else is reviewed first, and a refusal is the answer the
 * CLI prints.
 */
export function createComputerEgressHandlerV1(
  config: ComputerEgressHandlerConfigV1,
): (request: ComputerEgressRequestV1) => Promise<ComputerEgressResponseV1> {
  let sequence = 0;
  // A CLI that retries a write it timed out on sends the same bytes again.
  // Within one exec that is the same effect, answered with what the first
  // send answered rather than sent twice.
  const writes = new Map<string, Promise<ComputerEgressResponseV1>>();
  return async (request) => {
    const url = new URL(request.url);
    const route = computerEgressRouteV1(url);
    if (!route) {
      return computerEgressMessageV1(
        403,
        `FrockBot does not attach a connected account to ${url.host}${url.pathname}.`,
      );
    }
    const account = config
      .accounts()
      .find((candidate) => candidate.toolkit === route.toolkit);
    if (!account || (account.permit && !(await account.permit()))) {
      return computerEgressMessageV1(
        403,
        `No ${route.label} account is connected for this Bot. Ask the person to connect ${route.label} in Connectors, then try again.`,
      );
    }
    const reads = computerEgressReadsV1(request);
    const key = reads
      ? undefined
      : `${request.method} ${request.url} ${request.bodyBase64 ?? ""}`;
    const earlier = key ? writes.get(key) : undefined;
    if (earlier) return earlier;
    const answer = send(request, route, account, reads);
    if (key) writes.set(key, answer);
    return answer;
  };

  async function send(
    request: ComputerEgressRequestV1,
    route: ComputerEgressRouteV1,
    account: ComputerEgressAccountV1,
    reads: boolean,
  ): Promise<ComputerEgressResponseV1> {
    const effectId = `${config.context.effectId}:egress:${sequence++}`;
    if (!reads) {
      if (!config.review) {
        return computerEgressMessageV1(
          403,
          "FrockBot did not send this request: writes from the terminal need supervision, which this Turn does not have.",
        );
      }
      const call: ToolCall = {
        id: effectId,
        name: COMPUTER_EGRESS_TOOL_NAME,
        input: {
          account: account.label,
          method: request.method,
          url: request.url,
          ...(request.bodyBase64 ? { body: reviewBody(request) } : {}),
        },
      };
      const prepared = await config.review(call, {
        ...config.context,
        effectId,
        toolCall: call,
        effect: "mutate",
      });
      if (prepared.kind === "denied") {
        return computerEgressMessageV1(
          403,
          `FrockBot did not send this request. ${prepared.result.content}`,
        );
      }
    }
    try {
      return await account.send(request, config.context.signal);
    } catch {
      return reads
        ? computerEgressMessageV1(
            502,
            `${route.label} could not be reached through the connected account. Try again.`,
          )
        : computerEgressMessageV1(
            502,
            `The outcome of this ${route.label} request could not be confirmed. Do not repeat it; check the account for its result.`,
          );
    }
  }
}

interface LiveEgressV1 {
  readonly object: string;
  readonly expiresAt: number;
  answer(request: ComputerEgressRequestV1): Promise<ComputerEgressResponseV1>;
}

const LIVE = new Map<string, LiveEgressV1>();

/**
 * Makes one exec call's handler answerable under `nonce` until the returned
 * cleanup runs. The map is this isolate's, which is the object's: a request
 * reaches it only through that object, and only while the call is running.
 */
export function openComputerEgressV1(
  nonce: string,
  live: LiveEgressV1,
): () => void {
  LIVE.set(nonce, live);
  return () => {
    if (LIVE.get(nonce) === live) LIVE.delete(nonce);
  };
}

/** The answer an object gives a request its Worker already verified. */
export async function answerComputerEgressV1(input: {
  object: string;
  nonce: string;
  request: ComputerEgressRequestV1;
  now?: number;
}): Promise<ComputerEgressResponseV1> {
  const live = LIVE.get(input.nonce);
  if (
    !live ||
    live.object !== input.object ||
    live.expiresAt <= (input.now ?? Date.now())
  ) {
    return computerEgressMessageV1(
      410,
      "The command that made this request has finished. Connected accounts are reachable only while a computer_exec call is running.",
    );
  }
  return live.answer(input.request);
}

/**
 * What the token carries. Signed, because the Worker addresses an object by
 * `object` before anything else is checked, and an anonymous caller must not
 * decide which object exists.
 */
export interface ComputerEgressTokenV1 {
  v: 1;
  /** The Durable Object name the exec call runs in. */
  o: string;
  /** The exec call's nonce, the key its handler is registered under. */
  n: string;
  /** Expiry, in epoch milliseconds. */
  x: number;
  /** The endpoint the Computer's proxy posts requests to. */
  u: string;
}

const TOKEN_DOMAIN = "frockbot-computer-egress-v1.";

function base64Url(bytes: Uint8Array): string {
  return bytesToBase64V1(bytes)
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromBase64Url(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  return base64ToBytesV1(padded + "=".repeat((4 - (padded.length % 4)) % 4));
}

async function hmac(secret: string, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(
    await crypto.subtle.sign(
      "HMAC",
      key,
      new TextEncoder().encode(TOKEN_DOMAIN + message),
    ),
  );
}

export function computerEgressNonceV1(): string {
  return base64Url(crypto.getRandomValues(new Uint8Array(18)));
}

export async function signComputerEgressTokenV1(
  secret: string,
  token: ComputerEgressTokenV1,
): Promise<string> {
  const payload = base64Url(new TextEncoder().encode(JSON.stringify(token)));
  return `${payload}.${base64Url(await hmac(secret, payload))}`;
}

const OBJECT_NAME = /^[^:#\s]{1,256}:[^:#\s]{1,256}(#task:[^:#\s]{1,256})?$/;

export async function verifyComputerEgressTokenV1(
  secret: string,
  presented: string,
  now = Date.now(),
): Promise<ComputerEgressTokenV1 | undefined> {
  const [payload, signature, extra] = presented.split(".");
  if (!payload || !signature || extra !== undefined) return undefined;
  let expected: Uint8Array;
  let given: Uint8Array;
  try {
    expected = await hmac(secret, payload);
    given = fromBase64Url(signature);
  } catch {
    return undefined;
  }
  if (given.length !== expected.length) return undefined;
  let difference = 0;
  for (let index = 0; index < expected.length; index++) {
    difference |= expected[index]! ^ given[index]!;
  }
  if (difference !== 0) return undefined;
  let token: unknown;
  try {
    token = JSON.parse(new TextDecoder().decode(fromBase64Url(payload)));
  } catch {
    return undefined;
  }
  const value = token as Partial<ComputerEgressTokenV1>;
  if (
    value.v !== 1 ||
    typeof value.o !== "string" ||
    !OBJECT_NAME.test(value.o) ||
    typeof value.n !== "string" ||
    typeof value.x !== "number" ||
    typeof value.u !== "string" ||
    value.x <= now
  ) {
    return undefined;
  }
  return value as ComputerEgressTokenV1;
}

/** The path on the app's origin the Computer's proxy posts to. */
export const COMPUTER_EGRESS_PATH_V1 = "/api/computer/egress";

/** What `computer_exec` needs to open a call's egress: the Turn's own seam. */
export interface ComputerEgressSeamV1 {
  /** The Durable Object name this Turn runs in. */
  readonly object: string;
  /** Where the Computer's proxy posts, e.g. `https://bot.frockbot.com/api/computer/egress`. */
  readonly endpoint: string;
  sign(token: ComputerEgressTokenV1): Promise<string>;
}
