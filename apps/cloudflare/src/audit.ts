// The audit seam, bound in production.
//
// Two directions cross a Durable Object boundary here, and both are decoded on
// arrival — "Cross-runtime communication uses narrow, versioned DTOs, and
// every inbound value is decoded at its seam".
//
//  * `createUserAuditSinkV1` is the Bot Durable Object's half: a settled
//    Turn's entries go to the User Durable Object, which is the authority for
//    User-scoped state. Unlike the transcript index this is *not*
//    fire-and-forget — the Bot object holds them in a bounded durable outbox
//    until the User object accepts them (parity register row 30b), because an
//    audit surface with silent gaps answers no question anybody asks of it.
//  * `createBotAuditEntryPageV1` is the User Durable Object's half: one page
//    of a Bot's entries, projected from that Bot's own stored runs, which is
//    what makes the table rebuildable rather than authoritative.
import {
  auditEntriesFromStoredRunV1,
  type AuditEntryPageV1,
  type AuditEntryV1,
  type AuditProjectableRunV1,
  type AuditSinkV1,
} from "@frockbot/plugin-audit";

/** The User Durable Object's audit RPC surface, as the Bot object calls it. */
export interface UserAuditRpc {
  indexAuditEntries(input: unknown): Promise<unknown>;
}

/** The Bot Durable Object's projection RPC, as the User object calls it. */
export interface BotAuditRpc {
  projectAuditEntries(input: unknown): Promise<unknown>;
}

/**
 * `AuditSinkV1` over the User Durable Object.
 *
 * A failure here *throws*, on purpose, and that is the difference between this
 * sink and the transcript index's. The caller is draining a durable outbox: a
 * throw leaves the entries queued for the next settlement or alarm, and
 * swallowing it would turn an at-least-once queue into a silent drop. The Turn
 * that produced them is already durable and is never failed by this.
 */
export function createUserAuditSinkV1(
  rpc: UserAuditRpc,
  identity: { userId: string; botId: string },
): AuditSinkV1 {
  return {
    async indexEntries(entries: readonly AuditEntryV1[]) {
      if (entries.length === 0) return;
      const owned = entries.filter((entry) => entry.botId === identity.botId);
      if (owned.length === 0) return;
      await rpc.indexAuditEntries({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        entries: owned,
      });
    },
  };
}

/** The stored-run page the Shell Package offers, as this adapter reads it. */
export interface StoredRunEventPageV1 {
  runs: ReadonlyArray<{
    runId: string;
    acceptedAt: string;
    status: string;
    events: AuditProjectableRunV1["events"];
  }>;
  nextCursor?: string;
}

/**
 * One page of a Bot's entries, projected from its own durable session events.
 *
 * The *stored* run rather than the client projection: the client projection
 * drops `call.input`, and the argument digest needs the exact arguments. Same
 * function as settlement uses, so the entries a rebuild writes are the entries
 * a settlement would have written — the property the whole "the table is a
 * projection" claim rests on.
 */
export async function createBotAuditEntryPageV1(
  botId: string,
  page: StoredRunEventPageV1,
): Promise<AuditEntryPageV1> {
  const entries: AuditEntryV1[] = [];
  for (const run of page.runs) {
    entries.push(
      ...(await auditEntriesFromStoredRunV1(botId, {
        runId: run.runId,
        status: run.status,
        acceptedAt: run.acceptedAt,
        events: run.events,
      })),
    );
  }
  return {
    schemaVersion: 1,
    botId,
    entries,
    ...(page.nextCursor === undefined ? {} : { nextCursor: page.nextCursor }),
  };
}
