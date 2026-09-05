import { turnTextTooLongV1 } from "./turn-limits.js";

/**
 * Two different questions the composer used to answer with one predicate.
 *
 * "Can this client send at all" is about the transport, the Bot and the model.
 * "Is there something in the composer worth sending" is about the draft. Send
 * needs both. Try again needs only the first — the words it sends are the ones
 * already in the thread, read back off the person's own line — and folding the
 * draft into the same predicate is what disabled the recovery action for the
 * exact case it exists for: an admitted Turn that failed after the composer was
 * cleared. The only way to enable it was to type something unrelated, which is
 * not what the button would have sent.
 */
export interface SendReadinessInputV1 {
  /** The shell's connection to the backend. */
  connection: string;
  /** A model is resolved and usable for this account. */
  modelReady: boolean;
  /** The Bot the conversation is open on. */
  activeBotId?: string;
}

/** Whether this client could start a Turn, whatever the text turns out to be. */
export function sendReadyV1(input: SendReadinessInputV1): boolean {
  return (
    input.connection === "ready" &&
    input.modelReady &&
    Boolean(input.activeBotId)
  );
}

/** Whether the draft is something the send route would accept. */
export function draftSendableV1(text: string): boolean {
  return text.length > 0 && !turnTextTooLongV1(text);
}

/**
 * The text a failed Turn would be retried with, or nothing where there is no
 * such text to send.
 *
 * The same size rule as the composer, because a resend is an ordinary Turn: a
 * message that could not be sent again is not offered again.
 */
export function resendableTurnTextV1(
  text: string | undefined,
): string | undefined {
  const trimmed = text?.trim() ?? "";
  return draftSendableV1(trimmed) ? trimmed : undefined;
}
