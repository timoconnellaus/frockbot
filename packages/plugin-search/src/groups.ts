// Hits, grouped into the shape a person reads.
//
// The index answers with a flat, ranked list of `(botId, runId)` hits and
// knows nothing about Bots beyond their ids — deliberately, because Bot
// identity is the Flock Contribution's authority and a name copied into a row
// would be stale the moment a Bot is renamed. This module is the join: it
// reads the live directory and turns hits into groups the WebUI renders.
//
// Pure, so it is its own test surface. It is the only place a deep link is
// built, so a client never assembles one from parts it might get wrong.
import {
  searchDeepLinkV1,
  SEARCH_MAX_GROUPS_V1,
  type ClientSearchBotGroupV1,
  type ClientSearchResultsV1,
  type SearchIndexResultsV1,
} from "./shared.js";

/** One Bot, as the live directory describes it at query time. */
export interface SearchBotDescriptorV1 {
  botId: string;
  name: string;
  archived: boolean;
  /** A Bot its own settings keep out of the sidebar. Searchable, and labelled. */
  hidden: boolean;
  /** The uploaded avatar, when the Bot has one instead of its sheep. */
  avatarUrl?: string;
}

/**
 * Groups a page of hits by Bot, newest-ranked group first.
 *
 * Rank order is preserved twice over: groups appear in the order their best
 * hit did, and hits keep their order inside a group. A Bot the directory no
 * longer describes still gets a group, labelled by its id: the alternative is
 * dropping a hit the index legitimately holds because a rename raced a query.
 */
export function groupSearchHitsV1(
  results: SearchIndexResultsV1,
  directory: readonly SearchBotDescriptorV1[],
): ClientSearchResultsV1 {
  const described = new Map(directory.map((bot) => [bot.botId, bot]));
  const groups = new Map<string, ClientSearchBotGroupV1>();
  for (const hit of results.hits) {
    let group = groups.get(hit.botId);
    if (!group) {
      if (groups.size >= SEARCH_MAX_GROUPS_V1) continue;
      const bot = described.get(hit.botId);
      group = {
        botId: hit.botId,
        botName: bot?.name ?? hit.botId,
        archived: bot?.archived ?? false,
        hidden: bot?.hidden ?? false,
        ...(bot?.avatarUrl ? { avatarUrl: bot.avatarUrl } : {}),
        hits: [],
        totalHits: 0,
      };
      groups.set(hit.botId, group);
    }
    group.hits.push({
      runId: hit.runId,
      kind: hit.kind,
      at: hit.at,
      snippet: hit.snippet,
      deepLink: searchDeepLinkV1(hit.botId, hit.runId),
    });
    group.totalHits += 1;
  }
  return {
    schemaVersion: 1,
    query: results.query,
    groups: [...groups.values()],
    page: {
      truncated: results.truncated,
      ...(results.nextCursor === undefined
        ? {}
        : { nextCursor: results.nextCursor }),
    },
    indexState: results.indexState,
  };
}
