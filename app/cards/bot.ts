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
  a2uiByteLengthV1,
  A2UI_LIMITS_V1,
  cardSurfaceCardIdV1,
  cardSurfacePluginIdV1,
  decodeA2uiAgentMessageV1,
  type A2uiAgentMessageV1,
  type PluginWorkerCardActionInvocationV1,
} from "@frockbot/core/contracts";
import { decideApproval } from "@frockbot/app/approvals/bot";
import { enqueuePendingBotInputV1 } from "@frockbot/app/routines/inbox-store";
import { CARD_ACTION_CONTEXT_MAX_V1 } from "@frockbot/app/routines/inbox";
import {
  readBotPluginRosterV1,
  withPluginWorkerV1,
  type BotPluginRosterV1,
} from "@frockbot/app/plugins/worker-bot";
import { notePluginFailureV1 } from "@frockbot/app/plugins/health-bot";
import { readPluginHealthV1 } from "@frockbot/app/plugins/health";
import {
  cardActionRouteV1,
  cardKeyV1,
  CARD_APPROVAL_COMPONENT_V1,
  decodeCardIndexV1,
  CardBudgetError,
  CardDecodeError,
  decodeCardRecordV1,
  foldCardMessagesV1,
  projectCardV1,
  CARD_INDEX_KEY,
  CARD_PREFIX,
  CARD_REFUSAL_MAX_V1,
  type CardActionCommandV1,
  type CardActionReceiptV1,
  type CardListViewV1,
  type CardRecordV1,
  type CardViewV1,
} from "@frockbot/app/shell/cards";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";

/** How long one Plugin card handler may run. A press, not a job. */
export const CARD_ACTION_DEADLINE_MS = 10_000;

/**
 * A surface no record was ever written for, or one the listing's retention has
 * since dropped.
 */
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
 * Why a press could not be answered, bounded at both ends to what the receipt
 * carries. A plugin that failed to mount can say so at any length, and one
 * that threw nothing at all says nothing; neither may come back as a refused
 * receipt, so the words are cut to fit and a sentence stands in for silence.
 */
function cardFailureV1(reason: string): string {
  const said = reason.trim().slice(0, CARD_REFUSAL_MAX_V1);
  return said === "" ? "the plugin handler stopped without saying why" : said;
}

/**
 * The Bot's Cards, newest first. Every Card a Session drew is carried,
 * tombstoned ones included, because the send that drew one is still in the
 * transcript and the transcript still has to say something where it sits.
 *
 * The listing is the newest Cards that fit: the walk stops before
 * `cardListBytes` is exceeded and says `truncated` when it did, so what falls
 * off the end is the stalest card rather than an arbitrary one, and a client
 * is never quietly told it has them all. A card the listing left out is read
 * by its id with `readCard`, so every surface a Session holds stays readable
 * whatever the budget cut.
 *
 * This is also where the Session's card records are bounded, by the one bound
 * the Session has. The index caps the live surfaces; once the records the
 * index no longer lists outnumber `surfacesPerSession` too, the stalest of
 * them are deleted here, on read, because the transaction that settles a Turn
 * cannot list. A surface the index still lists is never dropped.
 */
export async function listCards(
  state: ShellBotStateV1,
  identity: BotIdentity,
): Promise<CardListViewV1> {
  await state.authority.validateIdentity(identity);
  const stored = await state.ctx.storage.list<unknown>({ prefix: CARD_PREFIX });
  let records = [...stored.values()].map((value) => decodeCardRecordV1(value));
  // Retention is enforced on read rather than in the settling transaction,
  // which cannot list. Only tombstones the index no longer lists are dropped,
  // and trimming loses a row and never a fact: the send that drew the card is
  // still on the durable log of the Turn that made it.
  const indexed = await state.ctx.storage.get<unknown>(CARD_INDEX_KEY);
  const live = new Set(
    indexed === undefined ? [] : decodeCardIndexV1(indexed).surfaces,
  );
  const unlisted = records
    .filter((card) => !live.has(card.surfaceId))
    .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));
  const trimmable = new Set(
    unlisted
      .slice(
        0,
        Math.max(0, unlisted.length - A2UI_LIMITS_V1.surfacesPerSession),
      )
      .map((card) => cardKeyV1(card.surfaceId)),
  );
  for (const key of trimmable) await state.ctx.storage.delete(key);
  records = records
    .filter((card) => !trimmable.has(cardKeyV1(card.surfaceId)))
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  const cards: CardViewV1[] = [];
  let bytes = 0;
  let truncated = false;
  for (const record of records) {
    const card = projectCardV1(record);
    bytes += a2uiByteLengthV1(card);
    if (bytes > A2UI_LIMITS_V1.cardListBytes) {
      truncated = true;
      break;
    }
    cards.push(card);
  }
  return {
    schemaVersion: 1,
    botId: identity.botId,
    cards,
    ...(truncated ? { truncated: true as const } : {}),
  };
}

/**
 * One Card by its surface id, for a client reading a surface the listing's
 * byte budget left out. A surface this Bot never drew is not found; a
 * tombstoned one is carried, exactly as the listing carries it, because the
 * send that drew it is still in the transcript.
 */
export async function readCardView(
  state: ShellBotStateV1,
  identity: BotIdentity,
  surfaceId: string,
): Promise<CardViewV1> {
  await state.authority.validateIdentity(identity);
  return projectCardV1(await readCard(state, surfaceId));
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

/** Whether one handler message carries trust chrome the press may not mint. */
function messageAsksForDecisionV1(message: A2uiAgentMessageV1): boolean {
  const components =
    "createSurface" in message
      ? message.createSurface.components
      : "updateComponents" in message
        ? message.updateComponents.components
        : undefined;
  return (components ?? []).some(
    (component) => component.component === CARD_APPROVAL_COMPONENT_V1,
  );
}

/**
 * Fold the messages a Plugin handler answered with onto the Card, in one
 * transaction, onto the record as it stands when the answer comes back. The
 * revision the person pressed at is checked before the handler runs, and a
 * handler's answer updates a surface rather than replacing one, so a Turn that
 * moved the surface during the call does not invalidate it. The answer is
 * decoded as A2UI here rather than in the worker host, because this is where
 * the Card's own budgets are.
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
      failure: cardFailureV1(
        error instanceof Error
          ? error.message
          : "the handler's messages were refused",
      ),
    };
  }
  // A press runs outside a Turn, so there is nothing here that could record
  // an Approval: `bindCardApprovalsV1` mints ids on the send path alone. A
  // handler that returned trust chrome would therefore put a Plugin-chosen
  // `approvalId` onto durable Card state, pointing a decision at an id the
  // kernel never issued or — worse — at another card's live Approval. The
  // Card is left exactly as it was and the refusal is the receipt's failure.
  if (messages.some(messageAsksForDecisionV1)) {
    return {
      card: await readCard(state, surfaceId),
      failure: cardFailureV1("a card action may not ask for a decision"),
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
      return { card: current, failure: cardFailureV1(error.message) };
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
    // The mirror of the draw's own check (`plugin-worker-host.ts`): a card
    // record carries no owner, so the surface id's minted prefix is what says
    // whose card this is. Without it a card drawn by one Plugin — or by the
    // Bot itself — could hand another Plugin that surface, its context and
    // its whole data model, and fold whatever came back onto it.
    const cardId = cardSurfaceCardIdV1(command.surfaceId);
    if (
      cardSurfacePluginIdV1(command.surfaceId) !== route.pluginId ||
      cardId === undefined
    ) {
      return {
        schemaVersion: 1,
        routed: "plugin",
        card: projectCardV1(card),
        failure: cardFailureV1(
          `card "${command.surfaceId}" is not a surface plugin "${route.pluginId}" drew`,
        ),
      };
    }
    const runId = `card-action:${command.surfaceId}:${card.revision}`;
    /**
     * A handler that threw, overran or answered with something the Card
     * cannot take is charged to its Plugin, the way a hook failure is (ADR
     * 0030): three in a row and the Plugin is off for this Bot. The verdict
     * is not acted on here — a press is not a Turn, and there is nothing to
     * fail — but the count and the notice are the same ones.
     */
    const chargeFailure = async (reason: string): Promise<void> => {
      try {
        await notePluginFailureV1(
          state,
          { runId, generationId: card.runId },
          {
            pluginId: route.pluginId,
            phase: "hook",
            message: reason,
            // A press is not a Turn, and the notice the person reads must
            // not tell them one was lost.
            card: "press",
          },
        );
      } catch {
        // Recording a failure must not be what fails the press.
      }
    };
    // A Plugin that cannot be reached at all is the same answer as one whose
    // handler threw: the Card is left exactly as it was and the person is
    // told why. A press on a card must not be able to fail a read of it.
    let outcome: Awaited<ReturnType<typeof runPluginCardAction>>;
    try {
      const roster = await readBotPluginRosterV1(state, identity);
      // A press the kernel will not put to the Plugin is refused here, off
      // the roster and the descriptor, rather than by the worker's own
      // refusal a round trip later — a card drawn before the Plugin stopped
      // declaring an action, or before it was turned off, still carries its
      // button, and pressing it must not count against a Plugin that never
      // ran. The worker still refuses it too.
      const refusal = await pluginCardActionRefusalV1(state, roster, {
        pluginId: route.pluginId,
        cardId,
        action: route.action,
      });
      if (refusal !== undefined) {
        return {
          schemaVersion: 1,
          routed: "plugin",
          card: projectCardV1(card),
          failure: cardFailureV1(refusal),
        };
      }
      outcome = await runPluginCardAction(
        state,
        identity,
        command,
        card,
        roster,
        {
          pluginId: route.pluginId,
          cardId,
          action: route.action,
          runId,
        },
      );
    } catch (error) {
      const failure = cardFailureV1(
        error instanceof Error ? error.message : "the plugin was unavailable",
      );
      await chargeFailure(failure);
      return {
        schemaVersion: 1,
        routed: "plugin",
        card: projectCardV1(card),
        failure,
      };
    }
    if (outcome.status !== "rendered") {
      const failure = cardFailureV1(
        outcome.reason ?? "the plugin handler changed nothing",
      );
      // A handler that refused in as many words is not a handler that broke.
      // Only a throw, an overrun, an unreachable worker, an answer the
      // kernel could not read, or a fold the Card's budgets refused counts
      // toward quarantine (ADR 0030).
      const deliberate =
        outcome.status === "drop" && outcome.deliberate === true;
      if (!deliberate) await chargeFailure(failure);
      return {
        schemaVersion: 1,
        routed: "plugin",
        card: projectCardV1(card),
        failure,
      };
    }
    const folded = await foldHandlerMessages(
      state,
      command.surfaceId,
      runId,
      outcome.messages,
    );
    // The one thing a handler may say to the Bot rather than to the card.
    // Queued only when the fold landed: a Card the person is not looking at
    // must not put words in front of the Bot about a change nobody saw.
    if (outcome.input !== undefined && folded.failure === undefined) {
      await state.ctx.storage.transaction(async (transaction) => {
        await enqueuePendingBotInputV1(transaction, {
          schemaVersion: 1,
          kind: "card-action",
          pressId: command.commandId ?? crypto.randomUUID(),
          surfaceId: command.surfaceId,
          name: command.event.name,
          context: outcome.input!,
          createdAt: new Date().toISOString(),
        });
      });
    }
    // A fold the Card's own budgets refused is the handler's doing too.
    if (folded.failure !== undefined) await chargeFailure(folded.failure);
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
      : JSON.stringify(command.event.context);
  if (context !== undefined && context.length > CARD_ACTION_CONTEXT_MAX_V1) {
    // The preamble puts this in the Bot's prompt verbatim, so a cut one is a
    // fragment of JSON the Bot would read as the whole answer. The press is
    // refused and the person is told, rather than half of it being acted on.
    throw new CardDecodeError(
      `a card action context is at most ${CARD_ACTION_CONTEXT_MAX_V1} characters once serialized`,
    );
  }
  await state.ctx.storage.transaction(async (transaction) => {
    await enqueuePendingBotInputV1(transaction, {
      schemaVersion: 1,
      kind: "card-action",
      // The client's own id makes a retried post the same press; without one
      // every post is a press of its own.
      pressId: command.commandId ?? crypto.randomUUID(),
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

/**
 * The invocation one press builds for the Plugin handler behind it.
 *
 * The data model travels only when the surface was created asking for it: a
 * client may post one regardless, and a surface that did not ask is not made
 * to answer about a model the kernel never compared against its own.
 */
export function cardActionInvocationV1(
  identity: BotIdentity,
  command: CardActionCommandV1,
  card: CardRecordV1,
  handler: {
    pluginId: string;
    cardId: string;
    action: string;
    runId: string;
    generationId: string;
  },
): PluginWorkerCardActionInvocationV1 {
  const dataModel = card.sendDataModel === true ? command.dataModel : undefined;
  return {
    schemaVersion: 1,
    pluginId: handler.pluginId,
    cardId: handler.cardId,
    surfaceId: command.surfaceId,
    action: handler.action,
    ...(command.event.context === undefined
      ? {}
      : { context: command.event.context }),
    ...(dataModel === undefined ? {} : { dataModel }),
    record: card.dataModel,
    botId: identity.botId,
    sessionId: `${identity.userId}:${identity.botId}`,
    runId: handler.runId,
    turnId: handler.runId,
    generationId: handler.generationId,
    deadlineMs: CARD_ACTION_DEADLINE_MS,
  };
}

/**
 * Why the kernel will not put this press to the Plugin, or `undefined` when
 * it will. Three different things are said apart, the way an admission
 * refusal and a missing capability are: a Plugin the Composition no longer
 * carries, a member this Bot has switched off, and a member that is on but
 * whose descriptor declares no such action. None is the Plugin failing — it
 * never ran — so none is charged to it.
 */
async function pluginCardActionRefusalV1(
  state: ShellBotStateV1,
  roster: BotPluginRosterV1,
  handler: { pluginId: string; cardId: string; action: string },
): Promise<string | undefined> {
  const member = roster.members.find(
    (candidate) => candidate.packageId === handler.pluginId,
  );
  // A Plugin the Composition no longer carries has no switch to throw, so it
  // must not be described as one a person could turn back on.
  if (member === undefined) {
    return `this Bot no longer runs plugin "${handler.pluginId}", so this card's controls do nothing`;
  }
  if (!roster.enabled.includes(handler.pluginId)) {
    // The switch reads the same whoever threw it, so the health record is
    // what says whether the person turned this Plugin off or a quarantine
    // did, and the person is never told they did something they did not.
    const health = await readPluginHealthV1(
      state.ctx.storage,
      handler.pluginId,
    );
    return health?.quarantinedAt !== undefined
      ? `plugin "${handler.pluginId}" was turned off for this Bot after it failed repeatedly, so this card's controls do nothing until it is turned on again under Plugins`
      : `plugin "${handler.pluginId}" is switched off for this Bot, so this card's controls do nothing until it is turned back on under Plugins`;
  }
  const declared = (member.descriptor.cards ?? []).some(
    (card) =>
      card.id === handler.cardId &&
      card.actions.some((action) => action.name === handler.action),
  );
  return declared
    ? undefined
    : `plugin "${handler.pluginId}" card "${handler.cardId}" declares no action "${handler.action}"`;
}

/** The Plugin handler behind one `plugin/<pluginId>/<action>` name. */
function runPluginCardAction(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: CardActionCommandV1,
  card: CardRecordV1,
  roster: BotPluginRosterV1,
  handler: { pluginId: string; cardId: string; action: string; runId: string },
) {
  return withPluginWorkerV1(
    state,
    identity,
    roster,
    { runId: handler.runId, deadlineMs: CARD_ACTION_DEADLINE_MS },
    (worker) =>
      worker.active.cardAction(
        cardActionInvocationV1(identity, command, card, {
          ...handler,
          generationId: roster.generationId,
        }),
      ),
  );
}
