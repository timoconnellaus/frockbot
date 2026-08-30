import { Clipboard } from "@capacitor/clipboard";
import { LocalNotifications } from "@capacitor/local-notifications";
import type { MobileNotificationRequest } from "@frockbot/mobile-core";
import type { MobilePlatformAdapters } from "./adapters.ts";

async function showNativeNotification(
  request: MobileNotificationRequest,
): Promise<void> {
  const permission = await LocalNotifications.checkPermissions();
  if (permission.display !== "granted") {
    const requested = await LocalNotifications.requestPermissions();
    if (requested.display !== "granted") {
      throw new Error("notification permission was denied");
    }
  }
  await LocalNotifications.schedule({
    notifications: [
      {
        id: Math.floor(Math.random() * 2_147_483_647),
        title: request.title,
        body: request.body ?? "",
        ongoing: false,
        autoCancel: true,
      },
    ],
  });
}

/** Narrow Capacitor adapters; these are never exposed directly to hosted code. */
export function createCapacitorAdapters(): MobilePlatformAdapters {
  return {
    notifications: {
      async show(request, signal) {
        signal.throwIfAborted();
        await showNativeNotification(request);
        signal.throwIfAborted();
      },
    },
    clipboard: {
      async readText(signal) {
        signal.throwIfAborted();
        const result = await Clipboard.read();
        signal.throwIfAborted();
        if (result.type !== "text/plain" && !result.value) {
          throw new Error("the clipboard does not hold text");
        }
        return result.value;
      },
      async writeText(text, signal) {
        signal.throwIfAborted();
        await Clipboard.write({ string: text });
        signal.throwIfAborted();
      },
    },
  };
}
