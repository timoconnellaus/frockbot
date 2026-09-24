// What one platform-paid web search costs the account, and how it is charged.
//
// Brave Search bills the deployment a flat rate per request, whatever the
// result count. The account pays twice that, as it pays for every other
// platform-paid resource, so the tariff is fixed per search rather than
// metered.
//
// ONE CHARGE PER SEARCH. `web_search` is idempotent: recovery after an
// eviction re-runs it rather than reading back a result. So the charge is
// keyed by the search's own durable effect id, and a re-run under the same
// id finds the reservation it already made instead of reserving again.
import type { AccountUsage } from "./model.js";

export const SEARCH_TARIFF = {
  providerMicrosPerSearch: 5_000,
  microsPerSearch: 10_000,
  usdPerSearch: 0.01,
} as const;

/**
 * The `pricing_version` a search reservation records. The tariff is its own
 * price list, apart from the plan and the hosted model rate table, so a
 * change to either never rewrites what a past search was charged under. A
 * new tariff is a new version.
 */
export const SEARCH_PRICING_VERSION = "search-2026-09-24";

export const SEARCH_RATE_DESCRIPTION = "Web search · US$0.01 per search";

/** One search's reserved charge, settled once the provider has answered. */
export interface SearchChargeV1 {
  /** The provider answered the request, so it was spent. */
  charge(): Promise<void>;
  /** The provider refused it, so nothing was spent. */
  release(): Promise<void>;
}

export interface SearchMeterV1 {
  /**
   * Hold one search's price before the provider is asked. Throws the
   * account's own refusal when it cannot spend, so no search runs unpaid.
   */
  reserve(search: {
    effectId: string;
    botId: string;
    sessionId: string;
  }): Promise<SearchChargeV1>;
}

const NOTHING_TO_SETTLE: SearchChargeV1 = {
  charge: () => Promise.resolve(),
  release: () => Promise.resolve(),
};

export function createSearchMeterV1(account: AccountUsage): SearchMeterV1 {
  return {
    async reserve(search) {
      const id = `search:${search.effectId}`;
      const reservation = await account.reserve({
        id,
        kind: "search",
        maximumMicros: SEARCH_TARIFF.microsPerSearch,
        botId: search.botId,
        sessionId: search.sessionId,
        description: SEARCH_RATE_DESCRIPTION,
        pricingVersion: SEARCH_PRICING_VERSION,
        unitRates: { microsPerSearch: SEARCH_TARIFF.microsPerSearch },
      });
      // An earlier run under this id already charged or released it. This
      // re-run is the same search, so it is not billed again either way.
      if (reservation.status !== "reserved") return NOTHING_TO_SETTLE;
      return {
        charge: () =>
          account.settle({
            id,
            costMicros: SEARCH_TARIFF.providerMicrosPerSearch,
            chargeMicros: SEARCH_TARIFF.microsPerSearch,
            quantities: { searches: 1 },
          }),
        release: () =>
          account.settle({
            id,
            costMicros: 0,
            chargeMicros: 0,
            quantities: { searches: 0 },
          }),
      };
    },
  };
}
