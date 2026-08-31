// The User backend Contribution: the one place a User's transcript index lives.
//
// It is mounted into the User Durable Object's Cordis root beside Settings,
// Credentials, Flock, and the Package Publisher, and it owns exactly one thing
// — a `SearchIndexV1` over that object's own SQL storage.
//
// Two seams it does not own, and takes as host functions instead:
//
//  * the Bot directory, because the Flock Contribution is the authority for
//    which Bots exist and which are archived, and a lifecycle answer copied
//    into the index would go stale the moment a Bot is archived;
//  * the row source, because the rows are projections of runs the *Bot*
//    Durable Object holds, and a rebuild must read them from that authority
//    rather than from anything this object remembers.
import type { Plugin } from "cordis";
import {
  SEARCH_REBUILD_PAGE_V1,
  SearchIndexV1,
  type SearchRebuildOutcomeV1,
  type SearchRowSourceV1,
  type SearchSqlV1,
} from "./index-store.js";
import {
  decodeSearchQueryV1,
  decodeSearchRowPageV1,
  decodeSearchRowV1,
  type SearchIndexResultsV1,
  type SearchIndexStateV1,
  type SearchRowV1,
} from "./shared.js";

export interface SearchUserBackendHost {
  /** The User Durable Object's own SQL storage. */
  sql: SearchSqlV1;
  /** Every Bot this User has, with the archived ones named. */
  readDirectory(): Promise<{
    botIds: readonly string[];
    archivedBotIds: readonly string[];
  }>;
  /**
   * One page of a Bot's projected rows, read from that Bot's Durable Object.
   * The answer is decoded here: it is inbound from another runtime.
   */
  projectBotRows(botId: string, cursor?: string): Promise<unknown>;
  /** Overridable so a test can drive quota eviction. */
  maxRows?: number;
}

export class SearchUserBackendContribution {
  readonly packageId = "search";
  private readonly index: SearchIndexV1;

  constructor(private readonly host: SearchUserBackendHost) {
    this.index = new SearchIndexV1({
      sql: host.sql,
      ...(host.maxRows === undefined ? {} : { maxRows: host.maxRows }),
    });
  }

  /** Idempotent on `(botId, runId, seq)`; a re-projected Turn adds nothing. */
  async indexRows(input: unknown): Promise<{ indexed: number }> {
    if (!Array.isArray(input)) throw new Error("search rows must be an array");
    if (input.length > 512) throw new Error("search rows exceed their bound");
    const rows: SearchRowV1[] = input.map(decodeSearchRowV1);
    return { indexed: this.index.insert(rows) };
  }

  async search(input: unknown): Promise<SearchIndexResultsV1> {
    const query = decodeSearchQueryV1(input);
    const directory = await this.host.readDirectory();
    return this.index.query(query, {
      archivedBotIds: directory.archivedBotIds,
    });
  }

  /** Every row of one Bot leaves the index. The archive saga calls this. */
  purge(botId: string): { removed: number } {
    return { removed: this.index.purge(botId) };
  }

  state(): SearchIndexStateV1 {
    return this.index.state();
  }

  /**
   * Reconstructs the whole index from the Bots' own stored runs.
   *
   * This is what makes the index disposable rather than authoritative: it can
   * be thrown away and rebuilt, and the rebuilt table is the same table.
   */
  async rebuild(): Promise<SearchRebuildOutcomeV1> {
    const directory = await this.host.readDirectory();
    const sources: SearchRowSourceV1[] = directory.botIds.map((botId) => ({
      botId,
      page: async (cursor) => {
        const page = decodeSearchRowPageV1(
          await this.host.projectBotRows(botId, cursor),
        );
        return {
          rows: page.rows.slice(0, SEARCH_REBUILD_PAGE_V1 * 8),
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        };
      },
    }));
    return this.index.rebuild(sources);
  }
}

export function createSearchUserBackendPlugin(
  host: SearchUserBackendHost,
  lifecycle: { mount(value: SearchUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(new SearchUserBackendContribution(host));
}
