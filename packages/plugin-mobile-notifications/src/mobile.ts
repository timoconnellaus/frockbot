import type {
  MobileCommand,
  MobileNotificationRequest,
} from "@frockbot/mobile-core";
import type { Plugin } from "cordis";

export const SHOW_NOTIFICATION_COMMAND = "mobile.notifications.show";

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
  const keys = Reflect.ownKeys(input);
  if (
    keys.some(
      (key) =>
        typeof key !== "string" ||
        !["title", "body", "urgency"].includes(key) ||
        !Object.prototype.propertyIsEnumerable.call(input, key),
    )
  ) {
    throw new Error("notification input has unknown fields");
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

export const mobileNotificationsPlugin: Plugin.Function = (ctx) => {
  const command: MobileCommand<ShowNotificationInput, ShowNotificationResult> =
    {
      id: SHOW_NOTIFICATION_COMMAND,
      decode: decodeShowNotificationInput,
      async execute(input, context): Promise<ShowNotificationResult> {
        const request: MobileNotificationRequest = {
          title: input.title,
          body: input.body,
          urgency: input.urgency ?? "normal",
        };
        await ctx.mobileNotifications.show(request, context.signal);
        return { shown: true };
      },
    };
  return ctx.mobileCommands.register(command);
};
mobileNotificationsPlugin.inject = ["mobileCommands", "mobileNotifications"];

export default mobileNotificationsPlugin;
