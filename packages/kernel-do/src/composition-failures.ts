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
  COMPOSITION_FAILURE_STREAK_KEY,
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
 * Quarantine is *marked* per generation, never per Bot: a generation an earlier
 * one's quarantine does not implicate is unaffected, and lifting a quarantine
 * is a decision about one generation. What earns a quarantine is either
 * counter reaching the threshold — this generation's own retries, or the Bot's
 * consecutive failures across however many generations the repairs minted.
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
      // Two counters, one threshold. `attempt` is this generation's own
      // retries; `streak` is the Bot's consecutive failures however many
      // generations they are spread over. Only the second one ever moves when
      // the model repairs by authoring a *new* generation, which is what it
      // always does — so without it the safeguard never fired and the
      // Composition grew one dead generation per repair attempt.
      const streak =
        ((await transaction.get<number>(COMPOSITION_FAILURE_STREAK_KEY)) ?? 0) +
        1;
      const quarantined =
        attempt >= this.threshold || streak >= this.threshold;
      const writes: Record<string, unknown> = {
        [compositionFailureKey(generationId, attempt)]: recorded,
        [compositionFailureCountKey(generationId)]: attempt,
        [COMPOSITION_FAILURE_STREAK_KEY]: streak,
      };
      if (quarantined) {
        writes[compositionQuarantineKey(generationId)] =
          decodeCompositionQuarantineV1({
            generationId,
            quarantinedAt: this.now().toISOString(),
            reason: recorded.message,
            // The count that earned it, which is the streak whenever the
            // repairs were spread over generations.
            failures: Math.max(attempt, streak),
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
    await this.ctx.storage.delete([
      compositionFailureCountKey(generationId),
      COMPOSITION_FAILURE_STREAK_KEY,
    ]);
  }
}
