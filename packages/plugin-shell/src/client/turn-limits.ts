/**
 * The composer's copy of the send route's size rule.
 *
 * The gateway refuses an oversized Turn with 413 before it ever reaches a Bot
 * (`TURN_TEXT_MAX_CHARACTERS_V1` in the Cloudflare application's
 * `request-body.ts`). A refusal the person could have seen coming is a bad
 * refusal, so the composer enforces the same number: it counts down as the
 * limit comes into reach and refuses to send past it, and the server's rule
 * stays the authority for anything that reaches it another way.
 *
 * One constant rather than a literal at each use, because a limit written
 * twice is a limit that drifts.
 */
export const TURN_TEXT_MAX_CHARACTERS_V1 = 32_000;

/**
 * Where the counter appears.
 *
 * A character count beside a half-written sentence is noise; it is only news
 * as the budget runs out. The last tenth is where a person can still act on
 * it — trim a paragraph, split the message — before the send button closes.
 */
export const TURN_TEXT_COUNTER_FROM_V1 = Math.floor(
  TURN_TEXT_MAX_CHARACTERS_V1 * 0.9,
);

/** How much of the budget is left; negative once the draft is over it. */
export function turnTextRemainingV1(text: string): number {
  return TURN_TEXT_MAX_CHARACTERS_V1 - text.length;
}

/** True once the draft is longer than the send route would accept. */
export function turnTextTooLongV1(text: string): boolean {
  return turnTextRemainingV1(text) < 0;
}

/** True once the count is worth showing. */
export function turnTextCounterVisibleV1(text: string): boolean {
  return text.length >= TURN_TEXT_COUNTER_FROM_V1;
}
