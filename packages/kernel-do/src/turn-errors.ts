import type { SessionEvent } from "@frockbot/kernel-contracts";

/**
 * Terminal classification of an admitted Turn's failure. The kernel's cursor
 * uses these to decide between failing, deferring, and requiring
 * reconciliation; the Package that executes the Turn raises them.
 */
export class BotTurnExecutionError extends Error {
  constructor(
    message: string,
    readonly events: SessionEvent[],
  ) {
    super(message);
    this.name = "BotTurnExecutionError";
  }
}

export class BotTurnReconciliationRequiredError extends Error {
  constructor(
    message: string,
    readonly events: SessionEvent[],
  ) {
    super(message);
    this.name = "BotTurnReconciliationRequiredError";
  }
}

/** Why the Bot declined to admit a Turn. */
export type BotTurnRefusalCodeV1 =
  | "busy"
  | "reconciliation-required"
  | "fenced"
  | "duplicate";

const BOT_TURN_REFUSAL_PREFIX_V1 = "BotTurnRefusedError:";

/**
 * An admission the Bot declined, as a typed error rather than a sentence.
 *
 * A refusal crosses a Durable Object RPC boundary, which preserves an error's
 * `name` and `message` and drops everything else — so the code rides on the
 * name, the way the gateway already relies on `name` for `BotNotFoundError`.
 * Classifying these by matching prose against `error.message` meant any
 * reword silently turned an ordinary 409 into a 500, and two real messages
 * already fell through.
 */
export class BotTurnRefusedError extends Error {
  constructor(
    readonly code: BotTurnRefusalCodeV1,
    message: string,
  ) {
    super(message);
    this.name = `${BOT_TURN_REFUSAL_PREFIX_V1}${code}`;
  }
}

/** The refusal an error carries, or `undefined` when it is not one. */
export function botTurnRefusalCodeV1(
  error: unknown,
): BotTurnRefusalCodeV1 | undefined {
  const name =
    typeof error === "object" && error !== null && "name" in error
      ? String((error as { name: unknown }).name)
      : "";
  if (!name.startsWith(BOT_TURN_REFUSAL_PREFIX_V1)) return undefined;
  const code = name.slice(BOT_TURN_REFUSAL_PREFIX_V1.length);
  return code === "busy" ||
    code === "reconciliation-required" ||
    code === "fenced" ||
    code === "duplicate"
    ? code
    : undefined;
}

export class BotTurnRecoveryRequiredError extends Error {
  constructor(readonly events: SessionEvent[]) {
    super("Bot turn has a durable outcome settlement pending");
    this.name = "BotTurnRecoveryRequiredError";
  }
}
