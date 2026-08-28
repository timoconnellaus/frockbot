import { describe, expect, test } from "bun:test";
import { defineComponent } from "vue";
import {
  ClientApplication,
  type ClientPlugin,
  decodeClientTurnResponse,
  decodeNotificationList,
  decodeRunList,
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
        events: [{ type: "tool/result", callId: "call-1", isError: false }],
      }),
    ).toMatchObject({ runId: "run-1", events: [{ callId: "call-1" }] });
    expect(
      decodeNotificationList({
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
        connectionId: "connection-1",
        redirectUrl: "https://connect.example/authorize",
        expiresAt: "2026-08-28T00:05:00.000Z",
      }).connectionId,
    ).toBe("connection-1");
    expect(
      decodeRunList({
        runs: [
          {
            runId: "failed-run",
            input: "Continue",
            events: [],
            status: "failed",
            failure: "Model reconciliation failed",
          },
        ],
      }),
    ).toMatchObject([
      { status: "failed", failure: "Model reconciliation failed" },
    ]);
  });

  test("rejects malformed nested response values", () => {
    expect(() =>
      decodeClientTurnResponse({ runId: "run-1", text: "done", events: [{}] }),
    ).toThrow("turn event.type must be a string");
    expect(() =>
      decodeNotificationList({ notifications: [{ notificationId: 1 }] }),
    ).toThrow("notification.notificationId must be a string");
    expect(() =>
      decodeStartConnectionResult({ connectionId: "connection-1" }),
    ).toThrow("Connection result.redirectUrl must be a string");
  });
});
