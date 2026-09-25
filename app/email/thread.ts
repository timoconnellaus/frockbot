// The emails one Turn took part in, read off its own durable record: the
// person's message that started it, the reply that answered it, and any note
// the Bot emailed them. Every email says which thread it is in, and a client
// draws one card per thread, so a conversation by email reads as one.
//
// Pure, like every projection of a run: the same record gives the same emails
// on settlement, on a later page, and after a rebuild.

import { pluginCardToolNameV1 } from "@frockbot/core/contracts";
import {
  emailThreadIdOfOriginV1,
  type StoredRunOriginV1,
} from "@frockbot/core/durable";
import {
  EMAIL_NOTE_SURFACE_PREFIX_V1,
  emailReplySubjectV1,
  emailTurnBodyV1,
} from "./shared.js";

/** One email of a thread. */
export interface RunEmailV1 {
  threadId: string;
  direction: "in" | "out";
  subject: string;
  at: string;
  text: string;
  /** The card a note was drawn on, which the thread card stands in for. */
  surfaceId?: string;
}

/** The most emails one Turn contributes to a thread. */
export const RUN_EMAILS_MAX_V1 = 16;

/** The part of a run this reads. */
export interface RunEmailSourceV1 {
  acceptedAt: string;
  input: string;
  admission?: { origin?: StoredRunOriginV1 };
  events: readonly {
    type: string;
    timestamp?: string;
    occurrenceId?: string;
    name?: string;
    input?: unknown;
    caller?: string;
    text?: string;
    payload?: unknown;
  }[];
}

const DYNAMIC_TOOL = "call_dynamic_tool";
const NOTE_TOOL = pluginCardToolNameV1("email", "owner");

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The note a call drew, when it was the email Plugin's `owner` card drawing a
 * new one. A redraw names the surface it updates and sends nothing.
 */
function noteOfCall(
  input: unknown,
): { subject: string; body: string } | undefined {
  const envelope = record(input);
  if (envelope?.namespace !== "email" || envelope.toolName !== NOTE_TOOL) {
    return undefined;
  }
  const args = record(envelope.arguments);
  if (!args || args.surfaceId !== undefined) return undefined;
  const data = record(args.data);
  if (typeof data?.subject !== "string" || typeof data.body !== "string") {
    return undefined;
  }
  return { subject: data.subject.trim(), body: data.body };
}

export function runEmailsV1(run: RunEmailSourceV1): RunEmailV1[] {
  const origin = run.admission?.origin;
  const email = origin?.kind === "email" ? origin : undefined;
  const emails: RunEmailV1[] = [];
  const thread = email && emailThreadIdOfOriginV1(email);
  if (email && thread) {
    emails.push({
      threadId: thread,
      direction: "in",
      subject: email.subject,
      at: run.acceptedAt,
      text: emailTurnBodyV1(run.input, email.subject),
    });
  }
  const notes = new Map<string, { subject: string; body: string }>();
  for (const event of run.events) {
    if (event.type === "tool/call" && event.name === DYNAMIC_TOOL) {
      const note = noteOfCall(event.input);
      if (note && event.occurrenceId) notes.set(event.occurrenceId, note);
      continue;
    }
    if (
      event.type === "reply/to-caller" &&
      event.caller === "email" &&
      email &&
      thread &&
      typeof event.text === "string"
    ) {
      emails.push({
        threadId: thread,
        direction: "out",
        subject: emailReplySubjectV1(email.subject),
        at: event.timestamp ?? run.acceptedAt,
        text: event.text,
      });
      continue;
    }
    if (event.type !== "send/to-user" || !event.occurrenceId) continue;
    const payload = record(event.payload);
    const surfaceId = payload?.surfaceId;
    const note = notes.get(event.occurrenceId);
    // The card is drawn only once its note has left, or may have: a note
    // that could not go draws nothing, so it is no email of the thread.
    if (
      payload?.type !== "card" ||
      typeof surfaceId !== "string" ||
      !surfaceId.startsWith(EMAIL_NOTE_SURFACE_PREFIX_V1) ||
      !note
    ) {
      continue;
    }
    notes.delete(event.occurrenceId);
    emails.push({
      // A note written while answering an email is in that email's thread;
      // any other starts one, named by its card.
      threadId: thread ?? surfaceId,
      direction: "out",
      subject: note.subject,
      at: event.timestamp ?? run.acceptedAt,
      text: note.body,
      surfaceId,
    });
  }
  return emails.slice(0, RUN_EMAILS_MAX_V1);
}
