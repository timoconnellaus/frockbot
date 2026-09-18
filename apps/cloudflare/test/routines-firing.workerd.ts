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
const SUBAGENT_HANDOFF = "The subagent found nothing that needs you.";

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
  setBotPluginEnabled(input: unknown): Promise<{ status: string }>;
  listRoutines(input: unknown): Promise<{
    routines: Array<{ routineId: string; runLog?: Array<{ status: string }> }>;
  }>;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  previousEventCount: number;
  admission?: {
    turnType: string;
    origin?: { kind?: string; routineId: string };
  };
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
  test("a Bot with Routines switched off admits no Turn for a firing", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `firing-off-${suffix}`,
      botId: `firing-off-bot-${suffix}`,
    };
    await provisionBot(identity);
    await createFiringRoutine(identity);
    expect(
      await rpc(identity).setBotPluginEnabled({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          kind: "set-plugin-enabled",
          commandId: crypto.randomUUID(),
          pluginId: "routines",
          enabled: false,
          expectedRevision: 0,
        },
      }),
    ).toMatchObject({ status: "applied" });

    await fireOnce(identity);

    // No run at all: the occurrence was consumed without admitting a Turn, so
    // no model call was spent and the hand-off the cue scripts never happened.
    expect(await storedRuns(identity)).toEqual([]);
    expect(
      await rpc(identity).listRoutineInbox({ schemaVersion: 1, ...identity }),
    ).toMatchObject({ unacknowledged: 0, entries: [] });
  });

  test("recovery re-mounts an interrupted firing on its recorded turn type", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `firing-recover-${suffix}`,
      botId: `firing-recover-bot-${suffix}`,
    };
    await provisionBot(identity);
    await createFiringRoutine(identity);
    await fireOnce(identity);

    // Named, not the newest: the same alarm that settles the firing opens the
    // delivery Turn its hand-off is owed, so the object holds two runs and
    // this test is about the firing.
    const settled = (await storedRuns(identity)).find(
      (run) => run.admission?.turnType === "automation",
    );
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

    const recovered = (await storedRuns(identity)).find(
      (run) => run.runId === settled!.runId,
    );
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

    // The alarm that settled the firing also opened the Turn the hand-off is
    // owed, on the Bot's own conversation. Nothing else used to open one, so a
    // 9:45am triage waited for the person to speak first.
    const delivery = (await storedRuns(identity)).find(
      (run) => run.admission?.origin?.kind === "routine-delivery",
    )!;
    expect(delivery).toMatchObject({
      sessionId: `${identity.userId}:${identity.botId}`,
      admission: { turnType: "chat" },
    });
    const delivered = delivery.events
      .filter((event) => event.type === "user/message")
      .map((event) => event.text ?? "");
    // The hand-off, and the cue saying nobody spoke — the Bot answers with the
    // conversation in front of it rather than the firing's words being posted
    // into a thread they were written without.
    expect(delivered.some((text) => text.includes(HANDOFF))).toBe(true);
    expect(
      delivered.some((text) => text.includes("Nobody has said anything")),
    ).toBe(true);

    await evictDurableObject(bot(identity.userId, identity.botId));

    // Delivered once. The person's own next Turn is not told again.
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
    expect(inputs.some((text) => text.includes(HANDOFF))).toBe(false);
    expect(
      inputs.some((text) => text.includes("what happened overnight?")),
    ).toBe(true);

    // And the alarm does not open a second delivery Turn for a hand-off it has
    // already delivered.
    await runDurableObjectAlarm(bot(identity.userId, identity.botId));
    expect(
      (await storedRuns(identity)).filter(
        (run) => run.admission?.origin?.kind === "routine-delivery",
      ),
    ).toHaveLength(1);
  });

  test("a subagent hand-off alone opens no delivery Turn", async () => {
    const suffix = crypto.randomUUID();
    const identity = {
      userId: `firing-subagent-${suffix}`,
      botId: `firing-subagent-bot-${suffix}`,
    };
    await provisionBot(identity);
    // One ordinary Turn first: the durable identity the alarm delivers under is
    // written by an admitted Turn, and this Bot has no Routine to write it.
    await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `hello-${suffix}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: "hello",
      },
    });

    // The pending queue is shared, and a background subagent settles on a path
    // that arms no alarm — so a delivery Turn for one is a Turn nothing would
    // ever open. This is the wake `recordTaskCompletion` enqueues.
    await runInDurableObject(
      bot(identity.userId, identity.botId),
      (_instance, state) =>
        state.storage.put("routine-wake:0000000001", {
          schemaVersion: 1,
          kind: "wake",
          wakeId: `tw-${suffix}`,
          runId: `task-${suffix}`,
          routineId: `task-${suffix}`,
          title: "Subagent: dig through the inbox",
          text: SUBAGENT_HANDOFF,
          createdAt: new Date().toISOString(),
          quiet: { automation: true },
          source: "subagent",
        }),
    );

    // The alarm runs its whole settle pass, hand-off delivery included.
    await runInDurableObject(bot(identity.userId, identity.botId), (instance) =>
      (instance as unknown as { alarm(): Promise<void> }).alarm(),
    );

    expect(
      (await storedRuns(identity)).filter(
        (run) => run.admission?.origin?.kind === "routine-delivery",
      ),
    ).toEqual([]);

    // It still reaches the Bot the way it always did: the person's next Turn.
    const turn = await rpc(identity).run({
      schemaVersion: 1,
      ...identity,
      command: {
        runId: `chat-${suffix}`,
        sessionId: `${identity.userId}:${identity.botId}`,
        acceptedAt: new Date().toISOString(),
        text: "anything new?",
      },
    });
    const chat = (await storedRuns(identity)).find(
      (run) => run.runId === turn.runId,
    )!;
    expect(
      chat.events
        .filter((event) => event.type === "user/message")
        .some((event) => (event.text ?? "").includes(SUBAGENT_HANDOFF)),
    ).toBe(true);
  });
});
