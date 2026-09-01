// The Memory runtime Contribution.
//
// Four responsibilities, and no authority of its own:
//
//  1. Render the Memory block into the system prompt once per admitted Turn,
//     in GrokBot's shape and order (user → project → own).
//  2. Record what it injected. "the session event log records exactly what was
//     injected, so an injection gap is visible in durable state rather than
//     silently changing the Bot's behavior" — `memory/injected` names every
//     Memory file generation the render read, every fact that reached the
//     prompt, and every tier a cap or a failure cut short.
//  3. Offer the mutation surface GrokBot exposes as `update_state target
//     memory`: `memory_write`, `memory_forget`, and the Project membership
//     trio `project_create` / `project_join` / `project_leave`. Each records
//     intent with an effect identifier *before* the effect runs.
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
} from "@frockbot/kernel-contracts";
// Merges the Agent loop's event declarations into the cordis Context type.
import type {} from "@frockbot/kernel-agent-loop/agent";
import type { Plugin } from "cordis";
import { createMemoryEmbedder } from "./embeddings.js";
import {
  listAllMemoryDocumentsV1,
  type MemoryDocumentV1,
} from "./documents.js";
import {
  buildMemoryIndexV1,
  emptyMemoryIndexV1,
  embedMemoryIndexV1,
  updateMemoryIndexV1,
  type MemoryIndexV1,
} from "./indexer.js";
import {
  parseProjectDocumentV1,
  projectDocumentPathV1,
  renderProjectDocumentV1,
  type MemoryProjectsV1,
} from "./projects.js";
export type {
  MemoryProjectsV1,
  MemoryProjectsOutcomeV1,
  MemoryProjectV1,
} from "./projects.js";
import { memoryDayV1, renderMemoryMarkerV1 } from "./facts.js";
import {
  MEMORY_NOTE_TTL_DAYS,
  renderMemoryInjectionV1,
  type MemoryInjectionV1,
  type MemoryProjectTierV1,
  type MemoryProjectV1,
} from "./render.js";
import {
  botMemoryRootV1,
  isMemoryProjectIdV1,
  memoryScopeRootV1,
  projectMemoryRootV1,
  userMemoryRootV1,
  type MemoryOwnerV1,
  type MemoryTierV1,
} from "./roots.js";
import { formatMemoryResultsV1, searchMemoryV1 } from "./searcher.js";
import { MemoryStore, MEMORY_MAX_FACT_LENGTH } from "./store.js";
import type {
  EmbedMemory,
  MemoryAiBinding,
  MemoryVectorIndex,
} from "./types.js";

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
  projects?: MemoryProjectsV1;
  /** Optional derived-index bindings; Memory is complete without them. */
  vectorize?: MemoryVectorIndex;
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
}

export async function sha256HexV1(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

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
  const started = session.events.findLast(
    (event) => event.type === "step/start",
  );
  const ended = session.events.findLast((event) => event.type === "step/end");
  if (started?.type !== "step/start") {
    throw new Error("a Memory effect has no open step to record against");
  }
  if (
    ended?.type === "step/end" &&
    ended.turn === started.turn &&
    ended.step === started.step
  ) {
    throw new Error("a Memory effect has no open step to record against");
  }
  return { turn: started.turn, step: started.step };
}

/**
 * The Turn-scoped Memory projection. Deep module, small surface: `refresh` is
 * the only way it changes, and `current` is what the prompt and the search
 * tool both read, so those two can never disagree about what this Turn saw.
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
  #turn: number | undefined;

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

  /**
   * Every Memory root this Bot can see this Turn, in tier order.
   *
   * A Project authority that cannot be reached yields no Projects and says so
   * — `unavailable` is an ordinary answer across a Durable Object seam, and a
   * Turn must not fail because membership was briefly unreadable. The gap is
   * carried into `memory/injected` as an omission rather than passing for "no
   * Projects joined".
   */
  async roots(): Promise<{
    own: WorkspaceMemoryRootV1;
    user: WorkspaceMemoryRootV1;
    projects: MemoryProjectV1[];
    unavailable?: string;
  }> {
    const owner = this.#host.owner;
    const roots = {
      own: botMemoryRootV1(owner),
      user: userMemoryRootV1(owner),
    };
    if (!this.#host.projects) return { ...roots, projects: [] };
    try {
      return { ...roots, projects: await this.#host.projects.joined() };
    } catch (error) {
      return {
        ...roots,
        projects: [],
        unavailable: `Project membership could not be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      };
    }
  }

  /** Reads every tier, renders the block, and records the injection. */
  async refresh(turn: number, session: Session): Promise<MemoryInjectionV1> {
    const store = this.#host.store;
    const owner = this.#host.owner;
    const { own, user, projects, unavailable } = await this.roots();
    const ownTier = await store.read(own);
    const userTier = await store.read(user);
    const projectTiers: MemoryProjectTierV1[] = [];
    for (const project of projects) {
      projectTiers.push({
        project,
        tier: await store.read(projectMemoryRootV1(owner, project.projectId)),
      });
    }
    // The fade's cutoff is computed once, here, and recorded below. A render
    // that decided "today" for itself would not replay: "The durable session
    // event log reconstructs … every exact normalized model request, given the
    // Composition generation and Memory generations it records."
    const now = this.#host.clock?.() ?? new Date();
    const noteCutoff = memoryDayV1(
      new Date(now.getTime() - MEMORY_NOTE_TTL_DAYS * 24 * 60 * 60 * 1_000),
    );
    this.#injection = renderMemoryInjectionV1({
      botId: owner.botId,
      own: ownTier,
      user: userTier,
      projects: projectTiers,
      joined: projects,
      noteCutoff,
    });
    if (unavailable) {
      this.#injection.omissions.push({ scope: "project", reason: unavailable });
    }
    this.#turn = turn;

    const sources = [
      ...ownTier.sources.map((source) => ({
        source,
        scope: "bot" as const,
        projectId: "",
      })),
      ...userTier.sources.map((source) => ({
        source,
        scope: "user" as const,
        projectId: "",
      })),
      ...projectTiers.flatMap((entry) =>
        entry.tier.sources.map((source) => ({
          source,
          scope: "project" as const,
          projectId: entry.project.projectId,
        })),
      ),
    ];
    session.append({
      type: "memory/injected",
      turn,
      sources: sources.map(({ source, scope, projectId }) => ({
        scope,
        projectId,
        path: source.path,
        generationId: source.generationId,
        contentHash: source.contentHash,
      })),
      facts: this.#injection.facts,
      omissions: this.#injection.omissions,
      faded: this.#injection.faded,
      noteCutoff,
      noteTtlDays: MEMORY_NOTE_TTL_DAYS,
    });
    await session.flush();

    // The index is derived from the same documents the render just read, so it
    // is refreshed on the same boundary and never outlives the Turn's view.
    await this.reindex();
    return this.#injection;
  }

  /** Rebuilds the derived index incrementally from the current files. */
  async reindex(): Promise<{ documentsChanged: number; chunksTotal: number }> {
    const documents = await this.documents();
    const update = await updateMemoryIndexV1(this.#index, documents);
    this.#index = update.index;
    await this.embed();
    return {
      documentsChanged: update.documentsChanged,
      chunksTotal: update.chunksTotal,
    };
  }

  /** Throws the derived index away and builds it again from the files. */
  async rebuild(): Promise<{ chunksTotal: number }> {
    this.#index = await buildMemoryIndexV1(await this.documents());
    await this.embed();
    return { chunksTotal: this.#index.chunks.length };
  }

  private async documents(): Promise<MemoryDocumentV1[]> {
    const { own, user, projects } = await this.roots();
    return listAllMemoryDocumentsV1(this.#host.store.reads, [
      own,
      user,
      ...projects.map((project) =>
        projectMemoryRootV1(this.#host.owner, project.projectId),
      ),
    ]);
  }

  private async embed(): Promise<void> {
    const embed = memoryEmbedderV1(this.#host);
    if (!embed || !this.#host.vectorize) return;
    try {
      await embedMemoryIndexV1(this.#index, embed, this.#host.vectorize);
    } catch (error) {
      // Embeddings are derived from the files and rebuildable; losing them
      // costs recall quality, never a fact.
      console.error("[memory] embedding the derived index failed", error);
    }
  }

  /** Drops the projection, so the next Turn reloads it rather than reusing it. */
  invalidate(): void {
    this.#injection = { text: "", facts: [], omissions: [], faded: [] };
    this.#index = emptyMemoryIndexV1();
    this.#turn = undefined;
  }
}

function memoryEmbedderV1(host: MemoryRuntimeHostV1): EmbedMemory | undefined {
  if (host.embed) return host.embed;
  if (host.ai) return createMemoryEmbedder(host.ai, host.embeddingModel);
  return undefined;
}

const SCOPE_ENUM = ["bot", "user", "project"] as const;
const TIER_ENUM = ["profile", "log", "note"] as const;

const MEMORY_WRITE_SCHEMA = {
  type: "object",
  properties: {
    scope: {
      type: "string",
      enum: [...SCOPE_ENUM],
      description:
        "bot = your own memory (the default and the most specific); user = shared with every Bot of this User; project = shared with the Bots in one Project you have joined.",
    },
    project: {
      type: "string",
      description: "The Project slug. Required when scope is project.",
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
    project: { type: "string" },
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
  project?: string;
  tier: MemoryTierV1;
  fact: string;
}

function decodeMemoryToolInputV1(
  input: unknown,
  allowTier: boolean,
): MemoryToolInputV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  const allowed = allowTier
    ? ["scope", "project", "tier", "fact"]
    : ["scope", "project", "fact"];
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
  if (scope === "project") {
    if (!isMemoryProjectIdV1(value.project)) {
      throw new Error("the project scope requires a valid Project slug");
    }
    decoded.project = value.project;
  } else if (value.project !== undefined) {
    throw new Error("project is only valid with the project scope");
  }
  return decoded;
}

function refusal(reason: string): ToolExecutionResult {
  return { content: reason, isError: true };
}

/**
 * Refuses a `project`-scope change to a Project this Bot has not joined.
 *
 * "only the Projects a Bot has joined are injected into its prompts", and a
 * Bot that may not read a Project's Memory may not write it either. Membership
 * is durable User-scoped state, so the answer comes from the Project authority
 * through the existing seam, never from anything this Package holds. A
 * membership that cannot be read is a refusal, not an assumption: an
 * unreachable authority must not become an open door.
 */
async function refuseUnjoinedProjectV1(
  host: MemoryRuntimeHostV1,
  scope: MemoryScopeNameV1,
  projectId: string | undefined,
): Promise<string | undefined> {
  if (scope !== "project" || projectId === undefined) return undefined;
  if (!host.projects) {
    return `Project membership is unavailable, so writing Project "${projectId}" memory cannot be authorised`;
  }
  let joined: MemoryProjectV1[];
  try {
    joined = await host.projects.joined();
  } catch (error) {
    return `Project membership could not be read: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (joined.some((project) => project.projectId === projectId)) {
    return undefined;
  }
  return `you have not joined Project "${projectId}"; join it before changing its memory`;
}

/**
 * The provenance one Memory write records. A Bot writes its own shard as
 * itself; the Project descriptor is a User-scoped file the Bot writes with its
 * User's authority, which is the only writer `writerOwnsMemoryPathV1` allows
 * outside a shard and the honest description of creating a Project.
 */
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
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/plugin-subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description:
      "Record one fact in memory. Choose the scope deliberately: bot memory is yours, user memory is shared with every Bot of this User, project memory is shared inside one Project. You always write into your own shard; never try to edit another Bot's.",
    inputSchema: MEMORY_WRITE_SCHEMA as unknown as Record<string, unknown>,
    idempotent: false,
    validate: (input) => {
      try {
        decodeMemoryToolInputV1(input, true);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: MemoryToolInputV1;
      try {
        decoded = decodeMemoryToolInputV1(input, true);
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
      let root: WorkspaceMemoryRootV1;
      try {
        root = memoryScopeRootV1(decoded.scope, host.owner, decoded.project);
      } catch (error) {
        return refusal(
          `memory_write was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const unjoined = await refuseUnjoinedProjectV1(
        host,
        decoded.scope,
        decoded.project,
      );
      if (unjoined) return refusal(`memory_write was refused: ${unjoined}`);
      // One vocabulary: the `note` tier writes the `[note] ` marker through
      // the same renderer the parser is the inverse of, so the tier enum and
      // the on-disk prefix can never drift apart.
      const text = renderMemoryMarkerV1(
        decoded.tier === "note" ? "note" : undefined,
        decoded.fact,
      );
      const contentHash = await sha256HexV1(text);
      const effectId = `memory:write:${decoded.scope}:${decoded.project ?? ""}:${decoded.tier}:${contentHash}`;
      const position = openMemoryTurnPositionV1(session);
      const path = `${decoded.scope}/${decoded.tier}`;
      // Intent before effect.
      session.append({
        type: "memory/write-intent",
        ...position,
        effectId,
        action: "write",
        scope: decoded.scope,
        projectId: decoded.project ?? "",
        tier: decoded.tier,
        path,
        contentHash,
      });
      await session.flush();

      const outcome = await host.store.write({
        root,
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
        projectId: decoded.project ?? "",
        tier: decoded.tier,
        path: outcome.path,
        generationId: outcome.generationId || "duplicate",
        contentHash,
      });
      // The model must not be told it succeeded before the record is durable.
      await session.flush();
      await projection.reindex();
      return {
        content: outcome.duplicate
          ? `That fact was already recorded in ${decoded.scope} memory; nothing changed.`
          : `Recorded in ${decoded.scope} memory (${decoded.tier}) at ${outcome.path} as generation ${outcome.generationId}. It reaches your prompt on your next Turn.`,
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
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/plugin-subagents` `SUBAGENT_TOOL_REACH_V1`.
    admission: { subagentRoles: ["executor"] },
    description:
      "Forget one fact by its exact recorded text. A fact you recorded is removed. A shared fact another Bot recorded is not edited — a retraction is written into your own shard instead, and newest wins.",
    inputSchema: MEMORY_FORGET_SCHEMA as unknown as Record<string, unknown>,
    idempotent: false,
    validate: (input) => {
      try {
        decodeMemoryToolInputV1(input, false);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: MemoryToolInputV1;
      try {
        decoded = decodeMemoryToolInputV1(input, false);
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
      let root: WorkspaceMemoryRootV1;
      try {
        root = memoryScopeRootV1(decoded.scope, host.owner, decoded.project);
      } catch (error) {
        return refusal(
          `memory_forget was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const unjoined = await refuseUnjoinedProjectV1(
        host,
        decoded.scope,
        decoded.project,
      );
      if (unjoined) return refusal(`memory_forget was refused: ${unjoined}`);
      const contentHash = await sha256HexV1(decoded.fact);
      const effectId = `memory:forget:${decoded.scope}:${decoded.project ?? ""}:${contentHash}`;
      const position = openMemoryTurnPositionV1(session);
      session.append({
        type: "memory/write-intent",
        ...position,
        effectId,
        action: "forget",
        scope: decoded.scope,
        projectId: decoded.project ?? "",
        tier: "log",
        path: `${decoded.scope}/forget`,
        contentHash,
      });
      await session.flush();

      const outcome = await host.store.forget({
        root,
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
          projectId: decoded.project ?? "",
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
          ? `That fact was recorded by another Bot, so it was not edited. A retraction is now in your own shard and newest wins, so it stops being injected on your next Turn.`
          : `Forgotten. The line is gone from ${outcome.path}.`,
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
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/plugin-subagents` `SUBAGENT_TOOL_REACH_V1`.
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
      const embed = memoryEmbedderV1(host);
      const results = await searchMemoryV1({
        index: projection.index(),
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
    // A general work tool: the full toolset an `executor` subagent gets, and
    // not part of the narrow reach of `browserUse`, `computerUse`, or the two
    // video roles. See `@frockbot/plugin-subagents` `SUBAGENT_TOOL_REACH_V1`.
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

const PROJECT_SCHEMA = {
  type: "object",
  properties: {
    project: {
      type: "string",
      description: "The Project slug: lowercase letters, digits and hyphens.",
    },
    name: { type: "string", description: "The Project's display name." },
    description: { type: "string" },
  },
  required: ["project"],
  additionalProperties: false,
} as const;

function decodeProjectInputV1(input: unknown): {
  project: string;
  name?: string;
  description?: string;
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("input must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    !Object.keys(value).every((key) =>
      ["project", "name", "description"].includes(key),
    )
  ) {
    throw new Error("input has unknown fields");
  }
  if (!isMemoryProjectIdV1(value.project)) {
    throw new Error("project must be a valid slug");
  }
  const decoded: { project: string; name?: string; description?: string } = {
    project: value.project,
  };
  for (const key of ["name", "description"] as const) {
    const candidate = value[key];
    if (candidate === undefined) continue;
    if (typeof candidate !== "string" || candidate.length > 512) {
      throw new Error(`${key} must be a bounded string`);
    }
    decoded[key] = candidate.trim();
  }
  return decoded;
}

export function createProjectTools(
  host: MemoryRuntimeHostV1 & {
    writer: MemoryWriterIdentityV1;
    projects: MemoryProjectsV1;
  },
  sessions: { get(sessionId: string): Session | undefined },
  projection: MemoryProjection,
): ToolDefinition[] {
  const act = (
    action: "create" | "join" | "leave",
    name: string,
    description: string,
  ): ToolDefinition => ({
    name,
    description,
    inputSchema: PROJECT_SCHEMA as unknown as Record<string, unknown>,
    idempotent: false,
    validate: (input) => {
      try {
        decodeProjectInputV1(input);
        return true;
      } catch {
        return false;
      }
    },
    execute: async (input: unknown, context: ToolExecutionContext) => {
      let decoded: ReturnType<typeof decodeProjectInputV1>;
      try {
        decoded = decodeProjectInputV1(input);
      } catch (error) {
        return refusal(
          `${name} was refused: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const session = sessions.get(context.sessionId);
      if (!session) {
        return refusal(
          `${name} was refused: session "${context.sessionId}" is unavailable, so the intent cannot be recorded`,
        );
      }
      const effectId = `memory:project:${action}:${decoded.project}`;
      const position = openMemoryTurnPositionV1(session);
      session.append({
        type: "memory/project-intent",
        ...position,
        effectId,
        action,
        projectId: decoded.project,
      });
      await session.flush();

      if (action === "create") {
        // The descriptor is a Memory file like any other, so it goes through
        // the same store and the same conditional write. It sits outside any
        // shard, so its writer is the User whose Project it is.
        const project: MemoryProjectV1 = {
          projectId: decoded.project,
          name: decoded.name || decoded.project,
          description: decoded.description ?? "",
        };
        const written = await host.store.writeFile({
          path: {
            root: projectMemoryRootV1(host.owner, decoded.project),
            path: projectDocumentPathV1(decoded.project),
          },
          text: renderProjectDocumentV1(project),
          writer: { kind: "user", userId: host.owner.userId },
        });
        if (written.status !== "ok") {
          // A conflict is not a success. Another writer holds a generation this
          // call never saw, so the descriptor on disk is not the one this Bot
          // asked for; membership is left unchanged and nothing is recorded as
          // changed, rather than logging a Project change that did not happen.
          return refusal(`${name} was ${written.status}: ${written.reason}`);
        }
      }

      const outcome =
        action === "create"
          ? await host.projects.create({
              projectId: decoded.project,
              name: decoded.name || decoded.project,
              description: decoded.description ?? "",
            })
          : action === "join"
            ? await host.projects.join(decoded.project)
            : await host.projects.leave(decoded.project);
      if (outcome.status !== "ok") {
        return refusal(`${name} was refused: ${outcome.reason}`);
      }
      session.append({
        type: "memory/project-changed",
        ...position,
        effectId,
        action,
        projectId: decoded.project,
        projects: outcome.joined.map((project) => project.projectId),
      });
      await session.flush();
      projection.invalidate();
      return {
        content: `Projects you have joined: ${
          outcome.joined.map((project) => project.projectId).join(", ") ||
          "none"
        }. Project memory changes reach your prompt on your next Turn.`,
        isError: false,
      };
    },
  });
  return [
    act(
      "create",
      "project_create",
      "Create a Project and join it. If the slug already exists this joins it instead, exactly as create-is-join.",
    ),
    act("join", "project_join", "Join an existing Project."),
    act(
      "leave",
      "project_leave",
      "Leave a Project. Its shared memory stays on disk; it simply stops loading into your prompt.",
    ),
  ];
}

/** Reads a Project descriptor back out of its Memory root, when one exists. */
export async function readProjectDocumentV1(
  store: MemoryStore,
  owner: MemoryOwnerV1,
  projectId: string,
): Promise<MemoryProjectV1 | undefined> {
  const outcome = await store.reads.read({
    root: projectMemoryRootV1(owner, projectId),
    path: projectDocumentPathV1(projectId),
  });
  if (outcome.status !== "ok") return undefined;
  return parseProjectDocumentV1(
    projectId,
    new TextDecoder().decode(outcome.file.bytes),
  );
}

/**
 * The runtime Contribution. Registers the Memory prompt section, the read
 * tools, and — only when the host supplies Bot provenance — the write tools.
 */
export function createMemoryRuntimePlugin(
  host: MemoryRuntimeHostV1,
): Plugin.Function {
  const plugin: Plugin.Function = (ctx) => {
    const projection = new MemoryProjection(host);
    const disposers: Array<() => void> = [];
    disposers.push(
      ctx.systemPrompt.register({
        id: "memory",
        order: 100,
        render: () => projection.current().text,
      }),
    );
    disposers.push(
      ctx.tools.register(createMemorySearchTool(host, projection)),
    );
    disposers.push(
      ctx.tools.register(createMemoryRebuildIndexTool(projection)),
    );
    if (host.writer) {
      const writing = { ...host, writer: host.writer };
      disposers.push(
        ctx.tools.register(
          createMemoryWriteTool(writing, ctx.sessions, projection),
        ),
      );
      disposers.push(
        ctx.tools.register(
          createMemoryForgetTool(writing, ctx.sessions, projection),
        ),
      );
      if (host.projects) {
        for (const tool of createProjectTools(
          { ...writing, projects: host.projects },
          ctx.sessions,
          projection,
        )) {
          disposers.push(ctx.tools.register(tool));
        }
      }
    }
    disposers.push(
      ctx.on("agent/pre-step", async (agent, _inputs, turn, step, next) => {
        // Once per Turn, at its first step. Memory a Turn writes reaches its
        // own prompt on the next Turn, which is what makes the injected block
        // and the `memory/injected` record describe the same thing.
        if (step === 1 || projection.loadedTurn() !== turn) {
          await projection.refresh(turn, agent.session);
        }
        return next();
      }),
    );
    return () => {
      for (const dispose of disposers.toReversed()) dispose();
      projection.invalidate();
    };
  };
  plugin.inject = ["tools", "systemPrompt", "sessions"];
  return plugin;
}

export default createMemoryRuntimePlugin;
