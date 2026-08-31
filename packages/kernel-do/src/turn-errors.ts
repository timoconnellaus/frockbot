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

export class BotTurnRecoveryRequiredError extends Error {
  constructor(readonly events: SessionEvent[]) {
    super("Bot turn has a durable outcome settlement pending");
    this.name = "BotTurnRecoveryRequiredError";
  }
}
