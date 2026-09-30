// The account's web search choice, inside the User Durable Object.
//
// The key or SearXNG address is sealed as a credential generation, exactly as
// a model API key or a saved secret is: activated on save, leased for one
// search at a time, and never returned. What is stored in the clear is which
// provider it is for and which generation holds it.
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import type {
  CredentialStorage,
  CredentialUserBackendContribution,
} from "@frockbot/app/credentials/user";
import { mintSecretGenerationV1 } from "@frockbot/app/secrets/shared";
import {
  decodeWebSearchChoiceViewV1,
  PLATFORM_WEB_SEARCH_CHOICE_V1,
  WEB_SEARCH_CREDENTIAL_ID_V1,
  WEB_SEARCH_CREDENTIAL_PACKAGE_ID_V1,
  WEB_SEARCH_LEASE_MS_V1,
  webSearchLeaseEffectIdV1,
  type WebSearchChoiceInputV1,
  type WebSearchChoiceViewV1,
} from "./search-choice.js";

const CHOICE_KEY = "web-search:choice";

export interface WebSearchChoiceStoreHostV1 {
  storage: CredentialStorage;
  credentials: CredentialUserBackendContribution;
  now?: () => number;
}

export interface WebSearchChoiceStoreV1 {
  read(): Promise<WebSearchChoiceViewV1>;
  /** Replaces the choice; a provider's secret is sealed before it is kept. */
  set(
    accountId: string,
    input: WebSearchChoiceInputV1,
  ): Promise<WebSearchChoiceViewV1>;
  /**
   * An expiring lease over the secret for one search. `generation` is the one
   * the Turn mounted with, so a choice changed since then refuses rather than
   * handing one provider's key to another.
   */
  lease(input: {
    accountId: string;
    effectId: string;
    generation: string;
  }): Promise<CredentialLeaseV1>;
  settle(input: { accountId: string; effectId: string }): Promise<void>;
}

/** The account's one search credential, as the store addresses it. */
function credentialOf(accountId: string) {
  return {
    accountId,
    connectionId: WEB_SEARCH_CREDENTIAL_ID_V1,
    packageId: WEB_SEARCH_CREDENTIAL_PACKAGE_ID_V1,
  };
}

export function createWebSearchChoiceStoreV1(
  host: WebSearchChoiceStoreHostV1,
): WebSearchChoiceStoreV1 {
  const now = host.now ?? Date.now;
  const read = async (): Promise<WebSearchChoiceViewV1> => {
    const stored = await host.storage.get<unknown>(CHOICE_KEY);
    return stored === undefined
      ? PLATFORM_WEB_SEARCH_CHOICE_V1
      : decodeWebSearchChoiceViewV1(stored);
  };
  const settle = (accountId: string, effectId: string) =>
    host.credentials.settle({
      ...credentialOf(accountId),
      effectId: webSearchLeaseEffectIdV1(effectId),
    });
  return {
    read,
    async set(accountId, input) {
      if (input.provider === "frockbot") {
        // A lease still out keeps its retired generation until it settles
        // or expires; nothing can lease the secret again.
        await host.credentials.disconnect(WEB_SEARCH_CREDENTIAL_ID_V1);
        await host.storage.delete(CHOICE_KEY);
        return PLATFORM_WEB_SEARCH_CHOICE_V1;
      }
      const generation = mintSecretGenerationV1();
      // Sealed before the transaction: the store's crypto is asynchronous,
      // and the write it leads to is the one that has to be atomic.
      const prepared = await host.credentials.prepareApiKey({
        ...credentialOf(accountId),
        generation,
        apiKey: input.provider === "searxng" ? input.url : input.apiKey,
      });
      const choice: WebSearchChoiceViewV1 = {
        schemaVersion: 1,
        provider: input.provider,
        generation,
        updatedAt: new Date(now()).toISOString(),
      };
      await host.storage.transaction(async (transaction) => {
        await host.credentials.stagePreparedApiKey(prepared, transaction);
        await host.credentials.activate(
          { ...credentialOf(accountId), generation },
          transaction,
        );
        await transaction.put(CHOICE_KEY, choice);
      });
      return choice;
    },
    async lease(input) {
      // A search is read-only, so a re-run after eviction needs a working
      // lease rather than the one its first attempt took: settling first
      // clears that attempt's lease, or its tombstone if it expired.
      await settle(input.accountId, input.effectId);
      return host.credentials.lease({
        ...credentialOf(input.accountId),
        effectId: webSearchLeaseEffectIdV1(input.effectId),
        expiresAt: new Date(now() + WEB_SEARCH_LEASE_MS_V1).toISOString(),
        expectedGeneration: input.generation,
      });
    },
    settle: (input) => settle(input.accountId, input.effectId),
  };
}
