// Subagent roles, the shared desktop, and messages that actually arrive.
//
// G1 dispatched a task and G2 gave it a lifecycle. This file is about the two
// ceilings and the one shared resource:
//
//  * A role is a *second* admission dimension. A `browserUse` child is offered
//    the browser and not the shell, and a call it was never offered is denied
//    before it runs — the same defence in depth the turn type gets.
//  * The desktop is one screen on one Computer that serves all of a User's
//    Bots, so `computerUse` is serialized at the Computer host's own `control`
//    op under a User-wide `desktop-gui` scope. A second one is refused, and the
//    refusal names the holder; stopping the holder hands it back.
//  * A queued `task_message` reaches the running child's next step, exactly
//    once. A queue nobody reads is an empty queue.
//
// Every claim here is driven from durable state rather than from timing: a
// child settles on its own alarm, so a test that needed a task to still be
// running would be a test about scheduling. The parent's record is rewound to
// the state it holds while a child works, which is what the code reads anyway.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot, provisionSiblingBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { subagentDurableObjectNameV1 } from "@frockbot/plugin-subagents/storage-keys";
import { taskDesktopLeaseOwnerV1 } from "@frockbot/plugin-subagents/records";
import type { TaskListViewV1 } from "@frockbot/plugin-subagents/shared";
import {
  COMPUTER_HOST_TOKEN_HEADER,
  encodeComputerHostRequestV1,
} from "@frockbot/computer-host-protocol";
import { FAKE_COMPUTER_HOST_TOKEN } from "./computer-host-fake.ts";

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

interface RolesRpc {
  run(command: unknown): Promise<{ runId: string; events: unknown[] }>;
  listTasks(input: unknown): Promise<TaskListViewV1>;
}

function rpc(identity: Identity): RolesRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(identity) as unknown as RolesRpc;
}

interface StoredRunProbe {
  runId: string;
  status: string;
  events: Array<{
    type: string;
    text?: string;
    content?: string;
    isError?: boolean;
    request?: { tools?: Array<{ name: string }> };
  }>;
  admission?: { turnType: string; subagentRole?: string };
}

async function storedRuns(
  stub: ReturnType<typeof bot>,
): Promise<StoredRunProbe[]> {
  return runInDurableObject(stub, async (_instance, state) => [
    ...(await state.storage.list<StoredRunProbe>({ prefix: "run:" })).values(),
  ]);
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

/** The tool results one Turn recorded, in order. */
function results(answer: {
  events: unknown[];
}): Array<{ content: string; isError: boolean }> {
  return (
    answer.events as Array<{
      type: string;
      content?: string;
      isError?: boolean;
    }>
  )
    .filter((event) => event.type === "tool/result")
    .map((event) => ({
      content: event.content ?? "",
      isError: event.isError === true,
    }));
}

async function tasks(identity: Identity): Promise<TaskListViewV1> {
  return rpc(identity).listTasks({ schemaVersion: 1, ...identity });
}

async function dispatch(
  identity: Identity,
  runId: string,
  call: { description: string; prompt: string; type?: string },
): Promise<{ runId: string; events: unknown[] }> {
  return turn(identity, runId, toolCallTriggerPrompt(["Task", call]));
}

/** Drives the child's alarm until the parent's record is terminal. */
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

/**
 * Puts the parent back into the state it holds while a child is working: the
 * record `running`, the active key present, no outcome.
 */
async function holdTaskRunning(
  identity: Identity,
  taskId: string,
  /** For a `computerUse` task, the desktop lease it is holding meanwhile. */
  lease?: { ownerId: string; expiresAt: string },
): Promise<void> {
  await runInDurableObject(bot(identity), async (_instance, state) => {
    const key = `task:${taskId}`;
    const stored = (await state.storage.get<Record<string, unknown>>(key))!;
    const { outcome: _outcome, ...record } = stored;
    await state.storage.put({
      [key]: { ...record, status: "running" },
      [`task-active:${taskId}`]: { schemaVersion: 1, taskId },
      ...(lease
        ? {
            "task-lease:desktop": {
              schemaVersion: 1,
              taskId,
              scope: "desktop-gui",
              recordedAt: new Date().toISOString(),
              ownerId: lease.ownerId,
              expiresAt: lease.expiresAt,
            },
          }
        : {}),
    });
  });
}

/** One control call, straight at the Computer host, as a lease holder. */
async function control(
  identity: Identity,
  action: "acquire" | "release",
  ownerId: string,
): Promise<number> {
  const response = await env.COMPUTER_HOST.fetch(
    new Request("http://computer-host.internal/v1/computer/control", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [COMPUTER_HOST_TOKEN_HEADER]: FAKE_COMPUTER_HOST_TOKEN,
      },
      body: JSON.stringify(
        encodeComputerHostRequestV1({
          version: 1,
          effectId: `${action}-${ownerId}`,
          identity: { userId: identity.userId },
          tenant: { botId: identity.botId },
          credentialRef: `sprites:user:${identity.userId}`,
          operation: {
            kind: "control",
            action,
            ownerId,
            maxAgeSeconds: 600,
            scope: "desktop-gui",
          },
        }),
      ),
    }),
  );
  return response.status;
}

describe("subagent roles and the shared desktop", () => {
  test("a browserUse child is never offered computer_exec, and a call is denied", async () => {
    const suffix = crypto.randomUUID();
    const identity = { userId: `role-${suffix}`, botId: `role-bot-${suffix}` };
    await provisionBot(identity);

    // The child's own prompt is what drives its Turn, so the brief is a call
    // the role does not admit: exactly the case defence in depth is for.
    await dispatch(identity, "dispatch-browser", {
      description: "Read one page",
      prompt: toolCallTriggerPrompt(["computer_exec", { command: "whoami" }]),
      type: "browserUse",
    });
    const taskId = (await tasks(identity)).tasks[0]!.taskId;
    await settleTask(identity, taskId);

    const [run] = await storedRuns(child(identity, taskId));
    expect(run).toBeDefined();
    // The role travels with the admission, so a child recovered after eviction
    // re-mounts the same catalog rather than a wider one.
    expect(run!.admission).toMatchObject({
      turnType: "subagent",
      subagentRole: "browserUse",
    });

    // The catalog the model was actually offered: never the shell or the
    // screen, whatever else this deployment's Bot happens to hold.
    const offered = run!.events
      .filter((event) => event.type === "model/request")
      .flatMap((event) => event.request?.tools ?? [])
      .map((tool) => tool.name);
    expect(offered.length).toBeGreaterThan(0);
    expect(offered).not.toContain("computer_exec");
    expect(offered).not.toContain("computer_screenshot");

    // And the call itself is refused rather than executed.
    const denied = run!.events.filter((event) => event.type === "tool/result");
    expect(denied).toHaveLength(1);
    expect(denied[0]!.isError).toBe(true);
    expect(denied[0]!.content).toContain("computer_exec");
    expect(denied[0]!.content).toContain("browserUse");
  });

  test("one desktop per User: a second computerUse task is refused, and a stop hands it back", async () => {
    const suffix = crypto.randomUUID();
    const userId = `gui-${suffix}`;
    const first = { userId, botId: `gui-bot-a-${suffix}` };
    const second = { userId, botId: `gui-bot-b-${suffix}` };
    await provisionBot(first);
    await provisionSiblingBot(second, 1);

    const dispatched = await dispatch(first, "dispatch-gui-1", {
      description: "Drive the desktop",
      prompt: "Open the settings window.",
      type: "computerUse",
    });
    expect(results(dispatched)[0]?.isError).toBe(false);
    const holder = (await tasks(first)).tasks[0]!.taskId;
    const owner = taskDesktopLeaseOwnerV1(first.botId, holder);

    // The state a `computerUse` task holds while it works: the parent's record
    // running, and the host's User-wide lease held under this task's owner.
    await settleTask(first, holder);
    await holdTaskRunning(first, holder, {
      ownerId: owner,
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(await control(first, "acquire", owner)).toBe(200);

    // A *different Bot* of the same User. Their Durable Objects cannot see each
    // other's records; the only thing that serializes them is the lease the
    // Computer host holds against the box they share.
    const refused = await dispatch(second, "dispatch-gui-2", {
      description: "Drive the same desktop",
      prompt: "Open the settings window too.",
      type: "computerUse",
    });
    const [answer] = results(refused);
    expect(answer?.isError).toBe(true);
    expect(answer?.content).toContain(owner);

    // The refused dispatch reached a durable terminal state rather than leaving
    // a task nobody will answer for.
    const refusedTasks = await tasks(second);
    expect(refusedTasks.tasks[0]).toMatchObject({ status: "failed" });
    expect(refusedTasks.active).toBe(0);

    // Stopping the holder releases the desktop: explicit, authenticated, and
    // the release is part of the settle every path goes through.
    const stopped = await turn(
      first,
      "stop-gui",
      toolCallTriggerPrompt(["task_stop", { taskId: holder }]),
    );
    expect(results(stopped)[0]?.isError).toBe(false);

    const next = await dispatch(second, "dispatch-gui-3", {
      description: "Take the desktop",
      prompt: "Now it is mine.",
      type: "computerUse",
    });
    const [taken] = results(next);
    expect(taken?.isError).toBe(false);
    expect(taken?.content).toContain("computerUse subagent");
  });

  test("a queued message reaches the child's next step exactly once", async () => {
    const suffix = crypto.randomUUID();
    const identity = { userId: `msg-${suffix}`, botId: `msg-bot-${suffix}` };
    await provisionBot(identity);

    await dispatch(identity, "dispatch-msg", {
      description: "Take an instruction mid-flight",
      prompt: "Start reading.",
    });
    const taskId = (await tasks(identity)).tasks[0]!.taskId;
    await settleTask(identity, taskId);

    // Rewind both halves to "the child has been handed the task and has not run
    // it yet", which is when a `task_message` is queued in the first place.
    await holdTaskRunning(identity, taskId);
    await runInDurableObject(
      child(identity, taskId),
      async (_instance, state) => {
        const key = `task-context:${taskId}`;
        const context =
          (await state.storage.get<Record<string, unknown>>(key))!;
        const { outcome: _outcome, ...rest } = context;
        await state.storage.put(key, { ...rest, status: "queued" });
        await state.storage.delete(`run:${taskId}`);
        await state.storage.delete("latest-events");
        await state.storage.delete("active-run");
      },
    );

    const queued = await turn(
      identity,
      "message-turn",
      toolCallTriggerPrompt([
        "task_message",
        { taskId, message: "stop at chapter three" },
      ]),
    );
    expect(results(queued)[0]?.isError).toBe(false);
    expect(results(queued)[0]?.content).toContain("1 are waiting");

    // The child runs and folds the message into the step it was about to take.
    await settleTask(identity, taskId);
    const [run] = await storedRuns(child(identity, taskId));
    const delivered = run!.events.filter(
      (event) =>
        event.type === "user/message" &&
        (event.text ?? "").includes("stop at chapter three"),
    );
    expect(delivered).toHaveLength(1);

    // Exactly once: the claim marked what it took, so nothing is waiting and a
    // second drain hands the child nothing.
    const checked = await turn(
      identity,
      "check-turn",
      toolCallTriggerPrompt(["task_check", { taskId }]),
    );
    expect(results(checked)[0]?.content).not.toContain("are waiting");
  });
});
