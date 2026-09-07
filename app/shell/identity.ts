// The Bot's durable identity and the two lifecycle questions the Durable
// Object asks about it. Everything here is authority state; the app adds only
// the rule that an archived Bot is one with no run in flight.

import { ACTIVE_RUN_KEY, type BotIdentity } from "@frockbot/core/durable";
import type { ShellBotStateV1 } from "./backend-state.js";

/** Refuses a command whose claimed identity is not this object's. */
export async function validateIdentity(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<void> {
  await state.authority.validateIdentity(identity);
}

/** Recompute the Bot authority's one alarm inside a Package write transaction. */
export async function refreshScheduledWork(
  state: ShellBotStateV1,
  transaction: DurableObjectTransaction,
): Promise<void> {
  await state.authority.refreshRecoveryAlarm(transaction);
}

/**
 * Whether the Flock may archive this Bot: true exactly when no run is active.
 * The storage handle is the archiving transaction's, not this object's, so the
 * answer is read inside the same write that acts on it.
 */
export async function archiveEligible(storage: {
  get<T>(key: string): Promise<T | undefined>;
}): Promise<boolean> {
  return (await storage.get<string>(ACTIVE_RUN_KEY)) === undefined;
}
