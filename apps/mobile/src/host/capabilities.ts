import {
  MobileClipboardCapability,
  MobileNotificationCapability,
  type MobileNotificationRequest,
} from "@frockbot/mobile-core";
import type { Context } from "cordis";
import type {
  MobileClipboardAdapter,
  MobileNotificationAdapter,
} from "./adapters.ts";

export function createNotificationProvider(adapter: MobileNotificationAdapter) {
  return class MobileNotificationProvider extends MobileNotificationCapability {
    constructor(ctx: Context) {
      super(ctx);
    }

    show(
      request: MobileNotificationRequest,
      signal: AbortSignal,
    ): Promise<void> {
      signal.throwIfAborted();
      return adapter.show(request, signal);
    }
  };
}

export function createClipboardProvider(adapter: MobileClipboardAdapter) {
  return class MobileClipboardProvider extends MobileClipboardCapability {
    constructor(ctx: Context) {
      super(ctx);
    }

    readText(signal: AbortSignal): Promise<string> {
      signal.throwIfAborted();
      return adapter.readText(signal);
    }

    writeText(text: string, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      return adapter.writeText(text, signal);
    }
  };
}
