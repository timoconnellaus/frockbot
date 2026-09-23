import {
  ACTIVE_RUN_KEY,
  IDENTITY_KEY,
  LATEST_EVENTS_KEY,
  NOTIFICATION_PREFIX,
  PENDING_AGENT_RUN_PREFIX,
  PENDING_USER_RUN_PREFIX,
  RUN_INDEX_PREFIX,
  RUN_PREFIX,
  SESSION_EVENT_LOG_PREFIX,
} from "@frockbot/core/durable";

/** One-time cleanup explicitly authorized by the owner for this incident.
 * Remove after the receipts have been verified in the release.
 * There is deliberately no route, configuration knob, or caller-supplied scope.
 */
const OWNER = "vgpqfaCcwnPlzjYdb2mIfNcOW1YV0SkG";
const BOTS = new Set([
  "bob-daff7ee3",
  "native-qa-20260905",
  "test-n5jJuqCi",
  // Its retired events also prevent rebuilding the account's search index.
  "test-99860758",
]);
const RECEIPT = "maintenance:chat-reset:2026-09-08";
const PREFIXES = [
  RUN_PREFIX,
  RUN_INDEX_PREFIX,
  SESSION_EVENT_LOG_PREFIX,
  NOTIFICATION_PREFIX,
  "shell:unread",
  "shell:preview",
  "shell:approval:",
  "shell:turn-tool-catalog:",
  "stop-receipt:",
  "bot-announcement:",
  PENDING_USER_RUN_PREFIX,
];
const KEYS = [
  ACTIVE_RUN_KEY,
  LATEST_EVENTS_KEY,
  "conversation",
  "conversation-index",
  "bot-announcement-sequence",
];

export async function cleanIncidentTestChatsV1(
  storage: DurableObjectStorage,
): Promise<void> {
  const receipt = await storage.transaction(async (tx) => {
    const identity = await tx.get<{ userId: string; botId: string }>(
      IDENTITY_KEY,
    );
    if (
      identity?.userId !== OWNER ||
      !BOTS.has(identity.botId) ||
      (await tx.get(RECEIPT))
    )
      return;
    for (const prefix of [PENDING_AGENT_RUN_PREFIX, "task-active:"]) {
      if ((await tx.list({ prefix, limit: 1 })).size) return;
    }
    let startAfter: string | undefined;
    for (;;) {
      const page = await tx.list<{ status?: string }>({
        prefix: RUN_PREFIX,
        limit: 64,
        ...(startAfter ? { startAfter } : {}),
      });
      if ([...page.values()].some((run) => run.status === "running")) return;
      if (page.size < 64) break;
      startAfter = [...page.keys()].at(-1);
    }
    let deletedKeys = 0;
    for (const prefix of PREFIXES) {
      for (;;) {
        const page = await tx.list({ prefix, limit: 64 });
        if (!page.size) break;
        deletedKeys += await tx.delete([...page.keys()]);
      }
    }
    deletedKeys += await tx.delete(KEYS);
    const result = {
      schemaVersion: 1,
      botId: identity.botId,
      deletedKeys,
      completedAt: new Date().toISOString(),
    };
    await tx.put(RECEIPT, result);
    return result;
  });
  if (receipt) console.info({ event: "incident-chat-cleanup", ...receipt });
}
