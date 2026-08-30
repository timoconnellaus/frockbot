import { describe, expect, test } from "bun:test";
import { handleHostedMobileMessage } from "./hosted-bridge.ts";

const origin = "https://app.frockbot.com";
const source = {} as MessageEventSource;

function event(data: unknown, overrides: Partial<MessageEvent> = {}) {
  return {
    origin,
    source,
    data,
    ...overrides,
  } as Pick<MessageEvent, "origin" | "source" | "data">;
}

describe("hosted mobile bridge", () => {
  test("round-trips one authenticated hosted API request", async () => {
    const requests: Array<{ path: string; init: RequestInit }> = [];
    const posted: Array<Record<string, unknown>> = [];
    await handleHostedMobileMessage(
      event({
        schemaVersion: 1,
        type: "frockbot/mobile-api-request",
        id: "person@example.com",
        path: "/api/bots",
        method: "GET",
      }),
      {
        hostedOrigin: origin,
        frameWindow: source,
        authorizedFetch: (path, init) => {
          requests.push({ path, init });
          return Promise.resolve(
            new Response('{"schemaVersion":1}', {
              status: 200,
              headers: { "content-type": "application/json" },
            }),
          );
        },
        invoke: () => Promise.reject(new Error("not used")),
        post: (message) => posted.push(message),
      },
    );
    expect(requests).toEqual([{ path: "/api/bots", init: { method: "GET" } }]);
    expect(posted).toEqual([
      {
        schemaVersion: 1,
        type: "frockbot/mobile-api-response",
        id: "person@example.com",
        status: 200,
        contentType: "application/json",
        body: '{"schemaVersion":1}',
      },
    ]);
  });

  test("accepts canonical RPC command identifiers", async () => {
    const invoked: Array<{ commandId: string; input: unknown }> = [];
    const posted: Array<Record<string, unknown>> = [];
    await handleHostedMobileMessage(
      event({
        schemaVersion: 1,
        type: "frockbot/mobile-command",
        id: "command@example.com",
        commandId: "clipboard:write@example.com",
        input: { text: "hello" },
      }),
      {
        hostedOrigin: origin,
        frameWindow: source,
        authorizedFetch: () => Promise.reject(new Error("not used")),
        invoke: (commandId, input) => {
          invoked.push({ commandId, input });
          return Promise.resolve("done");
        },
        post: (message) => posted.push(message),
      },
    );
    expect(invoked).toEqual([
      {
        commandId: "clipboard:write@example.com",
        input: { text: "hello" },
      },
    ]);
    expect(posted).toEqual([
      {
        schemaVersion: 1,
        type: "frockbot/mobile-command-result",
        id: "command@example.com",
        result: "done",
      },
    ]);
  });

  test("rejects wrong sources, origins, and unknown fields without effects", async () => {
    let effects = 0;
    const bridge = {
      hostedOrigin: origin,
      frameWindow: source,
      authorizedFetch: () => {
        effects += 1;
        return Promise.resolve(new Response());
      },
      invoke: () => {
        effects += 1;
        return Promise.resolve(undefined);
      },
      post: () => {
        effects += 1;
      },
    };
    const value = {
      schemaVersion: 1,
      type: "frockbot/mobile-api-request",
      id: "request-1",
      path: "/api/bots",
      method: "GET",
    };
    await handleHostedMobileMessage(
      event(value, { origin: "https://evil.test" }),
      bridge,
    );
    await handleHostedMobileMessage(
      event(value, { source: {} as MessageEventSource }),
      bridge,
    );
    await handleHostedMobileMessage(event({ ...value, extra: true }), bridge);
    expect(effects).toBe(0);
  });
});
