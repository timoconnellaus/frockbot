// A person's message never waits for a Routine, against a real Bot Durable
// Object: a firing parked at a step boundary lets the message run as its own
// chat Turn, survives an eviction, and resumes from its journal afterwards
// without asking the model or running a tool a second time.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import { repeatedToolCallPrompt } from "./harness/miniflare.ts";
import {
  hydrateStoredRunEventsV1,
  hydratedStoredRunsV1,
  rewindStoredRunEventsV1,
} from "./session-log-probe.ts";

function bot(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

interface ParkingRpc {
  executeRoutineCommand(input: unknown): Promise<{ status: string }>;
  run(command: unknown): Promise<{ runId: string }>;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  phase: string;
  previousEventCount: number;
  admission?: { turnType: string };
  events: Array<{
    type: string;
    turnType?: string;
    text?: string;
    occurrenceId?: string;
    request?: { requestId: string };
  }>;
}

function rpc(identity: { userId: string; botId: string }): ParkingRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(identity.userId, identity.botId) as unknown as ParkingRpc;
}

async function storedRuns(identity: {
  userId: string;
  botId: string;
}): Promise<StoredRunProbe[]> {
  return runInDurableObject(
    bot(identity.userId, identity.botId),
    (_instance, state) => hydratedStoredRunsV1<StoredRunProbe>(state.storage),
  );
}

describe("a Routine parked for the person's message", () => {
  test("lets the message run first, then resumes from its journal after an eviction", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `parking-${suffix}`,
      botId: `parking-bot-${suffix}`,
    };
    await provisionBot(identity);
    const created = await rpc(identity).executeRoutineCommand({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        botId: identity.botId,
        type: "routine/create",
        commandId: `create-${suffix}`,
        routineId: "triage",
        name: "Morning inbox triage",
        // Two steps that call a tool, then an answer: a step boundary to park
        // on with work on either side of it.
        prompt: repeatedToolCallPrompt(2, "get_dynamic_tools"),
        trigger: { kind: "webhook" },
      },
    });
    expect(created).toMatchObject({ status: "applied" });
    await rpc(identity).executeRoutineCommand({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        botId: identity.botId,
        type: "routine/run",
        commandId: `run-${suffix}`,
        routineId: "triage",
      },
    });
    await evictDurableObject(bot(identity.userId, identity.botId));
    await runDurableObjectAlarm(bot(identity.userId, identity.botId));

    const fired = (await storedRuns(identity)).find(
      (run) => run.admission?.turnType === "automation",
    )!;
    expect(fired.status).toBe("completed");
    const requestsWhenDone = fired.events.filter(
      (event) => event.type === "model/request",
    ).length;
    expect(requestsWhenDone).toBe(3);

    // The durable state a firing leaves when it parks at its first step
    // boundary: the step closed, the Turn open, the slot given away.
    await runInDurableObject(
      bot(identity.userId, identity.botId),
      async (_instance, state) => {
        const key = `run:${fired.runId}`;
        const stored = (await state.storage.get<
          StoredRunProbe & { responseText?: string; failure?: string }
        >(key))!;
        const run = await hydrateStoredRunEventsV1(state.storage, stored);
        const boundary = run.events.findIndex(
          (event) => event.type === "step/end",
        );
        await rewindStoredRunEventsV1(
          state.storage,
          key,
          stored,
          run.events.slice(0, boundary + 1) as never,
          { status: "running", phase: "parked" },
        );
        await state.storage.delete("active-run");
        await state.storage.put("parked-run", fired.runId);
      },
    );
    await evictDurableObject(bot(identity.userId, identity.botId));

    // The person does not wait for it: their message runs at once, as a chat
    // Turn of its own in the conversation, carrying only what they said.
    const said = "Can you remember that my wife is Becky";
    const message = await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `chat-${suffix}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: said,
      },
    });
    const runs = await storedRuns(identity);
    const chat = runs.find((run) => run.runId === message.runId)!;
    expect(chat).toMatchObject({
      status: "completed",
      sessionId: `${identity.userId}:${identity.botId}`,
    });
    expect(chat.admission?.turnType ?? "chat").toBe("chat");
    const inputs = chat.events
      .filter((event) => event.type === "user/message")
      .map((event) => event.text ?? "");
    expect(inputs.some((text) => text.includes(said))).toBe(true);
    expect(inputs.some((text) => text.includes("frockbot-test"))).toBe(false);
    expect(runs.find((run) => run.runId === fired.runId)).toMatchObject({
      status: "running",
      phase: "parked",
    });

    // Evicted again, the alarm carries the firing on from its boundary.
    await evictDurableObject(bot(identity.userId, identity.botId));
    await runDurableObjectAlarm(bot(identity.userId, identity.botId));

    const resumed = (await storedRuns(identity)).find(
      (run) => run.runId === fired.runId,
    )!;
    expect(resumed.status).toBe("completed");
    expect(
      resumed.events.filter((event) => event.type === "turn/start"),
    ).toHaveLength(1);
    expect(
      resumed.events
        .filter((event) => event.type === "turn/admission")
        .map((event) => event.turnType),
    ).toEqual(["automation"]);
    // Nothing it did before it parked happened again: one request per step,
    // and each tool call once.
    const requests = resumed.events.flatMap((event) =>
      event.type === "model/request" && event.request
        ? [event.request.requestId]
        : [],
    );
    expect(requests).toHaveLength(requestsWhenDone);
    expect(new Set(requests).size).toBe(requests.length);
    const calls = resumed.events.flatMap((event) =>
      event.type === "tool/call" && event.occurrenceId
        ? [event.occurrenceId]
        : [],
    );
    expect(calls).toHaveLength(2);
    expect(new Set(calls).size).toBe(2);
    await runInDurableObject(
      bot(identity.userId, identity.botId),
      async (_instance, state) => {
        expect(await state.storage.get("parked-run")).toBeUndefined();
      },
    );
  });
});
