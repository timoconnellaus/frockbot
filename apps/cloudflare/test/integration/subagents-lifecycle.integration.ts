// The subagent lifecycle through the deployed door.
//
// `SELF.fetch` enters `src/index.ts`: gateway auth, the User Durable Object,
// the real application artifact, and the Bot Durable Object. Two claims:
//
//  * A background task that completes while the parent Turn is over leaves
//    exactly one completion-inbox entry, and the Bot's next chat Turn runs on
//    the child's *summary* — never on the child's transcript, which is in a
//    Session this Bot has no door onto (ADR 0017).
//  * `POST /api/bots/:id/tasks/:taskId/stop` is a second authenticated door
//    onto the same durable cancellation `task_stop` performs, and a stranger
//    reaches neither it nor the task behind it.
import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import {
  asUser,
  botStateStubV1,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";
import { subagentDurableObjectNameV1 } from "@frockbot/plugin-subagents/storage-keys";
import { env } from "cloudflare:workers";

useApplicationArtifact();

const CHILD_PROMPT = "Read the release notes and summarise them.";
const CHILD_SUMMARY = "Ollama reply";

interface TaskView {
  taskId: string;
  status: string;
  settledAt?: string;
  summary?: string;
}

interface TaskListView {
  active: number;
  tasks: TaskView[];
}

function child(userId: string, botId: string, taskId: string) {
  return env.BOT_STATES.get(
    env.BOT_STATES.idFromName(
      subagentDurableObjectNameV1({ userId, botId, taskId }),
    ),
  );
}

/** Drive the child's alarm until the parent's record is terminal. */
async function settle(
  userId: string,
  botId: string,
  taskId: string,
): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const list = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/tasks`),
    )) as TaskListView;
    if (list.tasks.find((task) => task.taskId === taskId)?.settledAt) return;
    const stub = child(userId, botId, taskId);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runInDurableObject(stub, (instance: unknown) =>
      (instance as { alarm(): Promise<void> }).alarm(),
    );
  }
  throw new Error(`task ${taskId} never settled`);
}

async function dispatch(
  userId: string,
  botId: string,
  commandId: string,
): Promise<string> {
  await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text: toolCallTriggerPrompt([
        "Task",
        { description: "Read the release notes", prompt: CHILD_PROMPT },
      ]),
    }),
  );
  const list = (await expectOkJson(
    await asUser(userId, `/api/bots/${botId}/tasks`),
  )) as TaskListView;
  expect(list.tasks).toHaveLength(1);
  return list.tasks[0]!.taskId;
}

describe("the subagent lifecycle through the gateway", () => {
  it("delivers a background completion as one inbox entry and one summary on the next Turn", async () => {
    const userId = freshUserId("task-inbox");
    const botId = "task-inbox-bot";
    await provisionThroughGateway({ userId, botId });
    const taskId = await dispatch(userId, botId, "task-inbox-1");

    // The dispatching Turn is over before the child answers, so the completion
    // is owed to the *next* conversational Turn.
    await settle(userId, botId, taskId);

    const inbox = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/routines/inbox`),
    )) as {
      entries: Array<{ text: string; attribution: string }>;
      unacknowledged: number;
    };
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.unacknowledged).toBe(1);
    expect(inbox.entries[0]?.attribution).toContain("Subagent:");
    expect(inbox.entries[0]?.text).toContain(CHILD_SUMMARY);

    // The next chat Turn runs on the summary, and on nothing else the child
    // said: its prompt and its transcript stay in its own Session.
    const next = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "task-inbox-2",
        text: "what happened?",
      }),
    )) as { runId: string };
    const stored = await runInDurableObject(
      botStateStubV1(userId, botId),
      async (_instance, state) =>
        await state.storage.get<{
          events: Array<{ type: string; text?: string }>;
        }>(`run:${next.runId}`),
    );
    // The drained hand-off is a preamble on the Turn's *input*, ahead of the
    // person's own words — which stay verbatim and last.
    const input = stored!.events
      .filter((event) => event.type === "user/message")
      .map((event) => event.text ?? "")
      .join("\n");
    expect(input).toContain(CHILD_SUMMARY);
    expect(input).toContain("what happened?");
    expect(input).not.toContain(CHILD_PROMPT);

    // Still one entry, and the child's Turn is still not in the transcript.
    const runs = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: Array<{ runId: string }> };
    expect(runs.runs.map((run) => run.runId).sort()).toEqual([
      "task-inbox-1",
      "task-inbox-2",
    ]);
  });

  it("stops a task through its own route, and reads it back stopped", async () => {
    const userId = freshUserId("task-stop");
    const botId = "task-stop-bot";
    await provisionThroughGateway({ userId, botId });
    const taskId = await dispatch(userId, botId, "task-stop-1");
    await settle(userId, botId, taskId);

    // Rewind the parent to the durable state it holds while a child is still
    // working: the record `running`, the active key present, no outcome. That
    // is the state an explicit cancellation is for.
    await runInDurableObject(
      botStateStubV1(userId, botId),
      async (_instance, state) => {
        const key = `task:${taskId}`;
        const stored = (await state.storage.get<Record<string, unknown>>(key))!;
        const { outcome: _outcome, ...record } = stored;
        await state.storage.put({
          [key]: { ...record, status: "running" },
          [`task-active:${taskId}`]: { schemaVersion: 1, taskId },
        });
      },
    );

    const running = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/tasks/${taskId}`),
    )) as TaskView;
    expect(running).toMatchObject({ taskId, status: "running" });

    const stopped = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/tasks/${taskId}/stop`, {}),
    )) as TaskView;
    expect(stopped).toMatchObject({ taskId, status: "stopped" });
    expect(stopped.settledAt).toBeDefined();

    const readBack = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/tasks/${taskId}`),
    )) as TaskView;
    expect(readBack).toMatchObject({ taskId, status: "stopped" });
    expect(
      (
        (await expectOkJson(
          await asUser(userId, `/api/bots/${botId}/tasks`),
        )) as TaskListView
      ).active,
    ).toBe(0);
  });

  it("answers a stranger's read and stop with 404, and the wrong method with 405", async () => {
    const userId = freshUserId("task-owner");
    const botId = "task-owned-bot";
    await provisionThroughGateway({ userId, botId });
    const taskId = await dispatch(userId, botId, "task-owner-1");

    const stranger = freshUserId("task-stranger");
    expect(
      (await asUser(stranger, `/api/bots/${botId}/tasks/${taskId}`)).status,
    ).toBe(404);
    expect(
      (
        await postAsUser(
          stranger,
          `/api/bots/${botId}/tasks/${taskId}/stop`,
          {},
        )
      ).status,
    ).toBe(404);
    // Cancellation is a write, and a write is a POST.
    expect(
      (await asUser(userId, `/api/bots/${botId}/tasks/${taskId}/stop`)).status,
    ).toBe(405);
  });
});
