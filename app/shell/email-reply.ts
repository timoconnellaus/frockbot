// A Turn the person started by email answers by email. It is the email peer of
// a voice request's spoken answer: the same `reply_to_request`, bound to the
// email caller, whose answer is the body of a reply in the thread the person
// wrote in. What email adds is the delivery — the send, which leaves the
// platform, and the conversation when the send cannot happen.
import type {
  AgentRuntimeV1,
  RuntimeFeatureV1,
  SessionEvent,
} from "@frockbot/core/contracts";
import type {
  EmailReplyOutcomeV1,
  OwnerMailRefusalV1,
} from "@frockbot/app/email/bot";
import { EMAIL_NOTE_SURFACE_PREFIX_V1 } from "@frockbot/app/email/shared";
import {
  createReplyToRequestToolV1,
  REPLY_TO_REQUEST_TOOL_V1,
  type ReplyDelivererV1,
} from "./reply-to-caller.js";

/** What the Bot Durable Object hands an email Turn: the one send it makes. */
export interface EmailReplyRuntimeHostV1 {
  /**
   * Emails `body` back to the person, keyed by the Turn and the call that
   * answered, so a replayed call finds its claim and never sends twice.
   */
  send(request: {
    occurrenceId: string;
    body: string;
  }): Promise<EmailReplyOutcomeV1>;
}

export const EMAIL_REPLY_PROMPT_SECTION_V1 = "email-reply";

/** Beside the other callers' sections, after the conversational contract. */
const EMAIL_REPLY_PROMPT_ORDER_V1 = 93;

export const EMAIL_REPLY_PROMPT_TEXT_V1 = [
  "## This message came by email",
  "",
  `Your person wrote to you by email, and your answer goes back to them by email. Answer with one \`${REPLY_TO_REQUEST_TOOL_V1}\` call: \`answer\` is the body of your reply. It is sent from your own address as a reply in the thread they wrote in, under "Re:" and their subject, and it ends this Turn. On this Turn, that call is how they hear from you, not \`send_to_user\`.`,
  "- Write the email itself: what they will read in their inbox, in plain text, with no markdown. Never describe it — do not say that you are replying, have replied or sent anything, or where it will arrive. The reply is the proof.",
  `- Do not also answer in the conversation with \`send_to_user\`, and do not call \`email_owner\` to reply: \`${REPLY_TO_REQUEST_TOOL_V1}\` already emails them. They are not watching the app, so send no interim updates either.`,
  `- Use \`send_to_user\` only for what has to be answered in the app — an approval, a question with options, a secret request, a card — and still finish with \`${REPLY_TO_REQUEST_TOOL_V1}\`, saying briefly what it is. FrockBot ends that email with a line pointing them to the app, so do not add one.`,
].join("\n");

/**
 * The line an emailed reply ends with when the Turn left the person something
 * that can only be answered in the app: the card is in the conversation, and
 * the email is where they are looking.
 */
export const EMAIL_WAITING_LINE_V1 =
  "There's something waiting for you in FrockBot.";

/**
 * Whether this Turn drew anything in the conversation the person has to see
 * or answer there: a question, an approval, a secret request, a file, a card.
 * A note the Bot emailed is mail already, and text is what the reply says.
 */
export function waitingInAppV1(
  events: readonly SessionEvent[],
  turn: number,
): boolean {
  return events.some(
    (event) =>
      event.type === "send/to-user" &&
      event.turn === turn &&
      event.payload.type !== "text" &&
      !(
        event.payload.type === "card" &&
        event.payload.surfaceId.startsWith(EMAIL_NOTE_SURFACE_PREFIX_V1)
      ),
  );
}

/**
 * Why the reply is in the conversation rather than the person's inbox, in
 * their words. The Bot is told the same thing in its own.
 */
const NOT_EMAILED_V1: Record<OwnerMailRefusalV1, string> = {
  off: "this FrockBot doesn't send email",
  "no-sender": "this FrockBot doesn't send email",
  unreadable: "the email settings couldn't be read just now",
  inactive: "this Bot isn't active",
  "no-username": "your account has no email username yet",
  "switched-off": "Email is switched off in this Bot's settings",
  "no-address": "there's no address of yours to send it to",
  "not-owner": "the address you wrote from is no longer one of yours",
  "daily-limit": "this Bot has sent as many emails as it may today",
  refused: "the mail service turned it down",
};

/**
 * The reply's delivery, and the one place its channel is chosen: the
 * person's inbox when the send left or may have, and the conversation — with
 * the plain reason — when nothing left. It only ever runs for a call the loop
 * dispatched, so a reply that was never released is never sent.
 */
export function emailReplyDelivererV1(
  host: EmailReplyRuntimeHostV1,
): ReplyDelivererV1 {
  return async (answer, context, session) => {
    const turn = session.activeRunJournal.findLast(
      (event) => event.type === "turn/start",
    );
    const waiting =
      turn?.type === "turn/start" &&
      waitingInAppV1(session.activeRunJournal, turn.turn);
    const body = waiting ? `${answer}\n\n${EMAIL_WAITING_LINE_V1}` : answer;
    const outcome = await host.send({ occurrenceId: context.effectId, body });
    if (outcome.status === "sent") {
      return {
        channel: "caller",
        text: body,
        told: `Emailed your reply to ${outcome.to}, "${outcome.subject}". This Turn is over.`,
      };
    }
    if (outcome.status === "unknown") {
      return {
        channel: "caller",
        text: body,
        told: `Your reply may have been emailed (${outcome.reason}); it was not sent again. This Turn is over.`,
      };
    }
    return {
      channel: "conversation",
      payload: {
        type: "text",
        text: `${answer}\n\n(Not sent by email: ${NOT_EMAILED_V1[outcome.code]}.)`,
      },
      told: `Your reply could not be emailed (${outcome.reason}), so it was posted in the conversation instead, with the reason. This Turn is over.`,
    };
  };
}

/**
 * Mounted only on a Turn the person started by email: the reply tool bound to
 * the email caller, and the words that tell the model its answer is an email.
 */
export function createEmailReplyFeatureV1(
  host: EmailReplyRuntimeHostV1,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => {
    const disposers = [
      runtime.systemPrompt.register({
        id: EMAIL_REPLY_PROMPT_SECTION_V1,
        order: EMAIL_REPLY_PROMPT_ORDER_V1,
        render: (context) =>
          context.turnType === "chat" ? EMAIL_REPLY_PROMPT_TEXT_V1 : "",
      }),
      runtime.tools.register(
        createReplyToRequestToolV1(
          "email",
          runtime.sessions,
          emailReplyDelivererV1(host),
        ),
      ),
    ];
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
    };
  };
}
