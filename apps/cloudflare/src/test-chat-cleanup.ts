/** One-time cleanup explicitly authorized by the owner for this incident.
 * Remove after the three receipts have been verified in the release.
 * There is deliberately no route, configuration knob, or caller-supplied scope.
 */
const OWNER = "vgpqfaCcwnPlzjYdb2mIfNcOW1YV0SkG";
const BOTS = new Set(["bob-daff7ee3", "native-qa-20260905", "test-n5jJuqCi"]);
const RECEIPT = "maintenance:chat-reset:2026-09-08";
const PREFIXES = [
  "run:",
  "run-index:",
  "session-events:",
  "notification:",
  "shell:unread",
  "shell:preview",
  "shell:approval:",
  "shell:turn-tool-catalog:",
  "stop-receipt:",
  "bot-announcement:",
];
const KEYS = [
  "active-run",
  "pending-run",
  "latest-events",
  "conversation",
  "conversation-index",
  "bot-announcement-sequence",
];

export async function cleanIncidentTestChatsV1(
  storage: DurableObjectStorage,
): Promise<void> {
  const receipt = await storage.transaction(async (tx) => {
    const identity = await tx.get<{ userId: string; botId: string }>(
      "identity",
    );
    if (
      identity?.userId !== OWNER ||
      !BOTS.has(identity.botId) ||
      (await tx.get(RECEIPT))
    )
      return;
    for (const prefix of ["pending-agent-run:", "task-active:"]) {
      if ((await tx.list({ prefix, limit: 1 })).size) return;
    }
    let startAfter: string | undefined;
    for (;;) {
      const page = await tx.list<{ status?: string }>({
        prefix: "run:",
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
