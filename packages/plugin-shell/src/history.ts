// What history a Turn's model request is allowed to see.
//
// The Bot Durable Object keeps one ordered event log per Bot — the kernel's
// reconstruction surface, and not something a Package may partition. But "what
// enters a model request is Package policy", and this is that policy:
//
//  1. **A chat Turn sees only chat Turns.** Every event belonging to a Turn
//     whose `turn/admission` records a turn type other than `chat` is dropped
//     before the request is assembled. An automation firing therefore cannot
//     mutate the visible conversation even though its events share the log.
//
//  2. **An automation Turn starts fresh.** It sees its own Turn and one
//     pointer line naming the parent transcript — GrokBot's "fresh subagent…
//     the parent transcript is a pointer, not copied into the prompt". The
//     parent's messages are never copied, at any length.
//
//  3. **A `channel` Turn is given a history that is not this Bot's at all.**
//     It falls under rule 2 here — it is not a chat Turn, so it sees its own
//     Turn and nothing of the conversation — and the Channels Package then
//     supplies the Channel's own recent messages in place of the pointer,
//     through the Agent runtime's fresh-history mode. That substitution happens
//     outside this module, and this module is what makes it safe: whatever the
//     Turn is given, none of the Bot's personal transcript is in it.
//
// Memory is deliberately untouched by all three rules. "The parent agent's shared
// durable memories are available": Memory is injected as a prompt section, not
// as history, so a firing keeps every tier the parent has.
import {
  currentTurnV1,
  messageTurnsV1,
  type LlmMessage,
  type SessionEvent,
  type TurnTypeV1,
} from "@frockbot/kernel-contracts";

export { currentTurnV1 };

/**
 * The turn type each Turn was admitted as. A Turn recorded before turn
 * admission existed has no marker and replays as `chat`, which is what it was.
 */
export function turnTypesByTurnV1(
  events: readonly SessionEvent[],
): Map<number, TurnTypeV1> {
  const types = new Map<number, TurnTypeV1>();
  for (const event of events) {
    if (event.type === "turn/admission") types.set(event.turn, event.turnType);
  }
  return types;
}

/**
 * The pointer an automation Turn is given in place of the transcript.
 *
 * It names the conversation and says plainly that nothing from it is here, so
 * the model does not infer that the parent had nothing to say. `wake_parent` is
 * named because it is the only way back.
 */
export function automationParentPointerV1(input: {
  sessionId: string;
  chatTurns: number;
}): string {
  return [
    "You are running as an automation Turn, not inside the conversation with your user.",
    `The parent conversation is session "${input.sessionId}"; it has ${input.chatTurns} conversational ${
      input.chatTurns === 1 ? "Turn" : "Turns"
    } so far, and none of it has been copied into this prompt.`,
    "Your shared durable memories, Skills and work tools are the parent's.",
    "You cannot speak to the user from here. Call `wake_parent` with a complete hand-off when you are done; that message is the only thing the parent will see.",
  ].join(" ");
}

export interface TurnScopedMessagesInputV1 {
  events: readonly SessionEvent[];
  messages: readonly LlmMessage[];
  /** The parent-transcript pointer, used only on a non-chat Turn. */
  pointer(input: { sessionId: string; chatTurns: number }): string;
  sessionId: string;
}

/**
 * The messages one Turn's request may carry, given the whole session log and
 * the messages derived from it.
 *
 * Filtering happens here rather than at derivation because the durable log is
 * one ordered sequence whose contiguity the kernel enforces: the Turn is seeded
 * with the full history so its events keep their sequence, and only the request
 * is narrowed.
 */
export function turnScopedMessagesV1(
  input: TurnScopedMessagesInputV1,
): LlmMessage[] {
  const turns = messageTurnsV1(input.events);
  if (turns.length !== input.messages.length) {
    throw new Error(
      "session history and derived messages disagree about their length",
    );
  }
  const types = turnTypesByTurnV1(input.events);
  const current = currentTurnV1(input.events);
  const chatTurn = (turn: number) => (types.get(turn) ?? "chat") === "chat";
  if (chatTurn(current)) {
    return input.messages.filter((_, index) => chatTurn(turns[index]!));
  }
  const own = input.messages.filter((_, index) => turns[index] === current);
  const chatTurns = new Set(
    turns.filter((turn) => turn !== current && chatTurn(turn)),
  ).size;
  return [
    {
      role: "user",
      content: input.pointer({ sessionId: input.sessionId, chatTurns }),
    },
    ...own,
  ];
}
