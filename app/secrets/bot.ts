// The Bot Durable Object's half of a secret request: the request it recorded
// when the card was drawn, and the save that answers it.
//
// A save is the person's own act on a host-drawn field. It is checked against
// the request this object recorded — the terms the person was shown — and the
// value is handed straight to the User Durable Object, which seals it. What
// this object keeps is that the request was answered, and with which secret;
// what it tells the Bot is the reference and the label, as durable input on
// its next Turn. The value is never written here, never folded into the card,
// never queued, and never part of an error.

import { commitPublicationsV1, type BotIdentity } from "@frockbot/core/durable";
import type {
  A2uiAgentMessageV1,
  A2uiComponentV1,
} from "@frockbot/core/contracts";
import { cardRevisionPublicationV1 } from "@frockbot/app/shell/conversation-publication";
import {
  CARD_SECRET_FIELD_COMPONENT_V1,
  cardKeyV1,
  decodeCardRecordV1,
  foldCardMessagesV1,
  projectCardV1,
  type CardViewV1,
} from "@frockbot/app/shell/cards";
import type { ShellBotStateV1 } from "@frockbot/app/shell/backend-state";
import { enqueuePendingBotInputV1 } from "@frockbot/app/routines/inbox-store";
import { openInputDeliveryTurnV1 } from "../shell/input-delivery.js";
import {
  decodeSecretRequestRecordV1,
  decodeSecretViewV1,
  SECRET_LIMITS_V1,
  SECRET_REQUEST_PREFIX_V1,
  SecretRequestNotFoundError,
  secretRequestKeyV1,
  type SecretRequestRecordV1,
  type SecretSubmitCommandV1,
  type SecretSubmitReceiptV1,
  type SecretViewV1,
} from "./shared.js";
import { decodeCredentialLeaseV1 } from "@frockbot/core/connection";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";

/** Where one Bot records the secret requests its cards carry. */
export interface SecretRequestStoreV1 {
  /**
   * Idempotent: the draw that recorded a request recomputes the same id on
   * a replay, and a request already answered is never set back to waiting.
   */
  record(request: SecretRequestRecordV1): Promise<void>;
  read(requestId: string): Promise<SecretRequestRecordV1 | undefined>;
}

export function createSecretRequestStoreV1(storage: {
  get<T>(key: string): Promise<T | undefined>;
  put(key: string, value: unknown): Promise<void>;
  delete(key: string): Promise<boolean>;
  list<T>(options: { prefix: string }): Promise<Map<string, T>>;
}): SecretRequestStoreV1 {
  return {
    async record(request) {
      const key = secretRequestKeyV1(request.requestId);
      if ((await storage.get<unknown>(key)) !== undefined) return;
      // Bounded by the oldest, the way approvals are: a request nobody
      // answered for a hundred requests is not one anybody will.
      const stored = await storage.list<unknown>({
        prefix: SECRET_REQUEST_PREFIX_V1,
      });
      const created = (value: unknown): string => {
        try {
          return decodeSecretRequestRecordV1(value).createdAt;
        } catch {
          return "";
        }
      };
      const oldest: { key: string; createdAt: string }[] = [];
      for (const [storedKey, value] of stored) {
        oldest.push({ key: storedKey, createdAt: created(value) });
      }
      oldest.sort((left, right) =>
        left.createdAt.localeCompare(right.createdAt),
      );
      const excess = oldest.length + 1 - SECRET_LIMITS_V1.requestsPerBot;
      for (const { key: storedKey } of oldest.slice(0, Math.max(0, excess))) {
        await storage.delete(storedKey);
      }
      await storage.put(key, request);
    },
    async read(requestId) {
      const stored = await storage.get<unknown>(secretRequestKeyV1(requestId));
      return stored === undefined
        ? undefined
        : decodeSecretRequestRecordV1(stored);
    },
  };
}

/** The User Durable Object's secret seams, as a Bot reaches them. */
export interface UserSecretsRpcV1 {
  store(input: {
    requestId: string;
    label: string;
    origin?: string;
    payment: boolean;
    value: string;
  }): Promise<SecretViewV1>;
  describe(secretId: string): Promise<SecretViewV1 | undefined>;
  lease(secretId: string, effectId: string): Promise<CredentialLeaseV1>;
  settle(secretId: string, effectId: string): Promise<void>;
}

export function userSecretsV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
): UserSecretsRpcV1 {
  const rpc = state.env.USER_CONFIGURATIONS.get(
    state.env.USER_CONFIGURATIONS.idFromName(identity.userId),
  );
  const envelope = { schemaVersion: 1 as const, userId: identity.userId };
  return {
    store: async (input) =>
      decodeSecretViewV1(
        await rpc.storeSecret({ ...envelope, botId: identity.botId, ...input }),
      ),
    describe: async (secretId) => {
      const answer = await rpc.describeSecret({ ...envelope, secretId });
      const found = (answer as { secret?: unknown }).secret;
      return found === undefined || found === null
        ? undefined
        : decodeSecretViewV1(found);
    },
    lease: async (secretId, effectId) =>
      decodeCredentialLeaseV1(
        await rpc.leaseSecret({ ...envelope, secretId, effectId }),
      ),
    settle: (secretId, effectId) =>
      rpc.settleSecret({ ...envelope, secretId, effectId }),
  };
}

/** The field's component, as the card says it now: saved. */
function savedFields(
  components: readonly A2uiComponentV1[],
  request: SecretRequestRecordV1,
): A2uiComponentV1[] {
  return components
    .filter(
      (component) =>
        component.component === CARD_SECRET_FIELD_COMPONENT_V1 &&
        request.fieldIds.includes(component.id),
    )
    .map((component) => ({ ...component, state: "saved" }));
}

async function readCardView(
  state: ShellBotStateV1,
  surfaceId: string,
): Promise<CardViewV1 | undefined> {
  const stored = await state.ctx.storage.get<unknown>(cardKeyV1(surfaceId));
  return stored === undefined
    ? undefined
    : projectCardV1(decodeCardRecordV1(stored));
}

/**
 * One value a person typed into a secret request's field.
 *
 * The request is the authority: a request this Bot never recorded is not
 * found, and one already answered reads back that answer and saves nothing,
 * whatever was typed this time. Otherwise the value is sealed by the User
 * Durable Object — once per request, so a retried post after an answer that
 * was lost reads back the secret it already made — and then, in one
 * transaction here, the request is marked answered, the card's field is
 * settled, and the Bot is owed the reference.
 */
export async function submitSecretV1(
  state: ShellBotStateV1,
  identity: BotIdentity,
  requestId: string,
  command: SecretSubmitCommandV1,
  vault: Pick<UserSecretsRpcV1, "store"> = userSecretsV1(state, identity),
): Promise<SecretSubmitReceiptV1> {
  await state.authority.validateIdentity(identity);
  const store = createSecretRequestStoreV1(state.ctx.storage);
  const request = await store.read(requestId);
  if (!request) throw new SecretRequestNotFoundError();
  if (request.state === "saved") {
    const card = await readCardView(state, request.surfaceId);
    return { schemaVersion: 1, status: "replayed", ...(card ? { card } : {}) };
  }
  const saved = await vault.store({
    requestId,
    label: request.label,
    ...(request.origin === undefined ? {} : { origin: request.origin }),
    payment: request.payment,
    value: command.value,
  });
  const savedAt = new Date().toISOString();
  const answered = await state.ctx.storage.transaction(async (transaction) => {
    const stored = await transaction.get<unknown>(
      secretRequestKeyV1(requestId),
    );
    if (stored === undefined) return false;
    const current = decodeSecretRequestRecordV1(stored);
    if (current.state === "saved") return false;
    await transaction.put(secretRequestKeyV1(requestId), {
      ...current,
      state: "saved",
      secretId: saved.secretId,
      savedAt,
    } satisfies SecretRequestRecordV1);
    // The field settles where the person typed into it. The card may be gone
    // — its Session's surfaces are bounded — and then there is nothing to
    // settle, which changes nothing about the save.
    const cardValue = await transaction.get<unknown>(
      cardKeyV1(current.surfaceId),
    );
    if (cardValue !== undefined) {
      const card = decodeCardRecordV1(cardValue);
      const fields = savedFields(card.components, current);
      if (!card.deleted && fields.length > 0) {
        const update: A2uiAgentMessageV1 = {
          version: "v1.0",
          updateComponents: { surfaceId: card.surfaceId, components: fields },
        };
        const folded = foldCardMessagesV1(card, [update], {
          surfaceId: card.surfaceId,
          runId: `secret-save:${requestId}`,
          sessionId: card.sessionId,
          now: savedAt,
        });
        await transaction.put(cardKeyV1(card.surfaceId), folded);
        await commitPublicationsV1(transaction, [
          cardRevisionPublicationV1({
            surfaceId: card.surfaceId,
            revision: folded.revision,
          }),
        ]);
        await state.authority.refreshRecoveryAlarm(transaction);
      }
    }
    await enqueuePendingBotInputV1(transaction, {
      schemaVersion: 1,
      kind: "secret-saved",
      requestId,
      secretId: saved.secretId,
      label: current.label,
      payment: saved.payment,
      ...(current.origin === undefined ? {} : { origin: current.origin }),
      createdAt: savedAt,
    });
    return true;
  });
  if (answered) {
    await state.authority.drainCommittedPublication();
    // The Bot asked and ended its Turn; the save is what it was waiting for.
    await openInputDeliveryTurnV1(state, identity, {
      inputId: `secret-saved:${requestId}`,
    });
  }
  const card = await readCardView(state, request.surfaceId);
  return {
    schemaVersion: 1,
    status: answered ? "saved" : "replayed",
    ...(card ? { card } : {}),
  };
}
