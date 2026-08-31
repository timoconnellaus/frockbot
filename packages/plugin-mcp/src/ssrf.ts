/**
 * The outbound-URL rules every MCP request is held to.
 *
 * These rules are not MCP's. They are the Bot's outbound trust boundary, and
 * they live in `@frockbot/plugin-web/ssrf` — one classifier, one place, used
 * by `web_fetch` and by this Package. This module is the adapter that gives
 * the shared verdict MCP's own vocabulary.
 *
 * The earlier copy of these rules lived here and said so: "when it lands, one
 * of the two becomes the other's import; they are intentionally identical in
 * behaviour so the merge is a deletion." This is that deletion. The shared
 * classifier is a strict superset of what stood here — it additionally
 * normalizes every IPv4 encoding (`0177.0.0.1`, `2130706433`, `0x7f000001`),
 * parses IPv6 properly rather than by prefix regex, and refuses a bare label
 * with no dot — so no URL this module used to accept is refused now except
 * ones that were always private.
 *
 * One rule is deliberately relaxed for MCP: `web_fetch` refuses a non-default
 * port, because a Bot reading the public web has no business on one. A User
 * naming their own MCP endpoint may well run it on its own port, so this
 * caller opts into that and into nothing else.
 */
import { classifyOutboundUrlV1 } from "@frockbot/plugin-web/ssrf";

/**
 * Decode one outbound MCP URL, or explain why it is refused. Absolute https
 * only: an MCP endpoint carries a bearer credential, and http would put it on
 * the wire in the clear.
 */
export function decodeOutboundMcpUrlV1(value: unknown): URL {
  const verdict = classifyOutboundUrlV1(value, { allowNonDefaultPort: true });
  if (verdict.allowed) return new URL(verdict.url);
  switch (verdict.reason) {
    case "ssrf-blocked-scheme":
      throw new Error("MCP server URL must use https");
    case "ssrf-blocked-credentials":
      throw new Error("MCP server URL must not carry credentials");
    case "ssrf-blocked-host":
    case "ssrf-blocked-private-address":
      throw new Error("MCP server URL must not name a private address");
    default:
      throw new Error("MCP server URL must be an absolute https URL");
  }
}
