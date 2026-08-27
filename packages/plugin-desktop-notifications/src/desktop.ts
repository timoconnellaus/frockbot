import type {
  DesktopCommand,
  DesktopNotificationRequest,
} from "@frockbot/desktop-core";
import type { Plugin } from "cordis";

export const SHOW_NOTIFICATION_COMMAND = "desktop.notifications.show";

export interface ShowNotificationInput {
  title: string;
  body?: string;
  urgency?: "normal" | "critical";
}

export interface ShowNotificationResult {
  shown: true;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  maxLength: number,
): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error(`${key} must be a string`);
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > maxLength) {
    throw new Error(`${key} must be at most ${maxLength} characters`);
  }
  return normalized;
}

export function decodeShowNotificationInput(
  input: unknown,
): ShowNotificationInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("notification input must be an object");
  }
  const record = input as Record<string, unknown>;
  const title = optionalString(record, "title", 200);
  if (!title) throw new Error("notification title is required");
  const body = optionalString(record, "body", 4_096);
  const urgency = record.urgency ?? "normal";
  if (urgency !== "normal" && urgency !== "critical") {
    throw new Error('notification urgency must be "normal" or "critical"');
  }
  return { title, body, urgency };
}

export const desktopNotificationsPlugin: Plugin.Function = (ctx) => {
  const command: DesktopCommand<ShowNotificationInput, ShowNotificationResult> =
    {
      id: SHOW_NOTIFICATION_COMMAND,
      decode: decodeShowNotificationInput,
      async execute(input, context): Promise<ShowNotificationResult> {
        const request: DesktopNotificationRequest = {
          title: input.title,
          body: input.body,
          urgency: input.urgency ?? "normal",
        };
        await ctx.desktopNotifications.show(request, context.signal);
        return { shown: true };
      },
    };
  return ctx.desktopCommands.register(command);
};
desktopNotificationsPlugin.inject = ["desktopCommands", "desktopNotifications"];

export default desktopNotificationsPlugin;
