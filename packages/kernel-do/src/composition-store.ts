/// <reference types="@cloudflare/workers-types" />
// The Bot Durable Object is the authority for the Composition generations its
// Turns pin. Generations are durable records: proposing or committing one never
// mutates a recorded generation, and an in-flight Turn keeps the pin it was
// admitted under.
import type { CompositionPinV1 } from "@frockbot/kernel-contracts";
import {
  assertCompositionArtifactSetHashV1,
  compositionGenerationIdV1,
  type CompositionGenerationV1,
  type CompositionOriginV1,
  type CompositionStore,
  decodeCompositionGenerationV1,
} from "@frockbot/kernel-composition/generation";
import {
  COMPOSITION_CURRENT_KEY,
  COMPOSITION_INDEX_PREFIX,
  COMPOSITION_LAST_KNOWN_GOOD_KEY,
  compositionGenerationKey,
  compositionIndexKey,
} from "./storage-keys.js";

const MAX_COMPOSITION_PAGE = 100;

/** The `composition:current` pointer. */
export function decodeCompositionPinV1(input: unknown): CompositionPinV1 {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error("composition pointer is invalid");
  }
  const candidate = input as Record<string, unknown>;
  const keys = ["generationId", "artifactSetHash"];
  if (
    !keys.every((key) => Object.hasOwn(candidate, key)) ||
    !Object.keys(candidate).every((key) => keys.includes(key)) ||
    typeof candidate.generationId !== "string" ||
    candidate.generationId.length === 0 ||
    candidate.generationId.length > 256 ||
    typeof candidate.artifactSetHash !== "string" ||
    !/^[0-9a-f]{64}$/.test(candidate.artifactSetHash)
  ) {
    throw new Error("composition pointer is invalid");
  }
  return {
    generationId: candidate.generationId,
    artifactSetHash: candidate.artifactSetHash,
  };
}

export function compositionPinV1(
  generation: CompositionGenerationV1,
): CompositionPinV1 {
  return {
    generationId: generation.generationId,
    artifactSetHash: generation.artifactSetHash,
  };
}

export interface DurableCompositionStoreOptions {
  state: DurableObjectState;
  /** Builds the first-party generation a Bot starts on. Supplied by the Package. */
  bootstrap(): Promise<CompositionGenerationV1>;
  /** Injected clock; the revert generation is stamped with it. */
  now?(): Date;
}

/**
 * `CompositionStore` over the Bot object's prefixed keys: `composition:current`,
 * `composition:generation:<id>`, `composition:index:<createdAt>:<id>`, and
 * `composition:last-known-good`.
 */
export class DurableCompositionStore implements CompositionStore {
  private readonly ctx: DurableObjectState;
  private readonly buildBootstrap: () => Promise<CompositionGenerationV1>;
  private readonly now: () => Date;

  constructor(options: DurableCompositionStoreOptions) {
    this.ctx = options.state;
    this.buildBootstrap = options.bootstrap;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * First use with no records materializes the bootstrap generation, exactly
   * once, the same way durable identity is materialized.
   */
  async materialize(): Promise<CompositionPinV1> {
    const existing = await this.ctx.storage.get<unknown>(
      COMPOSITION_CURRENT_KEY,
    );
    if (existing !== undefined) return decodeCompositionPinV1(existing);
    const bootstrap = await this.buildBootstrap();
    await assertCompositionArtifactSetHashV1(bootstrap);
    const generation = decodeCompositionGenerationV1({
      ...bootstrap,
      status: "active",
    });
    return this.ctx.storage.transaction(async (transaction) => {
      const current = await transaction.get<unknown>(COMPOSITION_CURRENT_KEY);
      if (current !== undefined) return decodeCompositionPinV1(current);
      const pin = compositionPinV1(generation);
      await transaction.put({
        [compositionGenerationKey(generation.generationId)]: generation,
        [compositionIndexKey(generation.createdAt, generation.generationId)]:
          generation.generationId,
        [COMPOSITION_CURRENT_KEY]: pin,
        [COMPOSITION_LAST_KNOWN_GOOD_KEY]: generation.generationId,
      });
      return pin;
    });
  }

  /** The pinned pointer, read inside the caller's transaction. */
  async pin(transaction: DurableObjectTransaction): Promise<CompositionPinV1> {
    return decodeCompositionPinV1(
      await transaction.get<unknown>(COMPOSITION_CURRENT_KEY),
    );
  }

  async read(
    generationId: string,
  ): Promise<CompositionGenerationV1 | undefined> {
    const stored = await this.ctx.storage.get<unknown>(
      compositionGenerationKey(generationId),
    );
    if (stored === undefined) return undefined;
    const generation = decodeCompositionGenerationV1(stored);
    if (generation.generationId !== generationId) {
      throw new Error("composition generation does not match its lookup key");
    }
    return generation;
  }

  async current(): Promise<CompositionGenerationV1> {
    const pin = await this.materialize();
    return this.require(pin.generationId);
  }

  async lastKnownGood(): Promise<CompositionGenerationV1> {
    await this.materialize();
    const generationId = await this.ctx.storage.get<string>(
      COMPOSITION_LAST_KNOWN_GOOD_KEY,
    );
    if (typeof generationId !== "string" || generationId.length === 0) {
      throw new Error("bot has no last known good Composition generation");
    }
    return this.require(generationId);
  }

  async propose(
    generation: CompositionGenerationV1,
    options: { pin?: boolean } = {},
  ): Promise<void> {
    const proposed = decodeCompositionGenerationV1(generation);
    if (proposed.status !== "pending") {
      throw new Error(
        `composition generation "${proposed.generationId}" must be proposed as pending`,
      );
    }
    await assertCompositionArtifactSetHashV1(proposed);
    await this.materialize();
    await this.ctx.storage.transaction(async (transaction) => {
      const key = compositionGenerationKey(proposed.generationId);
      if ((await transaction.get<unknown>(key)) !== undefined) {
        throw new Error(
          `composition generation "${proposed.generationId}" already exists`,
        );
      }
      await transaction.put({
        [key]: proposed,
        [compositionIndexKey(proposed.createdAt, proposed.generationId)]:
          proposed.generationId,
        // Activation takes effect at the next admitted Turn: the pointer moves
        // now, the status stays pending until that Turn mounts and commits it.
        ...(options.pin
          ? { [COMPOSITION_CURRENT_KEY]: compositionPinV1(proposed) }
          : {}),
      });
    });
  }

  /** How many generations this Bot retains; the per-User retention quota reads it. */
  async retainedCount(): Promise<number> {
    await this.materialize();
    const entries = await this.ctx.storage.list<string>({
      prefix: COMPOSITION_INDEX_PREFIX,
    });
    return entries.size;
  }

  /** Activates a proposed generation and supersedes the one it replaces. */
  async commit(generationId: string): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(
        compositionGenerationKey(generationId),
      );
      if (stored === undefined) {
        throw new Error(`composition generation "${generationId}" is unknown`);
      }
      const generation = decodeCompositionGenerationV1(stored);
      if (generation.generationId !== generationId) {
        throw new Error("composition generation does not match its lookup key");
      }
      // A `failed` generation may still commit: a retry that finally mounts
      // and verifies is exactly what clears a fail-closed activation. A
      // `quarantined` or `superseded` one never does.
      if (
        generation.status !== "pending" &&
        generation.status !== "active" &&
        generation.status !== "failed"
      ) {
        throw new Error(
          `composition generation "${generationId}" is ${generation.status}`,
        );
      }
      const currentPointer = await transaction.get<unknown>(
        COMPOSITION_CURRENT_KEY,
      );
      const previous =
        currentPointer === undefined
          ? undefined
          : decodeCompositionPinV1(currentPointer);
      const active = decodeCompositionGenerationV1({
        ...generation,
        status: "active",
      });
      const writes: Record<string, unknown> = {
        [compositionGenerationKey(generationId)]: active,
        [COMPOSITION_CURRENT_KEY]: compositionPinV1(active),
        [COMPOSITION_LAST_KNOWN_GOOD_KEY]: generationId,
      };
      // The generation being committed may already be the pointer — a proposal
      // pinned for the next Turn is. Superseding its parent is what records
      // that a re-authored Package replaced the member set before it.
      const supersede = new Set<string>();
      if (previous && previous.generationId !== generationId) {
        supersede.add(previous.generationId);
      }
      if (
        generation.parentGenerationId &&
        generation.parentGenerationId !== generationId
      ) {
        supersede.add(generation.parentGenerationId);
      }
      for (const supersededId of supersede) {
        const storedPrevious = await transaction.get<unknown>(
          compositionGenerationKey(supersededId),
        );
        if (storedPrevious === undefined) continue;
        const decoded = decodeCompositionGenerationV1(storedPrevious);
        if (decoded.status !== "active" && decoded.status !== "pending") {
          continue;
        }
        writes[compositionGenerationKey(supersededId)] =
          decodeCompositionGenerationV1({ ...decoded, status: "superseded" });
      }
      await transaction.put(writes);
    });
  }

  /**
   * Fail-closed: records that a generation did not activate. The generation is
   * marked `failed` so the next admitted Turn retries it, or `quarantined` on
   * its third consecutive failure, in which case the pointer moves back to the
   * last known good and the generation is never retried until a User acts.
   */
  async fail(
    generationId: string,
    options: { quarantined: boolean },
  ): Promise<void> {
    await this.ctx.storage.transaction(async (transaction) => {
      const stored = await transaction.get<unknown>(
        compositionGenerationKey(generationId),
      );
      const writes: Record<string, unknown> = {};
      // A pin whose generation record is missing is exactly the `resolve`
      // failure this method exists for: there is no status to write, but the
      // pointer still has to stop naming it once it is quarantined.
      if (stored !== undefined) {
        const generation = decodeCompositionGenerationV1(stored);
        if (generation.status === "active") {
          throw new Error(
            `composition generation "${generationId}" is active and cannot fail closed`,
          );
        }
        const status = options.quarantined ? "quarantined" : "failed";
        writes[compositionGenerationKey(generationId)] =
          decodeCompositionGenerationV1({ ...generation, status });
      }
      if (options.quarantined) {
        const lastKnownGoodId = await transaction.get<string>(
          COMPOSITION_LAST_KNOWN_GOOD_KEY,
        );
        const lastKnownGood =
          lastKnownGoodId === undefined
            ? undefined
            : await transaction.get<unknown>(
                compositionGenerationKey(lastKnownGoodId),
              );
        if (lastKnownGood !== undefined) {
          writes[COMPOSITION_CURRENT_KEY] = compositionPinV1(
            decodeCompositionGenerationV1(lastKnownGood),
          );
        }
      }
      await transaction.put(writes);
    });
  }

  /**
   * Reverting is itself a recorded generation: a **new** pending generation
   * whose members equal the target's, parented on the generation that is
   * current right now. The recorded target is never mutated, and the revert
   * takes effect at the next admitted Turn like any other activation.
   */
  async revert(
    toGenerationId: string,
    origin: Extract<CompositionOriginV1, { kind: "revert" }>,
  ): Promise<CompositionGenerationV1> {
    if (origin.kind !== "revert" || origin.revertsTo !== toGenerationId) {
      throw new Error("composition revert origin does not name its target");
    }
    const current = await this.current();
    if (toGenerationId === current.generationId) {
      throw new Error(
        `composition generation "${toGenerationId}" is already current`,
      );
    }
    const target = await this.read(toGenerationId);
    if (!target) {
      throw new Error(`composition generation "${toGenerationId}" is unknown`);
    }
    const createdAt = this.now().toISOString();
    const generation = decodeCompositionGenerationV1({
      schemaVersion: 1,
      generationId: compositionGenerationIdV1(
        createdAt,
        target.artifactSetHash,
      ),
      artifactSetHash: target.artifactSetHash,
      parentGenerationId: current.generationId,
      createdAt,
      origin,
      members: target.members,
      status: "pending",
    });
    await this.propose(generation);
    return generation;
  }

  /** Newest first; `cursor` continues from the previous page. */
  async list(query: {
    limit: number;
    cursor?: string;
  }): Promise<{ generations: CompositionGenerationV1[]; cursor?: string }> {
    if (!Number.isSafeInteger(query.limit) || query.limit <= 0) {
      throw new Error("composition list limit must be a positive integer");
    }
    if (
      query.cursor !== undefined &&
      !query.cursor.startsWith(COMPOSITION_INDEX_PREFIX)
    ) {
      throw new Error("composition list cursor is invalid");
    }
    await this.materialize();
    const limit = Math.min(query.limit, MAX_COMPOSITION_PAGE);
    const entries = await this.ctx.storage.list<string>({
      prefix: COMPOSITION_INDEX_PREFIX,
      reverse: true,
      limit,
      ...(query.cursor ? { end: query.cursor } : {}),
    });
    const page = [...entries];
    const generations = await Promise.all(
      page.map(([, generationId]) => this.require(generationId)),
    );
    const last = page.at(-1);
    return {
      generations,
      ...(page.length === limit && last ? { cursor: last[0] } : {}),
    };
  }

  private async require(
    generationId: string,
  ): Promise<CompositionGenerationV1> {
    const generation = await this.read(generationId);
    if (!generation) {
      throw new Error(`composition generation "${generationId}" is unknown`);
    }
    return generation;
  }
}
