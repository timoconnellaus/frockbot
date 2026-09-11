import type { SessionEvent } from "@frockbot/core/contracts";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import type { StoredRunV1 } from "@frockbot/core/durable";
import { BOT_CONFIGURATION_KEY } from "../settings/bot.js";
import {
  PUSH_OUTBOX_PREFIX,
  sentAutomationRunKeyV1,
  type SentAutomationRunV1,
} from "./storage-keys.js";
import {
  MESSAGE_PREFIX,
  MESSAGE_SEQUENCE_KEY,
  UNREAD_STATE_KEY,
  SIDEBAR_PREVIEW_KEY,
  optionalUnreadStateV1,
  advanceUnreadActivityV1,
  isMessageBoundaryV1,
} from "../shell/unread.js";

/**
 * What one user-visible message is called, everywhere.
 *
 * The ordinal counts the run's own durable sends, so the id survives a page
 * that drops older sends and a client that renders only some of them: the
 * transcript names the same message the unread boundary does, which is what
 * makes opening the conversation able to clear the badge that message raised.
 */
export function messageIdV1(runId: string, ordinal: number): string {
  return `${runId}:send:${ordinal}`;
}

/**
 * What a failed Turn's notice is called. The transcript draws one line per
 * failed run, under this id, so the message the unread record names is the
 * line the device shows and opening the conversation clears it.
 */
export function failedTurnMessageIdV1(runId: string): string {
  return `${runId}:failed`;
}

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

/** One message to commit: everything a `MessageNotice` needs but its cursor. */
export interface VisibleMessageDraftV1 {
  messageId: string;
  runId: string;
  createdAt: string;
  body: string;
  /** Whether the run this message belongs to was admitted as an automation. */
  automation?: boolean;
  /**
   * The ordinal of a message whose run could not journal a send of its own,
   * because the run had already ended when the message was minted. The
   * transcript projects the run with this send appended at that ordinal, so
   * the message a person is badged for is one they can see, and one the read
   * boundary they send back names.
   */
  projectedSendOrdinal?: number;
}

/**
 * The durable records one or more user-visible messages contribute.
 *
 * The one place a message is minted. Everything a person is told about — a
 * reply, an approval, a Routine's result, a Routine that broke — commits the
 * same index entry, unread cursor, sidebar preview and push intent, so a new
 * kind of message cannot arrive with a badge and no notification, or the other
 * way round. `notifications.enabled` is the mute on *alerting* only: a muted
 * Bot still counts its unread and still writes nothing anyone is woken for.
 */
export async function visibleMessageRecordsV1(input: {
  settings: BotSettingsViewV1;
  messages: readonly VisibleMessageDraftV1[];
  read<T>(key: string): Promise<T | undefined>;
}): Promise<Record<string, unknown>> {
  if (!input.messages.length) return {};
  let sequence = (await input.read<number>(MESSAGE_SEQUENCE_KEY)) ?? 0;
  let unread = optionalUnreadStateV1(await input.read(UNREAD_STATE_KEY));
  const records: Record<string, unknown> = {};
  for (const message of input.messages) {
    const cursor = `message-${String(++sequence).padStart(20, "0")}`;
    const notice: MessageNotice = {
      notificationId: cursor,
      messageId: message.messageId,
      runId: message.runId,
      createdAt: message.createdAt,
      title: input.settings.profile.name,
      body: message.body,
      notify: input.settings.notifications.enabled,
    };
    records[`${MESSAGE_PREFIX}${cursor}`] = notice;
    records[`${PUSH_OUTBOX_PREFIX}${cursor}`] = notice;
    if (message.automation) {
      records[sentAutomationRunKeyV1(message.runId)] = {
        schemaVersion: 1,
        at: message.createdAt,
        ...(message.projectedSendOrdinal === undefined
          ? {}
          : {
              send: {
                ordinal: message.projectedSendOrdinal,
                text: message.body,
              },
            }),
      } satisfies SentAutomationRunV1;
    }
    unread = {
      ...advanceUnreadActivityV1(unread, {
        cursor,
        at: message.createdAt,
      }),
      // The boundary the reader decodes is the boundary the writer is held to.
      // An id outside the grammar would make the record undecodable for ever,
      // taking every later unread read and every event commit with it.
      ...(isMessageBoundaryV1(message.messageId)
        ? { lastMessageId: message.messageId }
        : {}),
    };
    records[SIDEBAR_PREVIEW_KEY] = {
      schemaVersion: 1,
      text: notice.body.slice(0, 120) || "New message",
      at: message.createdAt,
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
  const allSends = input.run.events.filter(
    (event) => event.type === "send/to-user",
  );
  const automation = input.run.admission?.turnType === "automation";
  return visibleMessageRecordsV1({
    settings,
    read: input.read,
    messages: sends.map((event) => ({
      messageId: messageIdV1(
        input.run.runId,
        allSends.findIndex((candidate) => candidate.seq === event.seq),
      ),
      runId: input.run.runId,
      createdAt: event.timestamp,
      body: messagePreview(event.payload as unknown as Record<string, unknown>),
      ...(automation ? { automation: true } : {}),
    })),
  });
}
