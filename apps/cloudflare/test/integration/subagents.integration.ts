// Subagent dispatch through the deployed door.
//
// `SELF.fetch` enters `src/index.ts`: gateway auth, the User Durable Object,
// the real application artifact, and the Bot Durable Object. What this proves
// is the shape of ADR 0017 from outside — a chat Turn dispatches a task, the
// Bot's own task list is where it is visible, the child's Turn is nowhere in
// the visible transcript, and a task list is a Bot-scoped read like any other,
// so another User's request for it is a 404 and not a redaction.
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  toolCallTriggerPrompt,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

interface TaskListView {
  schemaVersion: number;
  botId: string;
  active: number;
  tasks: Array<{
    taskId: string;
    type: string;
    description: string;
    status: string;
    model: string;
    background: boolean;
  }>;
}

interface RunView {
  runId: string;
  status: string;
}

describe("subagent tasks through the gateway", () => {
  it("shows a dispatched task on the Bot's task list and keeps the child out of the transcript", async () => {
    const userId = freshUserId("tasks");
    const botId = "tasks-bot";
    await provisionThroughGateway({ userId, botId });

    const turn = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${botId}/turns`, {
        schemaVersion: 1,
        commandId: "tasks-turn-1",
        text: toolCallTriggerPrompt([
          "Task",
          {
            description: "Read the release notes",
            prompt: "Read the release notes and summarise them.",
          },
        ]),
      }),
    )) as {
      events: Array<{ type: string; content?: string; isError?: boolean }>;
    };

    const result = turn.events.find((event) => event.type === "tool/result");
    expect(result).toMatchObject({ isError: false });
    expect(result?.content).toContain("Dispatched executor subagent");

    const list = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/tasks`),
    )) as TaskListView;
    expect(list.botId).toBe(botId);
    expect(list.tasks).toHaveLength(1);
    expect(list.tasks[0]).toMatchObject({
      description: "Read the release notes",
      type: "executor",
      background: true,
    });
    // The pinned model is a slug, not a Connection: the list says which model
    // the subagent runs on and nothing about how it reaches it.
    expect(list.tasks[0]?.model).toContain("/");
    expect(JSON.stringify(list)).not.toContain("summarise them");

    // The child's Turn is in a Subagent Durable Object with a Session of its
    // own. The visible transcript is the parent's, and holds only the parent's
    // Turn — whether or not the child has run yet.
    const runs = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as { runs: RunView[] };
    expect(runs.runs.map((run) => run.runId)).toEqual(["tasks-turn-1"]);
  });

  it("answers another User's request for the same Bot's tasks with 404", async () => {
    const userId = freshUserId("tasks-owner");
    const botId = "tasks-owned-bot";
    await provisionThroughGateway({ userId, botId });
    await expectOkJson(await asUser(userId, `/api/bots/${botId}/tasks`));

    const stranger = freshUserId("tasks-stranger");
    const denied = await asUser(stranger, `/api/bots/${botId}/tasks`);
    expect(denied.status).toBe(404);
  });

  it("refuses a bot id carrying the Subagent Durable Object separator", async () => {
    const userId = freshUserId("tasks-forge");
    const botId = "tasks-forge-bot";
    await provisionThroughGateway({ userId, botId });

    // `#task:` is how a Subagent Durable Object is named. A Bot id may not
    // carry it, so this can only ever be a forgery attempt and is refused
    // before any object is addressed.
    const forged = await asUser(
      userId,
      `/api/bots/${encodeURIComponent(`${botId}#task:tk-1`)}/tasks`,
    );
    expect(forged.status).toBe(400);
  });
});
