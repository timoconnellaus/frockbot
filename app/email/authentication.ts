// Whether a message was sent by the domain its `From` names.
//
// Anyone can write any `From`. What cannot be forged is the receiving
// server's verdict on the connection it accepted the message from: SPF, DKIM
// and DMARC, which it records in an `Authentication-Results` header (or the
// `ARC-Authentication-Results` of the ARC set it seals). A sender can put such
// headers in their own message too, so only one is believed: the topmost,
// because a server adds its trace headers above everything it received, and
// only when the service that wrote it is the receiving server itself.
//
// The rule is DMARC's. A message passes when DMARC passed for the `From`
// domain, or — when that domain publishes no DMARC policy at all — when the
// `From` domain itself signed it with DKIM, which is the alignment DMARC would
// have asked for. Anything else fails, including no verdict at all: this is
// the door every unverified message stops at, so it fails closed.

import { INBOUND_EMAIL_TRUSTED_AUTHSERV_IDS_V1 } from "./shared.js";

/** One header as the message carries it, in document order. */
export interface EmailHeaderV1 {
  /** Lowercase. */
  key: string;
  value: string;
}

export type SenderAuthenticationV1 =
  | { status: "pass"; basis: "dmarc" | "dkim" }
  | {
      status: "fail";
      reason: "no-verdict" | "untrusted-verdict" | "dmarc-fail" | "not-aligned";
    };

interface ResultV1 {
  method: string;
  result: string;
  properties: Record<string, string>;
}

/** The value with every `(comment)` removed, quoted strings kept whole. */
function withoutComments(value: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\\" && (quoted || depth > 0)) {
      if (depth === 0) out += char + (value[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (depth === 0 && char === '"') quoted = !quoted;
    if (!quoted && char === "(") {
      depth += 1;
      continue;
    }
    if (!quoted && char === ")" && depth > 0) {
      depth -= 1;
      continue;
    }
    if (depth === 0) out += char;
  }
  return out;
}

/** Split on `separator` outside quoted strings. */
function splitOutsideQuotes(value: string, separator: RegExp): string[] {
  const parts: string[] = [];
  let current = "";
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index]!;
    if (char === "\\" && quoted) {
      current += char + (value[index + 1] ?? "");
      index += 1;
      continue;
    }
    if (char === '"') quoted = !quoted;
    if (!quoted && separator.test(char)) {
      parts.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

function unquote(value: string): string {
  return value.startsWith('"') && value.endsWith('"') && value.length >= 2
    ? value.slice(1, -1).replace(/\\(.)/g, "$1")
    : value;
}

/**
 * One `Authentication-Results` value: who wrote it, and each method's result
 * with its properties. An ARC set's copy leads with its instance, `i=N;`.
 */
export function parseAuthenticationResultsV1(
  value: string,
  arc: boolean,
): { authservId: string; results: ResultV1[] } | undefined {
  const segments = splitOutsideQuotes(withoutComments(value), /;/);
  if (arc) {
    if (!/^i\s*=\s*[0-9]+$/i.test(segments[0] ?? "")) return undefined;
    segments.shift();
  }
  const authserv = segments.shift();
  if (!authserv) return undefined;
  // `authserv-id [version]`
  const authservId = authserv.split(/\s+/)[0]!.toLowerCase();
  const results: ResultV1[] = [];
  for (const segment of segments) {
    const [head, ...rest] = splitOutsideQuotes(segment, /\s/);
    const methodMatch = /^([a-z0-9-]+)(?:\/[0-9]+)?\s*=\s*([a-z]+)$/i.exec(
      head ?? "",
    );
    if (!methodMatch) continue;
    const properties: Record<string, string> = {};
    for (const token of rest) {
      const equals = token.indexOf("=");
      if (equals <= 0) continue;
      const key = token.slice(0, equals).trim().toLowerCase();
      if (!(key in properties)) {
        properties[key] = unquote(token.slice(equals + 1).trim());
      }
    }
    results.push({
      method: methodMatch[1]!.toLowerCase(),
      result: methodMatch[2]!.toLowerCase(),
      properties,
    });
  }
  return { authservId, results };
}

/**
 * Whether the message's `From` domain is proven to have sent it, by the
 * receiving server's own verdict.
 */
export function senderAuthenticationV1(
  headers: readonly EmailHeaderV1[],
  fromDomain: string,
  trusted: readonly string[] = INBOUND_EMAIL_TRUSTED_AUTHSERV_IDS_V1,
): SenderAuthenticationV1 {
  const top = headers.find(
    (header) =>
      header.key === "authentication-results" ||
      header.key === "arc-authentication-results",
  );
  if (!top) return { status: "fail", reason: "no-verdict" };
  const parsed = parseAuthenticationResultsV1(
    top.value,
    top.key === "arc-authentication-results",
  );
  if (!parsed) return { status: "fail", reason: "no-verdict" };
  if (!trusted.includes(parsed.authservId)) {
    return { status: "fail", reason: "untrusted-verdict" };
  }
  const domain = fromDomain.toLowerCase();
  const dmarc = parsed.results.filter((result) => result.method === "dmarc");
  if (dmarc.length === 0) return { status: "fail", reason: "no-verdict" };
  // Every DMARC verdict the server wrote has to agree: one pass beside one
  // fail is not a pass.
  if (dmarc.every((result) => result.result === "pass")) {
    return dmarc.every(
      (result) => result.properties["header.from"]?.toLowerCase() === domain,
    )
      ? { status: "pass", basis: "dmarc" }
      : { status: "fail", reason: "not-aligned" };
  }
  if (dmarc.every((result) => result.result === "none")) {
    // No policy published. The domain's own DKIM signature is the alignment
    // DMARC would have required; SPF alone names the envelope, not `From`.
    const signed = parsed.results.some(
      (result) =>
        result.method === "dkim" &&
        result.result === "pass" &&
        result.properties["header.d"]?.toLowerCase() === domain,
    );
    return signed
      ? { status: "pass", basis: "dkim" }
      : { status: "fail", reason: "not-aligned" };
  }
  return { status: "fail", reason: "dmarc-fail" };
}
