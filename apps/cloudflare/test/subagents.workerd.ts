// Subagent dispatch, against real Bot Durable Objects.
//
// ADR 0017 splits one Bot across two objects: the Bot's own Durable Object is
// the authority for a task, and a Subagent Durable Object — the same class, in
// the same namespace, named `<userId>:<botId>#task:<taskId>` — is only an
// execution host for the one `subagent` Turn it was handed. Three claims, and
// every one of them is about that split holding when something goes wrong:
//
//  * The child really runs, in its own object, as a `subagent` Turn with the
//    `{kind:"subagent"}` origin, and its outcome reaches the parent's record.
//  * The parent may be gone entirely between the dispatch and the child's
//    answer. The task record is durable, and the child's settle lands on it.
//  * The bounds are the parent's, and they are counted from durable keys: four
//    concurrent tasks per Bot, and the fifth is refused with the bound named.
import { env } from "cloudflare:workers";
import { evictDurableObject, runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { subagentDurableObjectNameV1 } from "@frockbot/plugin-subagents/storage-keys";
import type { TaskListViewV1 } from "@frockbot/plugin-subagents/shared";

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

interface SubagentRpc {
  run(command: unknown): Promise<{ runId: string; events: unknown[] }>;
  listTasks(input: unknown): Promise<TaskListViewV1>;
}

function rpc(identity: Identity): SubagentRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(identity) as unknown as SubagentRpc;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  responseText?: string;
  admission?: {
    turnType: string;
    origin?: { kind: string; taskId?: string; parentRunId?: string };
  };
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

/**
 * One chat Turn whose scripted tool calls are `Task` dispatches. The child's
 * prompt deliberately carries no trigger of its own: a subagent that scripted
 * a tool call would be testing the fake, not the split.
 */
async function dispatch(
  identity: Identity,
  runId: string,
  calls: ReadonlyArray<{ description: string; prompt: string }>,
): Promise<{ runId: string; events: unknown[] }> {
  return rpc(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt(
        ...calls.map(
          (call) => ["Task", call] as [name: string, input: unknown],
        ),
      ),
    },
  });
}

/**
 * Drive the child's alarm until the parent's record is terminal.
 *
 * The alarm may already have fired on its own — accepting a task arms it for
 * now — so a run that finds nothing scheduled is a success, not a failure.
 */
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

describe("subagent dispatch across two Durable Objects", () => {
  test("the child runs a subagent Turn in its own object and the parent records it", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `sub-${suffix}`,
      botId: `sub-bot-${suffix}`,
    };
    await provisionBot(identity);

    const parentRun = "dispatch-1";
    await dispatch(identity, parentRun, [
      { description: "Read the changelog", prompt: "Read the changelog." },
    ]);

    const dispatched = await tasks(identity);
    expect(dispatched.tasks).toHaveLength(1);
    const task = dispatched.tasks[0]!;
    expect(task).toMatchObject({
      description: "Read the changelog",
      type: "executor",
      background: true,
      status: "running",
    });
    expect(task.model).toContain("/");
    expect(dispatched.active).toBe(1);

    // The child is a different object entirely: nothing it does is in the
    // parent's run log, before or after it runs.
    expect((await storedRuns(bot(identity))).map((run) => run.runId)).toEqual([
      parentRun,
    ]);

    await settleTask(identity, task.taskId);

    const childRuns = await storedRuns(child(identity, task.taskId));
    expect(childRuns).toHaveLength(1);
    expect(childRuns[0]).toMatchObject({
      runId: task.taskId,
      sessionId: `task:${task.taskId}`,
      status: "completed",
      admission: {
        turnType: "subagent",
        origin: {
          kind: "subagent",
          taskId: task.taskId,
          parentRunId: parentRun,
        },
      },
    });

    const settled = await tasks(identity);
    expect(settled.active).toBe(0);
    expect(settled.tasks[0]).toMatchObject({ status: "completed" });
    expect(settled.tasks[0]?.summary).toContain("Ollama reply");

    // And the parent's own transcript still holds only the parent's Turn.
    expect((await storedRuns(bot(identity))).map((run) => run.runId)).toEqual([
      parentRun,
    ]);
  });

  test("a parent evicted mid-task keeps the record, and the child's answer lands on it", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `evict-${suffix}`,
      botId: `evict-bot-${suffix}`,
    };
    await provisionBot(identity);
    await dispatch(identity, "dispatch-evict", [
      { description: "Survive an eviction", prompt: "Take your time." },
    ]);
    const taskId = (await tasks(identity)).tasks[0]!.taskId;

    // Everything the parent held in memory is gone before the child answers.
    await evictDurableObject(bot(identity));

    // What the eviction must not cost is the record: the parent reads back the
    // same durable task, by id and by the description it was dispatched with,
    // from an object that no longer holds anything in memory.
    const surviving = await tasks(identity);
    expect(surviving.tasks).toHaveLength(1);
    expect(surviving.tasks[0]).toMatchObject({
      taskId,
      description: "Survive an eviction",
    });
    // Its status is deliberately not pinned. The child settles on its own
    // alarm in its own object, and nothing orders that against this read — the
    // stub answers instantly and cannot be held per test — so asserting
    // `running` here was asserting that the child had not finished yet, which
    // is a race rather than a property. The invariant that does hold is that
    // the slot count follows the record: a task the parent still shows as
    // unsettled occupies its slot, and a settled one has given it back.
    const settled = surviving.tasks[0]?.settledAt !== undefined;
    expect(surviving.active).toBe(settled ? 0 : 1);

    await evictDurableObject(bot(identity));
    await settleTask(identity, taskId);

    const reconciled = await tasks(identity);
    expect(reconciled.tasks[0]).toMatchObject({
      taskId,
      status: "completed",
    });
    expect(reconciled.active).toBe(0);

    // Settling is idempotent on the task id: a second answer for the same task
    // reads back the outcome that was recorded, and the slot is not returned
    // twice.
    await settleTask(identity, taskId);
    expect((await tasks(identity)).active).toBe(0);
  });

  test("four tasks run at once and the fifth is refused with the bound named", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `bound-${suffix}`,
      botId: `bound-bot-${suffix}`,
    };
    await provisionBot(identity);

    const turn = await dispatch(
      identity,
      "dispatch-bound",
      Array.from({ length: 5 }, (_value, index) => ({
        description: `Task ${index + 1}`,
        prompt: `Do piece ${index + 1}.`,
      })),
    );

    const results = (
      turn.events as Array<{
        type: string;
        content?: string;
        isError?: boolean;
      }>
    ).filter((event) => event.type === "tool/result");
    expect(results).toHaveLength(5);
    expect(results.filter((result) => result.isError !== true)).toHaveLength(4);
    const refused = results.find((result) => result.isError === true);
    expect(refused?.content).toContain("the bound is 4");

    const dispatched = await tasks(identity);
    expect(dispatched.tasks).toHaveLength(4);
    // Four distinct children, one per task: the tool call's effect identifier
    // is what the task id is derived from, so five calls in one step are five
    // distinct dispatches and not one retried four times.
    expect(new Set(dispatched.tasks.map((task) => task.taskId)).size).toBe(4);

    // Every one of them really runs, each in its own object, concurrently.
    for (const task of dispatched.tasks) {
      await settleTask(identity, task.taskId);
      const childRuns = await storedRuns(child(identity, task.taskId));
      expect(childRuns[0]).toMatchObject({
        runId: task.taskId,
        status: "completed",
        admission: { turnType: "subagent" },
      });
    }

    // The bound is a live count, not a ceiling on the record: settling gives
    // the slots back, and the next dispatch is admitted.
    const settled = await tasks(identity);
    expect(settled.active).toBe(0);
    expect(settled.tasks).toHaveLength(4);
    const again = await dispatch(identity, "dispatch-bound-2", [
      { description: "Task 6", prompt: "Do the sixth piece." },
    ]);
    expect(
      (again.events as Array<{ type: string; isError?: boolean }>).filter(
        (event) => event.type === "tool/result" && event.isError !== true,
      ),
    ).toHaveLength(1);
  });
});
