/**
 * The model provider Plugin wire: what a transport call may name, and what a
 * Plugin's answer may carry.
 *
 * The destination rule is the load-bearing one — a Plugin composes a body and
 * nothing else, and the endpoint and route are the deployment's — so most of
 * this file is about the ways a call must *not* be able to leave.
 */
import { describe, expect, test } from "bun:test";
import {
  decodePluginModelEventLineV1,
  decodePluginModelInvocationV1,
  decodePluginModelTransportRequestV1,
  PLUGIN_MODEL_DEADLINE_MAX_MS_V1,
  PLUGIN_MODEL_TRANSPORT_BODY_MAX_BYTES_V1,
  pluginModelTransportUrlV1,
} from "./plugin-model.js";
import { ISOLATE_MAX_DEADLINE_MS } from "./isolate.js";

const ENDPOINT = "https://api.deepseek.com";
const ROUTE = "/chat/completions";

describe("the one URL a transport call may go to", () => {
  test("joins the endpoint and the route", () => {
    expect(pluginModelTransportUrlV1(ENDPOINT, ROUTE)).toEqual({
      status: "ok",
      url: "https://api.deepseek.com/chat/completions",
    });
  });

  test("keeps an endpoint's own path prefix", () => {
    expect(
      pluginModelTransportUrlV1("https://gateway.example.com/deepseek", ROUTE),
    ).toEqual({
      status: "ok",
      url: "https://gateway.example.com/deepseek/chat/completions",
    });
  });

  test("refuses a route that is not a plain path under the endpoint", () => {
    for (const route of [
      "/chat/completions/../../user/balance",
      "/chat//completions",
      "chat/completions",
      "",
      "https://elsewhere.example.com/chat/completions",
      "/chat/completions\\user",
    ]) {
      expect(pluginModelTransportUrlV1(ENDPOINT, route)).toMatchObject({
        status: "refused",
      });
    }
  });

  test("refuses a route carrying a query or a fragment", () => {
    expect(
      pluginModelTransportUrlV1(ENDPOINT, "/chat/completions?x=1"),
    ).toMatchObject({ status: "refused" });
    expect(
      pluginModelTransportUrlV1(ENDPOINT, "/chat/completions#top"),
    ).toMatchObject({ status: "refused" });
  });

  test("refuses an endpoint that is not https, or carries credentials or a query", () => {
    for (const endpoint of [
      "http://api.deepseek.com",
      "https://user:secret@api.deepseek.com",
      "https://api.deepseek.com?key=1",
      "https://api.deepseek.com#x",
      "not a url",
    ]) {
      expect(pluginModelTransportUrlV1(endpoint, ROUTE)).toMatchObject({
        status: "refused",
      });
    }
  });
});

describe("the transport request a Plugin may send", () => {
  test("carries a ticket and a body, and no destination at all", () => {
    expect(
      decodePluginModelTransportRequestV1({
        schemaVersion: 1,
        transportId: "ticket-1",
        body: "{}",
      }),
    ).toEqual({ schemaVersion: 1, transportId: "ticket-1", body: "{}" });
  });

  test("refuses a request that tries to name a path", () => {
    expect(() =>
      decodePluginModelTransportRequestV1({
        schemaVersion: 1,
        transportId: "ticket-1",
        body: "{}",
        path: "/chat/completions",
      }),
    ).toThrow(/invalid fields/);
  });

  test("bounds the body", () => {
    expect(() =>
      decodePluginModelTransportRequestV1({
        schemaVersion: 1,
        transportId: "ticket-1",
        body: "x".repeat(PLUGIN_MODEL_TRANSPORT_BODY_MAX_BYTES_V1 + 1),
      }),
    ).toThrow();
  });
});

describe("the model invocation a Plugin is handed", () => {
  const request = {
    requestId: "request-1",
    provider: "deepseek",
    model: "deepseek-v4-pro",
    system: "",
    messages: [],
    tools: [],
  };
  const invocation = {
    schemaVersion: 1,
    pluginId: "deepseek",
    provider: "deepseek",
    protocolVersion: 1,
    request,
    transportId: "ticket-1",
    botId: "bot-1",
    sessionId: "session-1",
    runId: "run-1",
    turnId: "run-1",
    generationId: "generation-1",
    deadlineMs: 60_000,
    firstEventDeadlineMs: 120_000,
  };

  test("decodes, and refuses a request bound to a Connection", () => {
    expect(decodePluginModelInvocationV1(invocation).transportId).toBe(
      "ticket-1",
    );
    expect(() =>
      decodePluginModelInvocationV1({
        ...invocation,
        request: {
          ...request,
          modelBinding: { connectionId: "connection-1" },
        },
      }),
    ).toThrow(/Connection binding/);
  });

  test("its silence allowance is the isolate contract's own ceiling", () => {
    expect(PLUGIN_MODEL_DEADLINE_MAX_MS_V1).toBe(ISOLATE_MAX_DEADLINE_MS);
  });
});

describe("one event of a Plugin's answer", () => {
  test("decodes the normalized vocabulary", () => {
    expect(
      decodePluginModelEventLineV1('{"type":"text-delta","text":"hi"}'),
    ).toEqual({ type: "text-delta", text: "hi" });
    expect(
      decodePluginModelEventLineV1(
        '{"type":"provider-failure","classification":"transient","reason":"busy","retryAfterMs":1000}',
      ),
    ).toMatchObject({ classification: "transient", retryAfterMs: 1000 });
  });

  test("refuses a line that is not JSON, or not an event", () => {
    expect(() => decodePluginModelEventLineV1("{")).toThrow(/not JSON/);
    expect(() =>
      decodePluginModelEventLineV1('{"type":"what-even-is-this"}'),
    ).toThrow(/type is invalid/);
    expect(() =>
      decodePluginModelEventLineV1('{"type":"text-delta","text":7}'),
    ).toThrow(/text/);
  });

  test("refuses a finish reason the kernel does not have", () => {
    expect(() =>
      decodePluginModelEventLineV1('{"type":"finish","reason":"whatever"}'),
    ).toThrow(/reason is invalid/);
  });
});
