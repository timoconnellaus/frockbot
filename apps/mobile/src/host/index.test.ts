import { describe, expect, test } from "bun:test";
import type { MobileNotificationRequest } from "@frockbot/mobile-core";
import mobileClipboardManifest from "@frockbot/plugin-mobile-clipboard/manifest";
import {
  READ_CLIPBOARD_TEXT_COMMAND,
  type ReadClipboardTextResult,
  WRITE_CLIPBOARD_TEXT_COMMAND,
  type WriteClipboardTextResult,
} from "@frockbot/plugin-mobile-clipboard/mobile";
import mobileNotificationsManifest from "@frockbot/plugin-mobile-notifications/manifest";
import { SHOW_NOTIFICATION_COMMAND } from "@frockbot/plugin-mobile-notifications/mobile";
import type { MobilePlatformAdapters } from "./adapters.ts";
import {
  CLIPBOARD_PACKAGE,
  createMobileHost,
  NOTIFICATIONS_PACKAGE,
  resolveBuiltInMobileContribution,
  type MobileHostPackage,
} from "./index.ts";

const declaredPackages: readonly MobileHostPackage[] = [
  { specifier: NOTIFICATIONS_PACKAGE, manifest: mobileNotificationsManifest },
  { specifier: CLIPBOARD_PACKAGE, manifest: mobileClipboardManifest },
];

function createFakePlatform(initialClipboard = "initial") {
  const notifications: MobileNotificationRequest[] = [];
  let clipboard = initialClipboard;
  const adapters: MobilePlatformAdapters = {
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
  };
  return { adapters, notifications, clipboardText: () => clipboard };
}

async function expectFailure(
  promise: Promise<unknown>,
  message: string,
): Promise<void> {
  await expect(promise).rejects.toThrow(message);
}

describe("createMobileHost", () => {
  test("mounts only application-declared Contributions in declaration order", async () => {
    const platform = createFakePlatform();
    const resolved: string[] = [];
    const host = await createMobileHost({
      adapters: platform.adapters,
      packages: [...declaredPackages].reverse(),
      resolveContribution: async (specifier) => {
        resolved.push(specifier);
        return await resolveBuiltInMobileContribution(specifier);
      },
    });

    expect(resolved).toEqual([
      `${CLIPBOARD_PACKAGE}/mobile`,
      `${NOTIFICATIONS_PACKAGE}/mobile`,
    ]);
    expect(host.list()).toEqual([
      { id: READ_CLIPBOARD_TEXT_COMMAND },
      { id: WRITE_CLIPBOARD_TEXT_COMMAND },
      { id: SHOW_NOTIFICATION_COMMAND },
    ]);
    await host.dispose();
  });

  test("invokes declared clipboard and notification Plugins", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({
      adapters: platform.adapters,
      packages: declaredPackages,
    });

    expect(
      await host.invoke<ReadClipboardTextResult>(
        READ_CLIPBOARD_TEXT_COMMAND,
        {},
      ),
    ).toEqual({ text: "initial" });
    expect(
      await host.invoke<WriteClipboardTextResult>(
        WRITE_CLIPBOARD_TEXT_COMMAND,
        { text: "copied reply" },
      ),
    ).toEqual({ written: true });
    await host.invoke(SHOW_NOTIFICATION_COMMAND, {
      title: " default replied ",
      body: "Turn complete",
      urgency: "critical",
    });

    expect(platform.clipboardText()).toBe("copied reply");
    expect(platform.notifications).toEqual([
      { title: "default replied", body: "Turn complete", urgency: "critical" },
    ]);
    await host.dispose();
  });

  test("strictly rejects malformed and hidden Plugin input", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({
      adapters: platform.adapters,
      packages: declaredPackages,
    });
    const hidden = {};
    Object.defineProperty(hidden, "secret", { value: true });

    await expectFailure(
      host.invoke(READ_CLIPBOARD_TEXT_COMMAND, { extra: true }),
      "unknown fields",
    );
    await expectFailure(
      host.invoke(READ_CLIPBOARD_TEXT_COMMAND, hidden),
      "unknown fields",
    );
    await expectFailure(
      host.invoke(WRITE_CLIPBOARD_TEXT_COMMAND, { text: 42 }),
      "clipboard text must be a string",
    );
    expect(platform.clipboardText()).toBe("initial");
    await host.dispose();
  });

  test("propagates cancellation and unregisters on disposal", async () => {
    const platform = createFakePlatform();
    const host = await createMobileHost({
      adapters: platform.adapters,
      packages: declaredPackages,
    });
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
    await host.dispose();
    expect(host.list()).toEqual([]);
    await expectFailure(
      host.invoke(READ_CLIPBOARD_TEXT_COMMAND, {}),
      "is unavailable",
    );
  });

  test("fails closed for undeclared or unresolved Contributions", async () => {
    const platform = createFakePlatform();
    await expectFailure(
      createMobileHost({
        adapters: platform.adapters,
        packages: [
          { specifier: "@frockbot/plugin-clock", manifest: { id: "clock" } },
        ],
      }),
      "unsupported FrockBot manifest version",
    );
    await expectFailure(
      createMobileHost({
        adapters: platform.adapters,
        packages: declaredPackages,
        resolveContribution: () =>
          Promise.reject(new Error("declared contribution unavailable")),
      }),
      "declared contribution unavailable",
    );
  });
});
