/**
 * The Bot's admission-index cursor, alone in a module of its own.
 *
 * Two surfaces agree on these bytes — the run list pages by them and unread
 * state is a pair of them — and the second must not drag the Durable Object
 * types the first depends on into a browser-side program. So the format lives
 * here, with nothing but an identifier check under it.
 */
import { isPublicIdentifier } from "@frockbot/configuration-core";

/** `run-index:<acceptedAt ISO, 24 chars>:<runId>`, as the kernel writes it. */
export const RUN_CURSOR_PATTERN = /^run-index:(.{24}):(.+)$/;

export function decodeRunCursorV1(value: string): string {
  const match = RUN_CURSOR_PATTERN.exec(value);
  const acceptedAt = match?.[1];
  const runId = match?.[2];
  if (
    !acceptedAt ||
    !runId ||
    !Number.isFinite(Date.parse(acceptedAt)) ||
    new Date(acceptedAt).toISOString() !== acceptedAt ||
    !isPublicIdentifier(runId)
  ) {
    throw new Error("run cursor is invalid");
  }
  return value;
}
