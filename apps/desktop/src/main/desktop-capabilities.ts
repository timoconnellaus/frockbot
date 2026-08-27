import {
  DesktopClipboardCapability,
  DesktopDirectoryPickerCapability,
  type DesktopDirectoryPickerRequest,
  type DesktopDirectoryPickerResult,
  DesktopNotificationCapability,
  type DesktopNotificationRequest,
} from "@frockbot/desktop-core";

// These trusted adapters are the only Electron authority exposed to plugins.
import type { Context } from "cordis";
import {
  clipboard,
  dialog,
  Notification as ElectronNotification,
} from "electron";

export class ElectronNotificationCapability extends DesktopNotificationCapability {
  async show(
    request: DesktopNotificationRequest,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const notification = new ElectronNotification({
      title: request.title,
      body: request.body,
      urgency: request.urgency,
    });
    notification.show();
  }
}

export class ElectronDirectoryPickerCapability extends DesktopDirectoryPickerCapability {
  async pick(
    request: DesktopDirectoryPickerRequest,
    signal: AbortSignal,
  ): Promise<DesktopDirectoryPickerResult> {
    signal.throwIfAborted();
    const result = await dialog.showOpenDialog({
      title: request.title,
      properties: [
        request.mode === "directory" ? "openDirectory" : "openFile",
        ...(request.multiple ? (["multiSelections"] as const) : []),
      ],
    });
    signal.throwIfAborted();
    return { paths: result.filePaths, cancelled: result.canceled };
  }
}

export class ElectronClipboardCapability extends DesktopClipboardCapability {
  readText(signal: AbortSignal): Promise<string> {
    signal.throwIfAborted();
    return Promise.resolve(clipboard.readText());
  }

  writeText(text: string, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    clipboard.writeText(text);
    return Promise.resolve();
  }
}

export async function installDesktopCapabilities(ctx: Context): Promise<void> {
  await ctx.plugin(ElectronNotificationCapability);
  await ctx.plugin(ElectronDirectoryPickerCapability);
  await ctx.plugin(ElectronClipboardCapability);
}
