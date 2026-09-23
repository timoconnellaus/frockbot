// A member Bot's half of Group Chats: reading a group Turn back for the group,
// and knowing when a newer group message is waiting.
//
// A group Turn is an ordinary `agent`-lane Turn of the member, run under the
// group's Session and carrying the group as its origin. What it sends goes to
// the group, not to the member's one-to-one chat: the group reads the run back
// by id and posts each send once.

import type { SessionEvent } from "@frockbot/core/contracts";
import { endedOwingReplyV1 } from "../shell/delivery.js";
import type { GroupTurnOriginV1 } from "./context.js";
import type { GroupTurnStateV1 } from "./log.js";
import { isGroupSessionIdV1 } from "./shared.js";

const WAITING_PREFIX = "group-waiting:";

/** The newest group message a running member Turn has been told about. */
export function groupWaitingKeyV1(groupId: string): string {
  return `${WAITING_PREFIX}${groupId}`;
}

interface RunLike {
  sessionId: string;
  status: string;
  phase?: string;
  events: readonly SessionEvent[];
  admission?: { origin?: { kind: string } };
}

export function groupOriginOfRunV1(run: {
  admission?: { origin?: { kind: string } };
}): GroupTurnOriginV1 | undefined {
  const origin = run.admission?.origin;
  return origin?.kind === "group" ? (origin as GroupTurnOriginV1) : undefined;
}

/** A run of the group's Session: kept out of the member's one-to-one thread. */
export function isGroupRunV1(run: { sessionId: string }): boolean {
  return isGroupSessionIdV1(run.sessionId);
}

function sendText(payload: unknown): string | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const value = payload as Record<string, unknown>;
  if (value.type === "text" && typeof value.text === "string") {
    return value.text.trim() || undefined;
  }
  if (value.type === "attachment" && typeof value.url === "string") {
    const name = typeof value.name === "string" ? value.name : "Attachment";
    return `[${name}](${value.url})`;
  }
  if (value.type === "agent-card" && typeof value.title === "string") {
    return [value.title, typeof value.body === "string" ? value.body : ""]
      .filter(Boolean)
      .join("\n");
  }
  // Cards, widgets, approvals and secret requests are drawn by the one-to-one
  // chat's catalog; a group thread does not draw them yet.
  return undefined;
}

/** The Turn as the group reads it back. */
export function groupTurnStateOfRunV1(run: RunLike): GroupTurnStateV1 {
  const status: GroupTurnStateV1["status"] =
    run.status === "running"
      ? run.phase === "queued"
        ? "queued"
        : "running"
      : run.status === "completed" ||
          run.status === "failed" ||
          run.status === "cancelled"
        ? run.status
        : "running";
  const sends: GroupTurnStateV1["sends"] = [];
  for (const event of run.events) {
    if (event.type !== "send/to-user") continue;
    const text = sendText(event.payload);
    if (!text) continue;
    sends.push({ occurrence: event.seq, text, at: event.timestamp });
  }
  return {
    status,
    started:
      status !== "queued" ||
      run.events.some((event) => event.type === "turn/start"),
    sends,
    yielded: status === "completed" && endedOwingReplyV1(run.events),
  };
}

/**
 * Whether a newer group message is waiting for this group Turn.
 *
 * The group tells a member with a Turn open a message arrived; the Turn
 * yields at its next step boundary, like a person's chat Turn does for their
 * next message, and the group asks it again with that message in view.
 */
export async function groupMessageWaitingV1(
  origin: GroupTurnOriginV1,
  read: <T>(key: string) => Promise<T | undefined>,
): Promise<boolean> {
  const waiting = await read<number>(groupWaitingKeyV1(origin.groupId));
  return typeof waiting === "number" && waiting > origin.throughSeq;
}
