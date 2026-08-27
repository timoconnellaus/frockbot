import { describe, expect, test } from "bun:test";
import type {
  MobileNotificationRequest,
  MobileShareRequest,
} from "@frockbot/mobile-core";
import {
  READ_CLIPBOARD_TEXT_COMMAND,
  type ReadClipboardTextResult,
  WRITE_CLIPBOARD_TEXT_COMMAND,
  type WriteClipboardTextResult,
} from "@frockbot/plugin-mobile-clipboard/mobile";
import { SHOW_NOTIFICATION_COMMAND } from "@frockbot/plugin-mobile-notifications/mobile";
import type { MobilePlatformAdapters } from "./adapters.ts";
import {
  BUILT_IN_MOBILE_PACKAGES,
  createMobileHost,
  resolveBuiltInMobileContribution,
} from "./index.ts";

interface FakePlatform {
  adapters: MobilePlatformAdapters;
  notifications: MobileNotificationRequest[];
  shares: MobileShareRequest[];
  clipboardText: () => string;
}

function createFakePlatform(initialClipboard = "initial"): FakePlatform {
  const notifications: MobileNotificationRequest[] = [];
  const shares: MobileShareRequest[] = [];
  let clipboard = initialClipboard;
  return {
    notifications,
    shares,
    clipboardText: () => clipboard,
    adapters: {
      notifications: {
        show(request, signal) {
          signal.throwIfAborted();
          notifications.push(request);
          return Promise.resolve();
        },
      },
      clipboard: {
        readText(signal) {
          signal.throwIfAborted();
          return Promise.resolve(clipboard);
        },
        writeText(text, signal) {
          signal.throwIfAborted();
          clipboard = text;
          return Promise.resolve();
        },
      },
      share: {
        share(request, signal) {
          signal.throwIfAborted();
          shares.push(request);
          return Promise.resolve();
        },
      },
    },
  };
}

async function expectFailure(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  let failure: unknown;
  try {
    await promise;
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(failure instanceof Error ? failure.message : "").toContain(message);
}

describe("createMobileHost", () => {
  test("mounts the built-in mobile contributions", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({ adapters: platform.adapters });

    expect(host.list()).toEqual([
      { id: READ_CLIPBOARD_TEXT_COMMAND },
      { id: WRITE_CLIPBOARD_TEXT_COMMAND },
      { id: SHOW_NOTIFICATION_COMMAND },
    ]);
    await host.dispose();
  });

  test("invokes clipboard commands against the platform adapter", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({ adapters: platform.adapters });

    expect(await host.invoke<ReadClipboardTextResult>(READ_CLIPBOARD_TEXT_COMMAND, {})).toEqual({
      text: "initial",
    });
    expect(
      await host.invoke<WriteClipboardTextResult>(WRITE_CLIPBOARD_TEXT_COMMAND, {
        text: "copied reply",
      }),
    ).toEqual({ written: true });
    expect(platform.clipboardText()).toBe("copied reply");
    await host.dispose();
  });

  test("invokes the notification command against the platform adapter", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({ adapters: platform.adapters });

    await host.invoke(SHOW_NOTIFICATION_COMMAND, {
      title: " default replied ",
      body: "Turn complete",
      urgency: "critical",
    });

    expect(platform.notifications).toEqual([
      { title: "default replied", body: "Turn complete", urgency: "critical" },
    ]);
    await host.dispose();
  });

  test("decodes share requests before reaching the platform", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({ adapters: platform.adapters });

    await host.share({ title: " FrockBot ", text: " a reply " });
    expect(platform.shares).toEqual([
      { title: "FrockBot", text: "a reply", url: undefined },
    ]);
    await expectFailure(
      host.share({ title: "FrockBot" }),
      "share request must include text or url",
    );
    await host.dispose();
  });

  test("rejects malformed command input before the adapter runs", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({ adapters: platform.adapters });

    await expectFailure(
      host.invoke(WRITE_CLIPBOARD_TEXT_COMMAND, { text: 42 }),
      "clipboard text must be a string",
    );
    await expectFailure(
      host.invoke(SHOW_NOTIFICATION_COMMAND, { title: " " }),
      "notification title is required",
    );
    expect(platform.clipboardText()).toBe("initial");
    expect(platform.notifications).toEqual([]);
    await host.dispose();
  });

  test("propagates cancellation to the adapter", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({ adapters: platform.adapters });
    const controller = new AbortController();
    controller.abort(new Error("cancelled by test"));

    await expectFailure(
      host.invoke(
        WRITE_CLIPBOARD_TEXT_COMMAND,
        { text: "not written" },
        controller.signal,
      ),
      "cancelled by test",
    );
    expect(platform.clipboardText()).toBe("initial");
    await host.dispose();
  });

  test("unregisters every command when the host is disposed", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({ adapters: platform.adapters });

    await host.dispose();

    expect(host.list()).toEqual([]);
    await expectFailure(
      host.invoke(READ_CLIPBOARD_TEXT_COMMAND, {}),
      "is unavailable",
    );
  });

  test("fails when a declared contribution cannot be resolved", async () => {
    const platform = createFakePlatform();

    await expectFailure(
      createMobileHost({
        adapters: platform.adapters,
        resolveContribution: () =>
          Promise.reject(new Error("unknown built-in contribution")),
      }),
      "unknown built-in contribution",
    );
  });

  test("resolves only the declared built-in contribution specifiers", async () => {
    for (const pkg of BUILT_IN_MOBILE_PACKAGES) {
      const resolved = await resolveBuiltInMobileContribution(
        `${pkg.specifier}/mobile`,
      );
      expect(typeof (resolved as { default: unknown }).default).toBe("function");
    }
    await expectFailure(
      resolveBuiltInMobileContribution("@frockbot/plugin-clock/mobile"),
      "unknown built-in contribution: @frockbot/plugin-clock/mobile",
    );
  });
});
