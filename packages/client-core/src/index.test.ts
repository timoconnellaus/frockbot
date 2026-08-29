import { describe, expect, test } from "bun:test";
import { defineComponent } from "vue";
import {
  ClientApplication,
  type ClientPlugin,
  decodeAcknowledgement,
  decodeClientTurnResponse,
  decodeNotificationList,
  decodeStartConnectionResult,
} from "./index.js";

const transport = {
  turn: () => Promise.resolve({ runId: "run", text: "", events: [] }),
};
const First = defineComponent(() => () => null);
const Second = defineComponent(() => () => null);

describe("ClientApplication", () => {
  test("orders plugin-owned slots and removes them on disposal", async () => {
    const application = new ClientApplication(transport);
    const plugin: ClientPlugin = (ctx) => [
      ctx.slot({ slot: "panel", order: 20, component: Second }),
      ctx.slot({ slot: "panel", order: 10, component: First }),
    ];

    await application.install(plugin);
    expect(application.slots("panel").map((slot) => slot.component)).toEqual([
      First,
      Second,
    ]);

    application.dispose();
    expect(application.slots("panel")).toEqual([]);
  });

  test("rejects multiple root contributions during installation", async () => {
    const application = new ClientApplication(transport);
    await application.install((ctx) =>
      ctx.slot({ slot: "root", order: 10, component: First }),
    );
    let failure: unknown;

    try {
      await application.install((ctx) =>
        ctx.slot({ slot: "root", order: 20, component: Second }),
      );
    } catch (error) {
      failure = error;
    }

    expect(failure instanceof Error ? failure.message : "").toContain(
      "root is already registered",
    );
    application.dispose();
  });
});

describe("hosted response decoders", () => {
  test("decodes nested turn, notification, and Connection responses", () => {
    expect(
      decodeClientTurnResponse({
        runId: "run-1",
        text: "done",
        events: [
          {
            type: "tool/call",
            occurrenceId: "tool:1:1:0",
            name: "echo",
            input: { value: "done" },
          },
          {
            type: "tool/result",
            occurrenceId: "tool:1:1:0",
            isError: false,
          },
        ],
      }),
    ).toMatchObject({
      runId: "run-1",
      events: [
        { call: { id: "tool:1:1:0", name: "echo" } },
        { callId: "tool:1:1:0" },
      ],
    });
    expect(
      decodeNotificationList({
        schemaVersion: 1,
        notifications: [
          {
            notificationId: "notification-1",
            runId: "run-1",
            createdAt: "2026-08-28T00:00:00.000Z",
            title: "Done",
            body: "Finished",
          },
        ],
      }),
    ).toHaveLength(1);
    expect(
      decodeStartConnectionResult({
        schemaVersion: 1,
        status: "authorization-required",
        connectionId: "connection-1",
        redirectUrl: "https://connect.example/authorize",
        expiresAt: "2026-08-28T00:05:00.000Z",
      }).connectionId,
    ).toBe("connection-1");
    expect(
      decodeStartConnectionResult({
        schemaVersion: 1,
        status: "ready",
        connectionId: "connection-1",
      }),
    ).toEqual({
      schemaVersion: 1,
      status: "ready",
      connectionId: "connection-1",
    });
  });

  test("rejects malformed nested response values", () => {
    expect(() =>
      decodeClientTurnResponse({ runId: "run-1", text: "done", events: [{}] }),
    ).toThrow("turn event.type must be a string");
    expect(() =>
      decodeNotificationList({
        schemaVersion: 1,
        notifications: [{ notificationId: 1 }],
      }),
    ).toThrow("notification is invalid");
    expect(() =>
      decodeNotificationList({
        schemaVersion: 2,
        notifications: [],
      }),
    ).toThrow("notification list is invalid");
    expect(() =>
      decodeNotificationList({
        schemaVersion: 1,
        notifications: [
          {
            notificationId: "notification-run-1",
            createdAt: "2026-08-28T00:00:00.000Z",
            title: "Done",
            body: "Finished",
          },
        ],
      }),
    ).toThrow("notification is invalid");
    expect(() =>
      decodeStartConnectionResult({
        schemaVersion: 1,
        status: "authorization-required",
        connectionId: "connection-1",
      }),
    ).toThrow("Connection result is invalid");
    expect(() =>
      decodeStartConnectionResult({
        schemaVersion: 1,
        status: "ready",
        connectionId: "connection-1",
        redirectUrl: "https://connect.example/authorize",
      }),
    ).toThrow("Connection result is invalid");
    expect(() =>
      decodeStartConnectionResult({
        schemaVersion: 2,
        status: "ready",
        connectionId: "connection-1",
      }),
    ).toThrow("Connection result is invalid");
    expect(() =>
      decodeAcknowledgement({
        schemaVersion: 1,
        status: "acknowledged",
        extra: true,
      }),
    ).toThrow("acknowledgement is invalid");
  });

  test("allows only bounded absolute HTTPS Connection redirects", () => {
    const decode = (redirectUrl: string) => {
      const result = decodeStartConnectionResult({
        schemaVersion: 1,
        status: "authorization-required",
        connectionId: "connection-1",
        redirectUrl,
        expiresAt: "2026-08-28T00:05:00.000Z",
      });
      if (result.status === "ready") throw new Error("unexpected ready result");
      return result.redirectUrl;
    };

    expect(decode("https://connect.example/authorize?account=primary")).toBe(
      "https://connect.example/authorize?account=primary",
    );
    expect(decode("https://[::1]/authorize")).toBe("https://[::1]/authorize");
    for (const invalid of [
      "http://connect.example/authorize",
      "javascript:alert(1)",
      "data:text/html,unsafe",
      "/authorize",
      "//connect.example/authorize",
      "https://user:secret@connect.example/authorize",
      "https://connect.example/authorize#complete",
      "https://connect.example/authorize#",
      "https://connect.example/authorize\nnext",
      "https://connect.example/\u0000authorize",
      "https://connect.example/\u001bauthorize",
      "https:\\connect.example\\authorize",
      "https://connect_example/authorize",
      "https://connect..example/authorize",
      "https://-connect.example/authorize",
      "https://connect-.example/authorize",
      "https://connect.example:99999/authorize",
      `https://connect.example/${"x".repeat(4_096)}`,
    ]) {
      expect(() => decode(invalid)).toThrow(
        "invalid external authorization URL",
      );
    }
  });
});
