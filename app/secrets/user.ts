// The User's saved secrets, inside the User Durable Object.
//
// A secret's value is a credential generation like any Connection's: sealed
// with the deployment keyring under the account, the secret's id and the
// `secrets` Package, activated, and leased for one effect at a time. What this
// module adds beside it is the record a person and a Bot may read — the label
// it was asked for by, the site it is for, whether it is a payment detail and
// which Bot asked — and the one-save-per-request rule. The value itself is
// never stored anywhere but the sealed envelope, and never returned.

import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import type {
  CredentialStorage,
  CredentialUserBackendContribution,
} from "@frockbot/app/credentials/user";
import {
  decodeSecretItemV1,
  looksLikePaymentCardV1,
  mintSecretGenerationV1,
  mintSecretIdV1,
  SECRET_LEASE_MS_V1,
  SECRET_LIMITS_V1,
  SECRETS_PACKAGE_ID_V1,
  SecretLimitError,
  SecretNotFoundError,
  secretViewV1,
  type SecretItemV1,
  type SecretListViewV1,
  type SecretViewV1,
} from "./shared.js";

const ITEM_PREFIX = "secret:item:";
const REQUEST_PREFIX = "secret:request:";

function itemKey(secretId: string): string {
  return `${ITEM_PREFIX}${secretId}`;
}

/** Which secret one Bot's request was answered with. */
function requestKey(botId: string, requestId: string): string {
  return `${REQUEST_PREFIX}${botId}:${requestId}`;
}

export interface SecretVaultHostV1 {
  storage: CredentialStorage & {
    list<T>(options: { prefix: string }): Promise<Map<string, T>>;
  };
  credentials: CredentialUserBackendContribution;
  now?: () => number;
}

export interface SecretStoreInputV1 {
  accountId: string;
  botId: string;
  requestId: string;
  label: string;
  origin?: string;
  payment: boolean;
  value: string;
}

export interface SecretVaultV1 {
  /**
   * Seals one value under a new secret, once per request: a retried save of
   * a request already answered reads back the secret it made.
   */
  store(
    input: SecretStoreInputV1,
  ): Promise<SecretViewV1 & { status: "saved" | "replayed" }>;
  list(): Promise<SecretListViewV1>;
  describe(secretId: string): Promise<SecretViewV1 | undefined>;
  /** An expiring lease over the sealed value for one effect. */
  lease(input: {
    accountId: string;
    secretId: string;
    effectId: string;
  }): Promise<CredentialLeaseV1>;
  settle(input: {
    accountId: string;
    secretId: string;
    effectId: string;
  }): Promise<void>;
  remove(secretId: string): Promise<{ removed: boolean }>;
}

export function createSecretVaultV1(host: SecretVaultHostV1): SecretVaultV1 {
  const now = host.now ?? Date.now;
  const readItem = async (
    secretId: string,
  ): Promise<SecretItemV1 | undefined> => {
    const stored = await host.storage.get<unknown>(itemKey(secretId));
    return stored === undefined ? undefined : decodeSecretItemV1(stored);
  };
  const readItems = async (): Promise<SecretItemV1[]> => {
    const stored = await host.storage.list<unknown>({ prefix: ITEM_PREFIX });
    return [...stored.values()].map((value) => decodeSecretItemV1(value));
  };
  return {
    async store(input) {
      const answered = async (): Promise<SecretItemV1 | undefined> => {
        const secretId = await host.storage.get<string>(
          requestKey(input.botId, input.requestId),
        );
        return secretId === undefined ? undefined : readItem(secretId);
      };
      const earlier = await answered();
      if (earlier) return { ...secretViewV1(earlier), status: "replayed" };
      if ((await readItems()).length >= SECRET_LIMITS_V1.perUser) {
        throw new SecretLimitError();
      }
      const secretId = mintSecretIdV1();
      const generation = mintSecretGenerationV1();
      // Sealed before the transaction: the store's crypto is asynchronous,
      // and the write it leads to is the one that has to be atomic.
      const prepared = await host.credentials.prepareApiKey({
        accountId: input.accountId,
        connectionId: secretId,
        packageId: SECRETS_PACKAGE_ID_V1,
        generation,
        apiKey: input.value,
      });
      const item: SecretItemV1 = {
        schemaVersion: 1,
        secretId,
        label: input.label,
        // Whatever the Bot said it was asking for, a card number is a payment
        // detail: the value is the one thing here the Bot never chose.
        payment: input.payment || looksLikePaymentCardV1(input.value),
        ...(input.origin === undefined ? {} : { origin: input.origin }),
        botId: input.botId,
        createdAt: new Date(now()).toISOString(),
        requestId: input.requestId,
        generation,
      };
      const written = await host.storage.transaction(async (transaction) => {
        const raced = await transaction.get<string>(
          requestKey(input.botId, input.requestId),
        );
        if (raced !== undefined) return false;
        await host.credentials.stagePreparedApiKey(prepared, transaction);
        await host.credentials.activate(
          {
            accountId: input.accountId,
            connectionId: secretId,
            packageId: SECRETS_PACKAGE_ID_V1,
            generation,
          },
          transaction,
        );
        await transaction.put({
          [itemKey(secretId)]: item,
          [requestKey(input.botId, input.requestId)]: secretId,
        });
        return true;
      });
      if (!written) {
        const winner = await answered();
        if (winner) return { ...secretViewV1(winner), status: "replayed" };
        throw new SecretNotFoundError();
      }
      return { ...secretViewV1(item), status: "saved" };
    },
    async list() {
      const items = await readItems();
      return {
        schemaVersion: 1,
        secrets: items
          .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
          .map(secretViewV1),
      };
    },
    async describe(secretId) {
      const item = await readItem(secretId);
      return item === undefined ? undefined : secretViewV1(item);
    },
    async lease(input) {
      const item = await readItem(input.secretId);
      if (!item) throw new SecretNotFoundError();
      return host.credentials.lease({
        accountId: input.accountId,
        connectionId: item.secretId,
        packageId: SECRETS_PACKAGE_ID_V1,
        effectId: input.effectId,
        expiresAt: new Date(now() + SECRET_LEASE_MS_V1).toISOString(),
        expectedGeneration: item.generation,
      });
    },
    async settle(input) {
      await host.credentials.settle({
        accountId: input.accountId,
        connectionId: input.secretId,
        packageId: SECRETS_PACKAGE_ID_V1,
        effectId: input.effectId,
      });
    },
    async remove(secretId) {
      const item = await readItem(secretId);
      if (!item) return { removed: false };
      // A lease still out keeps its retired generation until it settles or
      // expires; nothing can lease the secret again once its record is gone.
      await host.credentials.disconnect(secretId);
      await host.storage.transaction(async (transaction) => {
        await transaction.delete(itemKey(secretId));
        await transaction.delete(requestKey(item.botId, item.requestId));
      });
      return { removed: true };
    },
  };
}
