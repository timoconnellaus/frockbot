// The Memory runtime Contribution.
//
// Four responsibilities, and no authority of its own:
//
//  1. Render the Memory block into the system prompt once per admitted Turn,
//     in GrokBot's shape and order (user → own), with the canonical core —
//     a Group Chat's shared Memory among it, in that group's Turns — ahead.
//  2. Record what it injected. "the session event log records exactly what was
//     injected, so an injection gap is visible in durable state rather than
//     silently changing the Bot's behavior" — `memory/injected` names every
//     Memory file generation the render read, every fact that reached the
//     prompt, and every tier a cap or a failure cut short.
//  3. Offer the mutation surface GrokBot exposes as `update_state target
//     memory`: `memory_write` and `memory_forget`. Each records intent with an
//     effect identifier *before* the effect runs.
//  4. Keep the derived index in step with the files, and offer
//     `memory_rebuild_index` so the derived half can always be thrown away.
//
// It never calls the Computer interface and never wakes a Computer; the seam
// is documented on `MemoryStore`.
import type {
  Session,
  ToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  WorkspaceMemoryRootV1,
  WorkspaceWriterV1,
  MemoryScopeNameV1,
  AgentRuntimeV1,
  RuntimeFeatureV1,
} from "@frockbot/core/contracts";
import { latestOpenStepPositionV1 } from "@frockbot/core/contracts";
import { createConcurrencyLimiterV1 } from "@frockbot/core/concurrency";
import { sha256HexTextV1 } from "@frockbot/core/crypto";
import { createMemoryEmbedder } from "./embeddings.js";
import {
  readAllMemoryDocumentsV1,
  type MemoryDocumentListingV1,
} from "./documents.js";
import {
  buildMemoryIndexV1,
  emptyMemoryIndexV1,
  embedMemoryIndexV1,
  memoryChunkVectorIdV1,
  updateMemoryIndexV1,
  type MemoryIndexV1,
} from "./indexer.js";
import type { MemoryChunkIndexWriterV1 } from "./chunk-index.js";
import type { MemoryGroupsV1 } from "./groups.js";
import { isGroupIdV1 } from "@frockbot/app/groups/shared";
import { renderMemoryMarkerV1 } from "./facts.js";
import {
  MEMORY_NOTE_TTL_DAYS,
  renderMemoryInjectionV1,
  type MemoryInjectionV1,
} from "./render.js";
import {
  botMemoryRootV1,
  memoryScopeRootV1,
  userMemoryRootV1,
  type MemoryOwnerV1,
  type MemoryTierV1,
} from "./roots.js";
import { formatMemoryResultsV1, searchMemoryV1 } from "./searcher.js";
import { MemoryStore, MEMORY_MAX_FACT_LENGTH } from "./store.js";
import { readLongTermMemoryV1 } from "./reader.js";
import {
  emptyMemoryTurnRecallV1,
  noteMemoryRecallV1,
  planMemoryRecallV1,
  recallBlocksFromHitsV1,
  renderCanonicalMemoryInjectionV1,
  renderMemoryRequestMessagesV1,
  type MemoryTurnRecallV1,
} from "./context.js";
import { authorityOf, type MemoryRecordsHostV1 } from "./engine-tools.js";
import { explicitDatesInQueryV1 } from "./hybrid.js";
import { isControlOnlyMemoryInputV1 } from "./policy.js";
import { memoryDayV1 } from "./facts.js";
import {
  productScopeToEngineV1,
  type MemoryAuthorityV1,
  type MemoryScopeRefV1,
  type MemoryHitV1,
} from "./records.js";
import type {
  EmbedMemory,
  MemoryAiBinding,
  MemoryVectorIndex,
} from "./types.js";
import type { MemoryRecordsV1 } from "./owner.js";
import {
  createMemoryBrowseTool,
  createMemoryExpandTool,
  executeRecordsForgetV1,
  executeRecordsSearchV1,
  executeRecordsWriteV1,
} from "./engine-tools.js";

/** Bot write provenance: the Session and Turn that recorded a fact. */
export interface MemoryWriterIdentityV1 {
  sessionId: string;
  turnId: string;
  runId: string;
}

/**
 * The host seam this Package receives, supplied by the Durable Object for one
 * admitted Turn. `files` and `writer` are present only when the Turn may
 * write, so a Bot cannot change Memory outside a Turn whose Session and Turn
 * its provenance can name.
 */
export interface MemoryRuntimeHostV1 {
  owner: MemoryOwnerV1;
  store: MemoryStore;
  writer?: MemoryWriterIdentityV1;
  /** The Group Chats this Bot is a member of: the group scopes it may use. */
  groups?: MemoryGroupsV1;
  /**
   * The Group Chat this Turn speaks in, when it is a group's. Its shared
   * Memory joins the Bot's own and its User's in the prompt and in recall.
   */
  group?: string;
  /** Optional derived-index bindings; Memory is complete without them. */
  vectorize?: MemoryVectorIndex;
  /** Durable ledger for vectors derived from this Bot's own Memory root. */
  chunkIndex?: MemoryChunkIndexWriterV1;
  embed?: EmbedMemory;
  ai?: MemoryAiBinding;
  embeddingModel?: string;
  /**
   * The Turn's clock, for the note-fade cutoff only. Defaults to the wall
   * clock; injected by tests so a fade can be driven without waiting a
   * fortnight. Nothing else in this Package reads it — `MemoryStore` keeps its
   * own, because a write's date is decided where the write happens.
   */
  clock?: () => Date;
  /**
   * Canonical SQLite Memory. When present, injection, recall and writes use
   * it. The Markdown store is not a second source of truth on that path.
   */
  records?: MemoryRecordsV1;
  /**
   * Orders what recall found by how much each bears on the request, dropping
   * what bears on nothing. Absent, or when it cannot say, recall keeps its
   * own order.
   */
  rankRecall?(input: {
    request: string;
    hits: readonly MemoryHitV1[];
  }): Promise<readonly MemoryHitV1[]>;
  /** Judges a fact against what is kept before a records write; see engine-tools. */
  judgeWrite?: MemoryRecordsHostV1["judgeWrite"];
}

export const sha256HexV1 = sha256HexTextV1;

/** The turn and step a Memory effect is recorded under. */
export interface MemoryTurnPositionV1 {
  turn: number;
  step: number;
}

/**
 * The open step a Memory event belongs to. The session log is the
 * reconstruction surface, so an event without its turn and step would not
 * replay in place.
 */
export function openMemoryTurnPositionV1(
  session: Session,
): MemoryTurnPositionV1 {
  const position = latestOpenStepPositionV1(session);
  if (!position) {
    throw new Error("a Memory effect has no open step to record against");
  }
  return position;
}

/**
 * The Turn-scoped Memory projection. `refresh` captures the exact document
 * snapshot injected into this Turn's prompt. `ensureIndex` lazily derives the
 * search index from that same snapshot, so prompt and search never disagree
 * about what this Turn saw even though embeddings stay off the reply path —
 * with one exception: a snapshot that could not be read whole is never applied
 * as this Turn's index, so it is deferred, and the search after it reads the
 * files again.
 */
export class MemoryProjection {
  #host: MemoryRuntimeHostV1;
  #injection: MemoryInjectionV1 = {
    text: "",
    facts: [],
    omissions: [],
    faded: [],
  };
  #index: MemoryIndexV1 = emptyMemoryIndexV1();
  #indexReady = false;
  #indexEpoch = 0;
  #indexing:
    | Promise<{
        documentsChanged: number;
        chunksTotal: number;
        deferred?: true;
      }>
    | undefined;
  #turn: number | undefined;
  #recall: MemoryTurnRecallV1 = emptyMemoryTurnRecallV1();
  #recallStatus = "empty";
  /**
   * The documents this Turn's tier reads already decoded, kept for the index
   * built from that snapshot on the first search. Taken exactly once and
   * cleared: a reindex after `memory_write` or `memory_forget` is reindexing
   * files that just changed, and must read them rather than trust what the
   * render saw.
   */
  #rendered: MemoryDocumentListingV1 | undefined;
  constructor(host: MemoryRuntimeHostV1) {
    this.#host = host;
  }

  current(): MemoryInjectionV1 {
    return this.#injection;
  }

  index(): MemoryIndexV1 {
    return this.#index;
  }

  loadedTurn(): number | undefined {
    return this.#turn;
  }

  /** Reads every tier, renders the block, and records the injection. */
  async refresh(turn: number, session: Session): Promise<MemoryInjectionV1> {
    // Canonical Memory is what `memory_write` records now. The file tiers
    // still render: a note fades at read time, and a shard keeps the headings
    // the conversation has always shown. A fact already in that text is not
    // repeated from the core.
    const store = this.#host.store;
    const owner = this.#host.owner;
    this.#rendered = undefined;
    // The tiers are independent roots, so they are read side by side under
    // one limiter: the budget is spent where the round trips are — on each
    // tier's files — and the ceiling stays what the helper says it is.
    const inFlight = createConcurrencyLimiterV1();
    const [ownTier, userTier] = await Promise.all([
      readLongTermMemoryV1(store, botMemoryRootV1(owner), { inFlight }),
      readLongTermMemoryV1(store, userMemoryRootV1(owner), { inFlight }),
    ]);
    // The fade's cutoff is computed once, here, and recorded below. A render
    // that decided "today" for itself would not replay: "The durable session
    // event log reconstructs … every exact normalized model request, given the
    // Composition generation and Memory generations it records."
    const now = this.#host.clock?.() ?? new Date();
    const noteCutoff = memoryDayV1(
      new Date(now.getTime() - MEMORY_NOTE_TTL_DAYS * 24 * 60 * 60 * 1_000),
    );
    this.#injection = renderMemoryInjectionV1({
      own: ownTier,
      user: userTier,
      noteCutoff,
    });
    const canonicalSources: Array<{
      scope: MemoryScopeNameV1;
      groupId: string;
      path: string;
      generationId: string;
      contentHash: string;
    }> = [];
    if (this.#host.records) {
      const canonical = await this.loadCanonical();
      canonicalSources.push(...canonical.sources);
      const extra = canonical.facts.filter(
        (fact) =>
          fact.text.length > 0 && !this.#injection.text.includes(fact.text),
      );
      if (extra.length > 0) {
        const rank = (scope: string) =>
          scope === "user" ? 0 : scope === "group" ? 1 : 2;
        extra.sort((left, right) => rank(left.scope) - rank(right.scope));
        // Ahead of the file block, in the same scope order that block uses,
        // so a fact recorded only in canonical Memory is where a reader of
        // the file render looks first.
        this.#injection = {
          ...this.#injection,
          text: [
            "<memory>",
            ...extra.map((fact) => fact.text),
            "</memory>",
            this.#injection.text,
          ]
            .filter((line) => line.length > 0)
            .join("\n"),
          facts: [...extra, ...this.#injection.facts],
        };
      }
    }
    this.#turn = turn;

    const sources = [
      ...ownTier.sources.map((source) => ({ source, scope: "bot" as const })),
      ...userTier.sources.map((source) => ({ source, scope: "user" as const })),
    ];
    session.append({
      type: "memory/injected",
      turn,
      sources: [
        ...sources.map(({ source, scope }) => ({
          scope,
          groupId: "",
          path: source.path,
          generationId: source.generationId,
          contentHash: source.contentHash,
        })),
        ...canonicalSources,
      ],
      facts: this.#injection.facts,
      omissions: this.#injection.omissions,
      faded: this.#injection.faded,
      noteCutoff,
      noteTtlDays: MEMORY_NOTE_TTL_DAYS,
    });
    await session.flush();

    // The index is derived from the same documents the render just read. Keep
    // that exact snapshot for `memory_search`, but do not spend embedding or
    // vector-store work on a Turn that never searches: `ensureIndex` builds the
    // index on first use.
    const tiers = [ownTier, userTier];
    this.#rendered = {
      documents: tiers.flatMap((tier) => tier.documents),
      complete: tiers.every((tier) => !tier.unavailable && !tier.omitted),
    };
    this.#indexReady = false;
    return this.#injection;
  }

  /**
   * Prepared core from the canonical engine. No Memory-file walk.
   * Recalled blocks are rendered later, beside the current turn.
   */
  private async loadCanonical(): Promise<{
    facts: MemoryInjectionV1["facts"];
    sources: Array<{
      scope: MemoryScopeNameV1;
      groupId: string;
      path: string;
      generationId: string;
      contentHash: string;
    }>;
  }> {
    const records = this.#host.records;
    if (!records) return { facts: [], sources: [] };
    this.#recall = emptyMemoryTurnRecallV1();
    this.#recallStatus = "empty";
    const authority = await turnAuthorityV1(this.#host);
    const scopes = memoryScopesForHostV1(this.#host, authority);
    const core = await records.preparedCore({
      authority,
      scopes,
      budget: 1_024,
    });
    const learnedAt = memoryDayV1(this.#host.clock?.() ?? new Date());
    const rendered = renderCanonicalMemoryInjectionV1({
      blocks: core.blocks,
      omissions: core.omissions,
      learnedAt,
    });
    return {
      facts: rendered.facts,
      sources: core.blocks.flatMap((block) =>
        block.manifest.map((leaf) => ({
          scope: engineScopeName(block.scope.kind),
          groupId:
            block.scope.kind === "groupChat"
              ? (block.scope.groupChatId ?? "")
              : "",
          path: `item:${leaf.itemId}`,
          generationId: String(leaf.generation),
          contentHash: String(block.generation),
        })),
      ),
    };
  }

  async recallForTurn(query: string, signature: string): Promise<void> {
    const records = this.#host.records;
    if (!records) return;
    const authority = await turnAuthorityV1(this.#host);
    const dates = explicitDatesInQueryV1(query);
    const recalled = await records.recall({
      authority,
      query,
      scopes: memoryScopesForHostV1(this.#host, authority),
      effort: "automatic",
      ...(dates.occurredFrom ? { filters: dates } : {}),
    });
    this.#recallStatus = recalled.status;
    const hits =
      this.#host.rankRecall && recalled.hits.length > 0
        ? await this.#host.rankRecall({ request: query, hits: recalled.hits })
        : recalled.hits;
    noteMemoryRecallV1(this.#recall, signature, recallBlocksFromHitsV1(hits));
  }

  renderMessages(
    messages: Parameters<typeof renderMemoryRequestMessagesV1>[0],
  ) {
    const records = this.#host.records;
    return renderMemoryRequestMessagesV1(messages, {
      blocks: this.#recall.blocks,
      status: this.#recallStatus,
      coreTokens: this.#injection.text
        ? new TextEncoder().encode(this.#injection.text).byteLength + 16
        : 0,
      active: (itemId, generation) => {
        if (!records) return true;
        const scopes = [
          productScopeToEngineV1("bot", this.#host.owner),
          productScopeToEngineV1("user", this.#host.owner),
        ];
        const seen = scopes.map((scope) =>
          records.engine.itemVisibility(scope, itemId, generation),
        );
        if (seen.includes("inactive")) return false;
        return true;
      },
    });
  }

  recallState(): MemoryTurnRecallV1 {
    return this.#recall;
  }

  /**
   * Builds and returns this Turn's derived index on the first search that can
   * build one. A Turn that never searches performs no embedding or
   * vector-store work.
   */
  async ensureIndex(): Promise<MemoryIndexV1> {
    if (!this.#indexReady) await this.startIndex();
    return this.#index;
  }

  private async startIndex(): Promise<{
    documentsChanged: number;
    chunksTotal: number;
    deferred?: true;
  }> {
    if (this.#indexReady) {
      return Promise.resolve({
        documentsChanged: 0,
        chunksTotal: this.#index.chunks.length,
      });
    }
    if (this.#indexing) {
      const result = await this.#indexing;
      if (result.deferred) return result;
      return this.#indexReady ? result : this.startIndex();
    }
    const epoch = this.#indexEpoch;
    const indexing = this.reindexCurrent(epoch).then(
      (result) => {
        if (epoch === this.#indexEpoch) {
          this.#indexReady = !result.deferred;
        } else {
          // An invalidation won the race while this snapshot's embeddings
          // were still being built. It must never republish the
          // pre-invalidation index.
          this.#index = emptyMemoryIndexV1();
          this.#indexReady = false;
        }
        if (this.#indexing === indexing) this.#indexing = undefined;
        return result;
      },
      (error: unknown) => {
        if (this.#indexing === indexing) this.#indexing = undefined;
        throw error;
      },
    );
    this.#indexing = indexing;
    const result = await indexing;
    if (result.deferred) return result;
    return this.#indexReady ? result : this.startIndex();
  }

  /**
   * Rebuilds the derived index incrementally from the current files.
   *
   * A listing that could not be read whole updates nothing. The indexer reads
   * an absent document as a deleted one, so applying a short listing turned a
   * transient object-storage blip into a permanent, silent deletion of that
   * document's chunks — `memory_search` simply found less, with no event and
   * no omission to say why. Keeping the previous index costs at worst one
   * stale chunk until the next Turn.
   */
  async reindex(): Promise<{
    documentsChanged: number;
    chunksTotal: number;
    /** True when the files could not be read whole and nothing was applied. */
    deferred?: true;
  }> {
    // A write or forget may arrive while the speculative build is still in
    // flight. Let that snapshot finish, then discard its rendered-file shortcut
    // and read the generations the mutation actually produced.
    if (this.#indexing) await this.#indexing;
    this.#rendered = undefined;
    this.#indexReady = false;
    return this.startIndex();
  }

  private async reindexCurrent(epoch: number): Promise<{
    documentsChanged: number;
    chunksTotal: number;
    /** True when the files could not be read whole and nothing was applied. */
    deferred?: true;
  }> {
    const listing = await this.documents();
    if (!listing.complete) {
      return {
        documentsChanged: 0,
        chunksTotal: this.#index.chunks.length,
        deferred: true,
      };
    }
    const update = await updateMemoryIndexV1(this.#index, listing.documents);
    if (epoch !== this.#indexEpoch) {
      return {
        documentsChanged: update.documentsChanged,
        chunksTotal: update.chunksTotal,
      };
    }
    const current = await this.embed(update.index, epoch);
    if (current && epoch === this.#indexEpoch) this.#index = update.index;
    return {
      documentsChanged: update.documentsChanged,
      chunksTotal: update.chunksTotal,
    };
  }

  /**
   * Throws the derived index away and builds it again from the files.
   *
   * An explicit rebuild on a partial listing is refused rather than half
   * done: "rebuild the index" that quietly drops what it could not read is
   * worse than a rebuild that says it could not run.
   */
  async rebuild(): Promise<{ chunksTotal: number; deferred?: true }> {
    if (this.#indexing) await this.#indexing;
    this.#rendered = undefined;
    this.#indexReady = false;
    const epoch = this.#indexEpoch;
    const rebuilding = (async () => {
      const listing = await this.documents();
      if (!listing.complete) {
        return {
          documentsChanged: 0,
          chunksTotal: this.#index.chunks.length,
          deferred: true as const,
        };
      }
      const index = await buildMemoryIndexV1(listing.documents);
      if (epoch === this.#indexEpoch) {
        const current = await this.embed(index, epoch);
        if (current && epoch === this.#indexEpoch) this.#index = index;
      }
      return {
        documentsChanged: 0,
        chunksTotal: index.chunks.length,
      };
    })().then(
      (result) => {
        if (epoch === this.#indexEpoch) {
          this.#indexReady = !result.deferred;
        } else {
          this.#index = emptyMemoryIndexV1();
          this.#indexReady = false;
        }
        if (this.#indexing === rebuilding) this.#indexing = undefined;
        return result;
      },
      (error: unknown) => {
        if (this.#indexing === rebuilding) this.#indexing = undefined;
        throw error;
      },
    );
    this.#indexing = rebuilding;
    const result = await rebuilding;
    if (epoch !== this.#indexEpoch) return this.rebuild();
    return {
      chunksTotal: result.chunksTotal,
      ...(result.deferred ? { deferred: true } : {}),
    };
  }

  private async documents(): Promise<MemoryDocumentListingV1> {
    const rendered = this.#rendered;
    this.#rendered = undefined;
    if (rendered) return rendered;
    return readAllMemoryDocumentsV1(this.#host.store.reads, [
      botMemoryRootV1(this.#host.owner),
      userMemoryRootV1(this.#host.owner),
    ]);
  }

  /**
   * Mirrors a built index into the vector store, when one is configured, and
   * answers whether the epoch it was built for is still current. An index
   * invalidated while it was embedding records no vector id in the chunk
   * ledger and upserts nothing, so a superseded build never reaches the store;
   * the caller publishes the in-memory index on the same answer.
   */
  private async embed(index: MemoryIndexV1, epoch: number): Promise<boolean> {
    const embed = memoryEmbedderV1(this.#host);
    if (!embed || !this.#host.vectorize) return epoch === this.#indexEpoch;
    try {
      await embedMemoryIndexV1(index, embed, this.#host.vectorize, {
        isCurrent: () => epoch === this.#indexEpoch,
        beforePublish: async () => {
          if (epoch !== this.#indexEpoch) return false;
          if (this.#host.chunkIndex) {
            const ownVectorIds = await Promise.all(
              index.chunks
                .filter(
                  (chunk) =>
                    chunk.scope === "bot" &&
                    chunk.botId === this.#host.owner.botId,
                )
                .map(memoryChunkVectorIdV1),
            );
            if (epoch !== this.#indexEpoch) return false;
            // Intent before effect: a crash after this write and
            // before/during the upsert leaves at worst an id whose delete is
            // a harmless no-op.
            await this.#host.chunkIndex.record(ownVectorIds);
          }
          return epoch === this.#indexEpoch;
        },
      });
      if (epoch !== this.#indexEpoch) return false;
    } catch (error) {
      // Embeddings are derived from the files and rebuildable; losing them
      // costs recall quality, never a fact.
      console.error("[memory] embedding the derived index failed", error);
    }
    return epoch === this.#indexEpoch;
  }

  /** Drops the projection, so the next Turn reloads it rather than reusing it. */
  invalidate(): void {
    this.#indexEpoch += 1;
    this.#injection = { text: "", facts: [], omissions: [], faded: [] };
    this.#index = emptyMemoryIndexV1();
    this.#indexReady = false;
    this.#turn = undefined;
    this.#rendered = undefined;
  }
}

function memoryEmbedderV1(host: MemoryRuntimeHostV1): EmbedMemory | undefined {
  if (host.embed) return host.embed;
  if (host.ai) return createMemoryEmbedder(host.ai, host.embeddingModel);
  return undefined;
}

const SCOPE_ENUM = ["bot", "user", "group"] as const;
const TIER_ENUM = ["profile", "log", "note"] as const;

const MEMORY_WRITE_SCHEMA = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: [...SCOPE_ENUM],
      description:
        "bot = your own memory (the default and the most specific); user = shared with every Bot of this User; group = shared with the members of one group chat you are in.",
    },
    group_id: {
      type: "string",
      description:
        "The group chat's id. With scope group; in a group chat it defaults to that group.",
    },
    tier: {
      type: "string",
      enum: [...TIER_ENUM],
      description:
        "profile = a foundational fact kept in mind every turn; log = dated history (the default); note = something that fades fast.",
    },
    fact: {
      type: "string",
      description: "One complete sentence, exactly as it should be recorded.",
    },
  },
  required: ["fact"],
  additionalProperties: false,
} as const;

const MEMORY_FORGET_SCHEMA = {
  type: "object",
  properties: {
    scope: { type: "string", enum: [...SCOPE_ENUM] },
    group_id: { type: "string" },
    fact: {
      type: "string",
      description: "The exact recorded text of the fact to forget.",
    },
  },
  required: ["fact"],
  additionalProperties: false,
} as const;

interface MemoryToolInputV1 {
  scope: MemoryScopeNameV1;
  groupId?: string;
  tier: MemoryTierV1;
  fact: string;
}

function decodeMemoryToolInputV1(
  input: unknown,
  allowTier: boolean,
  group?: string,
): MemoryToolInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = allowTier
    ? ["scope", "group_id", "tier", "fact"]
    : ["scope", "group_id", "fact"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    throw new Error("input has unknown fields");
  }
  const fact = value.fact;
  if (
    typeof fact !== "string" ||
    fact.trim().length === 0 ||
    fact.length > MEMORY_MAX_FACT_LENGTH
  ) {
    throw new Error("fact must be a bounded non-empty string");
  }
  const scope = value.scope ?? "bot";
  if (!SCOPE_ENUM.includes(scope as MemoryScopeNameV1)) {
    throw new Error("scope is invalid");
  }
  const tier = allowTier ? (value.tier ?? "log") : "log";
  if (!TIER_ENUM.includes(tier as MemoryTierV1)) {
    throw new Error("tier is invalid");
  }
  const decoded: MemoryToolInputV1 = {
    scope: scope as MemoryScopeNameV1,
    tier: tier as MemoryTierV1,
    fact: fact.trim(),
  };
  if (scope === "group") {
    const groupId = value.group_id ?? group;
    if (!isGroupIdV1(groupId)) {
      throw new Error("the group scope requires the group chat's group_id");
    }
    decoded.groupId = groupId;
  } else if (value.group_id !== undefined) {
    throw new Error("group_id is only valid with the group scope");
  }
  return decoded;
}

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

/** The provenance one Memory write records: the Bot, writing its own shard. */
function botWriterV1(
  owner: MemoryOwnerV1,
  writer: MemoryWriterIdentityV1,
): WorkspaceWriterV1 {
  return {
    kind: "bot",
    botId: owner.botId,
    sessionId: writer.sessionId,
    turnId: writer.turnId,
    runId: writer.runId,
  };
}

export function createMemoryWriteTool(
  host: MemoryRuntimeHostV1 & { writer: MemoryWriterIdentityV1 },
  sessions: { get(sessionId: string): Session | undefined },
  projection: MemoryProjection,
): ToolDefinition {
  return {
    name: "memory_write",
    namespace: "frockbot",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/app/subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description:
      "Record one fact in memory. Choose the scope deliberately: bot memory is yours, user memory is shared with every Bot of this User, group memory is shared by the members of one group chat. You always write into your own shard; never try to edit another Bot's.",
    inputSchema: MEMORY_WRITE_SCHEMA as unknown as Record<string, unknown>,
    idempotent: false,
    validate: (input) => {
      try {
        decodeMemoryToolInputV1(input, true, host.group);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: MemoryToolInputV1;
      try {
        decoded = decodeMemoryToolInputV1(input, true, host.group);
      } catch (error) {
        return refusal(
          `memory_write was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const session = sessions.get(context.sessionId);
      if (!session) {
        return refusal(
          `memory_write was refused: session "${context.sessionId}" is unavailable, so the intent cannot be recorded`,
        );
      }
      // A group's Memory is canonical only; it has no file root.
      if (decoded.scope === "group" && !host.records) {
        return refusal(
          `memory_write was refused: group memory is not available here`,
        );
      }
      // One vocabulary: the `note` tier writes the `[note] ` marker through
      // the same renderer the parser is the inverse of, so the tier enum and
      // the on-disk prefix can never drift apart.
      const text = renderMemoryMarkerV1(
        decoded.tier === "note" ? "note" : undefined,
        decoded.fact,
      );
      const contentHash = await sha256HexV1(text);
      const effectId = `memory:write:${decoded.scope}:${decoded.groupId ?? ""}:${decoded.tier}:${contentHash}`;
      const position = openMemoryTurnPositionV1(session);
      const path = `${decoded.scope}/${decoded.tier}`;
      // Intent before effect.
      session.append({
        type: "memory/write-intent",
        ...position,
        effectId,
        action: "write",
        scope: decoded.scope,
        groupId: decoded.groupId ?? "",
        tier: decoded.tier,
        path,
        contentHash,
      });
      await session.flush();

      if (host.records) {
        const result = await executeRecordsWriteV1(
          { ...host, records: host.records },
          decoded,
          effectId,
        );
        if (!result.isError) {
          session.append({
            type: "memory/written",
            ...position,
            effectId,
            action: "write",
            scope: decoded.scope,
            groupId: decoded.groupId ?? "",
            tier: decoded.tier,
            path: `${decoded.scope}/${decoded.tier}`,
            generationId: "records",
            contentHash,
          });
          await session.flush();
        }
        return result;
      }

      const outcome = await host.store.write({
        root: memoryScopeRootV1(decoded.scope as "bot" | "user", host.owner),
        tier: decoded.tier,
        fact: text,
        writer: botWriterV1(host.owner, host.writer),
      });
      if (outcome.status !== "ok") {
        return refusal(`memory_write was ${outcome.status}: ${outcome.reason}`);
      }
      session.append({
        type: "memory/written",
        ...position,
        effectId,
        action: "write",
        scope: decoded.scope,
        groupId: decoded.groupId ?? "",
        tier: decoded.tier,
        path: outcome.path,
        generationId: outcome.generationId || "duplicate",
        contentHash,
      });
      // The model must not be told it succeeded before the record is durable.
      await session.flush();
      await projection.reindex();
      return {
        // What the model paraphrases to the user. A path, a generation id
        // and "it reaches your prompt on your next Turn" are this Package's
        // mechanics, and we watched a Bot read them straight back to someone
        // who had only said where they lived.
        content: outcome.duplicate
          ? `Already remembered; nothing changed.`
          : `Remembered.`,
        isError: false,
      };
    },
  };
}

export function createMemoryForgetTool(
  host: MemoryRuntimeHostV1 & { writer: MemoryWriterIdentityV1 },
  sessions: { get(sessionId: string): Session | undefined },
  projection: MemoryProjection,
): ToolDefinition {
  return {
    name: "memory_forget",
    namespace: "frockbot",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/app/subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description:
      "Forget one fact by its exact recorded text. A fact you recorded is removed. A shared fact another Bot recorded is not edited — a retraction is written into your own shard instead, and newest wins.",
    inputSchema: MEMORY_FORGET_SCHEMA as unknown as Record<string, unknown>,
    idempotent: false,
    validate: (input) => {
      try {
        decodeMemoryToolInputV1(input, false, host.group);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: MemoryToolInputV1;
      try {
        decoded = decodeMemoryToolInputV1(input, false, host.group);
      } catch (error) {
        return refusal(
          `memory_forget was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const session = sessions.get(context.sessionId);
      if (!session) {
        return refusal(
          `memory_forget was refused: session "${context.sessionId}" is unavailable, so the intent cannot be recorded`,
        );
      }
      // A group's Memory is canonical only; it has no file root.
      if (decoded.scope === "group" && !host.records) {
        return refusal(
          `memory_forget was refused: group memory is not available here`,
        );
      }
      const contentHash = await sha256HexV1(decoded.fact);
      const effectId = `memory:forget:${decoded.scope}:${decoded.groupId ?? ""}:${contentHash}`;
      const position = openMemoryTurnPositionV1(session);
      session.append({
        type: "memory/write-intent",
        ...position,
        effectId,
        action: "forget",
        scope: decoded.scope,
        groupId: decoded.groupId ?? "",
        // A forget is not a tier and has no path until it has run: it may
        // rewrite the profile file, one or more log files, or write a
        // retraction. Naming `log` and `<scope>/forget` here made the intent
        // disagree with its own outcome — a forget of a profile fact recorded
        // `tier: "log", path: "bot/forget"` and then `path: "profile.md"`.
        // `pending` says plainly that the files are not known yet.
        tier: "pending",
        path: "",
        contentHash,
      });
      await session.flush();

      if (host.records) {
        const result = await executeRecordsForgetV1(
          { ...host, records: host.records },
          decoded,
          effectId,
        );
        if (!result.isError) {
          session.append({
            type: "memory/written",
            ...position,
            effectId,
            action: "forget",
            scope: decoded.scope,
            groupId: decoded.groupId ?? "",
            tier: "log",
            path: "",
            generationId: "records",
            contentHash,
          });
          await session.flush();
        }
        return result;
      }

      const outcome = await host.store.forget({
        root: memoryScopeRootV1(decoded.scope as "bot" | "user", host.owner),
        fact: decoded.fact,
        writer: botWriterV1(host.owner, host.writer),
      });
      // A forget can span more than one of this Bot's files. Whatever it
      // rewrote is durable whether or not the whole call succeeded, so the
      // event log records each rewritten file before the outcome is reported;
      // otherwise the log would claim nothing changed while the files disagree.
      const changed =
        outcome.written && outcome.written.length > 0
          ? outcome.written
          : outcome.status === "ok"
            ? [
                {
                  path: outcome.path,
                  generationId: outcome.generationId,
                  contentHash,
                },
              ]
            : [];
      for (const file of changed) {
        session.append({
          type: "memory/written",
          ...position,
          effectId,
          action: "forget",
          scope: decoded.scope,
          groupId: decoded.groupId ?? "",
          tier: "log",
          path: file.path,
          generationId: file.generationId || "unchanged",
          contentHash,
        });
      }
      if (changed.length > 0) await session.flush();
      if (outcome.status !== "ok") {
        return refusal(
          changed.length > 0
            ? `memory_forget was ${outcome.status} after changing ${changed.length} file(s) (${changed
                .map((file) => file.path)
                .join(", ")}): ${outcome.reason}`
            : `memory_forget was ${outcome.status}: ${outcome.reason}`,
        );
      }
      await projection.reindex();
      return {
        content: outcome.retracted
          ? `Forgotten. Another of your Bots had recorded it too, and it will stop coming up for them as well.`
          : `Forgotten.`,
        isError: false,
      };
    },
  };
}

const MEMORY_SEARCH_SCHEMA = {
  type: "object",
  properties: {
    query: { type: "string", minLength: 1, maxLength: 500 },
    scope: { type: "string", enum: [...SCOPE_ENUM] },
    maxResults: { type: "integer", minimum: 1, maximum: 20 },
  },
  required: ["query"],
  additionalProperties: false,
} as const;

interface MemorySearchInputV1 {
  query: string;
  scope?: MemoryScopeNameV1;
  maxResults?: number;
}

/**
 * Decodes `memory_search` input at the seam, exactly as the write tools do.
 *
 * "every inbound value is decoded at its seam" — a tool argument arrives from
 * a model, so it is inbound, and being read-only buys it no exemption: an
 * unknown key or an out-of-range `maxResults` is a refusal, never a value the
 * searcher is handed unchecked.
 */
function decodeMemorySearchInputV1(input: unknown): MemorySearchInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = ["query", "scope", "maxResults"];
  if (!Object.keys(value).every((key) => allowed.includes(key))) {
    throw new Error("input has unknown fields");
  }
  const query = value.query;
  if (
    typeof query !== "string" ||
    query.trim().length === 0 ||
    query.length > 500
  ) {
    throw new Error("query must be a bounded non-empty string");
  }
  const decoded: MemorySearchInputV1 = { query: query.trim() };
  if (value.scope !== undefined) {
    if (!SCOPE_ENUM.includes(value.scope as MemoryScopeNameV1)) {
      throw new Error("scope is invalid");
    }
    decoded.scope = value.scope as MemoryScopeNameV1;
  }
  if (value.maxResults !== undefined) {
    const maxResults = value.maxResults;
    if (
      !Number.isSafeInteger(maxResults) ||
      (maxResults as number) < 1 ||
      (maxResults as number) > 20
    ) {
      throw new Error("maxResults must be an integer between 1 and 20");
    }
    decoded.maxResults = maxResults as number;
  }
  return decoded;
}

export function createMemorySearchTool(
  host: MemoryRuntimeHostV1,
  projection: MemoryProjection,
): ToolDefinition {
  return {
    name: "memory_search",
    namespace: "frockbot",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/app/subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description:
      "Search your memory files for anything the injected block did not carry. Your prompt holds only the most recent capped selection; the rest is on disk.",
    inputSchema: MEMORY_SEARCH_SCHEMA as unknown as Record<string, unknown>,
    idempotent: true,
    validate: (input) => {
      try {
        decodeMemorySearchInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown) => {
      let value: MemorySearchInputV1;
      try {
        value = decodeMemorySearchInputV1(input);
      } catch (error) {
        return refusal(
          `memory_search was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (host.records) {
        return executeRecordsSearchV1(
          { ...host, records: host.records },
          value,
        );
      }
      const embed = memoryEmbedderV1(host);
      const index = await projection.ensureIndex();
      const results = await searchMemoryV1({
        index,
        query: value.query,
        maxResults: value.maxResults ?? 5,
        ...(value.scope ? { scope: value.scope } : {}),
        ...(embed ? { embed } : {}),
        ...(host.vectorize ? { vectorize: host.vectorize } : {}),
      });
      return {
        content: formatMemoryResultsV1(results),
        isError: false,
      };
    },
  };
}

export function createMemoryRebuildIndexTool(
  projection: MemoryProjection,
): ToolDefinition {
  return {
    name: "memory_rebuild_index",
    namespace: "frockbot",
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/app/subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description:
      "Throw away the derived memory index and build it again from the memory files. Safe at any time: the index holds no facts, only a way of finding them.",
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    } as unknown as Record<string, unknown>,
    idempotent: true,
    validate: () => true,
    execute: async () => {
      const rebuilt = await projection.rebuild();
      return {
        content: `Rebuilt the memory index from the files: ${rebuilt.chunksTotal} chunk(s).`,
        isError: false,
      };
    },
  };
}

/**
 * The runtime Contribution. Registers the Memory prompt section, the read
 * tools, and — only when the host supplies Bot provenance — the write tools.
 */
export function createMemoryRuntimeFeature(
  host: MemoryRuntimeHostV1,
): RuntimeFeatureV1<AgentRuntimeV1> {
  return (runtime) => {
    const projection = new MemoryProjection(host);
    const disposers: Array<() => void> = [];
    disposers.push(
      runtime.systemPrompt.register({
        id: "memory",
        order: 100,
        render: () => projection.current().text,
      }),
    );
    disposers.push(
      runtime.tools.register(createMemorySearchTool(host, projection)),
    );
    if (host.records) {
      disposers.push(
        runtime.tools.register(
          createMemoryExpandTool({ ...host, records: host.records }),
        ),
      );
      disposers.push(
        runtime.tools.register(
          createMemoryBrowseTool({ ...host, records: host.records }),
        ),
      );
    } else {
      disposers.push(
        runtime.tools.register(createMemoryRebuildIndexTool(projection)),
      );
    }
    if (host.writer) {
      const writing = { ...host, writer: host.writer };
      disposers.push(
        runtime.tools.register(
          createMemoryWriteTool(writing, runtime.sessions, projection),
        ),
      );
      disposers.push(
        runtime.tools.register(
          createMemoryForgetTool(writing, runtime.sessions, projection),
        ),
      );
    }
    disposers.push(
      runtime.hooks.add({
        preStep: async (agent, inputs, turn, step, next) => {
          // Once per Turn, at its first step. Memory a Turn writes reaches its
          // own prompt on the next Turn, which is what makes the injected
          // block and the `memory/injected` record describe the same thing.
          if (step === 1 || projection.loadedTurn() !== turn) {
            try {
              await projection.refresh(turn, agent.session);
            } catch (error) {
              // Memory is remote, and a remote read that throws used to fail
              // the whole Turn as `model-error`. A Turn with no Memory is a
              // worse Turn; a Turn that does not happen is no Turn at all. The
              // gap is recorded so it is visible in durable state rather than
              // being a silent change in the Bot's behaviour.
              agent.session.append({
                type: "memory/injected",
                turn,
                sources: [],
                facts: [],
                omissions: [
                  {
                    scope: "bot",
                    reason:
                      error instanceof Error
                        ? error.message
                        : "Memory could not be read for this Turn",
                  },
                ],
              });
              await agent.session.flush();
            }
          }
          if (host.records) {
            const userText =
              step === 1
                ? inputs.map((input) => input.text).join("\n")
                : agent.session.activeRunJournal
                    .flatMap((event) =>
                      event.type === "user/message" && event.turn === turn
                        ? [event.text]
                        : [],
                    )
                    .join("\n");
            const toolTexts =
              step === 1
                ? []
                : agent.session.activeRunJournal.flatMap((event) =>
                    event.type === "tool/result" &&
                    event.turn === turn &&
                    !event.name.startsWith("memory_")
                      ? [event.content]
                      : [],
                  );
            const plan = planMemoryRecallV1({
              userText,
              toolTexts,
              state: projection.recallState(),
              step,
            });
            if (plan) {
              try {
                await projection.recallForTurn(plan.query, plan.signature);
              } catch {
                // A timed-out or failed channel is a partial recall, not a
                // failed Turn. The model still has its tools.
              }
            }
          }
          return next();
        },
      }),
    );
    disposers.push(
      runtime.hooks.add({
        messageWindow: async (
          _agent,
          messages,
          _turn,
          _step,
          _signal,
          next,
        ) => {
          const windowed = await next();
          if (!host.records) return windowed;
          return projection.renderMessages(windowed);
        },
      }),
    );
    if (host.records && host.writer) {
      const records = host.records;
      const writer = host.writer;
      disposers.push(
        runtime.hooks.add({
          turnStopping: async (agent, turn) => {
            const text = agent.session.activeRunJournal
              .flatMap((event) =>
                event.type === "user/message" && event.turn === turn
                  ? [event.text]
                  : [],
              )
              .join("\n")
              .trim()
              .slice(0, 8_000);
            if (!text || isControlOnlyMemoryInputV1(text)) return;
            try {
              const authority = await turnAuthorityV1(host);
              // A group's thread is the group's to remember: what its Turns
              // read is extracted into the group's shared Memory.
              const destination =
                host.group && authority.joinedGroupChatIds.includes(host.group)
                  ? productScopeToEngineV1("group", host.owner, host.group)
                  : undefined;
              records.captureExtraction({
                authority,
                scope: productScopeToEngineV1("bot", host.owner),
                ...(destination ? { destinationScope: destination } : {}),
                principal: {
                  userId: host.owner.userId,
                  botId: host.owner.botId,
                  actor: "bot",
                  turnId: writer.turnId,
                  sessionId: writer.sessionId,
                  runId: writer.runId,
                },
                source: {
                  sourceId: `${writer.sessionId}:${turn}`,
                  sourceRevision: writer.runId,
                  kind: "chat",
                  locator: {
                    kind: "chat",
                    botId: host.owner.botId,
                    sessionId: writer.sessionId,
                    runId: writer.runId,
                    eventSeq: turn,
                    revision: writer.runId,
                  },
                  capturedText: text,
                },
              });
            } catch {
              // The Turn already settled. The obligation is retried only when
              // this capture itself committed; a throw here is visible as a
              // missing job, not a second writer.
            }
          },
        }),
      );
    }
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
      projection.invalidate();
    };
  };
}

/**
 * The authority a Turn's own reads and capture run under. Only a group's Turn
 * draws on a group's Memory, so only it reads the membership; a Bot's own
 * chat spends no round trip on it. The tools read it whenever they run.
 */
function turnAuthorityV1(
  host: Pick<MemoryRuntimeHostV1, "owner" | "groups" | "group">,
): Promise<MemoryAuthorityV1> {
  return authorityOf(
    host.group && host.groups
      ? { owner: host.owner, groups: host.groups }
      : { owner: host.owner },
  );
}

function engineScopeName(kind: string): MemoryScopeNameV1 {
  if (kind === "user") return "user";
  if (kind === "groupChat") return "group";
  return "bot";
}

/**
 * The scopes a Turn's prompt and automatic recall draw on: the Bot's own, its
 * User's, and — in a group's Turn, while the Bot is still a member — that
 * group's. Other groups the Bot is in are reached with the tools.
 */
function memoryScopesForHostV1(
  host: Pick<MemoryRuntimeHostV1, "owner" | "group">,
  authority: Pick<MemoryAuthorityV1, "joinedGroupChatIds">,
): MemoryScopeRefV1[] {
  return [
    productScopeToEngineV1("bot", host.owner),
    productScopeToEngineV1("user", host.owner),
    ...(host.group && authority.joinedGroupChatIds.includes(host.group)
      ? [productScopeToEngineV1("group", host.owner, host.group)]
      : []),
  ];
}

export default createMemoryRuntimeFeature;
