import { describe, expect, test } from "bun:test";
import { decodeOutboundMcpUrlV1 } from "./ssrf.js";

describe("decodeOutboundMcpUrlV1", () => {
  test("accepts an absolute https URL", () => {
    expect(
      decodeOutboundMcpUrlV1("https://mcp.example.test/mcp?v=1").toString(),
    ).toBe("https://mcp.example.test/mcp?v=1");
  });

  test.each([
    ["http://mcp.example.test/mcp", /must use https/],
    ["ws://mcp.example.test/mcp", /must use https/],
    ["/mcp", /absolute https URL/],
    ["", /absolute https URL/],
    ["https://user:pass@mcp.example.test/mcp", /must not carry credentials/],
    ["https://localhost/mcp", /private address/],
    ["https://server.local/mcp", /private address/],
    ["https://127.0.0.1/mcp", /private address/],
    ["https://10.0.0.5/mcp", /private address/],
    ["https://172.16.4.4/mcp", /private address/],
    ["https://192.168.0.1/mcp", /private address/],
    ["https://169.254.169.254/latest", /private address/],
    ["https://100.100.0.1/mcp", /private address/],
    ["https://metadata.google.internal/mcp", /private address/],
    ["https://[::1]/mcp", /private address/],
    ["https://[fd00::1]/mcp", /private address/],
    ["https://[fe80::1]/mcp", /private address/],
  ])("refuses %s", (url, reason) => {
    expect(() => decodeOutboundMcpUrlV1(url)).toThrow(reason);
  });

  test("still accepts a public IP literal", () => {
    expect(decodeOutboundMcpUrlV1("https://93.184.216.34/mcp").hostname).toBe(
      "93.184.216.34",
    );
  });
});
