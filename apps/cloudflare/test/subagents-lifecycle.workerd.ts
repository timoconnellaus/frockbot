// The subagent lifecycle, against real Bot Durable Objects.
//
// G1 proved the split: a task is admitted in the parent Bot Durable Object and
// executed in a Subagent Durable Object of the same Bot (ADR 0017). This file
// is about what happens to a task *after* it is dispatched, and every claim is
// about durable state surviving the object that wrote it:
//
//  * A child evicted mid-run resumes from its own cursor. Its Session is its
//    own durable state, so recovery is the child's, and the parent is told the
//    outcome once either way.
//  * `task_stop` is explicit, authenticated cancellation: it is durable before
//    the child is asked, terminal on the parent's record, and a second stop
//    reads the first back.
//  * A background task that completes while the parent Turn is over leaves a
//    pending wake, and that wake survives eviction and reaches the Bot's next
//    conversational Turn as durable input — carrying the child's *summary*,
//    never the child's transcript.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { subagentDurableObjectNameV1 } from "@frockbot/plugin-subagents/storage-keys";
import type {
  TaskListViewV1,
  TaskViewV1,
} from "@frockbot/plugin-subagents/shared";

interface Identity {
  userId: string;
  botId: string;
}

function bot(identity: Identity) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

function child(identity: Identity, taskId: string) {
  return env.BOT_STATES.getByName(
    subagentDurableObjectNameV1({ ...identity, taskId }),
  );
}

interface LifecycleRpc {
  run(command: unknown): Promise<{ runId: string; events: unknown[] }>;
  listTasks(input: unknown): Promise<TaskListViewV1>;
  readTask(input: unknown): Promise<TaskViewV1>;
  stopTask(input: unknown): Promise<TaskViewV1>;
  listRoutineInbox(input: unknown): Promise<{
    entries: Array<{ entryId: string; text: string; acknowledged: boolean }>;
    unacknowledged: number;
  }>;
}

function rpc(identity: Identity): LifecycleRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(identity) as unknown as LifecycleRpc;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  responseText?: string;
  previousEventCount?: number;
  events: Array<{ type: string; text?: string }>;
  admission?: { turnType: string };
}

async function storedRuns(
  stub: ReturnType<typeof bot>,
): Promise<StoredRunProbe[]> {
  return runInDurableObject(stub, async (_instance, state) => [
    ...(await state.storage.list<StoredRunProbe>({ prefix: "run:" })).values(),
  ]);
}

async function tasks(identity: Identity): Promise<TaskListViewV1> {
  return rpc(identity).listTasks({ schemaVersion: 1, ...identity });
}

async function turn(
  identity: Identity,
  runId: string,
  text: string,
): Promise<{ runId: string; events: unknown[] }> {
  return rpc(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text,
    },
  });
}

async function dispatch(
  identity: Identity,
  runId: string,
  call: { description: string; prompt: string },
): Promise<{ runId: string; events: unknown[] }> {
  return turn(identity, runId, toolCallTriggerPrompt(["Task", call]));
}

/** Drive the child's alarm until the parent's record is terminal. */
async function settleTask(identity: Identity, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const list = await tasks(identity);
    const task = list.tasks.find((candidate) => candidate.taskId === taskId);
    if (task && task.settledAt !== undefined) return;
    await runInDurableObject(child(identity, taskId), (_instance, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runInDurableObject(child(identity, taskId), (instance: unknown) =>
      (instance as { alarm(): Promise<void> }).alarm(),
    );
  }
  throw new Error(`task ${taskId} never settled`);
}

const CHILD_SUMMARY = "Ollama reply";

describe("the subagent lifecycle across two Durable Objects", () => {
  test("a child evicted mid-run resumes from its own cursor and settles once", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `life-${suffix}`,
      botId: `life-bot-${suffix}`,
    };
    await provisionBot(identity);
    await dispatch(identity, "dispatch-resume", {
      description: "Survive an eviction",
      prompt: "Take your time.",
    });
    const taskId = (await tasks(identity)).tasks[0]!.taskId;
    await settleTask(identity, taskId);

    // Rewind the *child* to the durable state an eviction mid-Turn leaves: the
    // run active and its Turn not yet ended, the Session cursor where it was.
    // Nothing about the parent is touched — the parent already holds the
    // terminal record, and the point is that the child's own recovery does not
    // contradict it.
    await runInDurableObject(
      child(identity, taskId),
      async (_instance, state) => {
        const key = `run:${taskId}`;
        const stored = (await state.storage.get<
          StoredRunProbe & { responseText?: string; failure?: string }
        >(key))!;
        const { responseText: _text, failure: _failure, ...run } = stored;
        const interrupted = run.events.filter(
          (event) => event.type !== "turn/end",
        );
        const latest =
          (await state.storage.get<Array<{ type: string }>>("latest-events")) ??
          [];
        await state.storage.put({
          [key]: {
            ...run,
            events: interrupted,
            status: "running",
            phase: "executing",
          },
          "latest-events": [
            ...latest.slice(0, run.previousEventCount ?? 0),
            ...interrupted,
          ],
          "active-run": taskId,
        });
      },
    );
    await evictDurableObject(child(identity, taskId));

    // Recovery happens on the child's own next touch, and it resumes the run
    // it was already executing rather than starting a second one. The parent
    // already holds the terminal record, so nothing but the child's own alarm
    // will drive this.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const [current] = await storedRuns(child(identity, taskId));
      if (current && current.status !== "running") break;
      await runInDurableObject(child(identity, taskId), (_instance, state) =>
        state.storage.setAlarm(Date.now()),
      );
      await runInDurableObject(child(identity, taskId), (instance: unknown) =>
        (instance as { alarm(): Promise<void> }).alarm(),
      );
    }
    const recovered = await storedRuns(child(identity, taskId));
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({
      runId: taskId,
      sessionId: `task:${taskId}`,
      status: "completed",
      admission: { turnType: "subagent" },
    });

    // One task, one outcome: the parent's record is what it always was.
    const settled = await tasks(identity);
    expect(settled.tasks).toHaveLength(1);
    expect(settled.tasks[0]).toMatchObject({
      taskId,
      status: "completed",
    });
    expect(settled.active).toBe(0);
  });

  test("task_stop is durable and terminal, and a second stop reads the first back", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `stop-${suffix}`,
      botId: `stop-bot-${suffix}`,
    };
    await provisionBot(identity);
    await dispatch(identity, "dispatch-stop", {
      description: "Be stopped",
      prompt: "Wait for a while.",
    });
    const taskId = (await tasks(identity)).tasks[0]!.taskId;
    await settleTask(identity, taskId);

    // Rewind the parent to the durable state it holds while a child is still
    // working — the record `running`, the active key present, and no outcome —
    // and take the child's context and alarm away, so the child cannot answer.
    // That is what a cancellation is *for*: a task that has been admitted and
    // has not reported. Driving it from durable state rather than from timing
    // is the `routines-firing.workerd.ts` pattern.
    await runInDurableObject(bot(identity), async (_instance, state) => {
      const key = `task:${taskId}`;
      const stored = (await state.storage.get<Record<string, unknown>>(key))!;
      const { outcome: _outcome, ...record } = stored;
      await state.storage.put({
        [key]: { ...record, status: "running" },
        [`task-active:${taskId}`]: { schemaVersion: 1, taskId },
      });
    });
    await runInDurableObject(
      child(identity, taskId),
      async (_instance, state) => {
        await state.storage.deleteAlarm();
        await state.storage.delete(`task-context:${taskId}`);
        await state.storage.delete(`run:${taskId}`);
      },
    );
    expect((await tasks(identity)).tasks[0]).toMatchObject({
      status: "running",
    });

    // The Bot's own door: a chat Turn calling `task_stop` by id.
    const stopping = await turn(
      identity,
      "stop-turn",
      toolCallTriggerPrompt(["task_stop", { taskId }]),
    );
    const results = (
      stopping.events as Array<{
        type: string;
        content?: string;
        isError?: boolean;
      }>
    ).filter((event) => event.type === "tool/result");
    expect(results).toHaveLength(1);
    expect(results[0]?.isError).toBe(false);
    expect(results[0]?.content).toContain(`Stopped subagent ${taskId}`);
    expect(results[0]?.content).toContain("durable");

    // Terminal on the parent's record, and it survives the object.
    await evictDurableObject(bot(identity));
    const stopped = await rpc(identity).readTask({
      schemaVersion: 1,
      ...identity,
      taskId,
    });
    expect(stopped).toMatchObject({ status: "stopped" });
    expect(stopped.settledAt).toBeDefined();
    expect((await tasks(identity)).active).toBe(0);

    // The child holds the same answer, so its own alarm cannot run the task
    // after it was cancelled — and if it somehow did, the parent's record is
    // already terminal and its settle would be a replay.
    await runInDurableObject(child(identity, taskId), (_instance, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runInDurableObject(child(identity, taskId), (instance: unknown) =>
      (instance as { alarm(): Promise<void> }).alarm(),
    );
    expect(await storedRuns(child(identity, taskId))).toEqual([]);
    expect(
      await rpc(identity).readTask({ schemaVersion: 1, ...identity, taskId }),
    ).toMatchObject({ status: "stopped" });

    // A second stop, through the User's door, is the same one act.
    await evictDurableObject(bot(identity));
    const again = await rpc(identity).stopTask({
      schemaVersion: 1,
      ...identity,
      taskId,
    });
    expect(again).toMatchObject({
      taskId,
      status: "stopped",
      settledAt: stopped.settledAt,
    });
  });

  test("a background completion's pending wake survives eviction and reaches the next chat Turn", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `wake-${suffix}`,
      botId: `wake-bot-${suffix}`,
    };
    await provisionBot(identity);
    await dispatch(identity, "dispatch-wake", {
      description: "Report back later",
      prompt: "Read the changelog.",
    });
    const taskId = (await tasks(identity)).tasks[0]!.taskId;

    // The dispatching Turn is over, so the completion is owed to the *next*
    // conversational Turn rather than to the one that dispatched.
    await evictDurableObject(bot(identity));
    await settleTask(identity, taskId);

    await evictDurableObject(bot(identity));
    const inbox = await rpc(identity).listRoutineInbox({
      schemaVersion: 1,
      ...identity,
    });
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.unacknowledged).toBe(1);
    expect(inbox.entries[0]?.text).toContain(CHILD_SUMMARY);

    await evictDurableObject(bot(identity));
    const next = await turn(identity, "chat-after-wake", "what happened?");
    const chat = (await storedRuns(bot(identity))).find(
      (run) => run.runId === next.runId,
    )!;
    const inputs = chat.events
      .filter((event) => event.type === "user/message")
      .map((event) => event.text ?? "");
    expect(inputs.some((text) => text.includes(CHILD_SUMMARY))).toBe(true);
    // The summary, and only the summary: the child's own Session is not a
    // conversation this Bot can read.
    expect(inputs.some((text) => text.includes("Read the changelog."))).toBe(
      false,
    );

    // The wake is drained exactly once, so the Turn after it carries nothing.
    const after = await turn(identity, "chat-after-drain", "and now?");
    const drained = (await storedRuns(bot(identity))).find(
      (run) => run.runId === after.runId,
    )!;
    expect(
      drained.events
        .filter((event) => event.type === "user/message")
        .some((event) => (event.text ?? "").includes(CHILD_SUMMARY)),
    ).toBe(false);
  });
});
