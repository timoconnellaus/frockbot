// The Shell's runtime Contribution: the Bot's voice to its User, and a child
// Turn's hand-off to its parent.
//
// Two tools, and no authority of its own:
//
//  0. One prompt section, `conversation`: when to speak and when not to. It
//     is contributed beside the tool so the section and the tool description
//     cannot drift into telling the model two different things.
//
//  1. `send_to_user` (legacy alias `send_message`) — parity register row 57b.
//     One tool carrying the typed payload union, admitted on chat turns only,
//     recording each send as `send/to-user` on the durable log. Row 57c: a
//     `widget` payload ends the Turn; row 53's `approval` payload is the only
//     other one that does, and for the same reason — the Bot has nothing left
//     to do until a person answers.
//  3. One `agent/message-window` handler, which is where the transcript seam is: a
//     chat Turn's request carries only chat Turns, and an automation Turn's
//     carries its own Turn and a pointer to the parent it may not read. See
//     `history.ts`.
//
//  2. `wake_parent` — row 40 / §2.13. One required `message`, a complete
//     hand-off, admitted on automation and subagent turns only, and always
//     ending the Turn. Delivering the hand-off into the parent's next
//     conversational Turn is a later slice; this records it durably.
//
// It lives in `plugin-shell` because the Shell already owns the run DTO and
// the WebUI that renders a send, so there is no cross-Package seam to cross.
// Nothing here reaches the kernel: admission is a declaration the tool
// registry enforces, and `endsTurn` is a boolean the Agent loop carries.
import {
  decodeSendToUserPayloadV1,
  decodeTurnTypeV1,
  type SendToUserPayloadV1,
  type Session,
  type ToolDefinition,
  type ToolExecutionContext,
  type ToolExecutionResult,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import {
  automationParentPointerV1,
  chatWindowV1,
  CHAT_HISTORY_BUDGET_CHARS_V1,
  turnScopedMessagesV1,
  turnTypesByTurnV1,
} from "./history.js";
import { runCompactionV1 } from "./compaction.js";
import { compactionWorkV1 } from "./compaction-scheduler.js";
import type { Plugin } from "cordis";
import manifest from "../frockbot.json" with { type: "json" };

export const SEND_TO_USER_TOOL_V1 = "send_to_user";
/** `SAND_LEGACY_SEND_MESSAGE_TOOL_NAME`: an alias, not a second tool. */
export const SEND_MESSAGE_ALIAS_V1 = "send_message";
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
  const capabilities = (
    manifest as {
      configuration?: {
        capabilities?: Array<{
          id: string;
          admission?: { turnTypes: string[] };
        }>;
      };
    }
  ).configuration?.capabilities;
  const capability = capabilities?.find(
    (candidate) => candidate.id === capabilityId,
  );
  const turnTypes = capability?.admission?.turnTypes;
  if (!turnTypes) return undefined;
  return turnTypes.map((turnType) =>
    decodeTurnTypeV1(turnType, `shell capability "${capabilityId}" admission`),
  );
}

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

/** Adapts a cordis fiber to the plain disposer this Package's list holds. */
function disposeFiber(fiber: { dispose(): unknown }): () => void {
  return () => void fiber.dispose();
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

export const CONVERSATION_PROMPT_TEXT_V1 = [
  "## Talking to the user",
  "",
  "Everything the user sees is a `send_to_user` call; nothing else reaches them.",
  'When a request will take more than a moment, send one short line first — "On it." or "Looking into that." — then go quiet and work.',
  "After that, send only on a real beat: the result, a decision only the user can make, or a blocker you cannot get past.",
  "Never narrate what you are doing, what you are about to do, or which tool you are using.",
  "Never leave a question or a request hanging: before you stop, the user must have the answer, the result, or the reason there isn't one.",
  "When the work is finished, send the result itself, not an account of how you got it.",
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
  "Every other payload leaves the Turn running.",
].join(" ");

const SEND_TO_USER_INPUT_SCHEMA = {
  type: "object",
  properties: {
    payload: {
      type: "object",
      description: "One typed send payload, as described by this tool.",
    },
  },
  required: ["payload"],
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
    admission: { turnTypes: ["chat"] },
    validate: (input: unknown) =>
      typeof input === "object" && input !== null && !Array.isArray(input),
    execute: async (
      input: unknown,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionResult> => {
      const record = input as Record<string, unknown>;
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
      session.append({
        type: "send/to-user",
        ...position,
        occurrenceId: context.effectId,
        payload,
      });
      await session.flush();
      return {
        content: sendAcknowledgement(payload),
        isError: false,
        // Row 57c: a widget ends the Turn, and row 53's approval card is the
        // only other payload that does. The decision is per result, so the
        // same tool leaves a text send running.
        ...(payload.type === "widget" || payload.type === "approval"
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
 * The Shell's runtime Contribution. Registers the user-facing send tool, its
 * legacy alias, and the parent hand-off, each bounded by the turn types its
 * manifest Capability declares.
 */
export const shellAgentPlugin: Plugin.Function = (ctx) => {
  const userVoice = shellAdmissionCeilingV1(USER_VOICE_CAPABILITY_V1);
  const parentHandoff = shellAdmissionCeilingV1(PARENT_HANDOFF_CAPABILITY_V1);
  const disposers = [
    // The voice and the rules for using it are contributed together, so a
    // Composition that admits the send tool always carries the contract.
    ctx.systemPrompt.register({
      id: CONVERSATION_PROMPT_SECTION_V1,
      order: CONVERSATION_PROMPT_ORDER_V1,
      render: () => CONVERSATION_PROMPT_TEXT_V1,
    }),
    ctx.tools.register(
      createSendToUserTool(SEND_TO_USER_TOOL_V1, ctx.sessions),
      userVoice ? { admissionCeiling: userVoice } : undefined,
    ),
    ctx.tools.register(
      createSendToUserTool(SEND_MESSAGE_ALIAS_V1, ctx.sessions),
      userVoice ? { admissionCeiling: userVoice } : undefined,
    ),
    ctx.tools.register(
      createWakeParentTool(ctx.sessions),
      parentHandoff ? { admissionCeiling: parentHandoff } : undefined,
    ),
    // ADR 0030. `ctx.inject` rather than a declared dependency: a host that
    // mounts the Shell without a model still gets its tools and its transcript
    // seam, and simply never compacts. The hook is evaluated after `turn/end`
    // is on the log and flushed — but `agent/turn-stopping` is a hook the loop
    // *awaits* inside its `finally`, so running the summariser here is exactly
    // the latency ADR 0030 says a compaction never costs. It is handed to the
    // detached scheduler instead and this returns at once: the Turn ends, the
    // run settles, the response goes out, and the summariser carries on behind
    // it. Nothing here may throw, and nothing here may wait.
    disposeFiber(
      ctx.inject(["llm"], (scoped) => {
        scoped.on("agent/turn-stopping", async (agent, turn) => {
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
                let text = "";
                // Two deadlines, one call: the compaction's own, and the abort
                // a newly admitted Turn raises when it takes the log back.
                const cancelled = AbortSignal.any([request.signal, signal]);
                for await (const event of scoped.llm.stream(
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
                  cancelled,
                )) {
                  if (event.type === "text-delta") text += event.text;
                }
                return text;
              },
            });
          });
        });
      }),
    ),
    // Applied after the rest of the chain, so this Package has the last word on
    // what history a request carries — the one rule the visible transcript
    // rests on.
    ctx.on(
      "agent/message-window",
      async (agent, _messages, _turn, _step, _signal, next) => {
        const proposed = await next();
        return turnScopedMessagesV1({
          events: agent.session.events,
          messages: proposed,
          pointer: automationParentPointerV1,
          sessionId: agent.session.id,
        });
      },
    ),
  ];
  return () => {
    for (const dispose of disposers.toReversed()) dispose();
  };
};
shellAgentPlugin.inject = ["tools", "sessions", "systemPrompt"];

export default shellAgentPlugin;
