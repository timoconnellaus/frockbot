/**
 * What the working row says while a message the person just sent is displacing
 * the Turn the Bot is still finishing.
 *
 * Sending mid-Turn supersedes the running Turn (ADR 0024): the new message is
 * admitted, the Turn it replaced is asked to stop, and the new one starts only
 * once that one has settled. For the seconds in between, the thread showed the
 * old Turn's working sheep — the same animation as always — over a greyed
 * message, and said nothing. Two Turns' worth of waiting looked like one Turn
 * being slow, and the person had no way to tell that the reply forming above
 * their message was the one they had already replaced.
 *
 * So the row gets words for exactly that window, and only then. They are calm
 * and they describe the thing that is actually happening: the previous reply is
 * being stopped. Nothing is blocked while they show — the composer stays open,
 * Stop still targets the Turn that is executing — and they go the moment the
 * new Turn produces its first event, which is when the ordinary working state
 * becomes true again.
 *
 * The drain is read off the transcript rather than tracked as a flag, so it
 * survives a reload: a Turn waiting behind another is `queued` in durable run
 * state, and `pending` on its lines is that fact projected. The module is pure
 * and keeps no clock; the caller supplies `now`.
 */

/** The words while the previous reply is being stopped. */
export const SUPERSEDE_DRAIN_LABEL_V1 = "Stopping the previous reply…";

/**
 * The words once it is taking longer than anyone expects. It says the same
 * thing, because the same thing is still true — it does not escalate, offer a
 * button, or imply the person did something wrong.
 */
export const SUPERSEDE_DRAIN_SLOW_LABEL_V1 =
  "Still stopping the previous reply";

/**
 * How long the ordinary wording stands before the slower one takes over. A
 * Turn cancels at its next external effect, so a few seconds is normal and a
 * model mid-request can take longer; twenty is well past "normal" without
 * being long enough for the person to conclude the app has stopped.
 */
export const SUPERSEDE_DRAIN_SLOW_AFTER_MS_V1 = 20_000;

/**
 * `none` is every ordinary moment, including an ordinary running Turn.
 * `stopping` and `slow` are the drain, before and after the bound.
 */
export type SupersedeDrainStateV1 = "none" | "stopping" | "slow";

/** One transcript line, as much of it as this derivation reads. */
export interface SupersedeDrainMessageV1 {
  role: string;
  status: string;
  /** True while this line's Turn is waiting behind another. */
  pending?: boolean;
  /** When the line was recorded, ISO-8601. */
  at?: string;
}

export function supersedeDrainStateV1(input: {
  /** The open Bot's thread, oldest first. */
  messages: readonly SupersedeDrainMessageV1[];
  /** Wall clock in milliseconds. */
  now: number;
}): SupersedeDrainStateV1 {
  // The line the new Turn draws before it starts: an assistant line, shaped
  // like a Turn in flight, still waiting behind the one it displaced. When the
  // displaced Turn settles and this one is admitted, `pending` goes and with it
  // the whole state — that is the "first event of the new Turn" transition.
  const waiting = input.messages.findLast(
    (message) =>
      message.role === "assistant" &&
      message.status === "streaming" &&
      message.pending === true,
  );
  if (!waiting) return "none";
  const startedAt = waiting.at ? Date.parse(waiting.at) : Number.NaN;
  if (Number.isNaN(startedAt)) return "stopping";
  return input.now - startedAt >= SUPERSEDE_DRAIN_SLOW_AFTER_MS_V1
    ? "slow"
    : "stopping";
}

/** The words for a state, or `undefined` when the row says nothing. */
export function supersedeDrainLabelV1(
  state: SupersedeDrainStateV1,
): string | undefined {
  if (state === "stopping") return SUPERSEDE_DRAIN_LABEL_V1;
  if (state === "slow") return SUPERSEDE_DRAIN_SLOW_LABEL_V1;
  return undefined;
}
