// The Shell owns reply delivery and conversation completion. Final sends end
// the Turn; interim sends continue work; background Turns hand off to a parent.
import { packageAdmissionCeilingV1 } from "@frockbot/core/contracts";
import {
  decodeSendToUserPayloadV1,
  decodeTurnTypeV1,
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
  turnScopedMessagesV1,
  turnTypesByTurnV1,
} from "./history.js";
import {
  COMPACTION_RESPONSE_SCHEMA_V1,
  type CompactionSummaryPayloadV1,
  renderCompactionSummaryV1,
  runCompactionV1,
} from "./compaction.js";
import { compactionWorkV1 } from "./compaction-scheduler.js";
import { conversationDeliveryHooksV1 } from "./delivery.js";
import { shellDefinitionV1 } from "./definition.js";

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
function openStepPositionV1(
  session: Session,
  tool: string,
): { turn: number; step: number } {
  const started = session.events.findLast(
    (event) => event.type === "step/start",
  );
  const ended = session.events.findLast((event) => event.type === "step/end");
  if (started?.type !== "step/start") {
    throw new Error(`${tool} has no open step to record against`);
  }
  if (
    ended?.type === "step/end" &&
    ended.turn === started.turn &&
    ended.step === started.step
  ) {
    throw new Error(`${tool} has no open step to record against`);
  }
  return { turn: started.turn, step: started.step };
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
      return "Secret request sent to the user.";
    case "agent-card":
      return "Agent card sent to the user.";
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

export const STEP_BUDGET_PROMPT_SECTION_V1 = "step-budget";
/** Late in the prompt, where the model reads it last and heeds it most. */
export const STEP_BUDGET_PROMPT_ORDER_V1 = 90;
/** The section appears when this many steps or fewer remain after this one. */
export const STEP_BUDGET_WARNING_STEPS_V1 = 3;
export const TIME_BUDGET_PROMPT_SECTION_V1 = "time-budget";
/** Immediately after the step warning, so the time warning is read last. */
export const TIME_BUDGET_PROMPT_ORDER_V1 = 91;
/** The section appears only once strictly fewer than two minutes remain. */
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
}): string {
  const step = context.step;
  if (!step) return "";
  const remaining = step.max - step.current;
  if (remaining > STEP_BUDGET_WARNING_STEPS_V1 || remaining < 0) return "";
  if (remaining === 0) {
    return [
      "<step_budget>",
      `This is the last step of this reply; after it the reply is stopped automatically. Do nothing except call \`${SEND_TO_USER_TOOL_V1}\` once with disposition:"finish" and a short status for the person: what is finished, what is not, and what they can do next.`,
      "</step_budget>",
    ].join("\n");
  }
  return [
    "<step_budget>",
    `This reply has ${remaining} ${remaining === 1 ? "step" : "steps"} left after this one before it is stopped automatically. Do not start new work. Call \`${SEND_TO_USER_TOOL_V1}\` now with disposition:"finish" and a short status for the person: what is finished, what is not, and what they can do next.`,
    "</step_budget>",
  ].join("\n");
}

/** Warns by wall-clock budget even when the model has used few steps. */
export function timeBudgetPromptTextV1(context: {
  deadline?: { at: number; now: number };
}): string {
  const deadline = context.deadline;
  if (!deadline) return "";
  const remaining = deadline.at - deadline.now;
  if (!Number.isFinite(remaining) || remaining >= TIME_BUDGET_WARNING_MS_V1) {
    return "";
  }
  return [
    "<time_budget>",
    `This Turn has fewer than 2 minutes left before it is stopped automatically. Do not start new work. Call \`${SEND_TO_USER_TOOL_V1}\` now with disposition:"finish" and a short status for the person: what is finished, what is not, and what they can do next.`,
    "</time_budget>",
  ].join("\n");
}

export const CONVERSATION_PROMPT_TEXT_V1 = [
  "## Talking to the user",
  "",
  "Everything the user sees is a `send_to_user` call; nothing else reaches them.",
  // The first line said sends are the only thing the user sees, and a model
  // still wrote its acknowledgement as plain assistant text and went straight
  // on to call tools — nobody saw it. So the acknowledgement names the call.
  "Your own text is not shown to the user. Writing a line in your reply instead of calling `send_to_user` means nobody reads it.",
  'When a request will take more than a moment, your first action is a `send_to_user` call with one short line — "On it." or "Looking into that." — and then you go quiet and work.',
  "After that, send only on a real beat: the result, a decision only the user can make, or a blocker you cannot get past.",
  "Never narrate what you are doing, what you are about to do, or which tool you are using.",
  "Never leave a question or a request hanging: before you stop, the user must have the answer, the result, or the reason there isn't one.",
  'Use disposition:"continue" for an interim update. When the work is finished, call send_to_user with disposition:"finish" and the result itself. A greeting needs one finish call. Finish ends the Turn immediately; never send another reply for the same result.',
  "Keep every message short — a line or two, no preamble and no sign-off.",
  "Don't say the same thing twice.",
].join("\n");

const SEND_TO_USER_DESCRIPTION = [
  "Speak to the user. This is the only way to say anything the user sees.",
  "Call it once, immediately, with one short line when the request will take",
  "more than a moment, then work in silence. Call it again only on a real",
  "beat: the result, a decision only the user can make, or a blocker. Do not",
  "call it to narrate a step or a tool, and never end your Turn leaving the",
  "user's question unanswered. Each call is one message; keep it short.",
  "The payload is one of:",
  '{"type":"text","text":"…"}',
  '{"type":"attachment","url":"https://…","name":"…","mediaType":"…"}',
  '{"type":"widget","widget":{"prompt":"…","helpText":"…","options":["…"],"allowCustom":false,"dismissOnMoveOn":false}}',
  '{"type":"secret-request","prompt":"…","secretName":"…"}',
  '{"type":"agent-card","agentId":"…","title":"…","body":"…"}',
  '{"type":"approval","approvalId":"…","action":"…","rationale":"…","risk":"low|medium|high","expiresInSeconds":86400}',
  "A widget asks the user a question with 1 to 6 options and ends your Turn;",
  "their answer arrives as a new Turn. An approval asks the user to allow one",
  "action you must not take without them; it also ends your Turn, and their",
  "decision — or its expiry — reaches you as input on a later Turn.",
  'Set disposition to "finish" for the answer, result, or blocker: this ends the Turn immediately. Use "continue" only for an interim update before more work. Widgets and approvals always end the Turn.',
].join(" ");

const SEND_TO_USER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    disposition: {
      type: "string",
      enum: ["finish", "continue"],
      description:
        "finish ends this Turn after delivery; continue sends an interim update and keeps working.",
    },
    payload: {
      type: "object",
      description: "One typed send payload, as described by this tool.",
    },
  },
  required: ["disposition", "payload"],
  additionalProperties: false,
} as const;

function createSendToUserTool(
  name: string,
  sessions: { get(sessionId: string): Session | undefined },
): ToolDefinition {
  return {
    name,
    description: SEND_TO_USER_DESCRIPTION,
    inputSchema: structuredClone(SEND_TO_USER_INPUT_SCHEMA) as Record<
      string,
      unknown
    >,
    admission: { turnTypes: ["chat", "agent"] },
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
      try {
        payload = decodeSendToUserPayloadV1(record.payload, `${name}.payload`);
      } catch (error) {
        return refusal(
          `${name} was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const session = sessions.get(context.sessionId);
      if (!session) {
        return refusal(
          `${name} was refused: session "${context.sessionId}" is unavailable, so the send cannot be recorded`,
        );
      }
      let position: { turn: number; step: number };
      try {
        position = openStepPositionV1(session, name);
      } catch (error) {
        return refusal(
          `${name} was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (
        !session.events.some(
          (event) =>
            event.type === "send/to-user" &&
            event.occurrenceId === context.effectId,
        )
      ) {
        session.append({
          type: "send/to-user",
          ...position,
          occurrenceId: context.effectId,
          payload,
        });
        await session.flush();
      }
      return {
        content: sendAcknowledgement(payload),
        isError: false,
        // User decisions always hand control back, even if labelled interim.
        ...(record.disposition === "finish" ||
        payload.type === "widget" ||
        payload.type === "approval"
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
      const session = sessions.get(context.sessionId);
      if (!session) {
        return refusal(
          `${WAKE_PARENT_TOOL_V1} was refused: session "${context.sessionId}" is unavailable, so the hand-off cannot be recorded`,
        );
      }
      let position: { turn: number; step: number };
      try {
        position = openStepPositionV1(session, WAKE_PARENT_TOOL_V1);
      } catch (error) {
        return refusal(
          `${WAKE_PARENT_TOOL_V1} was refused: ${error instanceof Error ? error.message : String(error)}`,
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
    },
  };
}

export const WAKE_PARENT_MESSAGE_LIMIT_V1 = 32_000;

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
    // The voice and the rules for using it are contributed together, so a
    // Composition that admits the send tool always carries the contract.
    runtime.systemPrompt.register({
      id: CONVERSATION_PROMPT_SECTION_V1,
      order: CONVERSATION_PROMPT_ORDER_V1,
      render: () => CONVERSATION_PROMPT_TEXT_V1,
    }),
    // Empty for most of a Turn; a countdown and one instruction at the end of
    // its step budget. See `stepBudgetPromptTextV1`.
    runtime.systemPrompt.register({
      id: STEP_BUDGET_PROMPT_SECTION_V1,
      order: STEP_BUDGET_PROMPT_ORDER_V1,
      render: (context) => stepBudgetPromptTextV1(context),
    }),
    runtime.systemPrompt.register({
      id: TIME_BUDGET_PROMPT_SECTION_V1,
      order: TIME_BUDGET_PROMPT_ORDER_V1,
      render: (context) => timeBudgetPromptTextV1(context),
    }),
    runtime.tools.register(
      createSendToUserTool(SEND_TO_USER_TOOL_V1, runtime.sessions),
      userVoice ? { admissionCeiling: userVoice } : undefined,
    ),
    runtime.tools.register(
      createWakeParentTool(runtime.sessions),
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
        const types = turnTypesByTurnV1(session.events);
        if ((types.get(turn) ?? "chat") !== "chat") return;
        compactionWorkV1(session.id).start(async (signal) => {
          if (signal.aborted) return;
          await runCompactionV1({
            session,
            window: chatWindowV1(session.events, session.deriveMessages()),
            budget: CHAT_HISTORY_BUDGET_CHARS_V1,
            currentTurn: turn,
            newEffectId: () => `compaction-${crypto.randomUUID()}`,
            summarise: async (request) => {
              // Two deadlines, one call: the compaction's own, and the abort
              // a newly admitted Turn raises when it takes the log back.
              const cancelled = AbortSignal.any([request.signal, signal]);
              const result =
                await runtime.llm.structured<CompactionSummaryPayloadV1>(
                  {
                    requestId: `compaction-${crypto.randomUUID()}`,
                    provider: request.provider,
                    model: request.model,
                    system: request.system,
                    messages: request.messages,
                    tools: [],
                    ...(request.modelBinding
                      ? { modelBinding: request.modelBinding }
                      : {}),
                  },
                  {
                    name: "conversation_compaction",
                    schema: COMPACTION_RESPONSE_SCHEMA_V1,
                  },
                  cancelled,
                );
              if (result.status === "failed") {
                throw new Error(result.failure.message);
              }
              return renderCompactionSummaryV1(result.value);
            },
          });
        });
      },
    }),
    // Applied after the rest of the chain, so this Package has the last word on
    // what history a request carries — the one rule the visible transcript
    // rests on.
    runtime.hooks.add({
      messageWindow: async (agent, _messages, _turn, _step, _signal, next) => {
        const proposed = await next();
        return turnScopedMessagesV1({
          events: agent.session.events,
          messages: proposed,
          pointer: automationParentPointerV1,
          sessionId: agent.session.id,
        });
      },
    }),
  ];
  return () => {
    for (const dispose of disposers.toReversed()) dispose();
  };
};

export default shellAgentFeature;
