// What a firing leaves behind, against a real Bot Durable Object.
//
// Two claims, and both are about eviction, because "Persist enough state to
// resume safely after Durable Object eviction" is the whole reason the
// completion inbox and the pending-input queue are durable records rather than
// something held in the isolate that ran the firing:
//
//  * A Turn interrupted mid-firing is recovered on the turn type it was
//    admitted as. Recovery must not quietly re-mount an automation Turn as a
//    chat one, which would hand it `send_to_user` and the transcript.
//  * A pending wake outlives the object and is delivered to the next
//    conversational Turn, exactly once.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import {
  hydrateStoredRunEventsV1,
  hydratedStoredRunsV1,
  rewindStoredRunEventsV1,
} from "./session-log-probe.ts";

const HANDOFF = "Two overnight emails need you.";

function bot(userId: string, botId: string) {
  return env.BOT_STATES.getByName(`${userId}:${botId}`);
}

interface FiringRpc {
  executeRoutineCommand(input: unknown): Promise<{ status: string }>;
  listRuns(input: unknown): Promise<{ runs: Array<{ runId: string }> }>;
  listRoutineInbox(input: unknown): Promise<{
    unacknowledged: number;
    entries: Array<{ entryId: string; runId: string; text: string }>;
  }>;
  run(command: unknown): Promise<{ runId: string }>;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  previousEventCount: number;
  admission?: { turnType: string; origin?: { routineId: string } };
  events: Array<{ type: string; turnType?: string; text?: string }>;
}

function rpc(identity: { userId: string; botId: string }): FiringRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return bot(identity.userId, identity.botId) as unknown as FiringRpc;
}

async function createFiringRoutine(identity: {
  userId: string;
  botId: string;
}): Promise<void> {
  const receipt = await rpc(identity).executeRoutineCommand({
    schemaVersion: 1,
    ...identity,
    command: {
      schemaVersion: 1,
      botId: identity.botId,
      type: "routine/create",
      commandId: `create-${identity.botId}`,
      routineId: "brief",
      name: "Morning brief",
      // The Routine's prompt is the automation Turn's cue, so the scripted
      // hand-off travels in it.
      prompt: toolCallTriggerPrompt(["wake_parent", { message: HANDOFF }]),
      trigger: { kind: "webhook" },
      timezone: "UTC",
    },
  });
  expect(receipt).toMatchObject({ status: "applied" });
}

async function fireOnce(identity: {
  userId: string;
  botId: string;
}): Promise<void> {
  await rpc(identity).executeRoutineCommand({
    schemaVersion: 1,
    ...identity,
    command: {
      schemaVersion: 1,
      botId: identity.botId,
      type: "routine/run",
      commandId: `run-${identity.botId}`,
      routineId: "brief",
    },
  });
  // The firing is a durable record and not a timer, so the object may be gone
  // when the alarm drains it.
  await evictDurableObject(bot(identity.userId, identity.botId));
  await runDurableObjectAlarm(bot(identity.userId, identity.botId));
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

describe("a firing's durable consequences in Workerd", () => {
  test("recovery re-mounts an interrupted firing on its recorded turn type", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `firing-recover-${suffix}`,
      botId: `firing-recover-bot-${suffix}`,
    };
    await provisionBot(identity);
    await createFiringRoutine(identity);
    await fireOnce(identity);

    const [settled] = await storedRuns(identity);
    expect(settled).toMatchObject({
      status: "completed",
      admission: { turnType: "automation" },
    });

    // Rewind the object to the durable state an eviction mid-firing leaves: the
    // run still active and its Turn not yet ended. Nothing else is touched —
    // the admission record, which is what recovery reads the turn type from,
    // stays exactly as the firing wrote it.
    await runInDurableObject(
      bot(identity.userId, identity.botId),
      async (_instance, state) => {
        const key = `run:${settled!.runId}`;
        const stored = (await state.storage.get<
          StoredRunProbe & { responseText?: string; failure?: string }
        >(key))!;
        const run = await hydrateStoredRunEventsV1(state.storage, stored);
        const interrupted = run.events.filter(
          (event) => event.type !== "turn/end",
        );
        await rewindStoredRunEventsV1(state.storage, key, stored, interrupted, {
          status: "running",
          phase: "executing",
        });
        await state.storage.put("active-run", settled!.runId);
      },
    );
    await evictDurableObject(bot(identity.userId, identity.botId));

    // Recovery on the next touch of the object, through a production read: the
    // transcript listing recovers the active run before it projects anything.
    const visible = await rpc(identity).listRuns({
      schemaVersion: 1,
      ...identity,
      query: { schemaVersion: 1 },
    });

    const [recovered] = await storedRuns(identity);
    expect(recovered).toMatchObject({
      runId: settled!.runId,
      status: "completed",
      admission: { turnType: "automation", origin: { routineId: "brief" } },
    });
    // The recovered Turn's own admission marker is the proof: had recovery
    // defaulted to chat, this would say so and the Turn would have been offered
    // the user-facing catalog.
    expect(
      recovered!.events
        .filter((event) => event.type === "turn/admission")
        .map((event) => event.turnType),
    ).toEqual(["automation"]);
    // And the recovered firing is still not in the conversation.
    expect(visible.runs.map((run) => run.runId)).not.toContain(settled!.runId);
  });

  test("a pending wake survives eviction and drains into the next chat Turn", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `firing-wake-${suffix}`,
      botId: `firing-wake-bot-${suffix}`,
    };
    await provisionBot(identity);
    await createFiringRoutine(identity);
    await fireOnce(identity);

    // The object goes away entirely between the firing and the conversation.
    await evictDurableObject(bot(identity.userId, identity.botId));

    const inbox = await rpc(identity).listRoutineInbox({
      schemaVersion: 1,
      ...identity,
    });
    expect(inbox.entries).toHaveLength(1);
    expect(inbox.unacknowledged).toBe(1);
    expect(inbox.entries[0]!.text).toBe(HANDOFF);

    await evictDurableObject(bot(identity.userId, identity.botId));

    const turn = await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `chat-${suffix}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: "what happened overnight?",
      },
    });
    const chat = (await storedRuns(identity)).find(
      (run) => run.runId === turn.runId,
    )!;
    const inputs = chat.events
      .filter((event) => event.type === "user/message")
      .map((event) => event.text ?? "");
    expect(inputs.some((text) => text.includes(HANDOFF))).toBe(true);
    expect(
      inputs.some((text) => text.includes("what happened overnight?")),
    ).toBe(true);

    // Delivered once. A second conversational Turn is not told again.
    const second = await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `chat-second-${suffix}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: "anything else?",
      },
    });
    const secondRun = (await storedRuns(identity)).find(
      (run) => run.runId === second.runId,
    )!;
    expect(
      secondRun.events
        .filter((event) => event.type === "user/message")
        .some((event) => (event.text ?? "").includes(HANDOFF)),
    ).toBe(false);
  });
});
