// The Shell owns reply delivery and conversation completion. Final sends end
// the Turn; interim sends continue work; background Turns hand off to a parent.
import { packageAdmissionCeilingV1 } from "@frockbot/core/contracts";
import {
  SUBAGENT_QUESTION_PREFIX_V1,
  TASK_QUESTION_MAX_V1,
} from "@frockbot/app/subagents/records";
import {
  decodeSendToUserPayloadV1,
  SEND_TO_USER_PAYLOAD_TYPES_V1,
  decodeTurnTypeV1,
  latestOpenStepPositionV1,
  type FirstPartyCardDrawsV1,
  type LlmMessage,
  type LoopHooksV1,
  type SendToUserPayloadV1,
  type Session,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type TurnTypeV1,
  type AgentRuntimeV1,
  type RuntimeFeatureV1,
} from "@frockbot/core/contracts";
import {
  automationParentPointerV1,
  chatWindowV1,
  CHAT_HISTORY_BUDGET_CHARS_V1,
  type ChatWindowV1,
  turnTypesByTurnV1,
} from "./history.js";
import { assembleJournalContextV1 } from "./working-context.js";
import {
  applyParkedCompactionV1,
  COMPACTION_MAX_SLICES_PER_RUN_V1,
  type CompactionLogV1,
  type ParkedCompactionStoreV1,
  runCompactionV1,
} from "./compaction.js";
import { compactionScopeV1, compactionWorkV1 } from "./compaction-scheduler.js";
import { SUMMARY_EFFECT_PREFIX_V1 } from "@frockbot/app/billing/model";
import { conversationDeliveryHooksV1 } from "./delivery.js";
import { shellDefinitionV1 } from "./definition.js";
import {
  drawFirstPartyCardV1,
  type SecretRequestTermsV1,
} from "./first-party-cards.js";
import {
  bindCardConnectAppsV1,
  bindCardSecretFieldsV1,
  CardDecodeError,
} from "./cards.js";
import {
  SecretDecodeError,
  secretOriginV1,
} from "@frockbot/app/secrets/shared";
import { connectCardAppV1 } from "@frockbot/app/connect/card";

export const SEND_TO_USER_TOOL_V1 = "send_to_user";
export const WAKE_PARENT_TOOL_V1 = "wake_parent";

/** The manifest Capability each tool is contributed under. */
export const USER_VOICE_CAPABILITY_V1 = "user-voice";
export const PARENT_HANDOFF_CAPABILITY_V1 = "parent-handoff";

/**
 * The durable ceiling the Shell's own manifest puts on a Capability, read back
 * out of the manifest rather than restated here. A registration that drifts
 * from the manifest is narrowed to the manifest, so the two cannot disagree
 * about what a turn type admits.
 */
export function shellAdmissionCeilingV1(
  capabilityId: string,
): readonly TurnTypeV1[] | undefined {
  return packageAdmissionCeilingV1(shellDefinitionV1, capabilityId);
}

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

/**
 * The open step a Shell event belongs to. The session log is the
 * reconstruction surface, so a send without its turn and step would not
 * replay in place.
 */
export function openStepPositionV1(
  session: Session,
  tool: string,
): { turn: number; step: number } {
  const position = latestOpenStepPositionV1(session);
  if (!position) {
    throw new Error(`${tool} has no open step to record against`);
  }
  return position;
}

/**
 * Puts one payload on the Turn's log, exactly where `send_to_user` puts one.
 *
 * `send_to_user` is not the only thing that sends: a Plugin's card tool draws
 * a Card, and the Card it draws is the same event in the same place. The
 * occurrence id is what makes a retried call the same send, so a caller
 * recording two payloads in one tool call gives each its own.
 */
export async function recordSendToUserV1(
  sessions: { get(sessionId: string): Session | undefined },
  payload: SendToUserPayloadV1,
  where: {
    sessionId: string;
    occurrenceId: string;
    tool: string;
    /**
     * The locked first-party cards, and the call drawing one of them (ADR
     * 0030 step 7).
     *
     * Passed by the four places that record one of the five old members —
     * `send_to_user`, the Plugin-authoring ask, the Machine command ask and
     * the Bot-template card — and by nothing else. A Plugin's card already
     * draws its own decision, so the approval the card seam records beside it
     * must not be mapped a second time.
     */
    cards?: FirstPartyCardDrawsV1;
    context?: ToolExecutionContext;
    /** What a `secret-request` is asked under beyond its words. */
    secretTerms?: SecretRequestTermsV1;
  },
): Promise<{ status: "sent" } | { status: "refused"; reason: string }> {
  const session = sessions.get(where.sessionId);
  if (!session) {
    return {
      status: "refused",
      reason: `session "${where.sessionId}" is unavailable, so the send cannot be recorded`,
    };
  }
  let position: { turn: number; step: number };
  try {
    position = openStepPositionV1(session, where.tool);
  } catch (error) {
    return {
      status: "refused",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
  // Every card reaches the log through here, whoever drew it, so this is
  // where a `ConnectApp` is bound to the app it will really connect.
  if (payload.type === "card") {
    try {
      payload = {
        ...payload,
        messages: bindCardConnectAppsV1(payload.messages, connectCardAppV1),
      };
    } catch (error) {
      if (!(error instanceof CardDecodeError)) throw error;
      return { status: "refused", reason: error.message };
    }
  }
  if (
    !session.activeRunJournal.some(
      (event) =>
        event.type === "send/to-user" &&
        event.occurrenceId === where.occurrenceId,
    )
  ) {
    session.append({
      type: "send/to-user",
      ...position,
      occurrenceId: where.occurrenceId,
      payload,
    });
    await session.flush();
  }
  // The send is durable; the card is its face. Drawing it is the same call a
  // Plugin's own card tool makes, deduped by the same effect id, and a draw
  // that could not happen changes nothing about the send.
  if (where.context) {
    await drawFirstPartyCardV1(
      where.cards,
      payload,
      where.context,
      where.secretTerms,
    );
  }
  return { status: "sent" };
}

/** What a recorded send tells the model it did. */
function sendAcknowledgement(payload: SendToUserPayloadV1): string {
  switch (payload.type) {
    case "text":
      return "Sent to the user.";
    case "attachment":
      return "Attachment sent to the user.";
    case "widget":
      return "Question sent to the user. This Turn is over; their answer arrives as a new Turn.";
    case "secret-request":
      // The value never reaches the Bot; the reference does, on a later Turn.
      return "Secret request sent to the user. This Turn is over; once they save it you receive a reference to it on a later Turn, never the value.";
    case "agent-card":
      return "Agent card sent to the user.";
    case "card":
      // Not a question, so not the end of the Turn: the card is in the thread
      // and a later send naming the same surface updates it in place.
      return "Card sent to the user. It stays in the conversation; send the same surfaceId again to update it.";
    case "approval":
      // Deliberately not "requested permission": nothing has been granted, and
      // the Turn is over whatever the answer turns out to be.
      return "Approval requested. This Turn is over; the decision reaches you as durable input on a later Turn.";
  }
}

/**
 * The Bot's conversational contract, in the words the model reads.
 *
 * It lives here rather than in a prompt Package because it is the same rule
 * the send tool's own description states: one place to write it, so the
 * section and the tool cannot drift into telling the model two things. The
 * Shell already owns the voice; it owns how the voice is used.
 */
export const CONVERSATION_PROMPT_SECTION_V1 = "conversation";
/** Ordered after identity (0), before anything a Package contributes. */
export const CONVERSATION_PROMPT_ORDER_V1 = 1;

/** The note appears when this many steps or fewer remain after this one. */
export const STEP_BUDGET_WARNING_STEPS_V1 = 3;
/** The note appears only once strictly fewer than two minutes remain. */
export const TIME_BUDGET_WARNING_MS_V1 = 2 * 60_000;

/**
 * What the model is told when its reply is about to be stopped.
 *
 * A Turn that reaches the loop's step ceiling ends `interrupted`, and a model
 * that was mid-work says nothing: the person sees a notice and no status. Bob
 * (2026-09-04) spent twenty steps retrying a failing publish and the thread
 * went quiet. So the last few steps carry a countdown and one instruction —
 * stop starting work, send a status — and the final step allows nothing else.
 */
export function stepBudgetPromptTextV1(context: {
  step?: { current: number; max: number };
  replyToCaller?: boolean;
}): string {
  const target = context.replyToCaller
    ? "reply_to_request"
    : SEND_TO_USER_TOOL_V1;
  const disposition = context.replyToCaller
    ? "the answer"
    : 'disposition:"finish"';
  const step = context.step;
  if (!step) return "";
  const remaining = step.max - step.current;
  if (remaining > STEP_BUDGET_WARNING_STEPS_V1 || remaining < 0) return "";
  if (remaining === 0) {
    return [
      "<step_budget>",
      `This is the last step of this reply; after it the reply is stopped automatically. Do nothing except call \`${target}\` once with ${disposition} and a short status for the person: what is finished, what is not, and what they can do next.`,
      "</step_budget>",
    ].join("\n");
  }
  return [
    "<step_budget>",
    `This reply has ${remaining} ${remaining === 1 ? "step" : "steps"} left after this one before it is stopped automatically. Do not start new work. Call \`${target}\` now with ${disposition} and a short status for the person: what is finished, what is not, and what they can do next.`,
    "</step_budget>",
  ].join("\n");
}

/** Warns by wall-clock budget even when the model has used few steps. */
export function timeBudgetPromptTextV1(context: {
  deadline?: { at: number; now: number };
  replyToCaller?: boolean;
}): string {
  const target = context.replyToCaller
    ? "reply_to_request"
    : SEND_TO_USER_TOOL_V1;
  const disposition = context.replyToCaller
    ? "the answer"
    : 'disposition:"finish"';
  const deadline = context.deadline;
  if (!deadline) return "";
  const remaining = deadline.at - deadline.now;
  if (!Number.isFinite(remaining) || remaining >= TIME_BUDGET_WARNING_MS_V1) {
    return "";
  }
  return [
    "<time_budget>",
    `This Turn has fewer than 2 minutes left before it is stopped automatically. Do not start new work. Call \`${target}\` now with ${disposition} and a short status for the person: what is finished, what is not, and what they can do next.`,
    "</time_budget>",
  ].join("\n");
}

/** Runtime notes carry a label so the model reads them as the platform's. */
export const TURN_BUDGET_NOTE_LABEL_V1 = "[FrockBot runtime: budget]";

/**
 * The step and time warnings, as one note at the tail of the request they
 * apply to. Not a system prompt section: the warning changes every step at
 * the end of a Turn, and a system prompt that changed would miss the cache on
 * the whole conversation behind it. A note at the tail costs nothing, and the
 * next request, built from the log, does not carry it.
 */
export const turnBudgetHooksV1: LoopHooksV1 = {
  async request(agent, _request, _turn, step, _signal, next) {
    const request = await next();
    const budget = agent.turnBudget?.();
    if (!budget) return request;
    const replyToCaller = request.tools.some(
      (tool) => tool.name === "reply_to_request",
    );
    const note = [
      stepBudgetPromptTextV1({
        step: { current: step, max: budget.maxSteps },
        replyToCaller,
      }),
      timeBudgetPromptTextV1({
        deadline: { at: budget.deadlineAt, now: budget.now },
        replyToCaller,
      }),
    ]
      .filter(Boolean)
      .join("\n\n");
    if (!note) return request;
    return {
      ...request,
      messages: [
        ...request.messages,
        { role: "user", content: `${TURN_BUDGET_NOTE_LABEL_V1}\n${note}` },
      ],
    };
  },
};

export const CONVERSATION_PROMPT_TEXT_V1 = [
  "## Talking to the user",
  "",
  "Everything the user sees is a `send_to_user` call; nothing else reaches them.",
  // The first line said sends are the only thing the user sees, and a model
  // still wrote its acknowledgement as plain assistant text and went straight
  // on to call tools — nobody saw it. So the acknowledgement names the call.
  "Your own text is not shown to the user. Writing a line in your reply instead of calling `send_to_user` means nobody reads it.",
  'When a request will take more than a moment, your first action is a `send_to_user` call with one short line — "On it." or "Looking into that." — and then you go quiet and work.',
  "After that, send only on a real beat: a part of the answer, the result, a decision only the user can make, or a blocker you cannot get past.",
  "Never narrate what you are doing, what you are about to do, or which tool you are using.",
  "Never leave a question or a request hanging: before you stop, the user must have the answer, the result, or the reason there isn't one.",
  'Use disposition:"continue" when you have more to say, including another part of the answer. When the reply is finished, call send_to_user with disposition:"finish" and the result itself. For a greeting, immediately call send_to_user({"disposition":"finish","payload":{"type":"text","text":"Hi! How can I help?"}}). Even a greeting must be a tool call, never a plain assistant reply. Finish ends the Turn immediately; never send another reply for the same result.',
  "Keep every message short — a line or two of plain prose about one thought, no preamble and no sign-off. Headings, bold labels, lists and tables are only for structured output the user asked for; give more detail when they ask for it.",
  "One message is enough for a simple answer. When an answer has distinct parts, send each part in its own call — two to four short messages; separate paragraphs in one call still make one bubble.",
  // Each of those bubbles used to cost its own inference: three consecutive
  // steps whose only tool call was a send, with no assistant text and a tool
  // result that took no time at all. The model already knows what all three
  // say by the time it writes the first.
  'When you already know every part, put those `send_to_user` calls in one `batch` call instead of one per step. They arrive as separate messages, in the order you write them. Keep `disposition:"finish"` on the last one.',
  "Don't say the same thing twice or close with a summary of the answer.",
].join("\n");

/**
 * The same contract, for a Turn that is not in the conversation.
 *
 * An automation or subagent Turn has no `send_to_user` — the manifest admits
 * `user-voice` on `chat` and `agent` only — because its Session is not the
 * conversation and what it writes has no position there. It was still handed
 * the conversational contract, so it was told at length to call a tool that
 * did not exist: Bob's morning triage (2026-09-16) read the inbox, built the
 * summary, then spent its last steps failing to send it. A Turn is told about
 * the voice it has.
 */
export const HANDOFF_PROMPT_TEXT_V1 = [
  "## Talking to the user",
  "",
  "You are not in the conversation on this Turn, and nothing you write here reaches the user. `send_to_user` does not exist; do not look for it or for another way to reach the person directly.",
  `The way out is one \`${WAKE_PARENT_TOOL_V1}\` call, and it ends this Turn. The message you pass is the only thing your conversation ever sees — your own text, your tool results and everything else here are not carried.`,
  "So write that message complete: what you were asked for, what you found, and anything the person needs to know or decide. Someone reading only those words, with none of this Turn in front of them, must have the whole answer.",
  "Do not narrate what you are doing or which tool you are using. Work, then hand off once.",
].join("\n");

/**
 * Which contract a Turn is given: the voice it has, never the one it hasn't.
 *
 * Read off the manifest's own admission ceiling rather than restated, so the
 * section and the tool registry cannot disagree about what this Turn may call.
 */
export function conversationPromptTextV1(turnType: TurnTypeV1): string {
  const ceiling = shellAdmissionCeilingV1(USER_VOICE_CAPABILITY_V1);
  if (ceiling === undefined || ceiling.includes(turnType)) {
    return CONVERSATION_PROMPT_TEXT_V1;
  }
  return turnType === "subagent"
    ? `${HANDOFF_PROMPT_TEXT_V1}\n${SUBAGENT_ASK_PROMPT_TEXT_V1}`
    : HANDOFF_PROMPT_TEXT_V1;
}

export const TASK_ASK_TOOL_V1 = "task_ask";

/** A subagent may ask once instead of guessing; it is resumed with the answer. */
export const SUBAGENT_ASK_PROMPT_TEXT_V1 = `When you cannot finish without an answer only the conversation that dispatched you has — which of two things the person meant, a detail nobody gave you — call \`${TASK_ASK_TOOL_V1}\` with that one question instead of guessing. It ends this Turn; you are resumed with the answer and keep everything you learned.`;

const SEND_TO_USER_DESCRIPTION = [
  "Speak to the user. This is the only way to say anything the user sees.",
  "Call it once, immediately, with one short line when the request will take",
  "more than a moment, then work in silence. Call it again only on a real",
  "beat: the result, a decision only the user can make, or a blocker. Do not",
  "call it to narrate a step or a tool, and never end your Turn leaving the",
  "user's question unanswered. Each call is one message; keep it short —",
  "a line or two of plain prose. Use one message for a simple answer, or",
  "separate calls for the distinct parts of a longer one.",
  "The payload is one of:",
  'payload.type is required on every send. A complete greeting call is {"disposition":"finish","payload":{"type":"text","text":"Hi! How can I help?"}}.',
  '{"type":"text","text":"…"}',
  '{"type":"attachment","url":"https://…","name":"…","mediaType":"…"}',
  '{"type":"widget","widget":{"prompt":"…","helpText":"…","options":["…"],"allowCustom":false,"dismissOnMoveOn":false}}',
  '{"type":"secret-request","prompt":"…","secretName":"…","origin":"https://…","payment":false} — asks the user to type a password, card number or other secret into a field on a card. You are never given the value: once they save it you get a reference ("secret-…") on a later Turn, and computer_browser fills it into a page with {"action":"fill","label":"…","secret":"secret-…"}. origin is the site it is for; payment is true for card numbers, security codes and bank details. It ends your Turn. Never ask for a secret in plain text.',
  '{"type":"agent-card","agentId":"…","title":"…","body":"…"}',
  '{"type":"card","surfaceId":"…","messages":[{"version":"v1.0","createSurface":{"surfaceId":"…","components":[{"id":"root","component":"Column","children":["title"]},{"id":"title","component":"Text","text":"…"}],"dataModel":{}}}]} — one A2UI surface in the conversation. A later send with the same surfaceId updates it in place and does not end your Turn. Name the surface anything but an underscore followed later by a dot: "trip_summary.v1" is refused, because "<plugin>_<card>." is reserved for the cards a plugin draws. "trip-summary.v1" or "tripSummary.v1" are fine.',
  '{"type":"approval","approvalId":"…","action":"…","rationale":"…","risk":"low|medium|high","expiresInSeconds":86400}',
  "A widget asks the user a question with 1 to 6 options and ends your Turn;",
  "their answer arrives as a new Turn. An approval asks the user to allow one",
  "action you must not take without them; it also ends your Turn, and their",
  "decision — or its expiry — reaches you as input on a later Turn.",
  'Set disposition to "finish" on the last message; it ends the Turn immediately. Use "continue" when there is more to say or do. Widgets, approvals and secret requests always end the Turn.',
].join(" ");

/**
 * The terms a `secret-request` send is asked under, taken off the tool input
 * before the payload is decoded.
 *
 * The payload's shape is what every installed app's exact-key decoder reads
 * on the wire, so the site and the payment class ride beside it in the tool
 * input and live on the request the kernel records rather than on the log's
 * payload.
 */
export function splitSecretRequestTermsV1(input: unknown): {
  payload: unknown;
  terms?: SecretRequestTermsV1;
} {
  if (
    !input ||
    typeof input !== "object" ||
    Array.isArray(input) ||
    (input as { type?: unknown }).type !== "secret-request"
  ) {
    return { payload: input };
  }
  const { origin, payment, ...payload } = input as Record<string, unknown>;
  if (payment !== undefined && typeof payment !== "boolean") {
    throw new SecretDecodeError("payload.payment must be a boolean");
  }
  return {
    payload,
    terms: {
      ...(origin === undefined
        ? {}
        : { origin: secretOriginV1(origin, "payload.origin") }),
      payment: payment === true,
    },
  };
}

const SEND_TO_USER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    disposition: {
      type: "string",
      enum: ["finish", "continue"],
      description:
        "finish ends this Turn after the last message; continue sends a message when there is more to say, including another part of the answer.",
    },
    payload: {
      type: "object",
      description: "One typed send payload, as described by this tool.",
      required: ["type"],
      properties: {
        type: {
          type: "string",
          enum: SEND_TO_USER_PAYLOAD_TYPES_V1,
        },
      },
      oneOf: [
        {
          type: "object",
          properties: {
            type: { const: "text" },
            text: {
              type: "string",
              minLength: 1,
              description:
                "One chat bubble: a line or two about one thought. Send distinct answer parts through separate calls.",
            },
          },
          required: ["type", "text"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { const: "attachment" },
            url: { type: "string" },
            name: { type: "string" },
            mediaType: { type: "string" },
          },
          required: ["type", "url"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { const: "widget" },
            widget: {
              type: "object",
              properties: {
                prompt: { type: "string" },
                helpText: { type: "string" },
                options: {
                  type: "array",
                  items: { type: "string" },
                  minItems: 1,
                  maxItems: 6,
                  uniqueItems: true,
                },
                allowCustom: { type: "boolean" },
                dismissOnMoveOn: { type: "boolean" },
              },
              required: ["prompt", "options"],
              additionalProperties: false,
            },
          },
          required: ["type", "widget"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { const: "secret-request" },
            prompt: { type: "string" },
            secretName: {
              type: "string",
              description:
                "What to call it, e.g. 'Shop login' or 'Visa card'. The user sees this name in Settings.",
            },
            origin: {
              type: "string",
              description:
                "The site it is for, e.g. https://shop.example. It is filled there without asking again; anywhere else needs the user's approval.",
            },
            payment: {
              type: "boolean",
              description:
                "True for a card number, security code or bank details: every fill asks the user first.",
            },
          },
          required: ["type", "prompt", "secretName"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { const: "agent-card" },
            agentId: { type: "string" },
            title: { type: "string" },
            body: { type: "string" },
          },
          required: ["type", "agentId", "title"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { const: "card" },
            surfaceId: {
              type: "string",
              description:
                'Letters, digits, dot, underscore or dash. It must not hold an underscore followed later by a dot ("trip_summary.v1"): that shape names the cards a plugin draws and is refused.',
            },
            // The A2UI envelope is decoded at the seam, not described here: a
            // catalog's components are the Skill's business and would cost
            // every Turn the whole vocabulary in its tool schema.
            messages: {
              type: "array",
              minItems: 1,
              maxItems: 16,
              items: { type: "object" },
            },
          },
          required: ["type", "surfaceId", "messages"],
          additionalProperties: false,
        },
        {
          type: "object",
          properties: {
            type: { const: "approval" },
            approvalId: { type: "string" },
            action: { type: "string" },
            rationale: { type: "string" },
            risk: { type: "string", enum: ["low", "medium", "high"] },
            expiresInSeconds: { type: "integer", minimum: 1 },
          },
          required: ["type", "approvalId", "action", "risk"],
          additionalProperties: false,
        },
      ],
    },
  },
  required: ["disposition", "payload"],
  additionalProperties: false,
} as const;

function createSendToUserTool(
  name: string,
  sessions: { get(sessionId: string): Session | undefined },
  runtime: { firstPartyCards?: FirstPartyCardDrawsV1 },
): ToolDefinition {
  return {
    name,
    description: SEND_TO_USER_DESCRIPTION,
    inputSchema: structuredClone(SEND_TO_USER_INPUT_SCHEMA) as Record<
      string,
      unknown
    >,
    admission: { turnTypes: ["chat", "agent", "automation"] },
    // A send is a bubble in the conversation, and two sends are read in the
    // order they landed in.
    orderedEffect: true,
    validate: (input: unknown) =>
      typeof input === "object" && input !== null && !Array.isArray(input),
    execute: async (
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const record = input as Record<string, unknown>;
      if (
        record.disposition !== "finish" &&
        record.disposition !== "continue"
      ) {
        return refusal(
          `${name} requires disposition: "finish" for the final reply or "continue" for an interim update.`,
        );
      }
      let payload: SendToUserPayloadV1;
      let secretTerms: SecretRequestTermsV1 | undefined;
      try {
        const split = splitSecretRequestTermsV1(record.payload);
        secretTerms = split.terms;
        payload = decodeSendToUserPayloadV1(split.payload, `${name}.payload`);
        // A Bot's own card may not carry the field a secret is typed into:
        // that field is the host's, on a secret request, and nowhere else.
        if (payload.type === "card") {
          bindCardSecretFieldsV1(payload.messages, undefined);
        }
      } catch (error) {
        return refusal(
          `${name} was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const recorded = await recordSendToUserV1(sessions, payload, {
        sessionId: context.sessionId,
        occurrenceId: context.effectId,
        tool: name,
        // Read now rather than closed over: the Plugin host sets it when it
        // mounts, which is after the Shell's own feature did.
        ...(runtime.firstPartyCards === undefined
          ? {}
          : { cards: runtime.firstPartyCards }),
        context,
        ...(secretTerms === undefined ? {} : { secretTerms }),
      });
      if (recorded.status !== "sent") {
        return refusal(`${name} was refused: ${recorded.reason}`);
      }
      return {
        content: sendAcknowledgement(payload),
        isError: false,
        // User decisions always hand control back, even if labelled interim.
        // A secret request is one: the Bot has nothing to fill until the
        // person has typed it.
        ...(record.disposition === "finish" ||
        payload.type === "widget" ||
        payload.type === "approval" ||
        payload.type === "secret-request"
          ? { endsTurn: true }
          : {}),
      };
    },
  };
}

function createWakeParentTool(sessions: {
  get(sessionId: string): Session | undefined;
}): ToolDefinition {
  return {
    name: WAKE_PARENT_TOOL_V1,
    description:
      "Hand off to your parent conversation and end this Turn. `message` must be a complete hand-off: the parent sees only what you write here.",
    inputSchema: {
      type: "object",
      properties: {
        message: {
          type: "string",
          description: "The complete hand-off the parent Turn receives.",
        },
      },
      required: ["message"],
      additionalProperties: false,
    },
    admission: { turnTypes: ["automation", "subagent"] },
    // The hand-off is appended to the parent conversation, so it has a
    // position there.
    orderedEffect: true,
    validate: (input: unknown) =>
      typeof input === "object" && input !== null && !Array.isArray(input),
    execute: async (
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const message = (input as Record<string, unknown>).message;
      if (typeof message !== "string" || message.trim().length === 0) {
        return refusal(
          `${WAKE_PARENT_TOOL_V1} was refused: message must be a non-empty string`,
        );
      }
      if (message.length > WAKE_PARENT_MESSAGE_LIMIT_V1) {
        return refusal(
          `${WAKE_PARENT_TOOL_V1} was refused: message exceeds ${WAKE_PARENT_MESSAGE_LIMIT_V1} characters`,
        );
      }
      return handOffToParentV1(sessions, context, WAKE_PARENT_TOOL_V1, message);
    },
  };
}

/**
 * Records one hand-off and ends the Turn. `wake_parent` and `task_ask` both
 * leave through here: the parent reads what the Turn handed over, nothing else.
 */
async function handOffToParentV1(
  sessions: { get(sessionId: string): Session | undefined },
  context: ToolExecutionContext,
  tool: string,
  message: string,
): Promise<ToolExecutionResult> {
  const session = sessions.get(context.sessionId);
  if (!session) {
    return refusal(
      `${tool} was refused: session "${context.sessionId}" is unavailable, so the hand-off cannot be recorded`,
    );
  }
  let position: { turn: number; step: number };
  try {
    position = openStepPositionV1(session, tool);
  } catch (error) {
    return refusal(
      `${tool} was refused: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  session.append({
    type: "wake/parent",
    ...position,
    occurrenceId: context.effectId,
    message,
  });
  await session.flush();
  // §2.13: calling it ends the turn, whatever the parent later does with it.
  return {
    content: "Handed off to the parent conversation. This Turn is over.",
    isError: false,
    endsTurn: true,
  };
}

function createTaskAskTool(sessions: {
  get(sessionId: string): Session | undefined;
}): ToolDefinition {
  return {
    name: TASK_ASK_TOOL_V1,
    description:
      "Ask the conversation that dispatched you one question you cannot finish without, and end this Turn. You are resumed with the answer and keep everything you have learned. `question` must stand alone: the asker sees only what you write here.",
    inputSchema: {
      type: "object",
      properties: {
        question: {
          type: "string",
          description:
            "The one question, with what you have found so far that it depends on.",
        },
      },
      required: ["question"],
      additionalProperties: false,
    },
    admission: { turnTypes: ["subagent"] },
    orderedEffect: true,
    validate: (input: unknown) =>
      typeof input === "object" && input !== null && !Array.isArray(input),
    execute: async (
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const question = (input as Record<string, unknown>).question;
      if (typeof question !== "string" || question.trim().length === 0) {
        return refusal(
          `${TASK_ASK_TOOL_V1} was refused: question must be a non-empty string`,
        );
      }
      if (question.trim().length > TASK_QUESTION_MAX_V1) {
        return refusal(
          `${TASK_ASK_TOOL_V1} was refused: question exceeds ${TASK_QUESTION_MAX_V1} characters`,
        );
      }
      return handOffToParentV1(
        sessions,
        context,
        TASK_ASK_TOOL_V1,
        `${SUBAGENT_QUESTION_PREFIX_V1}${question.trim()}`,
      );
    },
  };
}

export const WAKE_PARENT_MESSAGE_LIMIT_V1 = 32_000;

/**
 * The window compaction is measured against.
 *
 * The active-run journal is only the Turn that just ended. History lives in
 * the working-context projection, which is also what the next request carries,
 * so the trigger has to read that or a long conversation never crosses it.
 */
async function compactionWindowV1(
  session: Session,
  turn: number,
): Promise<ChatWindowV1> {
  const currentMessages = session.deriveTurnMessages(turn);
  const load = (
    session.workingContextSelector as
      | {
          compactionWindow?(input: {
            sessionId: string;
            currentTurn: number;
            currentMessages: readonly LlmMessage[];
          }): Promise<ChatWindowV1>;
        }
      | undefined
  )?.compactionWindow;
  if (load) {
    return load({
      sessionId: session.id,
      currentTurn: turn,
      currentMessages,
    });
  }
  return chatWindowV1(session.activeRunJournal, session.deriveMessages());
}

/**
 * The Shell's runtime Contribution. Registers `send_to_user`, the Bot's voice
 * to its User, and `wake_parent`, a background Turn's hand-off to the
 * conversation that started it, each bounded by the turn types its manifest
 * Capability declares.
 */
export const shellAgentFeature: RuntimeFeatureV1<AgentRuntimeV1> = (
  runtime,
) => {
  const userVoice = shellAdmissionCeilingV1(USER_VOICE_CAPABILITY_V1);
  const parentHandoff = shellAdmissionCeilingV1(PARENT_HANDOFF_CAPABILITY_V1);
  const disposers = [
    // The voice and the rules for using it are contributed together, and the
    // rules are chosen by the same ceiling that admits the tool: a Turn that
    // has the send tool carries the conversational contract, and one that has
    // only the hand-off is told about the hand-off. A section that named a
    // tool the Turn could not call sent the model hunting for it instead.
    runtime.systemPrompt.register({
      id: CONVERSATION_PROMPT_SECTION_V1,
      order: CONVERSATION_PROMPT_ORDER_V1,
      render: (context) => conversationPromptTextV1(context.turnType),
    }),
    // Nothing for most of a Turn; a countdown and one instruction at the end
    // of its step or time budget. See `turnBudgetHooksV1`.
    runtime.hooks.add(turnBudgetHooksV1),
    runtime.tools.register(
      createSendToUserTool(SEND_TO_USER_TOOL_V1, runtime.sessions, runtime),
      userVoice ? { admissionCeiling: userVoice } : undefined,
    ),
    runtime.tools.register(
      createWakeParentTool(runtime.sessions),
      parentHandoff ? { admissionCeiling: parentHandoff } : undefined,
    ),
    runtime.tools.register(
      createTaskAskTool(runtime.sessions),
      parentHandoff ? { admissionCeiling: parentHandoff } : undefined,
    ),
    runtime.hooks.add(conversationDeliveryHooksV1),
    // The hook is evaluated after `turn/end` is on the log and flushed — but
    // `turnStopping` is a hook the loop *awaits* inside its `finally`, so
    // running the summariser here is exactly the latency a compaction must
    // never cost. It is handed to the detached scheduler instead and this
    // returns at once: the Turn ends, the run settles, the response goes out,
    // and the summariser carries on behind it. Nothing here may throw, and
    // nothing here may wait.
    runtime.hooks.add({
      turnStopping: async (agent, turn) => {
        const session = agent.session;
        const work = compactionWorkV1(session.id, compactionScopeV1(session));
        // The log is free until the next admission, so an outcome that lands
        // before then is written straight through this Turn's Session.
        work.adopt(session);
        const types = turnTypesByTurnV1(session.activeRunJournal);
        if ((types.get(turn) ?? "chat") !== "chat") return;
        const parked =
          (
            session.workingContextSelector as
              { parkedCompaction?: ParkedCompactionStoreV1 } | undefined
          )?.parkedCompaction ?? work.memoryParking;
        const log: CompactionLogV1 = {
          journal: session.activeRunJournal,
          append: (event) =>
            work.write(session, async (owner) => {
              owner.append(event);
              await owner.flush();
            }),
          park: (outcome) => parked.write(outcome),
        };
        // The platform's summary model when a provider offers one, so a
        // conversation is compacted whatever model the Bot is on.
        const summaryModel = runtime.llm
          .list()
          .find((provider) => provider.summaryModel);
        work.start(async () => {
          // Whatever landed while this Turn ran is written first, so the
          // assessment below reads the summary as it now stands.
          const applied = await applyParkedCompactionV1({
            log,
            parked,
            state: (await compactionWindowV1(session, turn)).state,
          });
          if (applied === "yielded") return;
          // A backlog is summarised a bounded slice at a time; keep going
          // until it is covered, a Turn takes the log, or a slice fails.
          for (
            let slice = 0;
            slice < COMPACTION_MAX_SLICES_PER_RUN_V1;
            slice++
          ) {
            const outcome = await runCompactionV1({
              log,
              window: await compactionWindowV1(session, turn),
              budget: CHAT_HISTORY_BUDGET_CHARS_V1,
              currentTurn: turn,
              ...(summaryModel?.summaryModel
                ? {
                    model: {
                      provider: summaryModel.id,
                      model: summaryModel.summaryModel.model,
                      modelBinding: summaryModel.summaryModel.modelBinding,
                    },
                  }
                : {}),
              newEffectId: () =>
                `${SUMMARY_EFFECT_PREFIX_V1}${crypto.randomUUID()}`,
              summarise: async (request) => {
                try {
                  let text = "";
                  let truncated = false;
                  for await (const event of runtime.llm.stream(
                    {
                      // The intent's own effect id, never a fresh one: the
                      // summariser is a model effect like any other, and the
                      // id is what the durable log and the host's dispatch
                      // both key it by.
                      requestId: request.effectId,
                      provider: request.provider,
                      model: request.model,
                      system: request.system,
                      messages: request.messages,
                      tools: [],
                      ...(request.modelBinding
                        ? { modelBinding: request.modelBinding }
                        : {}),
                    },
                    request.signal,
                  )) {
                    if (event.type === "text-delta") text += event.text;
                    if (event.type === "finish") {
                      truncated = event.reason === "max-tokens";
                    }
                  }
                  if (truncated) {
                    throw new Error(
                      "The summary was cut off at its length limit.",
                    );
                  }
                  return text;
                } finally {
                  // The loop settles a model call's held resources when it
                  // dispatches it; this call is the compaction's own, outside
                  // any loop, so its lease is settled here — however the call
                  // ended. A failed settlement cannot be re-announced by a
                  // compaction, so it must not fail a summary that succeeded.
                  try {
                    await runtime.hooks.modelOutcomeCommitted(
                      agent,
                      request.effectId,
                    );
                  } catch {
                    // Nothing left to tell.
                  }
                }
              },
            });
            if (outcome.kind !== "compacted") return;
          }
        });
      },
    }),
    // Applied after the rest of the chain, so this Package has the last word on
    // what history a request carries — the one rule the visible transcript
    // rests on.
    runtime.hooks.add({
      messageWindow: async (agent, _messages, turn, _step, _signal, next) => {
        await next();
        const session = agent.session;
        const currentMessages = session.deriveTurnMessages(turn);
        const currentTurnType = session.turnType(turn);
        if (session.workingContextSelector) {
          return session.workingContextSelector({
            sessionId: session.id,
            epoch: session.cursor.epoch,
            currentTurn: turn,
            currentTurnType,
            currentMessages,
            budget: CHAT_HISTORY_BUDGET_CHARS_V1,
            pointer: automationParentPointerV1,
          });
        }
        const journalStart = session.activeRunJournal[0]?.seq ?? 0;
        if (journalStart > 0) {
          throw new Error(
            "working context is unavailable for this active-run journal",
          );
        }
        return assembleJournalContextV1({
          events: session.activeRunJournal,
          sessionId: session.id,
          currentTurn: turn,
          currentTurnType,
          currentMessages,
          pointer: automationParentPointerV1,
        });
      },
    }),
  ];
  return () => {
    for (const dispose of disposers.toReversed()) dispose();
  };
};

export default shellAgentFeature;
