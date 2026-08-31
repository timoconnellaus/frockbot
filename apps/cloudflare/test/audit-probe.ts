import { DurableObject } from "cloudflare:workers";
import { AuditStoreV1, type AuditEntryV1 } from "@frockbot/plugin-audit";

/**
 * `AuditStoreV1` against real Durable Object SQL storage, at a size the unit
 * fake cannot honestly stand in for.
 *
 * The unit suite drives the module's logic against JavaScript arrays. What it
 * cannot prove is that the table, its three indexes, and the offset paging
 * behave on real SQLite once there are thousands of rows — that the
 * `(kind, at)` index is accepted at all, that a deep page is still one
 * statement, and that eviction does not walk the whole table. This probe asks
 * SQLite directly.
 */
export class AuditProbe extends DurableObject {
  private store(options: {
    maxRows?: number;
    maxAgeMs?: number;
    now?: number;
  }) {
    return new AuditStoreV1({
      sql: this.ctx.storage.sql,
      ...(options.maxRows === undefined ? {} : { maxRows: options.maxRows }),
      ...(options.maxAgeMs === undefined ? {} : { maxAgeMs: options.maxAgeMs }),
      ...(options.now === undefined ? {} : { now: () => options.now! }),
    });
  }

  /** Fills the table with `count` entries alternating kind, then pages it. */
  async paging(count: number): Promise<{
    total: number;
    shellTotal: number;
    pages: number;
    walked: number;
    firstOccurrenceId: string;
    lastOccurrenceId: string;
    duplicates: number;
  }> {
    // Inside the age bound on purpose: this probe is about paging, and the
    // age bound has its own.
    const store = this.store({ maxRows: count * 2 });
    const base = Date.now() - count * 1_000;
    const entries: AuditEntryV1[] = Array.from({ length: count }, (_, i) => ({
      schemaVersion: 1,
      botId: i % 3 === 0 ? "scheduler" : "foreman",
      runId: `run-${Math.floor(i / 8)}`,
      occurrenceId: `tool:${Math.floor(i / 8) + 1}:1:${i % 8}`,
      turn: Math.floor(i / 8) + 1,
      step: 1,
      ordinal: i % 8,
      effectId: `tool:${Math.floor(i / 8) + 1}:1:${i % 8}`,
      at: new Date(base + i * 1_000).toISOString(),
      kind: i % 2 === 0 ? "shell" : "mcp",
      target: i % 2 === 0 ? "computer" : "remote:mcp.example.test",
      toolName: i % 2 === 0 ? "computer_exec" : "mcp__example__echo",
      argumentDigest: "a".repeat(64),
      preview: `entry ${i}`,
      outcome: "ok",
    }));
    for (let offset = 0; offset < entries.length; offset += 256) {
      store.insert(entries.slice(offset, offset + 256));
    }

    const seen: string[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = store.query({
        kind: "shell",
        limit: 100,
        ...(cursor === undefined ? {} : { before: cursor }),
      });
      seen.push(...page.entries.map((entry) => entry.occurrenceId));
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 200);

    return {
      total: store.count(),
      shellTotal: store.query({ kind: "shell" }).total,
      pages,
      walked: seen.length,
      firstOccurrenceId: seen[0] ?? "",
      lastOccurrenceId: seen.at(-1) ?? "",
      duplicates: seen.length - new Set(seen).size,
    };
  }

  /** Inserts rows either side of the age horizon and reports what survived. */
  async ageEviction(): Promise<{
    remaining: number;
    state: string;
    oldestKept: string;
  }> {
    const now = Date.parse("2026-09-01T00:00:00.000Z");
    const store = this.store({ maxAgeMs: 180 * 24 * 60 * 60 * 1_000, now });
    const day = 24 * 60 * 60 * 1_000;
    const entries: AuditEntryV1[] = [200, 181, 179, 1].map(
      (daysAgo, index) => ({
        schemaVersion: 1,
        botId: "foreman",
        runId: "run-age",
        occurrenceId: `tool:1:1:${index}`,
        turn: 1,
        step: 1,
        ordinal: index,
        effectId: `tool:1:1:${index}`,
        at: new Date(now - daysAgo * day).toISOString(),
        kind: "shell",
        target: "computer",
        toolName: "computer_exec",
        argumentDigest: "b".repeat(64),
        preview: `aged ${daysAgo}`,
        outcome: "ok",
      }),
    );
    store.insert(entries);
    const kept = store.all();
    return {
      remaining: kept.length,
      state: store.state(),
      oldestKept: kept.at(-1)?.preview ?? "",
    };
  }
}
