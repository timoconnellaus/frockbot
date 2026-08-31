// The User backend Contribution: the one place a User's audit table lives.
//
// It is mounted into the User Durable Object's Cordis root beside Settings,
// Credentials, Flock and the transcript index, and it owns exactly one thing —
// an `AuditStoreV1` over that object's own SQL storage.
//
// Three seams it does not own, and takes as host functions instead:
//
//  * the Bot directory, because Flock is the authority for which Bots exist;
//  * the entry source, because entries are projections of runs the *Bot*
//    Durable Object holds, and a rebuild must read them from that authority;
//  * the MCP host map, because Connections are User-scoped state this object
//    holds elsewhere — and resolving `remote:<slug>` to `remote:<host>` here,
//    on the one path both projection and rebuild take, is what stops the two
//    disagreeing about what a row says.
import type { Plugin } from "cordis";
import {
  AUDIT_MAX_ENTRY_PAGE_V1,
  AuditDecodeError,
  AUDIT_TARGET_REMOTE_PREFIX_V1,
  decodeAuditEntryPageV1,
  decodeAuditEntryV1,
  type AuditEntryV1,
  type AuditIndexStateV1,
  type AuditRebuildReceiptV1,
} from "./shared.js";
import {
  AuditStoreV1,
  type AuditEntrySourceV1,
  type AuditSqlV1,
} from "./store.js";

export interface AuditUserBackendHost {
  /** The User Durable Object's own SQL storage. */
  sql: AuditSqlV1;
  /** Every Bot this User has. */
  readDirectory(): Promise<{ botIds: readonly string[] }>;
  /**
   * One page of a Bot's projected entries, read from that Bot's Durable
   * Object. The answer is decoded here: it is inbound from another runtime.
   */
  projectBotEntries(botId: string, cursor?: string): Promise<unknown>;
  /**
   * `<mcp server slug> → <host>`, from this User's Connection registry.
   *
   * Absent or incomplete is not a failure: an unresolved slug stays
   * `remote:<slug>`, which is still a true statement about where the call
   * went, rather than a row that claims a host nobody can vouch for.
   */
  readMcpHosts?(): Promise<ReadonlyMap<string, string>>;
  /**
   * The Computer host's own per-effect journal, when the deployment exposes
   * one. It is non-authoritative (`AGENTS.md` § Computer and Workspace), so it
   * is only ever *compared* against the table — never inserted into it.
   */
  readHostJournalEffectIds?(): Promise<readonly string[]>;
  /** Overridable so a test can drive eviction. */
  maxRows?: number;
  /** Overridable so a test can drive age eviction. */
  maxAgeMs?: number;
  now?: () => number;
}

/**
 * `remote:<slug>` resolved against the Connection registry.
 *
 * Every other target passes through untouched: `computer` and `machine:<id>`
 * are complete as the classifier wrote them.
 */
export function resolveAuditTargetV1(
  target: string,
  hosts: ReadonlyMap<string, string>,
): string {
  if (!target.startsWith(AUDIT_TARGET_REMOTE_PREFIX_V1)) return target;
  const slug = target.slice(AUDIT_TARGET_REMOTE_PREFIX_V1.length);
  const host = hosts.get(slug);
  return host ? `${AUDIT_TARGET_REMOTE_PREFIX_V1}${host}` : target;
}

export class AuditUserBackendContribution {
  readonly packageId = "audit";
  private readonly store: AuditStoreV1;

  constructor(private readonly host: AuditUserBackendHost) {
    this.store = new AuditStoreV1({
      sql: host.sql,
      ...(host.maxRows === undefined ? {} : { maxRows: host.maxRows }),
      ...(host.maxAgeMs === undefined ? {} : { maxAgeMs: host.maxAgeMs }),
      ...(host.now === undefined ? {} : { now: host.now }),
    });
  }

  private async hosts(): Promise<ReadonlyMap<string, string>> {
    if (!this.host.readMcpHosts) return new Map();
    try {
      return await this.host.readMcpHosts();
    } catch {
      // A registry this object could not read leaves slugs unresolved, which
      // is a less specific row and not a wrong one.
      return new Map();
    }
  }

  private resolve(
    entries: readonly AuditEntryV1[],
    hosts: ReadonlyMap<string, string>,
  ): AuditEntryV1[] {
    return entries.map((entry) => ({
      ...entry,
      target: resolveAuditTargetV1(entry.target, hosts),
    }));
  }

  /**
   * Idempotent on `(botId, runId, occurrenceId)`; a redelivered outbox page
   * inserts nothing the second time.
   */
  async indexAuditEntries(input: unknown): Promise<{ indexed: number }> {
    if (!Array.isArray(input)) {
      throw new AuditDecodeError("audit entries must be an array");
    }
    if (input.length > AUDIT_MAX_ENTRY_PAGE_V1) {
      throw new AuditDecodeError("audit entries exceed their bound");
    }
    const entries = input.map(decodeAuditEntryV1);
    return {
      indexed: this.store.insert(this.resolve(entries, await this.hosts())),
    };
  }

  /** Every entry of one Bot leaves the table. The archive saga calls this. */
  purgeAuditForBot(botId: string): { removed: number } {
    return { removed: this.store.purge(botId) };
  }

  state(): AuditIndexStateV1 {
    return this.store.state();
  }

  query(request: {
    botId?: string;
    kind?: string;
    target?: string;
    before?: string;
    limit?: number;
  }): { entries: AuditEntryV1[]; nextCursor?: string; total: number } {
    return this.store.query(request);
  }

  /**
   * Reconstructs the whole table from the Bots' own stored runs.
   *
   * This is what makes the table disposable rather than authoritative. The
   * receipt names how many entries it wrote and how many effects the Computer
   * host's journal reported that no durable event accounts for — an `unknown`
   * the User is told about rather than a row invented to cover it.
   */
  async rebuildAuditIndex(): Promise<AuditRebuildReceiptV1> {
    const directory = await this.host.readDirectory();
    const hosts = await this.hosts();
    const sources: AuditEntrySourceV1[] = directory.botIds.map((botId) => ({
      botId,
      page: async (cursor) => {
        const page = decodeAuditEntryPageV1(
          await this.host.projectBotEntries(botId, cursor),
        );
        return {
          entries: this.resolve(page.entries, hosts),
          ...(page.nextCursor === undefined
            ? {}
            : { nextCursor: page.nextCursor }),
        };
      },
    }));
    const outcome = await this.store.rebuild(sources);
    return {
      schemaVersion: 1,
      status: "rebuilt",
      entries: outcome.entries,
      bots: outcome.bots,
      indexState: outcome.indexState,
      unknownOutcomes: this.store
        .all()
        .filter((entry) => entry.outcome === "unknown").length,
      hostJournalDiscrepancies: await this.countHostJournalDiscrepancies(),
    };
  }

  /**
   * Effects the host journal claims that the durable events do not.
   *
   * Counted, never written. The host is non-authoritative, so an effect it
   * reports with no matching session event is a discrepancy for a person to
   * look at — not evidence a Turn did something.
   */
  private async countHostJournalDiscrepancies(): Promise<number> {
    if (!this.host.readHostJournalEffectIds) return 0;
    let journal: readonly string[];
    try {
      journal = await this.host.readHostJournalEffectIds();
    } catch {
      return 0;
    }
    if (journal.length === 0) return 0;
    const known = new Set(this.store.all().map((entry) => entry.effectId));
    return journal.filter((effectId) => !known.has(effectId)).length;
  }
}

export function createAuditUserBackendPlugin(
  host: AuditUserBackendHost,
  lifecycle: { mount(value: AuditUserBackendContribution): () => void },
): Plugin {
  return () => lifecycle.mount(new AuditUserBackendContribution(host));
}
