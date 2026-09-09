import type { SessionEvent } from "@frockbot/core/contracts";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import type { StoredRunV1 } from "@frockbot/core/durable";
import { BOT_CONFIGURATION_KEY } from "../settings/bot.js";
import { PUSH_OUTBOX_PREFIX } from "./storage-keys.js";
import {
  MESSAGE_PREFIX,
  MESSAGE_SEQUENCE_KEY,
  UNREAD_STATE_KEY,
  SIDEBAR_PREVIEW_KEY,
  optionalUnreadStateV1,
  advanceUnreadActivityV1,
} from "../shell/unread.js";

export interface MessageNotice {
  notificationId: string;
  messageId: string;
  runId: string;
  createdAt: string;
  title: string;
  body: string;
  notify: boolean;
}

export function messagePreview(payload: Record<string, unknown>): string {
  if (typeof payload.text === "string") return payload.text.slice(0, 240);
  if (payload.type === "approval")
    return String(payload.action ?? "Approval requested").slice(0, 240);
  return (
    (
      {
        image: "Image",
        file: "File",
        attachment: "Attachment",
        audio: "Audio",
        video: "Video",
        widget: "Message",
        applet: "Applet",
      } as Record<string, string>
    )[String(payload.type)] ?? "New message"
  );
}

/** The message index, unread cursor and push intent commit with the send itself. */
export async function messageRecords(input: {
  run: StoredRunV1<BotSettingsViewV1>;
  events: readonly SessionEvent[];
  read<T>(key: string): Promise<T | undefined>;
}): Promise<Record<string, unknown>> {
  if (input.run.admission?.turnType === "subagent") return {};
  const sends = input.events.filter((event) => event.type === "send/to-user");
  if (!sends.length) return {};
  const settings =
    (await input.read<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
    input.run.configurationSnapshot;
  let sequence = (await input.read<number>(MESSAGE_SEQUENCE_KEY)) ?? 0;
  let unread = optionalUnreadStateV1(await input.read(UNREAD_STATE_KEY));
  const records: Record<string, unknown> = {};
  const allSends = input.run.events.filter(
    (event) => event.type === "send/to-user",
  );
  for (const event of sends) {
    const position = allSends.findIndex(
      (candidate) => candidate.seq === event.seq,
    );
    const messageId = `${input.run.runId}:send:${position}`;
    const cursor = `message-${String(++sequence).padStart(20, "0")}`;
    const notice: MessageNotice = {
      notificationId: cursor,
      messageId,
      runId: input.run.runId,
      createdAt: event.timestamp,
      title: settings.profile.name,
      body: messagePreview(event.payload as unknown as Record<string, unknown>),
      notify: settings.notifications.enabled,
    };
    records[`${MESSAGE_PREFIX}${cursor}`] = notice;
    records[`${PUSH_OUTBOX_PREFIX}${cursor}`] = notice;
    unread = {
      ...advanceUnreadActivityV1(unread, { cursor, at: event.timestamp }),
      lastMessageId: messageId,
    };
    records[SIDEBAR_PREVIEW_KEY] = {
      schemaVersion: 1,
      text: notice.body.slice(0, 120) || "New message",
      at: event.timestamp,
      role: "assistant",
    };
    if (notice.notify) {
      const { messageId: _id, notify: _notify, ...intent } = notice;
      records[`notification:${cursor}`] = intent;
    }
  }
  records[MESSAGE_SEQUENCE_KEY] = sequence;
  records[UNREAD_STATE_KEY] = unread;
  return records;
}
