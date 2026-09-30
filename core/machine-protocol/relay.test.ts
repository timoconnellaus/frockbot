import { describe, expect, test } from "bun:test";

import {
  MACHINE_RELAY_LIMITS_V1,
  decodeLocalModelUrlV1,
  decodeMachineRelayFrameV1,
  decodeMachineRelayUpFrameV1,
  decodeMachineSocketFrameV1,
} from "./protocol.ts";

const NOW = "2026-09-30T00:00:00.000Z";

describe("decodeLocalModelUrlV1", () => {
  test.each([
    ["http://localhost:11434/v1", "http://localhost:11434/v1"],
    ["http://127.0.0.1:1234/v1/", "http://127.0.0.1:1234/v1"],
    ["http://[::1]:9337/v1", "http://[::1]:9337/v1"],
    ["  http://localhost:8080  ", "http://localhost:8080"],
    ["https://localhost:8443/v1", "https://localhost:8443/v1"],
  ])("admits %s", (input, expected) => {
    expect(decodeLocalModelUrlV1(input)).toBe(expected);
  });

  test.each([
    "http://example.com:11434/v1",
    "http://192.168.1.10:11434/v1",
    "http://10.0.0.1/v1",
    "http://0.0.0.0:11434/v1",
    "http://localhost.example.com/v1",
    "http://127.0.0.2:11434/v1",
    "http://169.254.169.254/latest",
    "http://user:pass@localhost:11434/v1",
    "http://localhost:11434/v1?x=1",
    "http://localhost:11434/v1#frag",
    "file:///etc/passwd",
    "ftp://localhost/v1",
    "localhost:11434",
    "",
    42,
  ])("refuses %p", (input) => {
    expect(() => decodeLocalModelUrlV1(input)).toThrow();
  });

  test("an address that only looks local is refused", () => {
    // The WHATWG parser normalises these to their real hosts.
    expect(() => decodeLocalModelUrlV1("http://localhost@evil.com/")).toThrow();
    expect(() =>
      decodeLocalModelUrlV1("http://evil.com\\@localhost:11434/"),
    ).toThrow();
  });
});

describe("relay frames", () => {
  const relay = {
    type: "relay",
    relayId: "chat:req-1",
    method: "POST",
    url: "http://localhost:11434/v1/chat/completions",
    body: "{}",
    deadline: NOW,
    serverTime: NOW,
  };

  test("a relay decodes through the socket frame decoder", () => {
    expect(decodeMachineSocketFrameV1(relay)).toEqual(relay as never);
    expect(
      decodeMachineSocketFrameV1({ type: "relay-cancel", relayId: "x" }),
    ).toEqual({ type: "relay-cancel", relayId: "x" });
  });

  test("a relay to anywhere but loopback is refused", () => {
    expect(() =>
      decodeMachineRelayFrameV1({ ...relay, url: "https://api.openai.com/v1" }),
    ).toThrow(/must be on this computer/);
  });

  test("a GET carries no body and fields are exact", () => {
    expect(() =>
      decodeMachineRelayFrameV1({ ...relay, method: "GET" }),
    ).toThrow();
    expect(() => decodeMachineRelayFrameV1({ ...relay, extra: 1 })).toThrow();
    expect(() =>
      decodeMachineRelayFrameV1({ ...relay, method: "DELETE" }),
    ).toThrow();
  });

  test("an oversized body is refused", () => {
    expect(() =>
      decodeMachineRelayFrameV1({
        ...relay,
        body: "x".repeat(MACHINE_RELAY_LIMITS_V1.requestBytes + 1),
      }),
    ).toThrow();
  });

  test("up-frames decode strictly", () => {
    expect(
      decodeMachineRelayUpFrameV1({
        type: "relay-head",
        relayId: "r",
        status: 200,
        contentType: "text/event-stream",
      }),
    ).toEqual({
      type: "relay-head",
      relayId: "r",
      status: 200,
      contentType: "text/event-stream",
    });
    expect(
      decodeMachineRelayUpFrameV1({
        type: "relay-data",
        relayId: "r",
        data: "",
      }),
    ).toEqual({ type: "relay-data", relayId: "r", data: "" });
    expect(() =>
      decodeMachineRelayUpFrameV1({
        type: "relay-head",
        relayId: "r",
        status: 7,
      }),
    ).toThrow();
    expect(() =>
      decodeMachineRelayUpFrameV1({ type: "relay-end", relayId: "bad id" }),
    ).toThrow();
    expect(() =>
      decodeMachineRelayUpFrameV1({ type: "nope", relayId: "r" }),
    ).toThrow();
  });
});
