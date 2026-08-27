import {
  MobileClipboardCapability,
  MobileNotificationCapability,
  type MobileNotificationRequest,
  MobileShareCapability,
  type MobileShareRequest,
} from "@frockbot/mobile-core";
import type { Context } from "cordis";
import type {
  MobileClipboardAdapter,
  MobileNotificationAdapter,
  MobileShareAdapter,
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

export function createShareProvider(adapter: MobileShareAdapter) {
  return class MobileShareProvider extends MobileShareCapability {
    constructor(ctx: Context) {
      super(ctx);
    }

    share(request: MobileShareRequest, signal: AbortSignal): Promise<void> {
      signal.throwIfAborted();
      return adapter.share(request, signal);
    }
  };
}
