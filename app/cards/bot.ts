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
import { commitPublicationsV1, type BotIdentity } from "@frockbot/core/durable";
import { cardRevisionPublicationV1 } from "@frockbot/app/shell/conversation-publication";
import {
  a2uiByteLengthV1,
  A2UI_LIMITS_V1,
  cardSurfaceCardIdV1,
  cardSurfacePluginIdV1,
  decodeA2uiAgentMessageV1,
  type A2uiAgentMessageV1,
  type PluginWorkerCardActionInvocationV1,
  type PluginWorkerReviseCardResultV1,
} from "@frockbot/core/contracts";
import {
  ApprovalRevisionConflictError,
  decideApproval,
  type ApprovalRevisionV1,
} from "@frockbot/app/approvals/bot";
import {
  approvalKeyV1,
  decodeApprovalRecordV1,
} from "@frockbot/app/shell/approvals";
import { enqueuePendingBotInputV1 } from "@frockbot/app/routines/inbox-store";
import {
  CARD_ACTION_CONTEXT_MAX_V1,
  pendingBotInputIdV1,
  type PendingBotInputV1,
} from "@frockbot/app/routines/inbox";
import { openInputDeliveryTurnV1 } from "../shell/input-delivery.js";
import {
  readBotPluginRosterV1,
  withPluginWorkerV1,
  type BotPluginRosterV1,
} from "@frockbot/app/plugins/worker-bot";
import { notePluginFailureV1 } from "@frockbot/app/plugins/health-bot";
import { readPluginHealthV1 } from "@frockbot/app/plugins/health";
import { connectCardAppV1 } from "@frockbot/app/connect/card";
import {
  bindCardConnectAppsV1,
  cardActionRouteV1,
  cardApprovalBindingKeyV1,
  cardKeyV1,
  cardValuesDigestV1,
  decodeCardApprovalRecordV1,
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
  // A `ConnectApp` a handler draws is bound exactly as one a send draws, so
  // an update can no more rename the app than the first draw could.
  try {
    messages = bindCardConnectAppsV1(messages, connectCardAppV1);
  } catch (error) {
    if (!(error instanceof CardDecodeError)) throw error;
    return {
      card: await readCard(state, surfaceId),
      failure: cardFailureV1(error.message),
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
    await commitPublicationsV1(transaction, [
      cardRevisionPublicationV1({
        surfaceId,
        revision: folded.revision,
      }),
    ]);
    await state.authority.refreshRecoveryAlarm(transaction);
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
    // A Send pressed on fields the person changed is a decision about what
    // they changed, so the Plugin restates it before anything is recorded.
    // A decline sends nothing and needs no restating.
    const revised =
      decision === "approved"
        ? await reviseEditedCardV1(
            state,
            identity,
            command,
            card,
            route.approvalId,
          )
        : ({ status: "unedited" } as const);
    if (revised.status === "refused") {
      return {
        schemaVersion: 1,
        routed: "approval",
        card: projectCardV1(card),
        failure: revised.failure,
      };
    }
    // `decideApproval` refuses an id the kernel never recorded, which is what
    // stops a Card minting its own approval: the record is the authority and
    // the Card is only its face.
    let decided;
    try {
      decided = await decideApproval(
        state,
        identity,
        route.approvalId,
        { schemaVersion: 1, decision },
        revised.status === "revised" ? revised.revision : undefined,
      );
    } catch (error) {
      if (!(error instanceof ApprovalRevisionConflictError)) throw error;
      return {
        schemaVersion: 1,
        routed: "approval",
        card: projectCardV1(await readCard(state, command.surfaceId)),
        failure: cardFailureV1(
          "this card changed while it was being answered, so nothing was decided",
        ),
      };
    }
    if (revised.status === "revised" && decided.status === "replayed") {
      // Somebody answered first, about the values the card was drawn with.
      return {
        schemaVersion: 1,
        routed: "approval",
        card: projectCardV1(await readCard(state, command.surfaceId)),
        failure: cardFailureV1(
          "this was already decided, so your changes were not applied",
        ),
      };
    }
    if (revised.status === "revised" && revised.messages !== undefined) {
      // The face follows the decision rather than deciding it: a fold the
      // Card refuses leaves the old face over a decision that stands, and is
      // charged to the Plugin that answered it.
      const folded = await foldHandlerMessages(
        state,
        command.surfaceId,
        revised.runId,
        revised.messages,
      );
      if (folded.failure === undefined) {
        await state.authority.drainCommittedPublication();
      } else {
        await chargeCardFailureV1(state, card, revised, folded.failure);
      }
    }
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
    const runId = cardPressRunIdV1(command.surfaceId, card);
    const chargeFailure = (reason: string): Promise<void> =>
      chargeCardFailureV1(
        state,
        card,
        { runId, pluginId: route.pluginId },
        reason,
      );
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
      const refusal = await pluginCardRefusalV1(state, roster, {
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
    if (folded.failure === undefined) {
      await state.authority.drainCommittedPublication();
    }
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
  const pressed = {
    schemaVersion: 1,
    kind: "card-action",
    // The client's own id makes a retried post the same press; without one
    // every post is a press of its own.
    pressId: command.commandId ?? crypto.randomUUID(),
    surfaceId: command.surfaceId,
    name: command.event.name,
    ...(context === undefined ? {} : { context }),
    createdAt,
  } satisfies PendingBotInputV1;
  await state.ctx.storage.transaction((transaction) =>
    enqueuePendingBotInputV1(transaction, pressed),
  );
  // Nothing else answers this press — no handler redrew the card — so it
  // opens the Turn that does, rather than waiting for the person to speak. A
  // press repeated while that Turn has not started rides it: the Turn drains
  // the whole queue, so the person changing their answer costs no second one.
  // A handler's `input` above opens nothing: that press was answered on the
  // card and "costs no Turn", and a control pressed over and over must not
  // spend one per press.
  await openInputDeliveryTurnV1(state, identity, {
    inputId: pendingBotInputIdV1(pressed),
  });
  return {
    schemaVersion: 1,
    routed: "input",
    card: projectCardV1(card),
  };
}

/** The run a press on a Plugin's card is attributed to. A press, not a Turn. */
function cardPressRunIdV1(surfaceId: string, card: CardRecordV1): string {
  return `card-action:${surfaceId}:${card.revision}`;
}

/**
 * A handler that threw, overran or answered with something the Card cannot
 * take is charged to its Plugin, the way a hook failure is (ADR 0030): three
 * in a row and the Plugin is off for this Bot. The verdict is not acted on
 * here — a press is not a Turn, and there is nothing to fail — but the count
 * and the notice are the same ones.
 */
async function chargeCardFailureV1(
  state: ShellBotStateV1,
  card: CardRecordV1,
  press: { runId: string; pluginId: string },
  reason: string,
): Promise<void> {
  try {
    await notePluginFailureV1(
      state,
      { runId: press.runId, generationId: card.runId },
      {
        pluginId: press.pluginId,
        phase: "hook",
        message: reason,
        // A press is not a Turn, and the notice the person reads must not
        // tell them one was lost.
        kind: "press",
      },
    );
  } catch {
    // Recording a failure must not be what fails the press.
  }
}

/** What approving one card comes to, once any edit on it has been restated. */
type CardRevisionOutcomeV1 =
  | { status: "unedited" }
  | { status: "refused"; failure: string }
  | {
      status: "revised";
      revision: ApprovalRevisionV1;
      messages?: Record<string, unknown>[];
      runId: string;
      pluginId: string;
    };

/**
 * What a Send pressed on an edited card is a decision about (ADR 0030,
 * amended 2026-09-24).
 *
 * A Plugin's card whose surface asks for its data model can carry fields the
 * person edits — a draft's recipients, subject and body. Its decision is
 * bound to the digest of the values it was drawn with, so a Send over changed
 * fields is put back to the Plugin, which alone knows what its fields mean,
 * and it answers with what the decision now covers. The kernel moves the
 * binding to the digest of *that* in the transaction that records the
 * decision, so the capability that later acts on it is held to what the
 * person actually sent rather than to the draft they changed.
 *
 * Nothing is asked of the Plugin when nothing changed, or when there is
 * nothing to move: a decision already given, or one this surface's binding
 * does not hold. An edit the Plugin refuses, or cannot be asked about at all,
 * decides nothing — the person is told why, and the draft they changed is
 * never sent in place of the one they wrote.
 */
async function reviseEditedCardV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  command: CardActionCommandV1,
  card: CardRecordV1,
  approvalId: string,
): Promise<CardRevisionOutcomeV1> {
  const unedited = { status: "unedited" } as const;
  const pluginId = cardSurfacePluginIdV1(command.surfaceId);
  const cardId = cardSurfaceCardIdV1(command.surfaceId);
  if (
    pluginId === undefined ||
    cardId === undefined ||
    card.sendDataModel !== true ||
    command.dataModel === undefined
  ) {
    return unedited;
  }
  // Compared the way the binding's own digest is taken, so a field the
  // renderer wrote back exactly as it was drawn is no edit.
  if (
    (await cardValuesDigestV1(command.dataModel)) ===
    (await cardValuesDigestV1(card.dataModel))
  ) {
    return unedited;
  }
  const stored = await state.ctx.storage.get<unknown>(
    approvalKeyV1(approvalId),
  );
  if (
    stored === undefined ||
    decodeApprovalRecordV1(stored).decision !== "pending"
  ) {
    return unedited;
  }
  const binding = decodeCardApprovalRecordV1(
    await state.ctx.storage.get<unknown>(
      cardApprovalBindingKeyV1(pluginId, command.surfaceId),
    ),
  );
  if (!binding?.approvalIds.includes(approvalId)) return unedited;
  const runId = cardPressRunIdV1(command.surfaceId, card);
  const refuse = (reason: string) => ({
    status: "refused" as const,
    failure: cardFailureV1(
      `your changes could not be applied, so nothing was decided: ${reason}`,
    ),
  });
  let outcome:
    PluginWorkerReviseCardResultV1 | { status: "unavailable"; reason: string };
  try {
    const roster = await readBotPluginRosterV1(state, identity);
    const refusal = await pluginCardRefusalV1(state, roster, {
      pluginId,
      cardId,
    });
    if (refusal !== undefined) return refuse(refusal);
    outcome = await withPluginWorkerV1(
      state,
      identity,
      roster,
      { runId, deadlineMs: CARD_ACTION_DEADLINE_MS },
      (worker) =>
        worker.active.reviseCard({
          schemaVersion: 1,
          pluginId,
          cardId,
          surfaceId: command.surfaceId,
          dataModel: command.dataModel!,
          record: card.dataModel,
          botId: identity.botId,
          sessionId: `${identity.userId}:${identity.botId}`,
          runId,
          turnId: runId,
          generationId: roster.generationId,
          deadlineMs: CARD_ACTION_DEADLINE_MS,
        }),
    );
  } catch (error) {
    outcome = {
      status: "unavailable",
      reason:
        error instanceof Error ? error.message : "the plugin was unavailable",
    };
  }
  if (outcome.status === "unchanged") return unedited;
  if (outcome.status !== "revised") {
    const reason = outcome.reason ?? "the plugin could not restate the card";
    // A Plugin refusing the edit in as many words is not a Plugin that broke.
    if (!(outcome.status === "drop" && outcome.deliberate === true)) {
      await chargeCardFailureV1(state, card, { runId, pluginId }, reason);
    }
    return refuse(reason);
  }
  return {
    status: "revised",
    revision: {
      pluginId,
      surfaceId: command.surfaceId,
      from: binding.digest,
      digest: await cardValuesDigestV1(outcome.covers),
      wording: outcome.decision,
    },
    ...(outcome.messages === undefined ? {} : { messages: outcome.messages }),
    runId,
    pluginId,
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
 * whose descriptor declares no such card or action. None is the Plugin
 * failing — it never ran — so none is charged to it. With no `action`, the
 * question is about the card: an edit put back to the Plugin that drew it.
 */
async function pluginCardRefusalV1(
  state: ShellBotStateV1,
  roster: BotPluginRosterV1,
  handler: { pluginId: string; cardId: string; action?: string },
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
  const card = (member.descriptor.cards ?? []).find(
    (candidate) => candidate.id === handler.cardId,
  );
  if (handler.action === undefined) {
    return card === undefined
      ? `plugin "${handler.pluginId}" no longer declares card "${handler.cardId}"`
      : undefined;
  }
  const action = handler.action;
  return card?.actions.some((candidate) => candidate.name === action)
    ? undefined
    : `plugin "${handler.pluginId}" card "${handler.cardId}" declares no action "${action}"`;
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
