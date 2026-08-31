// The outbound trust boundary for every URL a Package fetches on a Bot's
// behalf: `web_fetch`'s target, and the remote MCP endpoint a User names.
//
// The Bot's Durable Object can reach anything workerd can reach, including
// hosts that only exist inside the platform's own network. Every URL a model
// hands `web_fetch` — and every `Location` a redirect hands it afterwards —
// passes through {@link classifyWebFetchUrlV1} first. The classifier is pure:
// it takes a string and returns a verdict, so it is exhaustively testable and
// holds no I/O, no cache, and no clock.
//
// LIMITATION — DNS rebinding. workerd exposes no resolve-then-connect hook, so
// a hostname cannot be pinned to the address the request will actually reach.
// A name that resolves to a public address at classification time and to
// `127.0.0.1` at connection time defeats every check below. Classification is
// therefore exact for IP literals and for the known-internal name shapes, and
// best-effort for everything else. Narrowing it further needs a platform
// primitive FrockBot does not have; the gap is recorded here rather than
// papered over.

/** The stable refusal codes a classification can produce. */
export type SsrfRefusalReasonV1 =
  | "ssrf-invalid-url"
  | "ssrf-blocked-scheme"
  | "ssrf-blocked-port"
  | "ssrf-blocked-credentials"
  | "ssrf-blocked-host"
  | "ssrf-blocked-private-address";

export type WebUrlClassificationV1 =
  | { allowed: true; url: string; hostname: string }
  | { allowed: false; reason: SsrfRefusalReasonV1; message: string };

/** Rule 1: the only scheme a Bot may fetch. */
const ALLOWED_PROTOCOL = "https:";

/** Rule 2: the default port, or the same port stated explicitly. */
const ALLOWED_PORT = "443";

export interface OutboundUrlPolicyV1 {
  /**
   * Allow a port other than 443. `web_fetch` does not: a Bot reading the
   * public web has no business on an arbitrary port, and the rule closes the
   * "public hostname, internal service port" shape. A User-named MCP endpoint
   * does, because a self-hosted server on its own port is an ordinary
   * deployment rather than an attack.
   */
  allowNonDefaultPort?: boolean;
}

/**
 * Rule 3: host names that name the platform rather than the public internet.
 * `localhost` and any label under it; anything under `.internal`, `.local`
 * (mDNS) or `.home.arpa`; and a bare label with no dot at all (`metadata`,
 * `redis`, a Kubernetes service name).
 */
const BLOCKED_HOST_SUFFIXES = [
  ".localhost",
  ".internal",
  ".local",
  ".home.arpa",
] as const;

function isBlockedHostName(hostname: string): boolean {
  if (hostname.length === 0) return true;
  if (hostname === "localhost" || hostname === "internal") return true;
  if (hostname === "local" || hostname === "home.arpa") return true;
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => hostname.endsWith(suffix))) {
    return true;
  }
  return !hostname.includes(".");
}

function decimalOrRadix(part: string): number | undefined {
  if (part.length === 0) return undefined;
  if (/^0[xX][0-9a-fA-F]+$/.test(part))
    return Number.parseInt(part.slice(2), 16);
  if (/^0[0-7]+$/.test(part)) return Number.parseInt(part.slice(1), 8);
  if (/^[0-9]+$/.test(part)) return Number.parseInt(part, 10);
  return undefined;
}

/**
 * Parse an IPv4 host in every encoding the WHATWG host parser accepts:
 * dotted quad, dotted-decimal short forms, octal (`0177.0.0.1`), hexadecimal
 * (`0x7f000001`), and a bare 32-bit integer (`2130706433`). Returns the four
 * octets, most significant first, or `undefined` when the host is not an IPv4
 * literal at all.
 *
 * Normalizing here rather than trusting `URL` is deliberate: the check must
 * hold for a `Location` header this code resolves itself, and for any future
 * caller that classifies a host string without building a `URL` first.
 */
export function parseIpv4LiteralV1(host: string): number[] | undefined {
  const trimmed = host.endsWith(".") ? host.slice(0, -1) : host;
  if (trimmed.length === 0) return undefined;
  const parts = trimmed.split(".");
  if (parts.length > 4) return undefined;
  const numbers: number[] = [];
  for (const part of parts) {
    const value = decimalOrRadix(part);
    if (value === undefined || !Number.isSafeInteger(value) || value < 0) {
      return undefined;
    }
    numbers.push(value);
  }
  // Every part but the last is one octet; the last fills the remaining bytes.
  const last = numbers[numbers.length - 1] as number;
  if (last >= 256 ** (5 - numbers.length)) return undefined;
  if (numbers.slice(0, -1).some((value) => value > 255)) return undefined;
  let address = last;
  for (let index = 0; index < numbers.length - 1; index += 1) {
    address += (numbers[index] as number) * 256 ** (3 - index);
  }
  return [
    Math.floor(address / 16777216) % 256,
    Math.floor(address / 65536) % 256,
    Math.floor(address / 256) % 256,
    address % 256,
  ];
}

/**
 * Parse an IPv6 literal, with or without surrounding brackets, including `::`
 * compression and a trailing embedded IPv4 (`::ffff:127.0.0.1`). Returns the
 * sixteen bytes, or `undefined` when the host is not an IPv6 literal.
 */
export function parseIpv6LiteralV1(host: string): number[] | undefined {
  let text = host;
  if (text.startsWith("[") && text.endsWith("]")) text = text.slice(1, -1);
  const zone = text.indexOf("%");
  if (zone >= 0) text = text.slice(0, zone);
  if (!text.includes(":")) return undefined;
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const expand = (segment: string): number[][] | undefined => {
    if (segment.length === 0) return [];
    const groups: number[][] = [];
    const pieces = segment.split(":");
    for (let index = 0; index < pieces.length; index += 1) {
      const piece = pieces[index] as string;
      if (index === pieces.length - 1 && piece.includes(".")) {
        const embedded = parseIpv4LiteralV1(piece);
        if (!embedded) return undefined;
        groups.push([embedded[0] as number, embedded[1] as number]);
        groups.push([embedded[2] as number, embedded[3] as number]);
        continue;
      }
      if (!/^[0-9a-fA-F]{1,4}$/.test(piece)) return undefined;
      const value = Number.parseInt(piece, 16);
      groups.push([Math.floor(value / 256), value % 256]);
    }
    return groups;
  };
  const head = expand(halves[0] as string);
  const tail = halves.length === 2 ? expand(halves[1] as string) : [];
  if (!head || !tail) return undefined;
  if (halves.length === 1) {
    if (head.length !== 8) return undefined;
    return head.flat();
  }
  if (head.length + tail.length > 7) return undefined;
  const middle = Array.from({ length: 8 - head.length - tail.length }, () => [
    0, 0,
  ]);
  return [...head, ...middle, ...tail].flat();
}

interface Ipv4Block {
  octets: [number, number, number, number];
  prefix: number;
}

/**
 * Rule 4, IPv4 half. Everything here is unreachable from the public internet
 * or reachable only from inside a platform, and `169.254.0.0/16` carries the
 * cloud metadata service at `169.254.169.254`.
 */
const BLOCKED_IPV4: readonly Ipv4Block[] = [
  { octets: [0, 0, 0, 0], prefix: 8 }, // "this network"
  { octets: [10, 0, 0, 0], prefix: 8 }, // RFC 1918
  { octets: [100, 64, 0, 0], prefix: 10 }, // carrier-grade NAT
  { octets: [127, 0, 0, 0], prefix: 8 }, // loopback
  { octets: [169, 254, 0, 0], prefix: 16 }, // link-local, incl. metadata
  { octets: [172, 16, 0, 0], prefix: 12 }, // RFC 1918
  { octets: [192, 0, 0, 0], prefix: 24 }, // IETF protocol assignments
  { octets: [192, 168, 0, 0], prefix: 16 }, // RFC 1918
  { octets: [198, 18, 0, 0], prefix: 15 }, // benchmarking
  { octets: [224, 0, 0, 0], prefix: 4 }, // multicast
  { octets: [240, 0, 0, 0], prefix: 4 }, // reserved, incl. broadcast
];

function inIpv4Block(address: readonly number[], block: Ipv4Block): boolean {
  let remaining = block.prefix;
  for (let index = 0; index < 4 && remaining > 0; index += 1) {
    const bits = Math.min(8, remaining);
    const mask = (0xff << (8 - bits)) & 0xff;
    if (((address[index] as number) & mask) !== (block.octets[index] & mask)) {
      return false;
    }
    remaining -= bits;
  }
  return true;
}

export function isBlockedIpv4V1(address: readonly number[]): boolean {
  return BLOCKED_IPV4.some((block) => inIpv4Block(address, block));
}

/**
 * Rule 4, IPv6 half: the unspecified address, loopback, unique-local
 * (`fc00::/7`), link-local (`fe80::/10`), multicast (`ff00::/8`), and both
 * embedded-IPv4 ranges. `::ffff:0:0/96` is refused outright rather than
 * unwrapped: a v4-mapped literal is never a legitimate way to name a public
 * host, and unwrapping it would reintroduce the encoding tricks rule 4 exists
 * to close.
 */
export function isBlockedIpv6V1(address: readonly number[]): boolean {
  const zeroPrefix = address.slice(0, 10).every((byte) => byte === 0);
  if (zeroPrefix && address.slice(10).every((byte) => byte === 0)) return true;
  if (zeroPrefix && address[10] === 0 && address[11] === 0) {
    // `::` followed by anything: unspecified, loopback, v4-compatible.
    return true;
  }
  if (zeroPrefix && address[10] === 0xff && address[11] === 0xff) return true;
  const first = address[0] as number;
  if ((first & 0xfe) === 0xfc) return true; // fc00::/7
  if (first === 0xfe && ((address[1] as number) & 0xc0) === 0x80) return true; // fe80::/10
  if (first === 0xff) return true; // ff00::/8
  return false;
}

function refuse(
  reason: SsrfRefusalReasonV1,
  message: string,
): WebUrlClassificationV1 {
  return { allowed: false, reason, message };
}

/**
 * Classify one candidate URL against SSRF rules 1–5. Redirects re-enter here
 * with each resolved `Location`, so a public URL that redirects to a private
 * one is refused on the hop that names the private address.
 *
 * A refusal never names a resolved address or any other detail the caller did
 * not already supply: the message restates the candidate's own host at most.
 */
export function classifyOutboundUrlV1(
  candidate: unknown,
  policy: OutboundUrlPolicyV1 = {},
): WebUrlClassificationV1 {
  if (typeof candidate !== "string" || candidate.trim().length === 0) {
    return refuse("ssrf-invalid-url", "The url must be an absolute https URL.");
  }
  if (candidate.length > 2048) {
    return refuse("ssrf-invalid-url", "The url is too long.");
  }
  let url: URL;
  try {
    url = new URL(candidate.trim());
  } catch {
    return refuse("ssrf-invalid-url", "The url is not an absolute URL.");
  }
  if (url.protocol !== ALLOWED_PROTOCOL) {
    return refuse(
      "ssrf-blocked-scheme",
      `Only https URLs may be fetched, not ${url.protocol.replace(":", "")}.`,
    );
  }
  if (url.username || url.password) {
    return refuse(
      "ssrf-blocked-credentials",
      "A url carrying credentials is refused.",
    );
  }
  if (
    !policy.allowNonDefaultPort &&
    url.port !== "" &&
    url.port !== ALLOWED_PORT
  ) {
    return refuse("ssrf-blocked-port", "Only the default https port is used.");
  }
  const hostname = url.hostname.toLowerCase();
  const ipv6 = parseIpv6LiteralV1(hostname);
  if (ipv6) {
    return isBlockedIpv6V1(ipv6)
      ? refuse(
          "ssrf-blocked-private-address",
          "That address is not on the public internet.",
        )
      : { allowed: true, url: url.toString(), hostname };
  }
  if (hostname.startsWith("[")) {
    return refuse("ssrf-invalid-url", "The url host is not a valid address.");
  }
  const ipv4 = parseIpv4LiteralV1(hostname);
  if (ipv4) {
    return isBlockedIpv4V1(ipv4)
      ? refuse(
          "ssrf-blocked-private-address",
          "That address is not on the public internet.",
        )
      : { allowed: true, url: url.toString(), hostname };
  }
  if (isBlockedHostName(hostname)) {
    return refuse(
      "ssrf-blocked-host",
      "That host names an internal service rather than a public site.",
    );
  }
  return { allowed: true, url: url.toString(), hostname };
}

/** `web_fetch`'s policy: the default port only. */
export function classifyWebFetchUrlV1(
  candidate: unknown,
): WebUrlClassificationV1 {
  return classifyOutboundUrlV1(candidate);
}
