// The transcript-index seam, bound in production.
//
// Two directions cross a Durable Object boundary here, and both are decoded on
// arrival — "Cross-runtime communication uses narrow, versioned DTOs, and
// every inbound value is decoded at its seam". An answer from another Durable
// Object is inbound, so it is decoded because of what it is, never trusted
// because of where it came from.
//
//  * `createUserSearchSinkV1` is the Bot Durable Object's half: a settled
//    Turn's rows go to the User Durable Object, which is the authority for
//    User-scoped state. It is deliberately fire-and-forget at the call site —
//    the run is already durable before this runs, and `rebuildSearchIndex`
//    reconstructs anything a failed projection missed.
//  * `createBotSearchRowPageV1` is the User Durable Object's half: one page of
//    a Bot's rows, projected from that Bot's own stored runs, which is what
//    makes the index rebuildable rather than authoritative.
import {
  searchRowsFromClientRunV1,
  type SearchRowPageV1,
  type SearchRowV1,
  type SearchSinkV1,
} from "@frockbot/plugin-search";
import { decodeClientRunPageV1 } from "@frockbot/plugin-shell/run-protocol";

/** The User Durable Object's search RPC surface, as the Bot object calls it. */
export interface UserSearchRpc {
  indexSearchRows(input: unknown): Promise<unknown>;
}

/** The Bot Durable Object's projection RPC, as the User object calls it. */
export interface BotSearchRpc {
  projectSearchRows(input: unknown): Promise<unknown>;
}

/**
 * `SearchSinkV1` over the User Durable Object.
 *
 * A failed index write is swallowed on purpose. The Turn it belongs to has
 * already reached its durable terminal state in the Bot Durable Object; making
 * the User object's availability a condition of a Turn settling would put a
 * derived projection on the critical path of the thing it is derived from.
 * The cost of the failure is bounded and repairable: those rows are missing
 * until a rebuild, and the index state the UI shows says so.
 */
export function createUserSearchSinkV1(
  rpc: UserSearchRpc,
  identity: { userId: string; botId: string },
): SearchSinkV1 {
  return {
    async indexRows(rows) {
      if (rows.length === 0) return;
      const owned = rows.filter((row) => row.botId === identity.botId);
      if (owned.length === 0) return;
      await rpc.indexSearchRows({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        rows: owned,
      });
    },
  };
}

/**
 * One page of a Bot's rows, projected from the run list the Shell Package
 * already exposes.
 *
 * The run list is the same projection the WebUI reads, so the rows a rebuild
 * writes are the rows a settlement would have written — the property the whole
 * "the index is disposable" claim rests on.
 */
export function createBotSearchRowPageV1(
  botId: string,
  runList: unknown,
): SearchRowPageV1 {
  const page = decodeClientRunPageV1(runList);
  const rows: SearchRowV1[] = page.runs.flatMap((run) =>
    searchRowsFromClientRunV1(botId, run),
  );
  return {
    schemaVersion: 1,
    botId,
    rows,
    ...(page.page.truncated && page.page.nextCursor
      ? { nextCursor: page.page.nextCursor }
      : {}),
  };
}
