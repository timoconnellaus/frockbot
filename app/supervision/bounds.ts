/**
 * Text bounded at both ends. A request's ask often comes last — after a
 * pasted email, a hand-off, a steering note — so a bound that keeps only the
 * start drops the one line that matters. Two thirds of the room goes to the
 * start and the rest to the end.
 */
export function clipEndsV1(text: string, max: number): string {
  if (text.length <= max) return text;
  const head = Math.ceil((max * 2) / 3);
  const tail = max - head;
  return `${text.slice(0, head)}…${tail > 0 ? text.slice(-tail) : ""}`;
}
