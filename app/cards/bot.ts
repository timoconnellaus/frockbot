// Reading a Card and answering one, inside the Bot Durable Object.
//
// `app/shell/cards.ts` is the record, the fold and the projection — read by
// the client too. This is the half that writes: the action a person took on a
// surface, and the one of three things the kernel does with it.
//
// The routing is the whole point (ADR 0030). A Card is untrusted content
// whoever wrote it, so what an action *means* is never the Card's to decide:
// `approval/<approvalId>` is recorded exactly as an Approval is and cannot
// name a decision the kernel never issued, `plugin/<pluginId>/<action>` runs
// the Plugin's own handler with the Bot's authority, and everything else is
// conversation input the Bot's next Turn reads — never a sentence the User is
// made to have said.
import type { BotIdentity } from "@frockbot/core/durable";
import {
  decodeA2uiAgentMessageV1,
  type A2uiAgentMessageV1,
} from "@frockbot/core/contracts";
import { decideApproval } from "@frockbot/app/approvals/bot";
import { enqueuePendingBotInputV1 } from "@frockbot/app/routines/inbox-store";
import { CARD_ACTION_CONTEXT_MAX_V1 } from "@frockbot/app/routines/inbox";
import {
  readBotPluginRosterV1,
  withPluginWorkerV1,
} from "@frockbot/app/plugins/worker-bot";
import {
  cardActionRouteV1,
  cardKeyV1,
  CardBudgetError,
  CardDecodeError,
  decodeCardRecordV1,
  foldCardMessagesV1,
  projectCardV1,
  CARD_PREFIX,
  type CardActionCommandV1,
  type CardActionReceiptV1,
  type CardListViewV1,
  type CardRecordV1,
} from "@frockbot/app/shell/cards";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";

/** How long one Plugin card handler may run. A press, not a job. */
export const CARD_ACTION_DEADLINE_MS = 10_000;

/** A surface this Bot never drew, or one the Session no longer holds. */
export class CardNotFoundError extends Error {
  constructor(surfaceId: string) {
    super(`card "${surfaceId}" was not found`);
    this.name = "CardNotFoundError";
  }
}

/** Raised when the client answered a revision the surface has moved past. */
export class CardStaleError extends Error {
  constructor(surfaceId: string) {
    super(`card "${surfaceId}" has moved on`);
    this.name = "CardStaleError";
  }
}

/**
 * The Bot's Cards, newest first. Every Card a Session drew is carried,
 * tombstoned ones included, because the send that drew one is still in the
 * transcript and the transcript still has to say something where it sits.
 */
export async function listCards(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<CardListViewV1> {
  await state.authority.validateIdentity(identity);
  const stored = await state.ctx.storage.list<unknown>({ prefix: CARD_PREFIX });
  const cards = [...stored.values()]
    .map((value) => decodeCardRecordV1(value))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  return {
    schemaVersion: 1,
    botId: identity.botId,
    cards: cards.map((card) => projectCardV1(card)),
  };
}

async function readCard(
  state: ShellBotStateV1,
  surfaceId: string,
): Promise<CardRecordV1> {
  const stored = await state.ctx.storage.get<unknown>(cardKeyV1(surfaceId));
  if (stored === undefined) {
    throw new CardNotFoundError(surfaceId);
  }
  return decodeCardRecordV1(stored);
}

/**
 * Fold the messages a Plugin handler answered with onto the Card, in one
 * transaction, and only if the surface has not moved in the meantime. The
 * handler's answer is decoded as A2UI here rather than in the worker host,
 * because this is where the Card's own budgets are.
 */
async function foldHandlerMessages(
  state: ShellBotStateV1,
  surfaceId: string,
  runId: string,
  raw: readonly Record<string, unknown>[],
): Promise<{ card: CardRecordV1; failure?: string }> {
  let messages: A2uiAgentMessageV1[];
  try {
    messages = raw.map((message, index) =>
      decodeA2uiAgentMessageV1(message, `card action message[${index}]`),
    );
  } catch (error) {
    return {
      card: await readCard(state, surfaceId),
      failure:
        error instanceof Error
          ? error.message
          : "the handler's messages were refused",
    };
  }
  const key = cardKeyV1(surfaceId);
  return state.ctx.storage.transaction(async (transaction) => {
    const stored = await transaction.get<unknown>(key);
    if (stored === undefined) {
      throw new CardNotFoundError(surfaceId);
    }
    const current = decodeCardRecordV1(stored);
    let folded: CardRecordV1;
    try {
      folded = foldCardMessagesV1(current, messages, {
        surfaceId,
        runId,
        sessionId: current.sessionId,
        now: new Date().toISOString(),
      });
    } catch (error) {
      if (!(error instanceof CardBudgetError)) throw error;
      return { card: current, failure: error.message };
    }
    await transaction.put(key, folded);
    return { card: folded };
  });
}

/**
 * One action on one Card, from a person.
 *
 * The revision is checked before anything is done with the action, so a press
 * on a card that has already been redrawn underneath the person is refused
 * rather than applied to a surface they were not looking at.
 */
export async function cardAction(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: CardActionCommandV1,
): Promise<CardActionReceiptV1> {
  await state.authority.validateIdentity(identity);
  const card = await readCard(state, command.surfaceId);
  if (card.deleted) {
    throw new CardNotFoundError(command.surfaceId);
  }
  if (card.revision !== command.revision) {
    throw new CardStaleError(command.surfaceId);
  }
  const route = cardActionRouteV1(command.event.name);
  if (route.kind === "approval") {
    const decision = command.event.context?.decision;
    if (decision !== "approved" && decision !== "denied") {
      throw new CardDecodeError(
        "an approval action must carry a decision of approved or denied",
      );
    }
    // `decideApproval` refuses an id the kernel never recorded, which is what
    // stops a Card minting its own approval: the record is the authority and
    // the Card is only its face.
    await decideApproval(state, identity, route.approvalId, {
      schemaVersion: 1,
      decision,
    });
    return {
      schemaVersion: 1,
      routed: "approval",
      card: projectCardV1(await readCard(state, command.surfaceId)),
    };
  }
  if (route.kind === "plugin") {
    const runId = `card-action:${command.surfaceId}:${card.revision}`;
    // A Plugin that cannot be reached at all is the same answer as one whose
    // handler threw: the Card is left exactly as it was and the person is
    // told why. A press on a card must not be able to fail a read of it.
    let outcome: Awaited<ReturnType<typeof runPluginCardAction>>;
    try {
      outcome = await runPluginCardAction(state, identity, command, {
        pluginId: route.pluginId,
        action: route.action,
        runId,
      });
    } catch (error) {
      return {
        schemaVersion: 1,
        routed: "plugin",
        card: projectCardV1(card),
        failure:
          error instanceof Error ? error.message : "the plugin was unavailable",
      };
    }
    if (outcome.status !== "rendered") {
      return {
        schemaVersion: 1,
        routed: "plugin",
        card: projectCardV1(card),
        failure: outcome.reason ?? "the plugin handler changed nothing",
      };
    }
    const folded = await foldHandlerMessages(
      state,
      command.surfaceId,
      runId,
      outcome.messages,
    );
    return {
      schemaVersion: 1,
      routed: "plugin",
      card: projectCardV1(folded.card),
      ...(folded.failure === undefined ? {} : { failure: folded.failure }),
    };
  }
  // Conversation input. Queued in its own transaction, so a disconnect after
  // the press cannot lose it and a Turn already running still reads it next.
  const createdAt = new Date().toISOString();
  const context =
    command.event.context === undefined
      ? undefined
      : JSON.stringify(command.event.context).slice(
          0,
          CARD_ACTION_CONTEXT_MAX_V1,
        );
  await state.ctx.storage.transaction(async (transaction) => {
    await enqueuePendingBotInputV1(transaction, {
      schemaVersion: 1,
      kind: "card-action",
      surfaceId: command.surfaceId,
      name: command.event.name,
      ...(context === undefined ? {} : { context }),
      createdAt,
    });
  });
  return {
    schemaVersion: 1,
    routed: "input",
    card: projectCardV1(card),
  };
}

/** The Plugin handler behind one `plugin/<pluginId>/<action>` name. */
function runPluginCardAction(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: CardActionCommandV1,
  handler: { pluginId: string; action: string; runId: string },
) {
  return readBotPluginRosterV1(state, identity).then((roster) =>
    withPluginWorkerV1(
      state,
      identity,
      roster,
      { runId: handler.runId, deadlineMs: CARD_ACTION_DEADLINE_MS },
      (worker) =>
        worker.active.cardAction({
          schemaVersion: 1,
          pluginId: handler.pluginId,
          surfaceId: command.surfaceId,
          action: handler.action,
          ...(command.event.context === undefined
            ? {}
            : { context: command.event.context }),
          ...(command.dataModel === undefined
            ? {}
            : { dataModel: command.dataModel }),
          botId: identity.botId,
          sessionId: `${identity.userId}:${identity.botId}`,
          runId: handler.runId,
          turnId: handler.runId,
          generationId: roster.generationId,
          deadlineMs: CARD_ACTION_DEADLINE_MS,
        }),
    ),
  );
}
