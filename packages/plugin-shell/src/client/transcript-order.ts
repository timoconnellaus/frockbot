/**
 * The order the thread draws its lines in.
 *
 * The transcript holds three kinds of line: the message a person sent, the
 * lines their Bot wrote answering it, and the occasional line the product
 * writes between Turns — a rename, a compaction marker. The last of those is
 * why the thread orders by time at all: an announcement belongs where it
 * happened, not at the end of whatever the projection appended last.
 *
 * Ordering every line by its own timestamp is what broke. A Turn's lines are
 * stamped from two different clocks: the durable projection stamps them with
 * the run's `admittedAt`, which is the backend's clock, while a Turn this tab
 * sent is drawn immediately from the browser's clock, before the backend has
 * seen it. The two disagree by at least a round trip and by however far the
 * two machines' clocks are apart, so a reply could sort above the message it
 * answered — and, sending three messages into one running Turn, above two of
 * them: the Bot's "both messages arrived" was painted before either of the
 * messages it was about.
 *
 * So a Turn is ordered as a unit. Every line of a Turn takes the timestamp of
 * that Turn's user message — the one line whose time is a fact about the
 * conversation rather than about whichever clock happened to stamp it — and
 * within a Turn the lines keep the durable order the projection put them in.
 * A line that belongs to no Turn, which is what a system announcement is,
 * still sorts by its own time. Nothing here reorders a Turn's own lines; it
 * only stops one Turn's lines from moving through another's.
 */

/** As much of a transcript line as ordering reads. */
export interface TranscriptOrderMessageV1 {
  /** The Turn the line belongs to. A system line has an id of its own. */
  runId: string;
  role: "user" | "assistant" | "system";
  /** When the line happened, ISO-8601, when the projection knows. */
  at?: string;
}

/**
 * Where each Turn sits in the conversation: the timestamp of the message the
 * person sent, which is what every line of that Turn is ordered by.
 *
 * A Turn whose user line carries no timestamp yet — the instant between the
 * send and the first projection — anchors on the first stamp any of its lines
 * has, and on nothing when it has none, which sorts it as arriving now.
 */
export function turnAnchorsV1(
  messages: readonly TranscriptOrderMessageV1[],
): Map<string, string> {
  const anchors = new Map<string, string>();
  for (const message of messages) {
    if (message.role === "system" || !message.at) continue;
    if (message.role === "user") {
      anchors.set(message.runId, message.at);
      continue;
    }
    if (!anchors.has(message.runId)) anchors.set(message.runId, message.at);
  }
  // A user line is authoritative wherever there is one, so a second pass is
  // not needed: the loop above overwrites an assistant-derived anchor when it
  // reaches the user line, and a user line always precedes its Turn's replies.
  return anchors;
}

/**
 * The thread, in the order it is drawn.
 *
 * `now` stands in for a line with no timestamp at all, so an incomplete
 * projection sorts to the bottom rather than jumping above durable history.
 * The sort is stable on the array order, which is the durable order the
 * projection maintains: sends before the Turn's closing line, Turns in the
 * order the backend listed them.
 */
export function orderTranscriptV1<T extends TranscriptOrderMessageV1>(
  messages: readonly T[],
  now: string,
): T[] {
  const anchors = turnAnchorsV1(messages);
  const keyOf = (message: T): string =>
    (message.role === "system"
      ? message.at
      : (anchors.get(message.runId) ?? message.at)) ?? now;
  return messages
    .map((message, index) => ({ message, index }))
    .sort(
      (left, right) =>
        keyOf(left.message).localeCompare(keyOf(right.message)) ||
        left.index - right.index,
    )
    .map((entry) => entry.message);
}
