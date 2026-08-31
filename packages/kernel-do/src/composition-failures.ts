/// <reference types="@cloudflare/workers-types" />
// The Bot Durable Object is the authority for why a Composition generation
// failed to activate and for whether it is quarantined. Failures are durable,
// visible, and repairable: nothing here deletes a recorded failure, and the
// consecutive counter is reset only by a generation that finally activates.
import {
  COMPOSITION_QUARANTINE_THRESHOLD,
  decodeCompositionFailureV1,
  decodeCompositionQuarantineV1,
  type CompositionFailureInputV1,
  type CompositionFailureLog,
  type CompositionFailureOutcomeV1,
  type CompositionFailureV1,
  type CompositionQuarantineV1,
} from "@frockbot/kernel-composition/activation";
import {
  compositionFailureCountKey,
  compositionFailureKey,
  compositionFailurePrefix,
  compositionQuarantineKey,
} from "./storage-keys.js";

export interface DurableCompositionFailureLogOptions {
  state: DurableObjectState;
  /** Injected clock; the quarantine record is stamped with it. */
  now?(): Date;
  /** Consecutive failures that quarantine a generation. Defaults to three. */
  threshold?: number;
}

/**
 * `CompositionFailureLog` over the Bot object's prefixed keys:
 * `composition:failure:<generationId>:<attempt>`,
 * `composition:failure-count:<generationId>`, and
 * `composition:quarantine:<generationId>`.
 *
 * Quarantine is per generation, never per Bot: a later, unrelated generation is
 * unaffected by an earlier one being quarantined.
 */
export class DurableCompositionFailureLog implements CompositionFailureLog {
  private readonly ctx: DurableObjectState;
  private readonly now: () => Date;
  private readonly threshold: number;

  constructor(options: DurableCompositionFailureLogOptions) {
    this.ctx = options.state;
    this.now = options.now ?? (() => new Date());
    this.threshold = options.threshold ?? COMPOSITION_QUARANTINE_THRESHOLD;
  }

  /** The attempt number is assigned here, inside the counter's transaction. */
  async record(
    failure: CompositionFailureInputV1,
  ): Promise<CompositionFailureOutcomeV1> {
    const generationId = failure.generationId;
    return this.ctx.storage.transaction(async (transaction) => {
      const previous =
        (await transaction.get<number>(
          compositionFailureCountKey(generationId),
        )) ?? 0;
      const attempt = previous + 1;
      const recorded = decodeCompositionFailureV1({ ...failure, attempt });
      const quarantined = attempt >= this.threshold;
      const writes: Record<string, unknown> = {
        [compositionFailureKey(generationId, attempt)]: recorded,
        [compositionFailureCountKey(generationId)]: attempt,
      };
      if (quarantined) {
        writes[compositionQuarantineKey(generationId)] =
          decodeCompositionQuarantineV1({
            generationId,
            quarantinedAt: this.now().toISOString(),
            reason: recorded.message,
            failures: attempt,
          });
      }
      await transaction.put(writes);
      return { consecutiveFailures: attempt, quarantined };
    });
  }

  /** Oldest attempt first. */
  async list(generationId: string): Promise<CompositionFailureV1[]> {
    const entries = await this.ctx.storage.list<unknown>({
      prefix: compositionFailurePrefix(generationId),
    });
    return [...entries.values()].map(decodeCompositionFailureV1);
  }

  async quarantine(
    generationId: string,
  ): Promise<CompositionQuarantineV1 | undefined> {
    const stored = await this.ctx.storage.get<unknown>(
      compositionQuarantineKey(generationId),
    );
    return stored === undefined
      ? undefined
      : decodeCompositionQuarantineV1(stored);
  }

  /**
   * A generation that finally activates starts its consecutive count over. The
   * recorded failures survive: they are the repair history a User reads.
   */
  async clear(generationId: string): Promise<void> {
    await this.ctx.storage.delete(compositionFailureCountKey(generationId));
  }
}
