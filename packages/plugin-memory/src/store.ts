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
  memoryShardOfV1,
  type MemoryOwnerV1,
  type MemoryTierV1,
} from "./roots.js";
import { refuseMemorySecretV1 } from "./secrets.js";

/** Most `list` pages walked before enumeration stops. */
export const MEMORY_MAX_LIST_PAGES = 8;
/** Most Memory files read to render one tier. */
export const MEMORY_MAX_FILES_PER_TIER = 64;
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
  /** Log facts held on disk beyond what `recent` carries, before any cap. */
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

  private via(botId: string): string {
    return this.#names[botId] ?? botId;
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
    if (cursor !== undefined) {
      // The listing was still going when the page bound ran out. Some shards
      // were never seen, so this read is not the whole tier and must say so.
      result.omitted = `the tier did not finish listing within ${MEMORY_MAX_LIST_PAGES} pages, so some shards were not read`;
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
    const files = classifiedFiles.slice(0, MEMORY_MAX_FILES_PER_TIER);
    if (classifiedFiles.length > files.length) {
      const dropped = classifiedFiles.length - files.length;
      result.omitted = `${dropped} Memory file(s) beyond the ${MEMORY_MAX_FILES_PER_TIER}-file read bound were not read`;
    }

    for (const { entry, classified } of files) {
      if (entry.generation.size > MEMORY_MAX_FILE_BYTES) {
        result.unavailable = `a Memory file exceeds ${MEMORY_MAX_FILE_BYTES} bytes`;
        continue;
      }
      const read = await this.#files.read(entry.path);
      if (read.status !== "ok") {
        result.unavailable = read.reason;
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
  }): Promise<MemoryWriteOutcomeV1> {
    const text = request.fact.trim();
    if (!text || text.length > MEMORY_MAX_FACT_LENGTH) {
      return {
        status: "refused",
        reason: `a fact must be between 1 and ${MEMORY_MAX_FACT_LENGTH} characters`,
      };
    }
    const secret = refuseMemorySecretV1(text);
    if (secret) return { status: "refused", reason: secret.reason };
    const at = request.at ?? this.#clock();
    const path = memoryFilePathV1(
      request.root,
      this.owner.botId,
      request.tier,
      at,
    );
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
   * Forgets one fact by its exact recorded text.
   *
   * In this Bot's own shard the line is removed. In a shared tier a fact
   * another Bot recorded is *not* edited — "Never edit another assistant's
   * shard" — so the forget is recorded as a retraction in this Bot's own log,
   * and newest-wins does the rest. That is the same correction mechanism
   * GrokBot documents for shared facts, applied to removal.
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
    const key = memoryFactKeyV1(text);
    const tier = await this.read(request.root);
    if (tier.unavailable) {
      return { status: "unavailable", reason: tier.unavailable };
    }

    const mine = [...tier.profile, ...tier.recent].filter(
      (fact) =>
        fact.botId === this.owner.botId && memoryFactKeyV1(fact.text) === key,
    );
    if (mine.length > 0) {
      // The Bot owns every file the fact sits in, so removing the line is both
      // permitted and the honest record: nothing else recorded it.
      let last: MemoryWriteOutcomeV1 | undefined;
      // Each rewritten file is recorded as it lands, so a failure part-way
      // through still answers with the generations that already exist on disk.
      const written: MemoryFileChangeV1[] = [];
      for (const source of tier.sources) {
        if (source.botId !== this.owner.botId) continue;
        const path: WorkspacePathV1 = { root: request.root, path: source.path };
        const refusal = this.refuseForeignShard(path, request.writer);
        if (refusal) return { ...refusal, written };
        const outcome = await this.rewrite(path, request.writer, (facts) => {
          const kept = facts.filter(
            (fact) => memoryFactKeyV1(fact.text) !== key,
          );
          return kept.length === facts.length ? "unchanged" : kept;
        });
        if (outcome.status !== "ok") return { ...outcome, written };
        if (!outcome.duplicate) {
          last = outcome;
          written.push({
            path: outcome.path,
            generationId: outcome.generationId,
            contentHash: outcome.contentHash,
          });
        }
      }
      if (last) return { ...last, written };
    }

    const elsewhere = [...tier.profile, ...tier.recent].some(
      (fact) =>
        fact.botId !== this.owner.botId && memoryFactKeyV1(fact.text) === key,
    );
    if (!elsewhere) {
      return {
        status: "refused",
        reason: `no fact matching "${text}" is recorded in this tier`,
      };
    }
    const retraction = await this.write({
      root: request.root,
      tier: "log",
      fact: memoryRetractionTextV1(text),
      writer: request.writer,
      at,
    });
    return retraction.status === "ok"
      ? { ...retraction, retracted: true }
      : retraction;
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
