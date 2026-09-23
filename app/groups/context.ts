// What a member Bot is shown when the group asks it for a Turn.
//
// A member's `group:<id>` Session holds only its own group Turns, so the
// thread between them — what the person and the other members said — is
// carried in the Turn's input. The input is written once, when the Turn is
// owed, and kept with it: a retried admission sends the same bytes, and a
// recovered Turn reads what it was first given.

import type { GroupEventV1, GroupMemberV1, GroupMessageV1 } from "./shared.js";

import type { StoredRunGroupOriginV1 } from "@frockbot/core/durable";

/** Why a member is being asked for a Turn. */
export type GroupTurnReasonV1 = StoredRunGroupOriginV1["reason"];

/** The return address a member's group Turn carries on its run record. */
export type GroupTurnOriginV1 = StoredRunGroupOriginV1;

/** How much of the thread one Turn input carries at most. */
export const GROUP_TURN_CONTEXT_MESSAGES_V1 = 60;
export const GROUP_TURN_CONTEXT_CHARS_V1 = 24_000;

/** Messages a member posted from one of its own group Turns. */
export function groupTurnMessageIdV1(
  runId: string,
  occurrence: number,
): string {
  return `b-${runId}-${occurrence}`;
}

function nameOf(botId: string, members: readonly GroupMemberV1[]): string {
  return members.find((member) => member.botId === botId)?.name ?? botId;
}

function eventLine(
  event: GroupEventV1,
  author: GroupMessageV1["author"],
  members: readonly GroupMemberV1[],
): string | undefined {
  const who =
    author.kind === "user" ? "The User" : nameOf(author.botId, members);
  switch (event.type) {
    case "created":
      return `${who} started this group.`;
    case "renamed":
      return event.name
        ? `${who} named this group "${event.name}".`
        : `${who} cleared this group's name.`;
    case "member-added":
      return `${who} added ${nameOf(event.botId, members)}.`;
    case "member-removed":
      return `${who} removed ${nameOf(event.botId, members)}.`;
    case "archived":
      return `${who} archived this group.`;
    case "restored":
      return `${who} restored this group.`;
    case "bot-message":
      return `${who} asked ${nameOf(event.toBotId, members)}, who is not in this group.`;
    case "turn-stopped":
    case "turn-failed":
      // How another member's Turn ended is not conversation.
      return undefined;
  }
}

/**
 * The lines a member reads, oldest first: what others said, and changes to
 * the group. The member's own posts from its group Turns are already in its
 * Session and are left out.
 */
export function renderGroupThreadLinesV1(input: {
  botId: string;
  members: readonly GroupMemberV1[];
  messages: readonly GroupMessageV1[];
}): string[] {
  const lines: string[] = [];
  for (const message of input.messages) {
    if (message.body.kind === "event") {
      const line = eventLine(message.body.event, message.author, input.members);
      if (line) lines.push(`(${line})`);
      continue;
    }
    if (message.author.kind === "user") {
      lines.push(`User: ${message.body.text}`);
      continue;
    }
    if (message.author.botId === input.botId) {
      if (message.messageId.startsWith("b-")) continue;
      lines.push(`You, from outside this chat: ${message.body.text}`);
      continue;
    }
    lines.push(
      `${nameOf(message.author.botId, input.members)}: ${message.body.text}`,
    );
  }
  return lines;
}

const REASON_TEXT: Record<GroupTurnReasonV1, string> = {
  mention: "You were mentioned. Reply in the group.",
  continue:
    "You had not finished your previous turn in this group when these messages arrived. Read them first, then decide whether to carry that work on, and say so when the others would want to know.",
  retry: "Your previous turn in this group did not finish. Try again.",
  jev: "Nobody mentioned you, but this looks like yours to answer. Reply in the group if you have something to add.",
};

/** The Turn input: the group, what happened since this member last took part, and why it is asked. */
export function renderGroupTurnInputV1(input: {
  botId: string;
  groupName: string;
  members: readonly GroupMemberV1[];
  messages: readonly GroupMessageV1[];
  reason: GroupTurnReasonV1;
}): string {
  const all = renderGroupThreadLinesV1(input);
  const kept: string[] = [];
  let chars = 0;
  for (const line of all.toReversed()) {
    if (
      kept.length >= GROUP_TURN_CONTEXT_MESSAGES_V1 ||
      chars + line.length > GROUP_TURN_CONTEXT_CHARS_V1
    ) {
      break;
    }
    kept.push(line);
    chars += line.length + 1;
  }
  kept.reverse();
  const omitted = all.length - kept.length;
  const roster = input.members
    .map((member) =>
      member.botId === input.botId ? `${member.name} (you)` : member.name,
    )
    .join(", ");
  return [
    `Group chat: ${input.groupName}`,
    `Members: ${roster}, and your User`,
    "",
    kept.length > 0
      ? "New in the group since you last took part:"
      : "Nothing new has been said in the group since you last took part.",
    ...(omitted > 0 ? [`(${omitted} earlier messages are not shown.)`] : []),
    ...kept,
    "",
    REASON_TEXT[input.reason],
  ].join("\n");
}

/**
 * The system prompt a group Turn carries: where the Bot is and how talking
 * there works. The thread itself is in the Turn input.
 */
export function groupTurnPromptV1(
  origin: GroupTurnOriginV1,
  botId: string,
): string {
  const others = origin.members
    .filter((member) => member.botId !== botId)
    .map((member) => `@${member.name}`)
    .join(", ");
  return [
    `You are in the group chat "${origin.groupName}" with your User and the other member Bots: ${others}.`,
    "Everything you send with `send_to_user` is posted to this group, where your User and every member read it; nothing you say here reaches your one-to-one chat. Finish with a single `send_to_user` in your own voice.",
    "To ask another member something, write @ and their name in your message. That asks them to answer, but you do not wait for it: your turn ends when you post, and their answer is the next message in the group. Mention a member only when you are asking them for something.",
    "Messages from your User are labelled `User:`. Messages from other members are labelled with their name.",
    "Write @User only when your User needs to see something now: that sends them a notification. Everything else you post just shows as unread.",
  ].join("\n\n");
}
