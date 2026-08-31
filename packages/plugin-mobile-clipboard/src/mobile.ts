import type {
  MobileCommand,
  MobileClipboardCapability,
} from "@frockbot/mobile-core";
import type { Plugin } from "cordis";

export const READ_CLIPBOARD_TEXT_COMMAND = "mobile.clipboard.readText";
export const WRITE_CLIPBOARD_TEXT_COMMAND = "mobile.clipboard.writeText";
export const MAX_CLIPBOARD_TEXT_LENGTH = 1_000_000;

export type ReadClipboardTextInput = Record<string, never>;

export interface ReadClipboardTextResult {
  text: string;
}

export interface WriteClipboardTextInput {
  text: string;
}

export interface WriteClipboardTextResult {
  written: true;
}

function inputRecord(
  input: unknown,
  allowedKeys: readonly string[],
): Record<string, unknown> {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("clipboard input must be an object");
  }
  const keys = Reflect.ownKeys(input);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !allowedKeys.includes(key) ||
        !Object.prototype.propertyIsEnumerable.call(input, key),
    )
  ) {
    throw new Error("clipboard input has unknown fields");
  }
  return input as Record<string, unknown>;
}

export function decodeReadClipboardTextInput(
  input: unknown,
): ReadClipboardTextInput {
  inputRecord(input, []);
  return {};
}

export function decodeWriteClipboardTextInput(
  input: unknown,
): WriteClipboardTextInput {
  const record = inputRecord(input, ["text"]);
  if (typeof record.text !== "string") {
    throw new Error("clipboard text must be a string");
  }
  if (record.text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
    throw new Error(
      `clipboard text must be at most ${MAX_CLIPBOARD_TEXT_LENGTH} characters`,
    );
  }
  return { text: record.text };
}

function readCommand(
  clipboard: MobileClipboardCapability,
): MobileCommand<ReadClipboardTextInput, ReadClipboardTextResult> {
  return {
    id: READ_CLIPBOARD_TEXT_COMMAND,
    decode: decodeReadClipboardTextInput,
    async execute(_input, context): Promise<ReadClipboardTextResult> {
      const text = await clipboard.readText(context.signal);
      if (text.length > MAX_CLIPBOARD_TEXT_LENGTH) {
        throw new Error(
          `clipboard text must be at most ${MAX_CLIPBOARD_TEXT_LENGTH} characters`,
        );
      }
      return { text };
    },
  };
}

function writeCommand(
  clipboard: MobileClipboardCapability,
): MobileCommand<WriteClipboardTextInput, WriteClipboardTextResult> {
  return {
    id: WRITE_CLIPBOARD_TEXT_COMMAND,
    decode: decodeWriteClipboardTextInput,
    async execute(input, context): Promise<WriteClipboardTextResult> {
      await clipboard.writeText(input.text, context.signal);
      return { written: true };
    },
  };
}

export const mobileClipboardPlugin: Plugin.Function = (ctx) => [
  ctx.mobileCommands.register(readCommand(ctx.mobileClipboard)),
  ctx.mobileCommands.register(writeCommand(ctx.mobileClipboard)),
];
mobileClipboardPlugin.inject = ["mobileCommands", "mobileClipboard"];

export default mobileClipboardPlugin;
