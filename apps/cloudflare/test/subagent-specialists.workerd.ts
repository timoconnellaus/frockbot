// Frock AI specialists, against real Bot Durable Objects.
//
//  * A child whose task pinned a model on the Bot's own connection runs its
//    Turn on that model, not on the Bot's. Before the fix the child re-read
//    the Bot's settings and ran the Bot's model whatever the parent chose.
//  * A pin on some other connection is not reachable from the Bot's binding,
//    so the child runs on the Bot's own model.
//  * A deployment that prices no specialist route — this one bills nothing —
//    offers none: a Frock AI Bot's prompt names no specialty.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import {
  FROCK_AI_DEFAULT_MODEL,
  FROCK_AI_PACKAGE_ID,
} from "@frockbot/providers/frock-ai/catalog";
import type { SessionEvent } from "@frockbot/core/contracts";
import { SessionEventLog } from "@frockbot/core/durable";
import { flockRevision, provisionBot } from "./provision-bot.ts";
import {
  frockbotToolCall,
  toolCallTriggerPrompt,
} from "./harness/miniflare.ts";
import {
  subagentDurableObjectNameV1,
  taskContextKeyV1,
  taskKeyV1,
  taskSessionIdV1,
} from "@frockbot/app/subagents/storage-keys";

interface Identity {
  userId: string;
  botId: string;
}

interface BotRpc {
  run(command: unknown): Promise<{ text?: string; events: unknown[] }>;
  durableSessionEvents(): Promise<SessionEvent[]>;
}

function stub(name: string): BotRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return env.BOT_STATES.getByName(name) as unknown as BotRpc;
}

async function frockAiBot(): Promise<Identity> {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `specialist-user-${suffix}`,
    botId: `specialist-bot-${suffix}`,
  };
  const user = env.USER_CONFIGURATIONS.getByName(identity.userId) as unknown as {
    readConfiguration(input: unknown): Promise<unknown>;
    createBot(input: unknown): Promise<{ status: string }>;
  };
  await user.readConfiguration({ schemaVersion: 1, userId: identity.userId });
  await expect(
    user.createBot({
      schemaVersion: 1,
      userId: identity.userId,
      command: {
        schemaVersion: 1,
        type: "bot/create",
        commandId: `create-${suffix}`,
        expectedRevision: await flockRevision(identity.userId),
        botId: identity.botId,
        name: "Specialist Bot",
      },
    }),
  ).resolves.toMatchObject({ status: "applied" });
  return identity;
}

async function chat(identity: Identity, runId: string): Promise<SessionEvent[]> {
  const name = `${identity.userId}:${identity.botId}`;
  const result = await stub(name).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: name,
      acceptedAt: new Date().toISOString(),
      text: "Write the toast for Mia's wedding.",
    },
  });
  expect(result.text).toBe("Frock AI reply");
  return stub(name).durableSessionEvents();
}

interface TaskList {
  tasks: Array<{ taskId: string; model: string; settledAt?: string }>;
}

/**
 * Dispatch one Task from a real parent Turn, then hand a second child a task
 * the parent recorded the same way, pinned to `pin`, and read its Turn.
 */
async function childRunOn(
  pin: (binding: Record<string, string>) => Record<string, string>,
): Promise<{ pinned: string; asked: string[] }> {
  const suffix = crypto.randomUUID();
  const identity = { userId: `pin-${suffix}`, botId: `pin-bot-${suffix}` };
  await provisionBot(identity);
  const parent = env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as BotRpc & { listTasks(input: unknown): Promise<TaskList> };
  await parent.run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId: "dispatch-pin",
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text: toolCallTriggerPrompt(
        frockbotToolCall("Task", {
          description: "Write the toast",
          prompt: "Write the toast for Mia's wedding.",
        }),
      ),
    },
  });
  const [task] = (await parent.listTasks({ schemaVersion: 1, ...identity }))
    .tasks;
  if (!task) throw new Error("the parent dispatched nothing");
  // The dispatched child is left to run on the Bot's own model. A second
  // task, recorded by the parent exactly as the first was, is pinned from the
  // start: the child's alarm fires on acceptance, so its pin cannot be changed
  // after the fact.
  const original = await runInDurableObject(
    env.BOT_STATES.getByName(
      subagentDurableObjectNameV1({ ...identity, taskId: task.taskId }),
    ),
    async (_i, state) =>
      (await state.storage.get<{
        type: string;
        parent: unknown;
        compositionGenerationId: string;
        model: { binding: Record<string, string>; slug: string };
      }>(taskContextKeyV1(task.taskId)))!,
  );
  const taskId = `tk-${crypto.randomUUID().replaceAll("-", "")}`;
  await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    async (_i, state) => {
      const record = (await state.storage.get<Record<string, unknown>>(
        taskKeyV1(task.taskId),
      ))!;
      await state.storage.put(taskKeyV1(taskId), {
        ...record,
        taskId,
        childSessionId: taskSessionIdV1(taskId),
      });
    },
  );
  const binding = pin(original.model.binding);
  const name = subagentDurableObjectNameV1({ ...identity, taskId });
  const child = () => env.BOT_STATES.getByName(name);
  await (child() as unknown as {
    runTask(input: unknown): Promise<unknown>;
  }).runTask({
    schemaVersion: 1,
    ...identity,
    request: {
      taskId,
      type: original.type,
      parent: original.parent,
      compositionGenerationId: original.compositionGenerationId,
      model: { binding, slug: original.model.slug },
      prompt: "Write the toast for Mia's wedding.",
    },
  });
  const pinned = binding.providerModelId!;
  const childEvents = () =>
    runInDurableObject(child(), (_i, state) =>
      new SessionEventLog(state.storage).read(taskSessionIdV1(taskId)),
    );
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const events = await childEvents();
    if (events.some((event) => event.type === "model/request")) {
      return { pinned, asked: modelsAsked(events) };
    }
    await runInDurableObject(child(), (_i, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runInDurableObject(child(), (instance: unknown) =>
      (instance as { alarm(): Promise<void> }).alarm(),
    );
  }
  throw new Error(`child ${taskId} never asked a model anything`);
}

function modelsAsked(events: SessionEvent[]): string[] {
  return events.flatMap((event) =>
    event.type === "model/request" ? [event.request.model] : [],
  );
}

describe("Frock AI specialists", () => {
  test("a child runs on the model its task pinned on the Bot's own connection", async () => {
    const same = await childRunOn((binding) => ({
      ...binding,
      providerModelId: "kimi-k2.6:cloud",
    }));
    expect(same.asked[0]).toBe("kimi-k2.6:cloud");

    // A pin this Bot's binding cannot reach runs the Bot's own model.
    const elsewhere = await childRunOn((binding) => ({
      ...binding,
      connectionId: "some-other-connection",
      providerModelId: "kimi-k2.6:cloud",
    }));
    expect(elsewhere.asked[0]).toBe("glm-5.3-flash:cloud");
  });

  test("a deployment that prices no specialist route offers none", async () => {
    const identity = await frockAiBot();
    const events = await chat(identity, "parent-unpriced");
    const request = events.find((event) => event.type === "model/request");
    if (request?.type !== "model/request") throw new Error("unreachable");
    const catalog = request.request.system.match(
      /<available_subagent_models>[\s\S]*?<\/available_subagent_models>[^\n]*\n[^\n]*(\n[^\n]*)?/,
    )?.[0];
    expect(catalog).toBeDefined();
    expect(catalog).toContain(`${FROCK_AI_PACKAGE_ID}/${FROCK_AI_DEFAULT_MODEL}`);
    expect(catalog).not.toContain("specialty");
    expect(catalog).not.toContain("@frock/writing");
  });
});
