/** A preview may repeat an explicit text send, never the model's scratch text. */
export function sentTextV1(
  events: readonly {
    type?: string;
    payload?: { type?: string; text?: string };
  }[],
): string {
  const sent = events.findLast(
    (event) => event.type === "send/to-user" && event.payload?.type === "text",
  );
  return sent?.payload?.text ?? "";
}
