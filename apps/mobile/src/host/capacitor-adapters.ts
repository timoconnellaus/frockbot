import { Clipboard } from "@capacitor/clipboard";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { Share } from "@capacitor/share";
import type {
  MobileNotificationRequest,
  MobileShareRequest,
} from "@frockbot/mobile-core";
import type { MobilePlatformAdapters } from "./adapters.ts";

function native(): boolean {
  return Capacitor.isNativePlatform();
}

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

async function showWebNotification(
  request: MobileNotificationRequest,
): Promise<void> {
  if (typeof Notification === "undefined") {
    throw new Error("notifications are unavailable in this environment");
  }
  let permission = Notification.permission;
  if (permission === "default") permission = await Notification.requestPermission();
  if (permission !== "granted") {
    throw new Error("notification permission was denied");
  }
  new Notification(request.title, {
    body: request.body,
    requireInteraction: request.urgency === "critical",
  });
}

async function readWebClipboard(): Promise<string> {
  if (!navigator.clipboard?.readText) {
    throw new Error("clipboard reads are unavailable in this environment");
  }
  return await navigator.clipboard.readText();
}

async function writeWebClipboard(text: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    throw new Error("clipboard writes are unavailable in this environment");
  }
  await navigator.clipboard.writeText(text);
}

async function shareWeb(request: MobileShareRequest): Promise<void> {
  if (!navigator.share) {
    throw new Error("sharing is unavailable in this environment");
  }
  await navigator.share({
    title: request.title,
    text: request.text,
    url: request.url,
  });
}

export function createCapacitorAdapters(): MobilePlatformAdapters {
  return {
    notifications: {
      async show(request, signal) {
        signal.throwIfAborted();
        if (native()) {
          await showNativeNotification(request);
          return;
        }
        await showWebNotification(request);
      },
    },
    clipboard: {
      async readText(signal) {
        signal.throwIfAborted();
        if (!native()) return await readWebClipboard();
        const result = await Clipboard.read();
        if (result.type !== "text/plain" && !result.value) {
          throw new Error("the clipboard does not hold text");
        }
        return result.value;
      },
      async writeText(text, signal) {
        signal.throwIfAborted();
        if (!native()) {
          await writeWebClipboard(text);
          return;
        }
        await Clipboard.write({ string: text });
      },
    },
    share: {
      async share(request, signal) {
        signal.throwIfAborted();
        if (!native()) {
          await shareWeb(request);
          return;
        }
        const available = await Share.canShare();
        if (!available.value) {
          throw new Error("sharing is unavailable on this device");
        }
        await Share.share({
          title: request.title,
          text: request.text,
          url: request.url,
        });
      },
    },
  };
}
