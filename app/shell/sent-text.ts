/** A preview may repeat an explicit text send, never the model's scratch text. */
export function sentTextV1(
  events: readonly {
    type?: string;
    text?: string;
    payload?: { type?: string; text?: string };
  }[],
): string {
  // Either delivery, whichever came last. A Turn the voice session asked for
  // answers with `reply_to_request` and may never send at all, and its answer
  // is still the text the Turn produced — it is what the run's outcome
  // carries, what the caller is handed, and what a preview repeats.
  const sent = events.findLast(
    (event) =>
      (event.type === "send/to-user" && event.payload?.type === "text") ||
      event.type === "reply/to-caller",
  );
  if (!sent) return "";
  return sent.type === "reply/to-caller"
    ? (sent.text ?? "")
    : (sent.payload?.text ?? "");
}
