import { registerPlugin } from "@capacitor/core";
import type { MobileNotificationRequest } from "@frockbot/mobile-core";
import type { MobilePlatformAdapters } from "./adapters.ts";

const READ_CLIPBOARD = "mobile.clipboard.readText";
const WRITE_CLIPBOARD = "mobile.clipboard.writeText";
const SHOW_NOTIFICATION = "mobile.notifications.show";

interface NativeBroker {
  invoke(options: {
    schemaVersion: 1;
    commandId:
      typeof READ_CLIPBOARD | typeof WRITE_CLIPBOARD | typeof SHOW_NOTIFICATION;
    input: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
}

const broker = registerPlugin<NativeBroker>("FrockBotMobile");

async function invoke(
  commandId: Parameters<NativeBroker["invoke"]>[0]["commandId"],
  input: Record<string, unknown>,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  signal.throwIfAborted();
  const result = await broker.invoke({ schemaVersion: 1, commandId, input });
  signal.throwIfAborted();
  return result;
}

export function createCapacitorAdapters(): MobilePlatformAdapters {
  return {
    notifications: {
      async show(request, signal) {
        await invoke(
          SHOW_NOTIFICATION,
          {
            title: request.title,
            ...(request.body === undefined ? {} : { body: request.body }),
            urgency: request.urgency,
          },
          signal,
        );
      },
    },
    clipboard: {
      async readText(signal) {
        const result = await invoke(READ_CLIPBOARD, {}, signal);
        if (typeof result.text !== "string") {
          throw new Error("native clipboard response is invalid");
        }
        return result.text;
      },
      async writeText(text, signal) {
        await invoke(WRITE_CLIPBOARD, { text }, signal);
      },
    },
  };
}
