import { describe, expect, test } from "bun:test";
import {
  classifyOutboundUrlV1,
  classifyWebFetchUrlV1,
  parseIpv4LiteralV1,
  parseIpv6LiteralV1,
  type SsrfRefusalReasonV1,
} from "./ssrf.ts";

/**
 * The classifier's whole contract, as a table. Each row is a URL a model could
 * plausibly hand `web_fetch` and the verdict the Bot's outbound boundary must
 * reach. `undefined` means the URL is allowed.
 */
const TABLE: ReadonlyArray<[string, SsrfRefusalReasonV1 | undefined]> = [
  // Allowed: ordinary public sites, in the shapes they actually arrive in.
  ["https://example.com/", undefined],
  ["https://example.com:443/a/b?c=d#e", undefined],
  ["https://sub.example.co.uk/page", undefined],
  ["https://example.test/index.html", undefined],
  ["https://1.1.1.1/", undefined],
  ["https://8.8.8.8/resolve", undefined],
  ["https://[2606:4700:4700::1111]/", undefined],
  ["https://xn--bcher-kva.example/", undefined],

  // Rule 1: scheme.
  ["http://example.com/", "ssrf-blocked-scheme"],
  ["http://169.254.169.254/latest/meta-data", "ssrf-blocked-scheme"],
  ["ftp://example.com/", "ssrf-blocked-scheme"],
  ["file:///etc/passwd", "ssrf-blocked-scheme"],
  ["data:text/html,<b>hi</b>", "ssrf-blocked-scheme"],
  ["blob:https://example.com/abc", "ssrf-blocked-scheme"],

  // Rule 2: port.
  ["https://example.com:8080/", "ssrf-blocked-port"],
  ["https://example.com:22/", "ssrf-blocked-port"],

  // Rule 5: credentials in the URL.
  ["https://user:pass@example.com/", "ssrf-blocked-credentials"],
  ["https://user@example.com/", "ssrf-blocked-credentials"],

  // Rule 3: names that are not the public internet.
  ["https://localhost/", "ssrf-blocked-host"],
  ["https://server.local/", "ssrf-blocked-host"],
  ["https://printer.home.arpa/", "ssrf-blocked-host"],
  ["https://api.localhost/", "ssrf-blocked-host"],
  ["https://metadata.google.internal/computeMetadata/v1/", "ssrf-blocked-host"],
  ["https://foo.internal/", "ssrf-blocked-host"],
  ["https://redis/", "ssrf-blocked-host"],
  ["https://metadata/", "ssrf-blocked-host"],

  // Rule 4: IPv4, in every encoding the host parser accepts.
  ["https://169.254.169.254/latest/meta-data", "ssrf-blocked-private-address"],
  ["https://127.0.0.1/", "ssrf-blocked-private-address"],
  ["https://0177.0.0.1/", "ssrf-blocked-private-address"],
  ["https://2130706433/", "ssrf-blocked-private-address"],
  ["https://0x7f000001/", "ssrf-blocked-private-address"],
  ["https://0x7f.1/", "ssrf-blocked-private-address"],
  ["https://127.1/", "ssrf-blocked-private-address"],
  ["https://10.0.0.5/", "ssrf-blocked-private-address"],
  ["https://172.16.0.1/", "ssrf-blocked-private-address"],
  ["https://192.168.1.1/", "ssrf-blocked-private-address"],
  ["https://100.64.0.1/", "ssrf-blocked-private-address"],
  ["https://198.18.0.1/", "ssrf-blocked-private-address"],
  ["https://192.0.0.1/", "ssrf-blocked-private-address"],
  ["https://0.0.0.0/", "ssrf-blocked-private-address"],
  ["https://255.255.255.255/", "ssrf-blocked-private-address"],
  ["https://239.0.0.1/", "ssrf-blocked-private-address"],

  // Rule 4: IPv6, including the mapped and compatible forms.
  ["https://[::1]/", "ssrf-blocked-private-address"],
  ["https://[::]/", "ssrf-blocked-private-address"],
  ["https://[::ffff:127.0.0.1]/", "ssrf-blocked-private-address"],
  ["https://[::ffff:8.8.8.8]/", "ssrf-blocked-private-address"],
  ["https://[fd00::1]/", "ssrf-blocked-private-address"],
  ["https://[fe80::1]/", "ssrf-blocked-private-address"],
  ["https://[ff02::1]/", "ssrf-blocked-private-address"],

  // Not URLs at all.
  ["", "ssrf-invalid-url"],
  ["not a url", "ssrf-invalid-url"],
  ["/relative/path", "ssrf-invalid-url"],
];

describe("the web_fetch outbound classifier", () => {
  for (const [candidate, expected] of TABLE) {
    test(`${expected ?? "allows"} ${candidate || "(empty)"}`, () => {
      const verdict = classifyWebFetchUrlV1(candidate);
      if (expected === undefined) {
        expect({ candidate, allowed: verdict.allowed }).toEqual({
          candidate,
          allowed: true,
        });
        return;
      }
      expect({
        candidate,
        reason: verdict.allowed ? undefined : verdict.reason,
      }).toEqual({ candidate, reason: expected });
    });
  }

  test("refuses a redirect that leaves the public internet", () => {
    // The first hop is a legitimate public URL; the `Location` is not. Only
    // re-running the classifier on the resolved target catches this, which is
    // exactly what `web_fetch` does on every hop.
    expect(classifyWebFetchUrlV1("https://redirector.example/go").allowed).toBe(
      true,
    );
    const followed = classifyWebFetchUrlV1(
      new URL(
        "//169.254.169.254/latest/meta-data",
        "https://redirector.example/go",
      ).toString(),
    );
    expect(followed.allowed ? "allowed" : followed.reason).toBe(
      "ssrf-blocked-private-address",
    );
  });

  test("lets a caller that legitimately needs a port opt into one", () => {
    // `web_fetch` refuses a non-default port; a User-named MCP endpoint on its
    // own port is an ordinary deployment, so that caller opts in explicitly.
    expect(
      classifyWebFetchUrlV1("https://mcp.example.test:8443/mcp").allowed,
    ).toBe(false);
    expect(
      classifyOutboundUrlV1("https://mcp.example.test:8443/mcp", {
        allowNonDefaultPort: true,
      }).allowed,
    ).toBe(true);
    // Opting into a port opts into nothing else.
    const stillPrivate = classifyOutboundUrlV1("https://127.0.0.1:8443/", {
      allowNonDefaultPort: true,
    });
    expect(stillPrivate.allowed ? "allowed" : stillPrivate.reason).toBe(
      "ssrf-blocked-private-address",
    );
  });

  test("never names a resolved address in a refusal", () => {
    const verdict = classifyWebFetchUrlV1("https://169.254.169.254/");
    expect(verdict.allowed).toBe(false);
    if (verdict.allowed) return;
    expect(verdict.message).not.toContain("169.254");
  });

  test("normalizes every IPv4 encoding to the same address", () => {
    for (const candidate of [
      "127.0.0.1",
      "0177.0.0.1",
      "2130706433",
      "0x7f000001",
      "127.1",
    ]) {
      expect({ candidate, octets: parseIpv4LiteralV1(candidate) }).toEqual({
        candidate,
        octets: [127, 0, 0, 1],
      });
    }
    expect(parseIpv4LiteralV1("example.com")).toBeUndefined();
    expect(parseIpv4LiteralV1("256.0.0.1")).toBeUndefined();
  });

  test("expands compressed and v4-embedded IPv6 literals", () => {
    expect(parseIpv6LiteralV1("[::1]")).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1,
    ]);
    expect(parseIpv6LiteralV1("::ffff:127.0.0.1")).toEqual([
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 255, 255, 127, 0, 0, 1,
    ]);
    expect(parseIpv6LiteralV1("example.com")).toBeUndefined();
  });
});
