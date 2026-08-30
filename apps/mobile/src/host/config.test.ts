import { describe, expect, test } from "bun:test";
import { decodeHostedApplicationUrl } from "./config.ts";

describe("mobile hosted application configuration", () => {
  test("accepts only an HTTPS origin or explicit loopback development origin", () => {
    expect(decodeHostedApplicationUrl("https://app.example.com/")).toBe(
      "https://app.example.com",
    );
    expect(decodeHostedApplicationUrl("http://127.0.0.1:5173")).toBe(
      "http://127.0.0.1:5173",
    );
    for (const value of [
      undefined,
      "not a URL",
      "http://app.example.com",
      "file:///tmp/app",
      "https://user:secret@app.example.com",
      "https://app.example.com/path",
      "https://app.example.com/?mobile_shell=1",
      "https://app.example.com/#mobile",
    ]) {
      expect(() => decodeHostedApplicationUrl(value)).toThrow();
    }
  });
});
