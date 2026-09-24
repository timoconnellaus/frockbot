// The Turn a pending input opens when it lands.
//
// Some inputs reach a Bot only through the pending-input queue — a person's
// answer to an approval, their press on a card, a command their Mac finished —
// and that queue is drained by the Bot's next conversational Turn. Nothing
// opened one, so the Bot said nothing until the person spoke again. This opens
// it: an ordinary `chat` Turn on the Bot's own conversation, where the queue
// is always drained, whose input is the drain and a cue saying nobody spoke.
// What makes it safe to open with nobody there is the delivery Turn's own
// handling (`isDeliveryOriginV1`): it ends without a model call when the queue
// is already empty, and gives back what it drained if it fails or is stopped.

import { sha256HexTextV1 } from "@frockbot/core/crypto";
import {
  botConversationBaseSessionIdV1,
  PENDING_AGENT_RUN_PREFIX,
  type BotIdentity,
} from "@frockbot/core/durable";
import {
  admitTurnCommandV1,
  syncCompositionFromUser,
} from "@frockbot/app/composition/bot";
import { INPUT_DELIVERY_CUE_V1 } from "@frockbot/app/routines/inbox";
import type { ShellBotStateV1 } from "./backend-state.js";
import { admitTurnToSessionLogV1 } from "./compaction-scheduler.js";

/**
 * The run id of the Turn one input opens. Derived from what makes the input
 * itself, so a retried delivery or a replayed press asks for the Turn it
 * already admitted rather than a second one.
 */
export async function inputDeliveryRunIdV1(key: string): Promise<string> {
  return `dl-${(await sha256HexTextV1(key)).slice(0, 32)}`;
}

/**
 * Open the Turn one pending input is owed, after the input is durable.
 *
 * On the `agent` lane, so it waits behind whatever is running instead of
 * making the Bot's own Turn yield the way a person's message does, and a
 * message the person sends meanwhile runs first — draining the input itself,
 * after which this Turn ends without a model call. The input is already
 * queued, so a Turn that cannot be admitted costs the immediate reply and
 * never the input.
 *
 * An input that lands while an input-delivery Turn is admitted but has not
 * started rides that Turn: it drains the whole queue when it starts, so a
 * second one behind it would find nothing. A card pressed over and over then
 * costs at most one Turn running and one waiting.
 */
export async function openInputDeliveryTurnV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  input: {
    /** The input's id in the queue (`pendingBotInputIdV1`). */
    inputId: string;
    /** What the run id is derived from. Defaults to `inputId`. */
    key?: string;
  },
): Promise<void> {
  try {
    if (await inputDeliveryWaiting(state)) return;
    const sessionId = botConversationBaseSessionIdV1(identity);
    await admitTurnToSessionLogV1(sessionId);
    // An approved Plugin joined the User's Composition a moment ago, and the
    // pin this Turn takes has to be that generation for the Plugin to run in
    // the Turn that says it is ready.
    await syncCompositionFromUser(state, identity);
    await admitTurnCommandV1(state, {
      userId: identity.userId,
      botId: identity.botId,
      runId: await inputDeliveryRunIdV1(input.key ?? input.inputId),
      sessionId,
      acceptedAt: new Date().toISOString(),
      text: INPUT_DELIVERY_CUE_V1,
      turnType: "chat",
      lane: "agent",
      origin: { kind: "input-delivery", inputId: input.inputId },
    });
  } catch {
    // Still queued: the Bot's next conversational Turn carries it.
  }
}

/** Whether an input-delivery Turn is admitted and waiting to start. */
async function inputDeliveryWaiting(state: ShellBotStateV1): Promise<boolean> {
  const waiting = await state.ctx.storage.list<string>({
    prefix: PENDING_AGENT_RUN_PREFIX,
  });
  for (const runId of waiting.values()) {
    const run = await state.authority.readRunHeader(runId);
    if (run?.admission?.origin?.kind === "input-delivery") return true;
  }
  return false;
}
