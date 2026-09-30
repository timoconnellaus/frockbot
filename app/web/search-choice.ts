// Which web search an account's Bots use: FrockBot's own, or one the person
// brings. This module is shared by the User Durable Object, which keeps the
// choice, and the Turn, which reads it when `web_search` mounts. It holds no
// secret: a key or a SearXNG address is sealed as a credential generation
// under {@link WEB_SEARCH_CREDENTIAL_ID_V1}, and only the generation that
// names it crosses this seam.
import { classifyOutboundUrlV1 } from "./ssrf.js";
import { isSearchRecordV1 as isRecord } from "./search-http.js";

/** FrockBot's Brave on the deployment's key, billed per search. */
export const PLATFORM_WEB_SEARCH_PROVIDER_V1 = "frockbot";

/** The providers a person can bring, each on their own key or server. */
export const ACCOUNT_WEB_SEARCH_PROVIDERS_V1 = [
  "brave",
  "exa",
  "tavily",
  "searxng",
] as const;

export type AccountWebSearchProviderV1 =
  (typeof ACCOUNT_WEB_SEARCH_PROVIDERS_V1)[number];

export type WebSearchProviderIdV1 =
  typeof PLATFORM_WEB_SEARCH_PROVIDER_V1 | AccountWebSearchProviderV1;

/** What each provider is called where a person or the model reads it. */
export const WEB_SEARCH_PROVIDER_NAMES_V1: Record<
  WebSearchProviderIdV1,
  string
> = {
  frockbot: "FrockBot",
  brave: "Brave Search",
  exa: "Exa",
  tavily: "Tavily",
  searxng: "SearXNG",
};

/**
 * The credential store's Package and Connection for the account's search
 * secret. One per account: saving another provider rotates the generation.
 */
export const WEB_SEARCH_CREDENTIAL_PACKAGE_ID_V1 = "web-search";
export const WEB_SEARCH_CREDENTIAL_ID_V1 = "web-search-provider";

/** A sealed generation's id, as `mintSecretGenerationV1` makes it. */
export const WEB_SEARCH_GENERATION_PATTERN_V1 = /^g[0-9a-f]{24}$/;

/** One search holds the secret for no longer than it could take. */
export const WEB_SEARCH_LEASE_MS_V1 = 60_000;

/** The account's choice, as anything but the credential store may read it. */
export type WebSearchChoiceViewV1 =
  | { schemaVersion: 1; provider: typeof PLATFORM_WEB_SEARCH_PROVIDER_V1 }
  | {
      schemaVersion: 1;
      provider: AccountWebSearchProviderV1;
      /** The sealed key or address this choice runs on. */
      generation: string;
      updatedAt: string;
    };

export const PLATFORM_WEB_SEARCH_CHOICE_V1: WebSearchChoiceViewV1 = {
  schemaVersion: 1,
  provider: PLATFORM_WEB_SEARCH_PROVIDER_V1,
};

/** What a person submits to change the choice. The secret is sealed on arrival. */
export type WebSearchChoiceInputV1 =
  | { provider: typeof PLATFORM_WEB_SEARCH_PROVIDER_V1 }
  | { provider: Exclude<AccountWebSearchProviderV1, "searxng">; apiKey: string }
  | { provider: "searxng"; url: string };

const MAX_API_KEY_LENGTH = 512;

export function isAccountWebSearchProviderV1(
  value: unknown,
): value is AccountWebSearchProviderV1 {
  return (
    typeof value === "string" &&
    (ACCOUNT_WEB_SEARCH_PROVIDERS_V1 as readonly string[]).includes(value)
  );
}

/**
 * A SearXNG instance's address, normalized to end in `/` so `search` resolves
 * under any path prefix it is served from. It is reached from the Bot's own
 * Durable Object, so it passes the same public-internet rules `web_fetch`
 * does — except the port, since a self-hosted instance rarely sits on 443.
 */
export function normalizeSearxngUrlV1(value: unknown): string {
  const verdict = classifyOutboundUrlV1(value, { allowNonDefaultPort: true });
  if (!verdict.allowed) throw new Error(verdict.message);
  const url = new URL(verdict.url);
  url.search = "";
  url.hash = "";
  // An address pasted from the browser's results page is the same instance.
  url.pathname = url.pathname.replace(/\/search\/?$/, "/");
  if (!url.pathname.endsWith("/")) url.pathname = `${url.pathname}/`;
  return url.toString();
}

/** Decode a person's submission. Throws with a reason that never quotes a key. */
export function decodeWebSearchChoiceInputV1(
  value: unknown,
): WebSearchChoiceInputV1 {
  if (!isRecord(value)) throw new Error("Choose a web search provider.");
  const provider = value.provider;
  const keys = Object.keys(value);
  if (provider === PLATFORM_WEB_SEARCH_PROVIDER_V1) {
    if (keys.length !== 1) throw new Error("FrockBot's search takes no key.");
    return { provider };
  }
  if (provider === "searxng") {
    if (keys.length !== 2 || !Object.hasOwn(value, "url")) {
      throw new Error("SearXNG takes the address of your instance.");
    }
    return { provider, url: normalizeSearxngUrlV1(value.url) };
  }
  if (provider === "brave" || provider === "exa" || provider === "tavily") {
    const apiKey =
      typeof value.apiKey === "string" ? value.apiKey.trim() : undefined;
    if (
      keys.length !== 2 ||
      !apiKey ||
      apiKey.length > MAX_API_KEY_LENGTH ||
      !/^[\x21-\x7e]+$/.test(apiKey)
    ) {
      throw new Error(
        `Paste your ${WEB_SEARCH_PROVIDER_NAMES_V1[provider]} API key.`,
      );
    }
    return { provider, apiKey };
  }
  throw new Error("Choose a web search provider.");
}

/** The stored record, which is also its own view. */
export function decodeWebSearchChoiceViewV1(
  value: unknown,
): WebSearchChoiceViewV1 {
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Web search choice is invalid");
  }
  if (value.provider === PLATFORM_WEB_SEARCH_PROVIDER_V1) {
    return PLATFORM_WEB_SEARCH_CHOICE_V1;
  }
  if (
    !isAccountWebSearchProviderV1(value.provider) ||
    typeof value.generation !== "string" ||
    !WEB_SEARCH_GENERATION_PATTERN_V1.test(value.generation) ||
    typeof value.updatedAt !== "string"
  ) {
    throw new Error("Web search choice is invalid");
  }
  return {
    schemaVersion: 1,
    provider: value.provider,
    generation: value.generation,
    updatedAt: value.updatedAt,
  };
}

/**
 * The lease one search takes on the account's secret. Keyed by the search's
 * own effect so a re-run after eviction asks for the same lease, and apart
 * from every Connection's and saved secret's leases.
 */
export function webSearchLeaseEffectIdV1(effectId: string): string {
  return `web-search:${effectId}`;
}
