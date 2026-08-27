import type {
  DesktopCommand,
  DesktopDirectoryPickerResult,
} from "@frockbot/desktop-core";
import type { Plugin } from "cordis";

export const PICK_DIRECTORY_COMMAND = "desktop.directory.pick";

export interface PickDirectoryInput {
  title?: string;
  multiple?: boolean;
}

export function decodePickDirectoryInput(input: unknown): PickDirectoryInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("directory picker input must be an object");
  }
  const record = input as Record<string, unknown>;
  let title: string | undefined;
  if (record.title !== undefined) {
    if (typeof record.title !== "string") {
      throw new Error("directory picker title must be a string");
    }
    title = record.title.trim() || undefined;
    if (title && title.length > 200) {
      throw new Error("directory picker title must be at most 200 characters");
    }
  }
  const multiple = record.multiple ?? false;
  if (typeof multiple !== "boolean") {
    throw new Error("directory picker multiple must be a boolean");
  }
  return { title, multiple };
}

export const desktopDirectoryPickerPlugin: Plugin.Function = (ctx) => {
  const command: DesktopCommand<
    PickDirectoryInput,
    DesktopDirectoryPickerResult
  > = {
    id: PICK_DIRECTORY_COMMAND,
    decode: decodePickDirectoryInput,
    execute: (input, context) =>
      ctx.desktopDirectoryPicker.pick(
        {
          mode: "directory",
          title: input.title,
          multiple: input.multiple ?? false,
        },
        context.signal,
      ),
  };
  return ctx.desktopCommands.register(command);
};
desktopDirectoryPickerPlugin.inject = [
  "desktopCommands",
  "desktopDirectoryPicker",
];

export default desktopDirectoryPickerPlugin;
