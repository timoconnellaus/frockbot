/// <reference types="@cloudflare/workers-types" />
// The Durable Object's half of the durable-root generation ledger.
//
// "The Workspace and its object-storage twin are the only durable state
// outside a Durable Object. They hold files, never authority: a Durable Object
// records every intent, effect, and generation that concerns them." Object
// storage holds the bytes; this module holds the authority — which generation
// those bytes are, who wrote them, which entity tag a conditional write must
// match, which losing writes were preserved, and which files were deleted.
//
// It implements `WorkspaceGenerationsV1`, declared in `@frockbot/kernel-
// contracts`, and knows nothing about object storage: the store that consumes
// it supplies etags and conflict keys as opaque strings. That is deliberate.
// The Bot Durable Object owns its own roots; "The User's Durable Object is the
// authority for ... the generation records of User Memory roots", and the same
// class serves either — the owner is whichever object constructs it.
//
// A minted generation id is sortable and strictly increasing across eviction:
// `<milliseconds>-<sequence>`, both zero-padded, with the milliseconds never
// allowed to move backwards. Ordering generations is the one thing the id is
// for, so a clock that jumps backwards must not be able to reorder them.
import {
  decodeWorkspaceGenerationRecordV1,
  workspaceRootKeyV1,
  type WorkspaceGenerationRecordV1,
  type WorkspaceGenerationsV1,
  type WorkspaceRootV1,
} from "@frockbot/kernel-contracts";
import {
  WORKSPACE_GENERATION_CURSOR_KEY,
  workspaceConflictKey,
  workspaceConflictPrefix,
  workspaceGenerationKey,
} from "./storage-keys.js";

/** Most preserved losing writes returned for one file in a single read. */
export const MAX_WORKSPACE_CONFLICT_PAGE = 100;

interface GenerationCursor {
  millis: number;
  sequence: number;
}

function decodeCursor(input: unknown): GenerationCursor {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { millis: 0, sequence: 0 };
  }
  const value = input as Record<string, unknown>;
  const millis = value.millis;
  const sequence = value.sequence;
  if (
    !Number.isSafeInteger(millis) ||
    (millis as number) < 0 ||
    !Number.isSafeInteger(sequence) ||
    (sequence as number) < 0
  ) {
    throw new Error("workspace generation cursor is invalid");
  }
  return { millis: millis as number, sequence: sequence as number };
}

export interface DurableWorkspaceGenerationsOptions {
  state: DurableObjectState;
}

/**
 * `WorkspaceGenerationsV1` over one Durable Object's storage, under the
 * `workspace:` key prefixes.
 */
export class DurableWorkspaceGenerations implements WorkspaceGenerationsV1 {
  private readonly ctx: DurableObjectState;
  /** The cursor, cached while resident; storage remains the authority. */
  private cursor: GenerationCursor | undefined;
  /** Serializes minting, so no two mints can read one cursor. */
  private minting: Promise<void> = Promise.resolve();

  constructor(options: DurableWorkspaceGenerationsOptions) {
    this.ctx = options.state;
  }

  /**
   * The `root` is accepted and unused: this ledger *is* one authority, so
   * every id it mints already orders against every other. Routing a root to
   * the object that owns it happens above, in the Worker.
   *
   * Minting is serialized through `minting`. The cursor is only assigned after
   * an `await` on storage, so two mints that begin before either has read —
   * the ordinary case on a cold object, where nothing is cached — would both
   * read the same cursor and return the same id. Two files would then claim
   * one generation, which is the one thing a generation id exists to prevent.
   */
  async mint(at: Date, _root?: WorkspaceRootV1): Promise<string> {
    const minted = this.minting.then(
      () => this.mintOne(at),
      () => this.mintOne(at),
    );
    this.minting = minted.then(
      () => undefined,
      () => undefined,
    );
    return minted;
  }

  private async mintOne(at: Date): Promise<string> {
    const stored =
      this.cursor ??
      decodeCursor(
        await this.ctx.storage.get<unknown>(WORKSPACE_GENERATION_CURSOR_KEY),
      );
    const millis = Math.max(at.getTime(), stored.millis);
    const next: GenerationCursor = {
      millis,
      sequence: millis === stored.millis ? stored.sequence + 1 : 1,
    };
    this.cursor = next;
    await this.ctx.storage.put(WORKSPACE_GENERATION_CURSOR_KEY, next);
    return `${next.millis.toString().padStart(15, "0")}-${next.sequence
      .toString()
      .padStart(9, "0")}`;
  }

  async current(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<WorkspaceGenerationRecordV1 | undefined> {
    const stored = await this.ctx.storage.get<unknown>(
      workspaceGenerationKey(workspaceRootKeyV1(root), path),
    );
    if (stored === undefined) return undefined;
    return decodeWorkspaceGenerationRecordV1(stored);
  }

  async record(entry: WorkspaceGenerationRecordV1): Promise<void> {
    const decoded = decodeWorkspaceGenerationRecordV1(entry);
    await this.ctx.storage.put(
      workspaceGenerationKey(workspaceRootKeyV1(decoded.root), decoded.path),
      decoded,
    );
  }

  /**
   * A deletion is a recorded generation like any other. Object storage forgets
   * a deleted key, so without this record nothing durable would say the file
   * was removed, by whom, or when — the recovery question a Durable Object
   * exists to answer.
   */
  async tombstone(entry: WorkspaceGenerationRecordV1): Promise<void> {
    const decoded = decodeWorkspaceGenerationRecordV1({
      ...entry,
      deleted: true,
    });
    await this.ctx.storage.put(
      workspaceGenerationKey(workspaceRootKeyV1(decoded.root), decoded.path),
      decoded,
    );
  }

  /**
   * A losing write, preserved beside the winner. It is stored under its own
   * key rather than replacing the current record, so "preserved as a
   * conflicting generation and surfaced, never merged or dropped" is what the
   * storage layout itself says.
   */
  async conflict(entry: WorkspaceGenerationRecordV1): Promise<void> {
    const decoded = decodeWorkspaceGenerationRecordV1(entry);
    await this.ctx.storage.put(
      workspaceConflictKey(
        workspaceRootKeyV1(decoded.root),
        decoded.path,
        decoded.generation.generationId,
      ),
      decoded,
    );
  }

  async conflicts(
    root: WorkspaceRootV1,
    path: string,
  ): Promise<WorkspaceGenerationRecordV1[]> {
    const stored = await this.ctx.storage.list<unknown>({
      prefix: workspaceConflictPrefix(workspaceRootKeyV1(root), path),
      limit: MAX_WORKSPACE_CONFLICT_PAGE,
    });
    return [...stored.values()].map((value) =>
      decodeWorkspaceGenerationRecordV1(value),
    );
  }
}
