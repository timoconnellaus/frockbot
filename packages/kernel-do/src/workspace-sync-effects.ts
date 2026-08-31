/// <reference types="@cloudflare/workers-types" />
// The Durable Object's half of the durable-root sync's effect records.
//
// Constitution, Computer and Workspace: "Computer effects are reconcilable. A
// mutation or process launch records intent and an effect identifier in the
// Bot's Durable Object and in the Workspace before it runs, so recovery can
// read its outcome or classify it as unknown without repeating it." The sync
// agent lives in a Computer provider Package and holds no authority of its
// own, so the record it depends on belongs here, in the object that owns the
// root — the same division `DurableWorkspaceGenerations` makes for generations.
//
// It is the same two-key shape the Bot's other effects use (`authorship:
// intent:` / `authorship:artifact:`), reduced to one key: an intent is written
// before the push and removed when the push settles, so "the key is present"
// *is* "this effect was recorded and never reported back". Recovery never
// repeats the write — the sync reads what the store actually holds for that
// path and adopts the generation it finds.
//
// Growth is bounded by settlement in the ordinary case. A connection that
// drops mid-push (which happens on every Computer pause) leaves an intent
// behind, so the store also caps how many unsettled intents it keeps: past the
// cap the oldest are dropped, because an intent so old that the sync has run
// many times since carries no information the store cannot re-derive.
import {
  decodeWorkspaceSyncEffectV1,
  type WorkspaceSyncEffectV1,
  type WorkspaceSyncEffectsV1,
} from "@frockbot/kernel-contracts";
import {
  WORKSPACE_SYNC_EFFECT_PREFIX,
  workspaceSyncEffectKey,
} from "./storage-keys.js";

/** Most unsettled push intents one object keeps before dropping the oldest. */
export const MAX_WORKSPACE_SYNC_EFFECTS = 512;

export interface DurableWorkspaceSyncEffectsOptions {
  state: DurableObjectState;
  /** Overrides the retention cap; the default is the constant above. */
  maximum?: number;
}

/** `WorkspaceSyncEffectsV1` over one Durable Object's storage. */
export class DurableWorkspaceSyncEffects implements WorkspaceSyncEffectsV1 {
  private readonly ctx: DurableObjectState;
  private readonly maximum: number;

  constructor(options: DurableWorkspaceSyncEffectsOptions) {
    this.ctx = options.state;
    this.maximum = options.maximum ?? MAX_WORKSPACE_SYNC_EFFECTS;
  }

  async intent(effect: WorkspaceSyncEffectV1): Promise<void> {
    const decoded = decodeWorkspaceSyncEffectV1(effect);
    await this.ctx.storage.put(
      workspaceSyncEffectKey(decoded.effectId),
      decoded,
    );
    await this.trim();
  }

  async settle(effect: WorkspaceSyncEffectV1): Promise<void> {
    await this.ctx.storage.delete(workspaceSyncEffectKey(effect.effectId));
  }

  async pending(effectId: string): Promise<WorkspaceSyncEffectV1 | undefined> {
    const stored = await this.ctx.storage.get<unknown>(
      workspaceSyncEffectKey(effectId),
    );
    if (stored === undefined) return undefined;
    return decodeWorkspaceSyncEffectV1(stored);
  }

  /** Every intent this object still holds unsettled, oldest first. */
  async unsettled(): Promise<WorkspaceSyncEffectV1[]> {
    const stored = await this.ctx.storage.list<unknown>({
      prefix: WORKSPACE_SYNC_EFFECT_PREFIX,
    });
    return [...stored.values()]
      .map((value) => decodeWorkspaceSyncEffectV1(value))
      .sort((left, right) => left.at.localeCompare(right.at));
  }

  private async trim(): Promise<void> {
    const stored = await this.ctx.storage.list<unknown>({
      prefix: WORKSPACE_SYNC_EFFECT_PREFIX,
    });
    if (stored.size <= this.maximum) return;
    const ordered = [...stored.entries()]
      .map(([key, value]) => {
        try {
          return { key, at: decodeWorkspaceSyncEffectV1(value).at };
        } catch {
          // An undecodable record is the oldest thing there is: drop it first.
          return { key, at: "" };
        }
      })
      .sort((left, right) => left.at.localeCompare(right.at));
    for (const entry of ordered.slice(0, stored.size - this.maximum)) {
      await this.ctx.storage.delete(entry.key);
    }
  }
}
