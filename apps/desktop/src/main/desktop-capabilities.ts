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
  app,
  clipboard,
  dialog,
  Notification as ElectronNotification,
  safeStorage,
} from "electron";
import { FileSecretStoreCapability } from "./machine-secrets.js";
import { NodeMachineHostCapability } from "./machine-host.js";

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

/**
 * Electron's `safeStorage`, as the cipher the secret store is built on.
 *
 * This indirection is the whole reason `machine-secrets.ts` can be tested:
 * everything about the file — its shape, what a failed decrypt does, what an
 * unavailable keychain does — is exercised against a fake cipher, and the real
 * one is these three lines.
 */
export const electronSecretCipher = {
  isEncryptionAvailable: () => safeStorage.isEncryptionAvailable(),
  encryptString: (value: string) => safeStorage.encryptString(value),
  decryptString: (value: Uint8Array) =>
    safeStorage.decryptString(Buffer.from(value)),
};

export async function installDesktopCapabilities(ctx: Context): Promise<void> {
  await ctx.plugin(ElectronNotificationCapability);
  await ctx.plugin(ElectronDirectoryPickerCapability);
  await ctx.plugin(ElectronClipboardCapability);
}

/**
 * The two capabilities the registered-machine agent runs on.
 *
 * Kept apart from `installDesktopCapabilities` because they are mounted at a
 * different moment: the agent's contribution needs them before it starts its
 * loop, and the loop starts as soon as the host is built rather than when a
 * window appears.
 */
export async function installMachineCapabilities(ctx: Context): Promise<void> {
  await ctx.plugin(NodeMachineHostCapability, {});
  await ctx.plugin(FileSecretStoreCapability, {
    directory: app.getPath("userData"),
    cipher: electronSecretCipher,
  });
}
