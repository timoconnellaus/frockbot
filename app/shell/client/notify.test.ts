import { afterEach, describe, expect, test } from "bun:test";
import { showClientNotificationV1 } from "./notify.js";

const globals = globalThis as unknown as {
  window?: Record<string, unknown>;
  Notification?: unknown;
};
const original = { window: globals.window, Notification: globals.Notification };

afterEach(() => {
  globals.window = original.window;
  globals.Notification = original.Notification;
});

function shellBridge(commandId: string, calls: unknown[]) {
  return {
    list: () => [{ id: commandId }],
    invoke: (request: unknown) => {
      calls.push(request);
      return Promise.resolve({ status: "ok" });
    },
  };
}

function webNotification(shown: unknown[]) {
  class FakeNotification {
    static permission = "granted";
    constructor(title: string, options?: { body?: string }) {
      shown.push({ title, body: options?.body });
    }
  }
  return FakeNotification;
}

describe("the client notification seam", () => {
  test("prefers the desktop Package when the shell exposes it", async () => {
    const calls: unknown[] = [];
    const shown: unknown[] = [];
    globals.window = {
      frockbotDesktop: shellBridge("desktop.notifications.show", calls),
      Notification: webNotification(shown),
    };
    globals.Notification = globals.window.Notification;
    expect(
      await showClientNotificationV1({ title: "Alpha replied", body: "hi" }),
    ).toBe("desktop");
    expect(calls).toEqual([
      {
        schemaVersion: 1,
        action: "invoke",
        commandId: "desktop.notifications.show",
        input: { title: "Alpha replied", body: "hi", urgency: "normal" },
      },
    ]);
    expect(shown).toEqual([]);
  });

  test("uses the mobile Package when that is the shell", async () => {
    const calls: unknown[] = [];
    globals.window = {
      // The desktop bridge exists but exposes no commands, exactly as the
      // Electron preload does today.
      frockbotDesktop: { request: () => Promise.resolve(undefined) },
      frockbotMobile: shellBridge("mobile.notifications.show", calls),
    };
    globals.Notification = undefined;
    expect(await showClientNotificationV1({ title: "Beta", body: "" })).toBe(
      "mobile",
    );
    expect(calls).toHaveLength(1);
  });

  test("falls back to the web API, and reports when nothing can show it", async () => {
    const shown: unknown[] = [];
    const Notification = webNotification(shown);
    globals.window = { Notification };
    globals.Notification = Notification;
    expect(await showClientNotificationV1({ title: "Gamma", body: "b" })).toBe(
      "web",
    );
    expect(shown).toEqual([{ title: "Gamma", body: "b" }]);

    Notification.permission = "denied";
    expect(await showClientNotificationV1({ title: "Gamma", body: "b" })).toBe(
      "unavailable",
    );
    expect(shown).toHaveLength(1);
  });
});
