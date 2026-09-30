// The search provider seam: which `WebSearchV1` a Bot's `web_search` runs on.
//
// FrockBot's own is Brave on the deployment's key, billed per search. A
// person may instead bring Brave, Exa or Tavily on their own key, or their own
// SearXNG instance; that search is never billed. There is no fallback between
// them: when the person's provider refuses, fails or runs out, the tool
// returns that error to the model, and FrockBot's Brave is never asked.
//
// AUTHORITY. `web_search` is the Web Package's `web-search` Capability. Like
// `web_fetch` it needs no Connection, so a Bot holds it while its Web switch
// is on — on FrockBot's search provided the deployment holds
// `BRAVE_SEARCH_API_KEY`. Without that key an account on FrockBot's search
// mounts nothing: the model is never offered a search it cannot run.
//
// THE PERSON'S SECRET is sealed in the User Durable Object. The Turn mounts
// with the choice and the generation that holds it, and each search takes an
// expiring lease under its own effect id and opens it here, inside the Bot's
// Durable Object, for the one request. It never reaches a tool argument, a
// tool result, the event log, or the Bot's Computer.
import type {
  AgentRuntimeV1,
  RuntimeFeatureV1,
} from "@frockbot/core/contracts";
import type { CredentialLeaseV1 } from "@frockbot/core/connection";
import { CredentialLeaseRuntime } from "@frockbot/app/credentials/user";
import type { SearchMeterV1 } from "@frockbot/app/billing/search";
import type { WebFetchFn } from "./agent.js";
import {
  ExaWebSearchV1,
  SearxngWebSearchV1,
  TavilyWebSearchV1,
} from "./account-providers.js";
import { BraveWebSearchV1 } from "./brave.js";
import {
  createWebSearchToolDefinitionV1,
  type WebSearchV1,
} from "./contract.js";
import {
  WEB_SEARCH_CREDENTIAL_ID_V1,
  WEB_SEARCH_CREDENTIAL_PACKAGE_ID_V1,
  WEB_SEARCH_PROVIDER_NAMES_V1,
  type AccountWebSearchProviderV1,
  type WebSearchChoiceViewV1,
} from "./search-choice.js";

/** The account's choice as this Turn mounted it, and its secret per search. */
export interface AccountWebSearchV1 {
  choice: WebSearchChoiceViewV1;
  /** Runs `use` with the choice's secret, leased for this search alone. */
  withSecret<T>(
    effectId: string,
    use: (secret: string) => Promise<T>,
  ): Promise<T>;
}

/**
 * The Bot-side half: lease through the User Durable Object, open with the
 * deployment keyring, and settle whatever became of the search.
 */
export function createAccountWebSearchV1(host: {
  accountId: string;
  choice: WebSearchChoiceViewV1;
  lease(effectId: string, generation: string): Promise<CredentialLeaseV1>;
  settle(effectId: string): Promise<void>;
  readSecret(name: "CREDENTIAL_KEYRING"): string | undefined;
}): AccountWebSearchV1 {
  const choice = host.choice;
  return {
    choice,
    async withSecret(effectId, use) {
      if (choice.provider === "frockbot") {
        throw new Error("FrockBot's web search has no account secret");
      }
      const name = WEB_SEARCH_PROVIDER_NAMES_V1[choice.provider];
      let secret: string;
      try {
        const lease = await host.lease(effectId, choice.generation);
        secret = await new CredentialLeaseRuntime({
          readSecret: host.readSecret,
        }).open({
          accountId: host.accountId,
          connectionId: WEB_SEARCH_CREDENTIAL_ID_V1,
          packageId: WEB_SEARCH_CREDENTIAL_PACKAGE_ID_V1,
          lease,
        });
      } catch {
        await host.settle(effectId).catch(() => undefined);
        throw new Error(
          `Your ${name} search could not be used: its saved key or address is unavailable, or the web search setting changed. It takes effect from the next message.`,
        );
      }
      try {
        return await use(secret);
      } finally {
        await host.settle(effectId).catch(() => undefined);
      }
    },
  };
}

function accountProvider(
  provider: AccountWebSearchProviderV1,
  secret: string,
  fetch: WebFetchFn | undefined,
): WebSearchV1 {
  const config = { secret, ...(fetch ? { fetch } : {}) };
  switch (provider) {
    case "brave":
      return new BraveWebSearchV1({ ...config, apiKey: secret, ownKey: true });
    case "exa":
      return new ExaWebSearchV1(config);
    case "tavily":
      return new TavilyWebSearchV1(config);
    case "searxng":
      return new SearxngWebSearchV1(config);
  }
}

/**
 * The enablement fence. A Bot holds `web_search` only through this Package's
 * enabled `web-search` Capability, and only while its account's provider can
 * run: its own, or FrockBot's where the deployment holds a key.
 */
export async function createConfiguredWebSearchRuntimeContribution(config: {
  capability: {
    packageId: string;
    capabilityId: string;
    connectionId?: string;
  };
  /** The deployment's key; absent, FrockBot's search is not offered. */
  apiKey: string | undefined;
  /** Charges FrockBot's search only; a person's own provider is never metered. */
  meter?: SearchMeterV1;
  /** Reads the account's choice, only once the fence has passed. Absent means FrockBot's. */
  account?: () => Promise<AccountWebSearchV1>;
  fetch?: WebFetchFn;
}): Promise<RuntimeFeatureV1<AgentRuntimeV1> | undefined> {
  if (
    config.capability.packageId !== "web" ||
    config.capability.capabilityId !== "web-search"
  ) {
    return undefined;
  }
  const account = await config.account?.();
  const own = account?.choice.provider;
  let provider: WebSearchV1;
  if (account && own && own !== "frockbot") {
    // The person's own provider, with its secret leased per search.
    provider = {
      search: (request, execution) =>
        account.withSecret(execution.effectId, (secret) =>
          accountProvider(own, secret, config.fetch).search(request, execution),
        ),
    };
  } else if (config.apiKey) {
    provider = new BraveWebSearchV1({
      apiKey: config.apiKey,
      ...(config.meter ? { meter: config.meter } : {}),
      ...(config.fetch ? { fetch: config.fetch } : {}),
    });
  } else {
    return undefined;
  }
  return (runtime) =>
    runtime.tools.register(createWebSearchToolDefinitionV1(provider), {
      admissionCeiling: ["chat", "agent", "automation", "subagent"],
      subagentRoleCeiling: ["executor"],
    });
}
