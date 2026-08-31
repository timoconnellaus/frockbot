import type { MobileNotificationRequest } from "@frockbot/mobile-core";

export interface MobileNotificationAdapter {
  show(request: MobileNotificationRequest, signal: AbortSignal): Promise<void>;
}

export interface MobileClipboardAdapter {
  readText(signal: AbortSignal): Promise<string>;
  writeText(text: string, signal: AbortSignal): Promise<void>;
}

/** Platform adapters are private implementation details of declared Plugins. */
export interface MobilePlatformAdapters {
  notifications: MobileNotificationAdapter;
  clipboard: MobileClipboardAdapter;
}
