// The disposable cleanup a Bot that predates message-cursor unread runs when
// it is next loaded, against a real Bot Durable Object.
//
// The release requires it: a Bot carrying Turn-counted unread state and the
// pending notification projections of the old scheme must come back with that
// state gone — not repaired, and not left to badge a count no message id can
// name — while its conversation and settings survive untouched. Only an
// evicted object can make that claim, because the cleanup runs once, in the
// constructor, before any request or alarm can read the old rows.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";

interface UnreadRpc {
  readUnread(input: unknown): Promise<{
    count: number;
    unread: boolean;
    lastActivityCursor?: string;
    lastMessageId?: string;
    lastMessage?: { text: string; role: string };
  }>;
  listRuns(input: unknown): Promise<{ runs: unknown[] }>;
}

test("an existing Bot drops its old unread state and starts counting messages", async () => {
  const suffix = crypto.randomUUID();
  const identity = {
    schemaVersion: 1 as const,
    userId: `cleanup-user-${suffix}`,
    botId: `cleanup-bot-${suffix}`,
  };
  await provisionBot(identity);
  const name = `${identity.userId}:${identity.botId}`;
  const stub = env.BOT_STATES.getByName(name);
  const rpc = stub as unknown as UnreadRpc;

  // The conversation this Bot already had before the deployment.
  await stub.run({
    ...identity,
    command: {
      runId: `run-before-${suffix}`,
      sessionId: name,
      acceptedAt: "2026-09-01T00:00:00.000Z",
      text: "hello",
    },
  });

  // The Bot as the deployment finds it: unread counted by Turn, and the
  // notification projections the old scheme left pending. The maintenance
  // receipt goes with them, because this Bot was last written by the build
  // that had never heard of the cleanup.
  await runInDurableObject(stub, async (_instance, state) => {
    await state.storage.put({
      "shell:unread": {
        schemaVersion: 1,
        count: 7,
        lastActivityCursor: "2026-09-01T00:00:00.000Z",
        lastActivityAt: "2026-09-01T00:00:00.000Z",
      },
      "notification:run-legacy-1": {
        schemaVersion: 1,
        notificationId: "run-legacy-1",
        runId: "run-legacy-1",
        title: "Sol replied",
        body: "an alert nobody can clear",
      },
      "notification:run-failed:run-legacy-2": {
        schemaVersion: 1,
        notificationId: "run-failed:run-legacy-2",
        runId: "run-legacy-2",
        title: "Sol could not finish",
        body: "an alert nobody can clear",
      },
    });
    await state.storage.delete("maintenance:message-notifications:2026-09-09");
    // The pre-deployment Bot has no message index either: messages were not
    // the unit of unread yet, so the rows this build wrote for the Turn above
    // are removed and the conversation is left as the old build kept it.
    for (const key of [
      ...(await state.storage.list({ prefix: "shell:message:" })).keys(),
    ])
      await state.storage.delete(key);
    await state.storage.delete("shell:message-sequence");
  });

  await evictDurableObject(stub);

  await runInDurableObject(stub, async (_instance, state) => {
    expect(await state.storage.get("shell:unread")).toBeUndefined();
    expect((await state.storage.list({ prefix: "notification:" })).size).toBe(
      0,
    );
    expect(
      await state.storage.get("maintenance:message-notifications:2026-09-09"),
    ).toBeDefined();
  });

  // The conversation itself is not the disposable part.
  const history = await rpc.listRuns({
    ...identity,
    query: { schemaVersion: 1 },
  });
  expect(history.runs.map((run) => (run as { runId: string }).runId)).toContain(
    `run-before-${suffix}`,
  );

  // The badge the person sees after the deployment is empty, not seven.
  expect(await rpc.readUnread(identity)).toMatchObject({
    count: 0,
    unread: false,
  });

  // And a fresh conversation counts again, by the message the transcript
  // draws rather than by the Turn.
  const reply = await stub.run({
    ...identity,
    command: {
      runId: `run-fresh-${suffix}`,
      sessionId: name,
      acceptedAt: "2026-09-10T00:00:00.000Z",
      text: "hello again",
    },
  });
  expect(reply.text).toBe("Ollama reply");

  const badged = await rpc.readUnread(identity);
  expect(badged).toMatchObject({
    count: 1,
    unread: true,
    lastMessageId: `run-fresh-${suffix}:send:0`,
    lastMessage: { text: "Ollama reply", role: "assistant" },
  });
  expect(badged.lastActivityCursor).toMatch(/^message-[0-9]{20}$/);

  // The cleanup is once, not on every load: the new state survives the next
  // eviction.
  await evictDurableObject(stub);
  expect(await rpc.readUnread(identity)).toMatchObject({
    count: 1,
    unread: true,
    lastMessageId: `run-fresh-${suffix}:send:0`,
  });
});
