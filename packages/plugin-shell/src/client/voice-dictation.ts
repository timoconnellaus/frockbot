// Dictation, as text arriving in a draft somebody may be editing at the same
// time (voice plan D4).
//
// The composer writes what it hears into the textarea rather than into a
// separate box, so the message is editable while it is being spoken, a
// rejected send restores it like any other draft, and Send is the ordinary
// Send. That makes one thing hard and this module is that one thing: knowing
// which part of the draft dictation put there, when the person is free to
// type in the middle of it.
//
// The answer is a *tail*: the exact text last written on dictation's behalf.
// Each update replaces the last occurrence of the previous tail with the next
// one. Delete it, retype around it, paste over it — if the previous tail is
// no longer in the draft, the new text is appended rather than forced back
// into a position nobody asked for. Nothing here reads the caret, so it holds
// on a phone keyboard and a desktop one alike.

export type VoiceDictationStateV1 =
  /** No microphone. The send button is the wave button when the draft is empty. */
  | "idle"
  /** Asked for the microphone, or waiting for the upstream to say `ready`. */
  | "starting"
  /** Capturing. Bin and Send have replaced the wave button. */
  | "listening"
  /** Send was pressed; the last of the audio is being transcribed. */
  | "finishing";

export interface DictationDraftV1 {
  draft: string;
  tail: string;
}

/** Joins dictation onto a draft without gluing two words together. */
function joined(head: string, tail: string): string {
  if (!head) return tail;
  if (!tail) return head;
  return /\s$/u.test(head) ? `${head}${tail}` : `${head} ${tail}`;
}

/**
 * Puts `nextTail` where `previousTail` was, or on the end when it has gone.
 *
 * `lastIndexOf`, not `indexOf`: dictating the same short word twice must
 * rewrite the second one.
 */
export function applyDictationTailV1(
  draft: string,
  previousTail: string,
  nextTail: string,
): DictationDraftV1 {
  if (!previousTail) return { draft: joined(draft, nextTail), tail: nextTail };
  const at = draft.lastIndexOf(previousTail);
  if (at < 0) return { draft: joined(draft, nextTail), tail: nextTail };
  const before = draft.slice(0, at);
  const after = draft.slice(at + previousTail.length);
  return { draft: `${before}${nextTail}${after}`, tail: nextTail };
}

/**
 * What has been heard so far: the finished segments, and the deltas of the
 * one still being spoken.
 *
 * A provider streams a segment as deltas and then re-sends it, punctuated and
 * capitalised, as a `completed` transcript. Keeping the two apart is what lets
 * the finished form replace the rough one in place instead of appearing twice.
 */
export class VoiceDictationTranscriptV1 {
  #settled: string[] = [];
  #pending = "";

  delta(text: string): void {
    this.#pending += text;
  }

  /** One finished segment; it replaces the deltas that built it. */
  settle(text: string): void {
    const trimmed = text.trim();
    if (trimmed) this.#settled.push(trimmed);
    this.#pending = "";
  }

  /** Everything dictated in this session, as one string. */
  text(): string {
    const settled = this.#settled.join(" ");
    const pending = this.#pending.trim();
    if (!settled) return pending;
    if (!pending) return settled;
    return `${settled} ${pending}`;
  }

  /** True until the first word arrives, so an empty capture sends nothing. */
  empty(): boolean {
    return this.text().length === 0;
  }

  reset(): void {
    this.#settled = [];
    this.#pending = "";
  }
}

/** The composer's label for each state, so the aria text and the title agree. */
export function voiceButtonLabelV1(state: VoiceDictationStateV1): string {
  switch (state) {
    case "idle":
      return "Dictate a message";
    case "starting":
      return "Starting dictation";
    case "listening":
      return "Listening";
    case "finishing":
      return "Finishing dictation";
  }
}

/**
 * The scale factor of each bar of the capture animation, newest first.
 *
 * Level-driven rather than time-driven: a wave that moves while the room is
 * silent says the microphone is working when it is not. Each call shifts the
 * previous bars along, so a syllable travels across the control instead of
 * every bar jumping at once.
 *
 * `previous` is the value this function last returned, so the whole animation
 * is one `ref` and one assignment.
 */
export function voiceWaveBarsV1(
  level: number,
  previous: readonly number[],
  bars = 4,
): number[] {
  const clamped = Number.isFinite(level) ? Math.min(1, Math.max(0, level)) : 0;
  // A floor, so the control never collapses to a line and loses its shape.
  const next = [0.2 + clamped * 0.8, ...previous].slice(0, bars);
  while (next.length < bars) next.push(0.2);
  return next;
}
