import type {
  MobileNotificationRequest,
  MobileShareRequest,
} from "@frockbot/mobile-core";

export interface MobileNotificationAdapter {
  show(request: MobileNotificationRequest, signal: AbortSignal): Promise<void>;
}

export interface MobileClipboardAdapter {
  readText(signal: AbortSignal): Promise<string>;
  writeText(text: string, signal: AbortSignal): Promise<void>;
}

export interface MobileShareAdapter {
  share(request: MobileShareRequest, signal: AbortSignal): Promise<void>;
}

export interface MobilePlatformAdapters {
  notifications: MobileNotificationAdapter;
  clipboard: MobileClipboardAdapter;
  share: MobileShareAdapter;
}
