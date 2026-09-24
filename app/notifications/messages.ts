import {
  isFirstPartyCardFaceV1,
  type SessionEvent,
} from "@frockbot/core/contracts";
import type { BotSettingsViewV1 } from "@frockbot/core/configuration";
import type { StoredRunV1 } from "@frockbot/core/durable";
import { BOT_CONFIGURATION_KEY } from "../settings/bot.js";
import {
  PUSH_OUTBOX_PREFIX,
  sentAutomationRunKeyV1,
  TELEGRAM_MIRROR_KEY,
  TELEGRAM_OUTBOX_PREFIX,
  type SentAutomationRunV1,
  type TelegramOutboxEntryV1,
} from "./storage-keys.js";
import {
  telegramMessageTextV1,
  telegramMirrorTextV1,
} from "../telegram/mirror.js";
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
   * Whether the run was asked by the account's voice session. Its answer goes
   * back by its own route; a send it makes on the side still lands in the
   * conversation and counts as unread, but wakes no device — the person is on
   * the call, and a buzz for the thing they are being told aloud is noise.
   */
  voice?: boolean;
  /**
   * Whether the run was asked from Telegram. Its answer is told there, so —
   * like a voice answer — it counts as unread and wakes no device: a buzz from
   * the app for the reply the person is reading in Telegram is the same
   * message twice.
   */
  telegram?: boolean;
  /**
   * The whole of what was said, when `body` is only its alert preview. The
   * Telegram chat shows the message itself, so it carries this rather than the
   * preview's 240 characters.
   */
  text?: string;
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
 *
 * It is also where a message is owed to Telegram, for the same reason: while
 * this Bot is the one the User's Telegram chat talks to, every message the
 * person could read in the app is committed to that outbox in the same
 * transaction, so none is mirrored that the conversation does not hold, and
 * none the conversation holds is missed. A voice answer is the exception, as
 * it is for push: the person is hearing it.
 */
export async function visibleMessageRecordsV1(input: {
  settings: BotSettingsViewV1;
  messages: readonly VisibleMessageDraftV1[];
  read<T>(key: string): Promise<T | undefined>;
}): Promise<Record<string, unknown>> {
  if (!input.messages.length) return {};
  let sequence = (await input.read<number>(MESSAGE_SEQUENCE_KEY)) ?? 0;
  let unread = optionalUnreadStateV1(await input.read(UNREAD_STATE_KEY));
  const mirrored = (await input.read(TELEGRAM_MIRROR_KEY)) !== undefined;
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
      notify:
        input.settings.notifications.enabled &&
        !message.voice &&
        !message.telegram,
    };
    records[`${MESSAGE_PREFIX}${cursor}`] = notice;
    records[`${PUSH_OUTBOX_PREFIX}${cursor}`] = notice;
    if (mirrored && !message.voice) {
      records[`${TELEGRAM_OUTBOX_PREFIX}${cursor}`] = {
        schemaVersion: 1,
        cursor,
        messageId: message.messageId,
        text: telegramMessageTextV1(message.text ?? message.body),
      } satisfies TelegramOutboxEntryV1;
    }
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
  // A group Turn's sends are the group's messages: they badge and notify
  // from the group, never from the member's one-to-one chat.
  if (input.run.admission?.origin?.kind === "group") return {};
  // Only a send is a message addressed to the User. An answer the Turn's
  // caller asked for is `reply/to-caller`, and it reaches that caller by its
  // own route: it mints no message, raises no badge and wakes no device, which
  // is why it is a different event rather than a send wearing a flag.
  const allSendsOnRun = input.run.events.filter(
    (event) => event.type === "send/to-user",
  );
  // A locked first-party Card is drawn beside the send it is the face of (ADR
  // 0030 step 7), so the log carries two records of one thing the person is
  // told. Only the send they are told *by* mints a message: the face raises no
  // second badge and wakes no device a second time.
  const sends = input.events
    .filter((event) => event.type === "send/to-user")
    .filter((event) => !isFirstPartyCardFaceV1(event, allSendsOnRun));
  if (!sends.length) return {};
  const settings =
    (await input.read<BotSettingsViewV1>(BOT_CONFIGURATION_KEY)) ??
    input.run.configurationSnapshot;
  const allSends = allSendsOnRun;
  const automation = input.run.admission?.turnType === "automation";
  const voice = input.run.admission?.origin?.kind === "voice";
  const telegram = input.run.admission?.origin?.kind === "telegram";
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
      text: telegramMirrorTextV1(event.payload),
      ...(automation ? { automation: true } : {}),
      ...(voice ? { voice: true } : {}),
      ...(telegram ? { telegram: true } : {}),
    })),
  });
}
