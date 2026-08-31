/**
 * The outbound-URL rules every MCP request is held to.
 *
 * A remote MCP server URL is User-supplied text that a Durable Object then
 * fetches, so it is the classic server-side request forgery surface: the
 * request leaves from inside the deployment's network, carrying a credential
 * the User never sees. The rules here are deliberately narrow — https only,
 * no credentials in the URL, and no address that could name something inside
 * a private network — so that a URL which passes is one whose only reachable
 * destination is the public internet.
 *
 * NOTE (duplication): the same classifier is specified for the Web Tools
 * Package. That PR had not landed when this one was written, so there is no
 * `plugin-web/src/ssrf.ts` to import. When it lands, one of the two becomes
 * the other's import; they are intentionally identical in behaviour so the
 * merge is a deletion.
 */

export interface OutboundUrlRejection {
  reason: string;
}

const BLOCKED_HOST_SUFFIXES = [
  ".local",
  ".internal",
  ".localhost",
  ".home.arpa",
];

const BLOCKED_HOSTNAMES = new Set([
  "localhost",
  "metadata.google.internal",
  "metadata",
]);

function isIpv4Literal(host: string): number[] | undefined {
  const parts = host.split(".");
  if (parts.length !== 4) return undefined;
  const octets = parts.map((part) =>
    /^\d{1,3}$/.test(part) ? Number(part) : Number.NaN,
  );
  if (octets.some((octet) => !Number.isInteger(octet) || octet > 255)) {
    return undefined;
  }
  return octets;
}

/** RFC 1918, loopback, link-local, CGNAT, broadcast and reserved ranges. */
function isPrivateIpv4(octets: number[]): boolean {
  const [a = 0, b = 0] = octets;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateIpv6(host: string): boolean {
  // `URL` keeps an IPv6 literal in brackets and lowercases it.
  const inner =
    host.startsWith("[") && host.endsWith("]") ? host.slice(1, -1) : host;
  if (!inner.includes(":")) return false;
  if (inner === "::" || inner === "::1") return true;
  // Unique local (fc00::/7), link-local (fe80::/10), and IPv4-mapped.
  if (/^f[cd]/.test(inner) || /^fe[89ab]/.test(inner)) return true;
  const mapped = inner.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped?.[1]) {
    const octets = isIpv4Literal(mapped[1]);
    return octets ? isPrivateIpv4(octets) : true;
  }
  return false;
}

/**
 * Decode one outbound MCP URL, or explain why it is refused. Absolute https
 * only: an MCP endpoint carries a bearer credential, and http would put it on
 * the wire in the clear.
 */
export function decodeOutboundMcpUrlV1(value: unknown): URL {
  if (typeof value !== "string" || value.length === 0 || value.length > 2_048) {
    throw new Error("MCP server URL must be an absolute https URL");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("MCP server URL must be an absolute https URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("MCP server URL must use https");
  }
  if (url.username || url.password) {
    throw new Error("MCP server URL must not carry credentials");
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(host)) {
    throw new Error("MCP server URL must not name a private address");
  }
  if (BLOCKED_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix))) {
    throw new Error("MCP server URL must not name a private address");
  }
  const octets = isIpv4Literal(host);
  if (octets && isPrivateIpv4(octets)) {
    throw new Error("MCP server URL must not name a private address");
  }
  if (isPrivateIpv6(host)) {
    throw new Error("MCP server URL must not name a private address");
  }
  return url;
}
