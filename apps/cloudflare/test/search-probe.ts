import { DurableObject } from "cloudflare:workers";

/**
 * The FTS5 spike, kept as a permanent probe.
 *
 * The whole Search Package rests on one fact the Durable Object SQL
 * *authorizer* decides: whether `CREATE VIRTUAL TABLE … USING fts5` is
 * allowed. `workerd` embeds an FTS5-enabled SQLite, but a compiled-in
 * extension and an authorized statement are different things, so this asks the
 * authorizer directly. If it ever stops answering yes, this fails before any
 * suite that assumes it.
 */
export class SearchSpikeProbe extends DurableObject {
  async fts5(): Promise<{
    created: boolean;
    hits: string[];
    failure?: string;
  }> {
    try {
      this.ctx.storage.sql.exec(
        "CREATE VIRTUAL TABLE IF NOT EXISTS spike USING fts5(body, tokenize='unicode61')",
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO spike (body) VALUES (?)",
        "the gym build in Wollongong",
      );
      this.ctx.storage.sql.exec(
        "INSERT INTO spike (body) VALUES (?)",
        "an unrelated line",
      );
      const hits = this.ctx.storage.sql
        .exec<{ s: string }>(
          "SELECT snippet(spike, 0, '', '', '…', 8) AS s FROM spike WHERE spike MATCH ? ORDER BY rank",
          '"wollongong"*',
        )
        .toArray()
        .map((row) => row.s);
      return { created: true, hits };
    } catch (error) {
      return {
        created: false,
        hits: [],
        failure: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
