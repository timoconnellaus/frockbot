// The Bot-to-User usage seam. A settled Turn is already durable before the
// Bot queues these entries, and this adapter deliberately propagates failures
// so the Bot's durable outbox retains them for its next alarm.
import type { UsageEntryV1, UsageSinkV1 } from "@frockbot/plugin-billing";

export interface UserUsageRpcV1 {
  recordUsageEntries(input: unknown): Promise<unknown>;
}

export function createUserUsageSinkV1(
  rpc: UserUsageRpcV1,
  identity: { userId: string; botId: string },
): UsageSinkV1 {
  return {
    async recordEntries(entries: readonly UsageEntryV1[]) {
      if (entries.length === 0) return;
      const owned = entries.filter((entry) => entry.botId === identity.botId);
      if (owned.length === 0) return;
      await rpc.recordUsageEntries({
        schemaVersion: 1,
        userId: identity.userId,
        botId: identity.botId,
        entries: structuredClone(owned),
      });
    },
  };
}
