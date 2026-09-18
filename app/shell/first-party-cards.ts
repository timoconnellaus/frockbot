// The five first-party sends, mapped onto the locked Plugins that draw them
// (ADR 0030 step 7).
//
// `approval`, `widget`, `attachment`, `secret-request` and `agent-card` were
// each a payload member with a Flutter widget behind it. They are Cards now,
// drawn by five locked seeded Plugins, so the deployment's own cards go
// through the path a User's Plugin goes through: a declared `dataSchema`, a
// `renderCard` in an untrusted worker, the Frock catalog, and the same seam
// that folds any other Card into the Session.
//
// What does not move is the meaning. The payload is still recorded on the
// Turn's log exactly as it always was, because that log is where an Approval
// record is minted from, where a Machine command and a Plugin intent find the
// decision they are keyed by, where delivery decides a Turn is over, and where
// a notification finds its words. The Card is the *face* of that send; the
// send is still the kernel's.
//
// The client therefore draws the Card and no longer draws these five members
// itself. A draw that could not happen — a host with no Worker Loader, so
// nothing seeded, or a locked Plugin that failed its health check — leaves
// the send on the log with no face, and nothing else is written.
//
// A plain line beside the send was the other option and is deliberately not
// taken. A `send/to-user` text payload is conversation: it goes into the
// Bot's own chat history, so every approval would come back to the model as a
// second message saying what it just asked. Two records of one send is the
// duplication this step exists to remove, whichever way round it is. Every
// environment this deployment ships binds the Plugin worker loader, and a
// locked Plugin that cannot mount is an outage the ADR's own decision accepts
// — "a Plugin that is always on for this Bot failed" is already a thing the
// kernel has words for.
import {
  FIRST_PARTY_CARD_OCCURRENCE_SUFFIX_V1,
  type FirstPartyCardDrawV1,
  type FirstPartyCardDrawsV1,
  type SendToUserPayloadV1,
  type ToolExecutionContext,
} from "@frockbot/core/contracts";

/** The locked Plugin, and the card of it, each old member is drawn by. */
export const FIRST_PARTY_CARD_PLUGINS_V1 = {
  approval: { pluginId: "approvals", cardId: "decision" },
  widget: { pluginId: "questions", cardId: "ask" },
  attachment: { pluginId: "attachments", cardId: "file" },
  "secret-request": { pluginId: "credentials", cardId: "request" },
  "agent-card": { pluginId: "agents", cardId: "note" },
} as const satisfies Record<string, { pluginId: string; cardId: string }>;

/** The payload members a locked Plugin draws rather than the client. */
export type FirstPartyCardMemberV1 = keyof typeof FIRST_PARTY_CARD_PLUGINS_V1;

export const FIRST_PARTY_CARD_MEMBERS_V1: readonly FirstPartyCardMemberV1[] =
  Object.keys(FIRST_PARTY_CARD_PLUGINS_V1) as FirstPartyCardMemberV1[];

export function isFirstPartyCardMemberV1(
  type: SendToUserPayloadV1["type"],
): type is FirstPartyCardMemberV1 {
  return (FIRST_PARTY_CARD_MEMBERS_V1 as readonly string[]).includes(type);
}

/**
 * The draw one payload asks for, or nothing when the payload is not one of
 * the five.
 *
 * The values are the payload's own, reshaped to the card's declared schema
 * and nothing more: a mapping that decided anything would be a second place
 * the meaning of a send lives.
 */
export function firstPartyCardDrawV1(
  payload: SendToUserPayloadV1,
): FirstPartyCardDrawV1 | undefined {
  switch (payload.type) {
    case "approval":
      return {
        ...FIRST_PARTY_CARD_PLUGINS_V1.approval,
        data: {
          action: payload.action,
          risk: payload.risk,
          ...(payload.rationale === undefined
            ? {}
            : { rationale: payload.rationale }),
        },
        // The decision is already on the log under the id the Bot chose, and
        // that id is what its Machine command, its Plugin intent and its next
        // Turn's durable input are keyed by. The Card decides *that*.
        approvalIds: [payload.approvalId],
      };
    case "widget":
      return {
        ...FIRST_PARTY_CARD_PLUGINS_V1.widget,
        data: {
          prompt: payload.widget.prompt,
          options: payload.widget.options,
          ...(payload.widget.helpText === undefined
            ? {}
            : { helpText: payload.widget.helpText }),
          ...(payload.widget.allowCustom === undefined
            ? {}
            : { allowCustom: payload.widget.allowCustom }),
        },
      };
    case "attachment":
      return {
        ...FIRST_PARTY_CARD_PLUGINS_V1.attachment,
        data: {
          url: payload.url,
          ...(payload.name === undefined ? {} : { name: payload.name }),
          ...(payload.mediaType === undefined
            ? {}
            : { mediaType: payload.mediaType }),
        },
      };
    case "secret-request":
      return {
        ...FIRST_PARTY_CARD_PLUGINS_V1["secret-request"],
        data: { prompt: payload.prompt, secretName: payload.secretName },
      };
    case "agent-card":
      return {
        ...FIRST_PARTY_CARD_PLUGINS_V1["agent-card"],
        data: {
          agentId: payload.agentId,
          title: payload.title,
          ...(payload.body === undefined ? {} : { body: payload.body }),
        },
      };
    default:
      return undefined;
  }
}

/**
 * Draws the Card that is one send's face, if there is one to draw.
 *
 * Answers the surface it drew, or nothing — the payload was not one of the
 * five, or this host draws no cards, or the draw was refused. It never
 * throws and it never writes: a card is a face, and a face that could not be
 * drawn must not be how a send fails, nor what a send becomes.
 */
export async function drawFirstPartyCardV1(
  cards: FirstPartyCardDrawsV1 | undefined,
  payload: SendToUserPayloadV1,
  context: ToolExecutionContext,
): Promise<{ surfaceId?: string }> {
  const request = firstPartyCardDrawV1(payload);
  if (!request || !cards) return {};
  try {
    const outcome = await cards.draw(request, {
      ...context,
      // One tool call records the send and the Card that is its face, and a
      // send is deduped by its occurrence: sharing the effect id would make
      // the card the *same* send as the payload, so the second of the two
      // would be silently dropped. Derived rather than minted, so a replayed
      // call recomputes the same occurrence, the same surface id and — for a
      // Plugin that mints them — the same Approval ids.
      effectId: `${context.effectId}${FIRST_PARTY_CARD_OCCURRENCE_SUFFIX_V1}`,
    });
    return outcome.status === "drawn" ? { surfaceId: outcome.surfaceId } : {};
  } catch {
    return {};
  }
}
