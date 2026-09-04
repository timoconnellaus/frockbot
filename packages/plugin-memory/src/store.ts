// The Memory Package's single writer, and the reader that merges shards.
//
// "The Memory Package is the single writer of Memory roots, and within a
// shared root each Bot's shard is written only on that Bot's behalf: it writes
// object storage, every write produces a generation recorded in the owning
// Durable Object, and the Workspace presents Memory roots read-only through
// the durable-root sync."
//
// Every byte in and out of this module goes through `WorkspaceFilesV1`. There
// is no second store, no cache that outlives a call, and — the point of the
// whole design — no Computer type anywhere on the path.
//
// HIBERNATION SEAM. "The Agent loop, Memory, Skills, Package composition, and
// Routines function correctly while the Computer is hibernated and do not wake
// it." Whoever supplies `WorkspaceFilesV1` owns that promise; in production it
// is the object-storage store of ADR 0013, so a read here is an object-storage
// read whether or not a Computer host is running.
import {
  writerOwnsMemoryPathV1,
  type WorkspaceEntryV1,
  type WorkspaceFilesV1,
  type WorkspaceGenerationV1,
  type WorkspaceMemoryRootV1,
  type WorkspacePathV1,
  type WorkspaceReadsV1,
  type WorkspaceWriterV1,
} from "@frockbot/kernel-contracts";
import {
  memoryDayV1,
  memoryFactBodyV1,
  memoryFactKeyV1,
  memoryRetractionTextV1,
  parseMemoryFileV1,
  renderMemoryFileV1,
  resolveMemoryFactsV1,
  sortMemoryFactsV1,
  type MemoryFactV1,
  type SourcedMemoryFactV1,
} from "./facts.js";
import {
  memoryFileKindV1,
  memoryFilePathV1,
  memoryLogPathV1,
  memoryShardOfV1,
  MEMORY_MAX_LOG_PARTS_V1,
  type MemoryOwnerV1,
  type MemoryTierV1,
} from "./roots.js";
import { refuseMemorySecretV1 } from "./secrets.js";

/** Most `list` pages walked before enumeration stops. */
export const MEMORY_MAX_LIST_PAGES = 8;
/** Most Memory files read to render one tier. */
export const MEMORY_MAX_FILES_PER_TIER = 64;

/**
 * How much longer than a fact a retraction of it may be: the `[forgotten] `
 * prefix, and the marker the retracted text may already carry.
 */
const MEMORY_RETRACTION_HEADROOM = 32;

/**
 * The files of one tier that a bounded read keeps, in path order.
 *
 * One function, used by the injected block and by the search index, because
 * they used to choose differently: the block kept the newest files by
 * recorded generation and the index kept the first in listing order. Past the
 * cap that meant injection covered recent Memory while `memory_search`
 * covered ancient Memory, and nothing recorded that they disagreed.
 *
 * The newest are kept, by `writtenAt` with the generation id breaking a tie —
 * both recorded by the write that produced the file — and the survivors are
 * returned in path order, which is the order the tier merge relies on.
 */
export function selectNewestMemoryFilesV1<
  T extends {
    path: { path: string };
    generation: { writtenAt: string; generationId: string };
  },
>(files: readonly T[], limit = MEMORY_MAX_FILES_PER_TIER): T[] {
  const newest = [...files]
    .sort(
      (left, right) =>
        left.generation.writtenAt.localeCompare(right.generation.writtenAt) ||
        left.generation.generationId.localeCompare(
          right.generation.generationId,
        ),
    )
    .slice(-limit);
  const kept = new Set(newest.map((file) => file.path.path));
  return files
    .filter((file) => kept.has(file.path.path))
    .sort((left, right) => left.path.path.localeCompare(right.path.path));
}
/** The longest fact this Package will record. */
export const MEMORY_MAX_FACT_LENGTH = 2_000;
/** The largest Memory file this Package will rewrite. */
export const MEMORY_MAX_FILE_BYTES = 256 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One Memory file the reader consumed, named by its exact generation. */
export interface MemorySourceV1 {
  path: string;
  kind: "profile" | "log";
  botId: string;
  generationId: string;
  contentHash: string;
}

/** One tier, merged across every shard, newest first, retractions applied. */
export interface MemoryTierReadV1 {
  root: WorkspaceMemoryRootV1;
  profile: SourcedMemoryFactV1[];
  recent: SourcedMemoryFactV1[];
  sources: MemorySourceV1[];
  /**
   * How many log facts the tier read resolved. It equals `recent.length`:
   * `read` applies no cap of its own, so there is nothing "beyond" it — the
   * caps live in the renderer. The field was documented as the surplus and
   * assigned the total, which is a difference nothing could act on.
   */
  logTotal: number;
  /** Set when the tier could not be read in full; rendered as an omission. */
  unavailable?: string;
  /**
   * Set when the read completed but a declared bound cut it short, so some
   * Memory on disk never reached this result.
   *
   * Distinct from `unavailable`: the tier *was* read, and the facts here are
   * sound, so a write or a forget against it is still meaningful. What is not
   * sound is treating this read as the whole tier — "an injection gap is
   * visible in durable state rather than silently changing the Bot's
   * behavior", so the renderer turns this into an omission on the tier's scope.
   */
  omitted?: string;
}

export type MemoryWriteOutcomeV1 =
  | {
      status: "ok";
      path: string;
      generationId: string;
      contentHash: string;
      /** True when the fact was already recorded and nothing was written. */
      duplicate: boolean;
    }
  | { status: "refused"; reason: string }
  | { status: "conflict"; reason: string }
  | { status: "unavailable"; reason: string };

/** One file a multi-file change actually rewrote, and the generation it made. */
export interface MemoryFileChangeV1 {
  path: string;
  generationId: string;
  contentHash: string;
}

/**
 * A forget, which may touch more than one file.
 *
 * `written` names every file this call actually rewrote, and it is present on
 * a failure too: a forget that mutates the first of two files and then fails
 * on the second has changed durable state, and "Failures are observable
 * through durable state" means the caller has to be able to record what did
 * change rather than reporting a clean failure the files contradict.
 */
export type MemoryForgetOutcomeV1 = MemoryWriteOutcomeV1 & {
  retracted?: boolean;
  written?: MemoryFileChangeV1[];
};

export interface MemoryStoreOptionsV1 {
  files: WorkspaceFilesV1;
  owner: MemoryOwnerV1;
  /** Display names per Bot id, for the `[via …]` tag. Missing ids show the id. */
  botNames?: Readonly<Record<string, string>>;
  clock?: () => Date;
}

/**
 * The deep module this Package is built on: three public operations over a
 * Workspace file surface, and every rule about shards, dedupe, retraction, and
 * secrets decided inside.
 */
export class MemoryStore {
  readonly owner: MemoryOwnerV1;
  #files: WorkspaceFilesV1;
  #names: Readonly<Record<string, string>>;
  #clock: () => Date;

  constructor(options: MemoryStoreOptionsV1) {
    this.#files = options.files;
    this.owner = options.owner;
    this.#names = options.botNames ?? {};
    this.#clock = options.clock ?? (() => new Date());
  }

  /** The read-only projection the reader half needs, for callers that want it. */
  get reads(): WorkspaceReadsV1 {
    return this.#files;
  }

  /**
   * The name to credit a shared fact to, or nothing.
   *
   * A Bot id is an internal handle, not a name: rendered into the prompt as
   * `[via remy-9d15e086]` the model reads it as something to say out loud and
   * tells the User a sibling's id. With no name to give, the fact is simply
   * uncredited — the fact itself is what the User asked for.
   */
  private via(botId: string): string | undefined {
    return this.#names[botId];
  }

  /**
   * Reads one whole tier: every shard, merged, newest fact winning, with a
   * retraction in any shard suppressing the fact it names.
   */
  async read(root: WorkspaceMemoryRootV1): Promise<MemoryTierReadV1> {
    const result: MemoryTierReadV1 = {
      root,
      profile: [],
      recent: [],
      sources: [],
      logTotal: 0,
    };
    const entries: WorkspaceEntryV1[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MEMORY_MAX_LIST_PAGES; page += 1) {
      const outcome = await this.#files.list(
        cursor === undefined ? { root } : { root, cursor },
      );
      if (outcome.status !== "ok") {
        // "unavailable" is an ordinary answer: a tier that cannot be read
        // contributes no facts and says so, rather than failing the Turn.
        result.unavailable = outcome.reason;
        return result;
      }
      entries.push(...outcome.entries);
      if (!outcome.cursor) {
        cursor = undefined;
        break;
      }
      cursor = outcome.cursor;
    }
    // Every omission this read makes is kept, not the last one: two bounds can
    // both bite, and a caller that refuses on an incomplete read needs to be
    // told everything that was left out rather than whichever omission was
    // written most recently.
    const omissions: string[] = [];
    if (cursor !== undefined) {
      // The listing was still going when the page bound ran out. Some shards
      // were never seen, so this read is not the whole tier and must say so.
      omissions.push(
        `the tier did not finish listing within ${MEMORY_MAX_LIST_PAGES} pages, so some shards were not read`,
      );
    }

    const profile: SourcedMemoryFactV1[] = [];
    const log: SourcedMemoryFactV1[] = [];
    const classifiedFiles = entries
      .flatMap((entry) => {
        const classified = memoryFileKindV1(root, entry.path.path);
        return classified ? [{ entry, classified }] : [];
      })
      // Newest month last, so a merge that ties on day still has an order.
      .sort((left, right) =>
        left.entry.path.path.localeCompare(right.entry.path.path),
      );
    // The bound keeps the *newest* files: what Memory is for is injecting
    // recent facts, so a tier past the bound loses its oldest months rather
    // than its newest. The selection is shared with the search index, so the
    // injected block and `memory_search` cover the same files.
    const selected = selectNewestMemoryFilesV1(
      classifiedFiles.map(({ entry, classified }) => ({
        path: entry.path,
        generation: entry.generation,
        entry,
        classified,
      })),
    );
    const files = selected.map(({ entry, classified }) => ({
      entry,
      classified,
    }));
    if (classifiedFiles.length > files.length) {
      const dropped = classifiedFiles.length - files.length;
      omissions.push(
        `${dropped} Memory file(s) beyond the ${MEMORY_MAX_FILES_PER_TIER}-file read bound were not read; the newest ${MEMORY_MAX_FILES_PER_TIER} were kept`,
      );
    }
    if (omissions.length > 0) result.omitted = omissions.join("; ");

    // Every unreadable file is named, not just the last one. Assigning
    // `result.unavailable` per file overwrote the reason each time, so a tier
    // where three files failed reported one reason and was injected as if it
    // were whole.
    const unreadable: string[] = [];
    for (const { entry, classified } of files) {
      if (entry.generation.size > MEMORY_MAX_FILE_BYTES) {
        unreadable.push(
          `"${entry.path.path}" exceeds ${MEMORY_MAX_FILE_BYTES} bytes`,
        );
        continue;
      }
      const read = await this.#files.read(entry.path);
      if (read.status !== "ok") {
        unreadable.push(`"${entry.path.path}": ${read.reason}`);
        continue;
      }
      result.sources.push({
        path: entry.path.path,
        kind: classified.kind,
        botId: classified.shard,
        generationId: read.file.generation.generationId,
        contentHash: read.file.generation.contentHash,
      });
      const parsed = parseMemoryFileV1(decoder.decode(read.file.bytes));
      const sourced = parsed.map((fact) => ({
        ...fact,
        botId: classified.shard,
        via: this.via(classified.shard),
        kind: classified.kind,
        generationId: read.file.generation.generationId,
      }));
      if (classified.kind === "profile") profile.push(...sourced);
      else log.push(...sourced);
    }

    if (unreadable.length > 0) {
      result.unavailable = `${unreadable.length} Memory file(s) could not be read: ${unreadable.join("; ")}`;
    }

    // Retractions cross files inside a tier: a `[forgotten]` line in the log
    // suppresses the profile fact it names, which is what "newest wins" means
    // once forgetting exists at all.
    const resolved = resolveMemoryFactsV1([...profile, ...log]);
    result.profile = sortMemoryFactsV1(
      resolved.filter((fact) => fact.kind === "profile"),
    );
    result.recent = sortMemoryFactsV1(
      resolved.filter((fact) => fact.kind === "log"),
    );
    result.logTotal = result.recent.length;
    return result;
  }

  /**
   * Records one fact in this Bot's own shard of a root.
   *
   * Refusals come first and are values, not throws: a secret-shaped fact, a
   * fact this writer may not place at this path, an oversized fact. A fact
   * already recorded is answered as a duplicate with no write at all, which is
   * both GrokBot's dedupe and what makes a resumed Turn free.
   */
  async write(request: {
    root: WorkspaceMemoryRootV1;
    tier: MemoryTierV1;
    fact: string;
    writer: WorkspaceWriterV1;
    at?: Date;
    /** Set only by `forget`: a retraction of a fact already on disk. */
    retraction?: true;
  }): Promise<MemoryWriteOutcomeV1> {
    const text = request.fact.trim();
    // The cap bounds what a Bot may *record*. A retraction is a fact the
    // Package writes about a fact that is already on disk, so measuring the
    // retraction against the same cap made a fact longer than
    // `MEMORY_MAX_FACT_LENGTH` minus the prefix impossible to forget — the
    // one operation that shrinks Memory refused because Memory was too big.
    const cap = request.retraction
      ? MEMORY_MAX_FACT_LENGTH + MEMORY_RETRACTION_HEADROOM
      : MEMORY_MAX_FACT_LENGTH;
    if (!text || text.length > cap) {
      return {
        status: "refused",
        reason: `a fact must be between 1 and ${MEMORY_MAX_FACT_LENGTH} characters`,
      };
    }
    const secret = refuseMemorySecretV1(text);
    if (secret) return { status: "refused", reason: secret.reason };
    const at = request.at ?? this.#clock();
    const path = await this.tierWritePath(request.root, request.tier, at);
    if ("status" in path) return path;
    const refusal = this.refuseForeignShard(path, request.writer);
    if (refusal) return refusal;
    const line: MemoryFactV1 = { date: memoryDayV1(at), text };
    return this.rewrite(path, request.writer, (facts) => {
      const key = memoryFactKeyV1(text);
      if (facts.some((fact) => memoryFactKeyV1(fact.text) === key)) {
        return "unchanged";
      }
      return [...facts, line];
    });
  }

  /**
   * The file this tier's next fact goes in, rolling the log over when the
   * current file is full.
   *
   * A log file that grew past the per-file cap used to take its whole tier
   * down with it: the read skips an oversized file, so the tier vanished from
   * injection, and `forget` answered `unavailable` for it, so no tool could
   * trim it back. Rolling to `log/YYYY-MM.NN.md` keeps every fact, keeps
   * every file readable, and needs no migration — the existing month file is
   * part 0 and stays exactly where it is.
   *
   * The profile tier does not roll: it is a bounded, curated file, and one
   * that reached the cap is a real refusal the User should see.
   */
  private async tierWritePath(
    root: WorkspaceMemoryRootV1,
    tier: MemoryTierV1,
    at: Date,
  ): Promise<WorkspacePathV1 | MemoryWriteOutcomeV1> {
    const path = memoryFilePathV1(root, this.owner.botId, tier, at);
    if (tier === "profile") return path;
    for (let part = 0; part <= MEMORY_MAX_LOG_PARTS_V1; part += 1) {
      const candidate = memoryLogPathV1(root, this.owner.botId, at, part);
      const head = await this.#files.stat(candidate);
      if (head.status === "not-found") return candidate;
      if (head.status !== "ok")
        return { status: head.status, reason: head.reason };
      // Room for at least one more fact of the maximum size, so a write never
      // pushes a file past the cap and strands it.
      if (
        head.entry.generation.size + MEMORY_MAX_FACT_LENGTH <
        MEMORY_MAX_FILE_BYTES
      )
        return candidate;
    }
    return {
      status: "refused",
      reason: `this month's Memory log already has ${MEMORY_MAX_LOG_PARTS_V1} files`,
    };
  }

  /**
   * Forgets one fact by its recorded text, ignoring any marker on it.
   *
   * In this Bot's own shard the line is removed. In a shared tier a fact
   * another Bot recorded is *not* edited — "Never edit another assistant's
   * shard" — so the forget is recorded as a retraction in this Bot's own log,
   * and newest-wins does the rest. That is the same correction mechanism
   * GrokBot documents for shared facts, applied to removal.
   *
   * MARKERS. The match is on the marker-stripped body, so `forget("x")`
   * removes `x`, `[note] x` and `[episode] x` alike, and a caller who does
   * pass `[note] x` still matches because the input is stripped too. GrokBot's
   * rule is "forget matches the exact recorded text" (§2.2), and a literal
   * reading of it would make a User unable to forget a note whose `[note] `
   * prefix they were never shown — the marker is a tier the *host* wrote, not
   * a word the User said. The asymmetry with `write`, which still dedupes on
   * the full text, is deliberate and in the safe direction: writing twice
   * keeps both records, forgetting once removes both.
   *
   * A shared fact is retracted once per *recorded* text, because a retraction
   * suppresses the exact text it names: forgetting `x` when another Bot holds
   * `[note] x` writes `[forgotten] [note] x`.
   */
  async forget(request: {
    root: WorkspaceMemoryRootV1;
    fact: string;
    writer: WorkspaceWriterV1;
    at?: Date;
  }): Promise<MemoryForgetOutcomeV1> {
    const text = request.fact.trim();
    if (!text) return { status: "refused", reason: "a fact text is required" };
    const at = request.at ?? this.#clock();
    const key = memoryFactKeyV1(memoryFactBodyV1(text));
    const matches = (candidate: string): boolean =>
      memoryFactKeyV1(memoryFactBodyV1(candidate)) === key;
    const tier = await this.read(request.root);
    if (tier.unavailable) {
      return { status: "unavailable", reason: tier.unavailable };
    }
    if (tier.omitted) {
      // A forget decided on part of a tier is a lie: the fact may sit in a
      // file the read bound cut, and answering "ok" would leave it on disk,
      // injected on the next Turn, with the User told it was forgotten. An
      // incomplete read is therefore an incomplete answer.
      return {
        status: "unavailable",
        reason: `the tier could not be read in full, so a forget cannot be complete: ${tier.omitted}`,
      };
    }

    const mine = [...tier.profile, ...tier.recent].filter(
      (fact) => fact.botId === this.owner.botId && matches(fact.text),
    );
    // Both halves always run. Removing my own line and returning left another
    // Bot's copy of the same fact being injected forever, under a tool result
    // that said "Forgotten. The line is gone from …" — so a shared fact two
    // Bots had recorded came back on the very next Turn.
    const ownWrites: MemoryFileChangeV1[] = [];
    let ownLast: MemoryWriteOutcomeV1 | undefined;
    if (mine.length > 0) {
      // Removing the line from my own shard is permitted and is the honest
      // record for the copies I wrote. Each rewritten file is recorded as it
      // lands, so a failure part-way through still answers with the
      // generations that already exist on disk.
      for (const source of tier.sources) {
        if (source.botId !== this.owner.botId) continue;
        const path: WorkspacePathV1 = { root: request.root, path: source.path };
        const refusal = this.refuseForeignShard(path, request.writer);
        if (refusal) return { ...refusal, written: ownWrites };
        const outcome = await this.rewrite(path, request.writer, (facts) => {
          const kept = facts.filter((fact) => !matches(fact.text));
          return kept.length === facts.length ? "unchanged" : kept;
        });
        if (outcome.status !== "ok") return { ...outcome, written: ownWrites };
        if (!outcome.duplicate) {
          ownLast = outcome;
          ownWrites.push({
            path: outcome.path,
            generationId: outcome.generationId,
            contentHash: outcome.contentHash,
          });
        }
      }
    }

    const elsewhere = [
      ...new Set(
        [...tier.profile, ...tier.recent]
          .filter((fact) => fact.botId !== this.owner.botId)
          .filter((fact) => matches(fact.text))
          .map((fact) => fact.text),
      ),
    ];
    if (elsewhere.length === 0) {
      // Nothing else holds it. My own removal, if there was one, is the whole
      // answer.
      if (ownLast) return { ...ownLast, written: ownWrites };
      return {
        status: "refused",
        reason: `no fact matching "${text}" is recorded in this tier`,
      };
    }
    const written: MemoryFileChangeV1[] = [...ownWrites];
    let last: MemoryWriteOutcomeV1 | undefined = ownLast;
    for (const recorded of elsewhere) {
      const retraction = await this.write({
        root: request.root,
        tier: "log",
        fact: memoryRetractionTextV1(recorded),
        writer: request.writer,
        at,
        retraction: true,
      });
      if (retraction.status !== "ok") return { ...retraction, written };
      last = retraction;
      if (!retraction.duplicate) {
        written.push({
          path: retraction.path,
          generationId: retraction.generationId,
          contentHash: retraction.contentHash,
        });
      }
    }
    if (!last) {
      return {
        status: "refused",
        reason: `no fact matching "${text}" is recorded in this tier`,
      };
    }
    return { ...last, retracted: true, written };
  }

  /**
   * Writes one arbitrary Memory file this Bot owns — the Project descriptor,
   * and nothing else today. It goes through the same shard guard and the same
   * conditional write as a fact, because the constitution's rule is about the
   * root, not about what the bytes mean.
   */
  async writeFile(request: {
    path: WorkspacePathV1;
    text: string;
    writer: WorkspaceWriterV1;
  }): Promise<MemoryWriteOutcomeV1> {
    const bytes = encoder.encode(request.text);
    if (bytes.byteLength > MEMORY_MAX_FILE_BYTES) {
      return { status: "refused", reason: "the Memory file is too large" };
    }
    const secret = refuseMemorySecretV1(request.text);
    if (secret) return { status: "refused", reason: secret.reason };
    if (!writerOwnsMemoryPathV1(request.path, request.writer)) {
      return {
        status: "refused",
        reason: `this writer may not write "${request.path.path}" in this Memory root`,
      };
    }
    const existing = await this.#files.stat(request.path);
    if (existing.status !== "ok" && existing.status !== "not-found") {
      return { status: existing.status, reason: existing.reason };
    }
    return this.commit(
      request.path,
      bytes,
      request.writer,
      existing.status === "ok" ? existing.entry.generation : undefined,
    );
  }

  private refuseForeignShard(
    path: WorkspacePathV1,
    writer: WorkspaceWriterV1,
  ): MemoryWriteOutcomeV1 | undefined {
    // The contract decides ownership; this Package never re-decides it. The
    // store refuses the same write again, so this is an early, legible answer
    // rather than the boundary itself.
    if (writerOwnsMemoryPathV1(path, writer)) return undefined;
    return {
      status: "refused",
      reason: `only the Bot that owns this Memory shard may write "${path.path}"`,
    };
  }

  private async rewrite(
    path: WorkspacePathV1,
    writer: WorkspaceWriterV1,
    change: (facts: MemoryFactV1[]) => MemoryFactV1[] | "unchanged",
  ): Promise<MemoryWriteOutcomeV1> {
    const existing = await this.#files.read(path);
    if (existing.status !== "ok" && existing.status !== "not-found") {
      return { status: existing.status, reason: existing.reason };
    }
    const current: WorkspaceGenerationV1 | undefined =
      existing.status === "ok" ? existing.file.generation : undefined;
    const facts =
      existing.status === "ok"
        ? parseMemoryFileV1(decoder.decode(existing.file.bytes))
        : [];
    const next = change(facts);
    if (next === "unchanged") {
      return {
        status: "ok",
        path: path.path,
        generationId: current?.generationId ?? "",
        contentHash: current?.contentHash ?? "",
        duplicate: true,
      };
    }
    return this.commit(
      path,
      encoder.encode(renderMemoryFileV1(next)),
      writer,
      current,
    );
  }

  private async commit(
    path: WorkspacePathV1,
    bytes: Uint8Array,
    writer: WorkspaceWriterV1,
    current: WorkspaceGenerationV1 | undefined,
  ): Promise<MemoryWriteOutcomeV1> {
    // The cap is checked here rather than only in `writeFile`, because this is
    // the path every fact takes. A commit that sailed past it left a file the
    // read then skipped, taking the whole tier out of injection with no tool
    // able to trim it. A `forget` shrinking an already-oversized file is the
    // one thing that must still get through: refusing it would make the
    // condition unrecoverable.
    if (
      bytes.byteLength > MEMORY_MAX_FILE_BYTES &&
      bytes.byteLength >= (current?.size ?? 0)
    ) {
      return {
        status: "refused",
        reason: `this Memory file would exceed ${MEMORY_MAX_FILE_BYTES} bytes`,
      };
    }
    const outcome = await this.#files.write({
      path,
      bytes,
      writer,
      expectedGenerationId: current?.generationId ?? null,
      mediaType: "text/markdown; charset=utf-8",
    });
    if (outcome.status === "ok") {
      return {
        status: "ok",
        path: path.path,
        generationId: outcome.generation.generationId,
        contentHash: outcome.generation.contentHash,
        duplicate: false,
      };
    }
    if (outcome.status === "conflict") {
      return { status: "conflict", reason: outcome.reason };
    }
    return {
      status: outcome.status === "refused" ? "refused" : "unavailable",
      reason: outcome.reason,
    };
  }
}
