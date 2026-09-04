// Where the compaction marker sits in the transcript (ADR 0030).
//
// The marker is one system line, and the only thing it has to get right is
// *where*: it says the Turns above it are what the model now carries a summary
// of. Dated by when the summariser ran, it landed under the newest reply,
// which says the opposite of what it means.
import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/kernel-contracts";
import { projectClientAnnouncementsV1 } from "./run-protocol.js";
import { projectAnnouncements } from "./client/index.js";
import { COMPACTED_ANNOUNCEMENT_TEXT_V1 } from "./compaction.js";
import type { WebChatMessage } from "./shared.js";

const at = (minute: number) =>
  new Date(Date.UTC(2026, 0, 1, 0, minute)).toISOString();

/** Three Turns, each a minute apart, and a compaction covering the first two. */
function log(): SessionEvent[] {
  const events: SessionEvent[] = [];
  let seq = 0;
  for (const turn of [1, 2, 3]) {
    events.push(
      { type: "turn/start", seq: seq++, timestamp: at(turn * 2), turn },
      {
        type: "turn/end",
        seq: seq++,
        timestamp: at(turn * 2 + 1),
        turn,
        outcome: "completed",
      },
    );
  }
  events.push({
    type: "conversation/compacted",
    seq: seq++,
    // Written at the end of Turn 3, which is the Turn that crossed the
    // threshold — and nowhere near the range it covers.
    timestamp: at(7),
    effectId: "compaction-1",
    fromTurn: 1,
    throughTurn: 2,
    summary: "## Summary\nprivate to the model",
    identifiers: [],
    provider: "ollama-cloud",
    model: "kimi-k2",
  });
  return events;
}

function message(
  id: string,
  role: WebChatMessage["role"],
  timestamp?: string,
): WebChatMessage {
  return {
    id,
    runId: id.split(":")[0]!,
    role,
    text: id,
    ...(timestamp ? { at: timestamp } : {}),
    status: "completed",
    tools: [],
    sends: [],
  };
}

/** The thread as `projectDurableRuns` leaves it: only user lines are dated. */
function thread(turns: readonly number[]): WebChatMessage[] {
  return turns.flatMap((turn) => [
    message(`run-${turn}:user`, "user", at(turn * 2)),
    message(`run-${turn}:assistant`, "assistant"),
  ]);
}

describe("the compaction marker sits where the summary ends", () => {
  test("is dated by the end of the range it covers, not by when it was written", () => {
    const announcements = projectClientAnnouncementsV1(
      log().filter((event) => event.type === "conversation/compacted"),
      log(),
    );
    expect(announcements).toEqual([
      {
        type: "conversation/compacted",
        announcementId: "compaction-6",
        // `turn/end` for Turn 2, not the compaction's own timestamp of 00:07.
        at: at(5),
        throughTurn: 2,
      },
    ]);
    // Without the session log there is nothing to anchor to, and the old
    // behaviour stands rather than a wrong claim being invented.
    expect(
      projectClientAnnouncementsV1(
        log().filter((event) => event.type === "conversation/compacted"),
      )[0]?.at,
    ).toBe(at(7));
  });

  test("lands between the last compacted Turn and the first verbatim one, and stays there", () => {
    const announcements = projectClientAnnouncementsV1(
      log().filter((event) => event.type === "conversation/compacted"),
      log(),
    );
    const messages = thread([1, 2, 3]);
    projectAnnouncements(messages, announcements);
    expect(messages.map((entry) => entry.id)).toEqual([
      "run-1:user",
      "run-1:assistant",
      "run-2:user",
      "run-2:assistant",
      "compaction-6",
      "run-3:user",
      "run-3:assistant",
    ]);
    expect(messages[4]?.text).toBe(COMPACTED_ANNOUNCEMENT_TEXT_V1);
    expect(messages[4]?.role).toBe("system");

    // A newer Turn arrives and the marker does not follow it down.
    messages.push(
      message("run-4:user", "user", at(8)),
      message("run-4:assistant", "assistant"),
    );
    projectAnnouncements(messages, announcements);
    expect(messages.map((entry) => entry.id)).toEqual([
      "run-1:user",
      "run-1:assistant",
      "run-2:user",
      "run-2:assistant",
      "compaction-6",
      "run-3:user",
      "run-3:assistant",
      "run-4:user",
      "run-4:assistant",
    ]);
  });

  test("sits at the top of what remains when the covered Turns have scrolled away", () => {
    const announcements = projectClientAnnouncementsV1(
      log().filter((event) => event.type === "conversation/compacted"),
      log(),
    );
    const messages = thread([3]);
    projectAnnouncements(messages, announcements);
    expect(messages.map((entry) => entry.id)).toEqual([
      "compaction-6",
      "run-3:user",
      "run-3:assistant",
    ]);
  });

  test("a rename still sorts among the Turns it happened between", () => {
    const renamed = projectClientAnnouncementsV1([
      {
        type: "bot/renamed",
        seq: 3,
        timestamp: at(5),
        from: "Housework",
        to: "Atlas",
        namedBy: "bot",
      },
    ]);
    const messages = thread([1, 2, 3]);
    projectAnnouncements(messages, renamed);
    expect(messages.map((entry) => entry.id)).toEqual([
      "run-1:user",
      "run-1:assistant",
      "run-2:user",
      "run-2:assistant",
      "announcement-3",
      "run-3:user",
      "run-3:assistant",
    ]);
  });
});
