// A subagent asking its parent, against real Bot Durable Objects.
//
// `task_ask` is admitted on `subagent` Turns only. It hands off like
// `wake_parent`, with the question marked, and ends the child's Turn. The
// parent is told the question and how to answer it, and the Turn that opens
// on it is routed by Jev: the conversation answers it, or the person does.
// `task_resume` then carries the answer back to the same child.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import {
  frockbotToolCall,
  frockbotToolCallPrompt,
  toolCallTriggerPrompt,
} from "./harness/miniflare.ts";
import { subagentDurableObjectNameV1 } from "@frockbot/app/subagents/storage-keys";
import type { TaskListViewV1 } from "@frockbot/app/subagents/shared";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";

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

interface AskRpc {
  run(command: unknown): Promise<{ runId: string; events: unknown[] }>;
  listTasks(input: unknown): Promise<TaskListViewV1>;
  listRoutineInbox(input: unknown): Promise<{
    entries: Array<{ entryId: string; text: string }>;
  }>;
}

function rpc(identity: Identity): AskRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(identity) as unknown as AskRpc;
}

interface ProbeEvent {
  type: string;
  text?: string;
  message?: string;
  content?: string;
  isError?: boolean;
  route?: { answerer: string; judgments: unknown[] };
  decision?: { send?: string; reason?: string; judgments: unknown[] };
  call?: { name?: string };
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  events: ProbeEvent[];
}

async function storedRuns(
  stub: ReturnType<typeof bot>,
): Promise<StoredRunProbe[]> {
  return runInDurableObject(stub, (_instance, state) =>
    hydratedStoredRunsV1<StoredRunProbe>(state.storage),
  );
}

async function tasks(identity: Identity): Promise<TaskListViewV1> {
  return rpc(identity).listTasks({ schemaVersion: 1, ...identity });
}

async function turn(identity: Identity, runId: string, text: string) {
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

async function settleTask(identity: Identity, taskId: string): Promise<void> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const task = (await tasks(identity)).tasks.find(
      (candidate) => candidate.taskId === taskId,
    );
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

const QUESTION =
  "Which ledger did you mean, the personal one or the business one?";

function askingPrompt(): string {
  return toolCallTriggerPrompt(["task_ask", { question: QUESTION }]);
}

describe("a subagent asking the conversation that dispatched it", () => {
  test("the question reaches the parent, is routed by Jev, and task_resume answers it", async () => {
    const suffix = crypto.randomUUID();
    const identity = { userId: `ask-${suffix}`, botId: `ask-bot-${suffix}` };
    await provisionBot(identity);

    await turn(
      identity,
      "dispatch-ask",
      frockbotToolCallPrompt("Task", {
        description: "Review the ledger",
        prompt: askingPrompt(),
      }),
    );
    const taskId = (await tasks(identity)).tasks[0]!.taskId;
    await settleTask(identity, taskId);

    // The child asked, and its Turn ended on the hand-off.
    const [asked] = await storedRuns(child(identity, taskId));
    expect(asked?.status).toBe("completed");
    const wake = asked!.events.find((event) => event.type === "wake/parent");
    expect(wake?.message).toBe(`[Question for you] ${QUESTION}`);
    const task = (await tasks(identity)).tasks[0]!;
    expect(task.status).toBe("completed");

    // The parent is told the question and how to answer it.
    const inbox = await rpc(identity).listRoutineInbox({
      schemaVersion: 1,
      ...identity,
    });
    const notice = inbox.entries[0]!.text;
    console.log(`INBOX NOTICE: ${notice}`);
    expect(notice).toBe(
      `executor subagent "Review the ledger" asked a question. It asks: ${QUESTION} It is waiting: answer with task_resume {"resume":"${taskId}","prompt":"<your answer>"}.`,
    );

    // The Turn that opens on it is routed by Jev, once.
    const opened = await turn(identity, "chat-on-question", "any news?");
    const chat = (await storedRuns(bot(identity))).find(
      (run) => run.runId === opened.runId,
    )!;
    const routes = chat.events.filter(
      (event) => event.type === "supervision/question",
    );
    console.log(`QUESTION ROUTE: ${JSON.stringify(routes)}`);
    expect(routes).toHaveLength(1);
    expect(routes[0]!.route!.answerer).toBe("person");
    // The question is not work the child made, so no send is judged a relay.
    expect(
      chat.events.some(
        (event) =>
          event.type === "supervision/send" &&
          event.decision?.reason === "paraphrased_work",
      ),
    ).toBe(false);

    // The answer goes back to the same child, which keeps what it had.
    await turn(
      identity,
      "answer-ask",
      frockbotToolCallPrompt("task_resume", {
        resume: taskId,
        prompt: "The business one.",
      }),
    );
    let childRuns = await storedRuns(child(identity, taskId));
    for (
      let attempt = 0;
      attempt < 20 &&
      (childRuns.length < 2 || childRuns.at(-1)!.status === "running");
      attempt += 1
    ) {
      await runInDurableObject(child(identity, taskId), (_instance, state) =>
        state.storage.setAlarm(Date.now()),
      );
      await runInDurableObject(child(identity, taskId), (instance: unknown) =>
        (instance as { alarm(): Promise<void> }).alarm(),
      );
      childRuns = await storedRuns(child(identity, taskId));
    }
    const resumed = childRuns.at(-1)!;
    expect(childRuns.length).toBeGreaterThan(1);
    expect(resumed.status).toBe("completed");
    expect(
      resumed.events.some(
        (event) =>
          event.type === "user/message" &&
          (event.text ?? "").includes("The business one."),
      ),
    ).toBe(true);
    const settled = (await tasks(identity)).tasks.find(
      (candidate) => candidate.taskId === resumed.runId,
    )!;
    expect(settled.status).toBe("completed");
    expect(settled.summary).not.toContain("[Question for you]");
  });

  test("a blocking Task whose child asks returns the question as its result", async () => {
    const suffix = crypto.randomUUID();
    const identity = { userId: `askb-${suffix}`, botId: `askb-bot-${suffix}` };
    await provisionBot(identity);

    const dispatched = await turn(
      identity,
      "dispatch-ask-blocking",
      toolCallTriggerPrompt(
        frockbotToolCall("Task", {
          description: "Review the ledger",
          prompt: askingPrompt(),
          background: false,
        }),
      ),
    );
    const results = (dispatched.events as ProbeEvent[]).filter(
      (event) => event.type === "tool/result",
    );
    const taskId = (await tasks(identity)).tasks[0]?.taskId;
    expect(taskId).toBeDefined();
    expect(
      results.some(
        (result) =>
          result.content ===
          `executor subagent ${taskId} completed. It asks: ${QUESTION} It is waiting: answer with task_resume {"resume":"${taskId}","prompt":"<your answer>"}.`,
      ),
    ).toBe(true);
  });

  test("a conversational Turn cannot call task_ask", async () => {
    const suffix = crypto.randomUUID();
    const identity = { userId: `askc-${suffix}`, botId: `askc-bot-${suffix}` };
    await provisionBot(identity);

    const asked = await turn(identity, "chat-ask", askingPrompt());
    const events = asked.events as ProbeEvent[];
    const result = events.find((event) => event.type === "tool/result");
    expect(result?.isError).toBe(true);
    expect(events.some((event) => event.type === "wake/parent")).toBe(false);
  });

  test("a Turn opened on a finished subagent's work runs the relay check on its send", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `relay-${suffix}`,
      botId: `relay-bot-${suffix}`,
    };
    await provisionBot(identity);

    await turn(
      identity,
      "dispatch-relay",
      frockbotToolCallPrompt("Task", {
        description: "Draft a toast",
        prompt: "Draft a wedding toast.",
      }),
    );
    const taskId = (await tasks(identity)).tasks[0]!.taskId;
    await settleTask(identity, taskId);

    const opened = await turn(
      identity,
      "chat-relay",
      toolCallTriggerPrompt([
        "send_to_user",
        { text: "Here it is: Ollama reply", disposition: "final" },
      ]),
    );
    const chat = (await storedRuns(bot(identity))).find(
      (run) => run.runId === opened.runId,
    )!;
    const sends = chat.events.filter(
      (event) => event.type === "supervision/send",
    );
    expect(sends.length).toBeGreaterThan(0);
    expect(sends[0]!.decision!.send).toBe("release");
  });
});
