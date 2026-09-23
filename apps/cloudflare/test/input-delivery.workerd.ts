// An input that lands with nobody speaking opens the Bot's reply, against a
// real Bot Durable Object.
//
// A question answered on its card and a command the person's Mac finished
// both reach the Bot only through the pending-input queue. Each now opens a
// Turn of the Bot's own, so it answers without the person having to type
// again — and that Turn is the ordinary chat Turn the queue is drained by, so
// the person's next message is not told the same thing twice.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { provisionBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";

interface Identity {
  userId: string;
  botId: string;
}

interface StoredRunProbe {
  runId: string;
  sessionId: string;
  status: string;
  events: Array<{ type: string; text?: string }>;
  admission?: {
    turnType: string;
    lane?: string;
    origin?: { kind: string; inputId?: string };
  };
}

interface BotRpc {
  run(command: unknown): Promise<{ runId: string }>;
  listCards(input: unknown): Promise<{
    cards: Array<{ surfaceId: string; revision: number }>;
  }>;
  cardAction(input: unknown): Promise<{ routed: string }>;
  deliverMachineResult(input: unknown): Promise<{ status: string }>;
}

function stub(identity: Identity) {
  return env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
}

function bot(identity: Identity): BotRpc {
  // SAFETY: the generated stub type for the Bot RPCs is too deep for the
  // compiler to instantiate here; this names only the methods this test calls.
  return stub(identity) as unknown as BotRpc;
}

async function storedRuns(identity: Identity): Promise<StoredRunProbe[]> {
  return runInDurableObject(stub(identity), (_instance, state) =>
    hydratedStoredRunsV1<StoredRunProbe>(state.storage),
  );
}

function inputDeliveries(runs: StoredRunProbe[]): StoredRunProbe[] {
  return runs.filter((run) => run.admission?.origin?.kind === "input-delivery");
}

/**
 * The input-delivery Turns, once every one has settled. They start on the
 * promise the input left behind, or on the recovery alarm, so this nudges the
 * alarm between looks rather than assuming which of the two won.
 */
async function settledDeliveries(
  identity: Identity,
): Promise<StoredRunProbe[]> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const found = inputDeliveries(await storedRuns(identity));
    if (found.length > 0 && found.every((run) => run.status !== "running")) {
      return found;
    }
    await runInDurableObject(stub(identity), (_instance, state) =>
      state.storage.setAlarm(Date.now()),
    );
    await runInDurableObject(stub(identity), (instance: unknown) =>
      (instance as { alarm(): Promise<void> }).alarm(),
    );
  }
  throw new Error("the input never opened a Turn");
}

function userMessages(run: StoredRunProbe): string[] {
  return run.events
    .filter((event) => event.type === "user/message")
    .map((event) => event.text ?? "");
}

async function chat(identity: Identity, runId: string, text: string) {
  const turn = await bot(identity).run({
    schemaVersion: 1,
    ...identity,
    command: {
      runId,
      sessionId: `${identity.userId}:${identity.botId}`,
      acceptedAt: new Date().toISOString(),
      text,
    },
  });
  return (await storedRuns(identity)).find((run) => run.runId === turn.runId)!;
}

async function freshBot(prefix: string): Promise<Identity> {
  const suffix = crypto.randomUUID();
  const identity = { userId: `${prefix}-${suffix}`, botId: `${prefix}-bot` };
  await provisionBot(identity);
  return identity;
}

describe("an input that lands opens the Bot's reply", () => {
  test("a question answered on its card", async () => {
    const identity = await freshBot("question");
    await chat(
      identity,
      "ask-1",
      toolCallTriggerPrompt([
        "send_to_user",
        {
          disposition: "finish",
          payload: {
            type: "widget",
            widget: { prompt: "Which day?", options: ["Tuesday", "Thursday"] },
          },
        },
      ]),
    );
    const [card] = (
      await bot(identity).listCards({ schemaVersion: 1, ...identity })
    ).cards;
    expect(card).toBeDefined();

    const pressed = await bot(identity).cardAction({
      schemaVersion: 1,
      ...identity,
      command: {
        schemaVersion: 1,
        surfaceId: card!.surfaceId,
        revision: card!.revision,
        commandId: "press-1",
        event: { name: "question-answer", context: { answer: "Tuesday" } },
      },
    });
    expect(pressed.routed).toBe("input");

    // The press opened a Turn of the Bot's own, on its conversation, that
    // read the answer as a choice on a control rather than as their words.
    const [delivery, ...more] = await settledDeliveries(identity);
    expect(more).toEqual([]);
    expect(delivery).toMatchObject({
      status: "completed",
      sessionId: `${identity.userId}:${identity.botId}`,
      admission: {
        turnType: "chat",
        lane: "agent",
        origin: { kind: "input-delivery", inputId: "card-action:press-1" },
      },
    });
    const told = userMessages(delivery!).join("\n");
    expect(told).toContain('"answer":"Tuesday"');
    expect(told).toContain("Nobody has said anything");
    expect(told).toContain("For a card they pressed");

    // A retried post of the same press opens nothing more.
    await bot(identity)
      .cardAction({
        schemaVersion: 1,
        ...identity,
        command: {
          schemaVersion: 1,
          surfaceId: card!.surfaceId,
          revision: card!.revision,
          commandId: "press-1",
          event: { name: "question-answer", context: { answer: "Tuesday" } },
        },
      })
      .catch(() => undefined);
    expect(inputDeliveries(await storedRuns(identity))).toHaveLength(1);
  });

  test("a command the person's Mac finished", async () => {
    const identity = await freshBot("machine-result");
    // One ordinary Turn first: the durable identity a delivery is admitted
    // under is written by an admitted Turn.
    await chat(identity, "hello-1", "hello");

    const delivery = {
      schemaVersion: 1,
      botId: identity.botId,
      runId: "ask-machine-1",
      machineId: "mac-1",
      commandId: "cmd-1",
      outcome: "ok",
      finishedAt: new Date().toISOString(),
      preview: "exit 0 · 3 files changed",
    };
    const accepted = await bot(identity).deliverMachineResult({
      schemaVersion: 1,
      ...identity,
      delivery,
    });
    expect(accepted.status).toBe("accepted");

    const [reported, ...more] = await settledDeliveries(identity);
    expect(more).toEqual([]);
    expect(reported).toMatchObject({
      status: "completed",
      admission: {
        turnType: "chat",
        lane: "agent",
        origin: { kind: "input-delivery", inputId: "machine-result:cmd-1" },
      },
    });
    const told = userMessages(reported!).join("\n");
    expect(told).toContain('Command "cmd-1" on machine mac-1 finished ok');
    expect(told).toContain("For a machine command that finished");

    // The same result delivered again asks for the Turn it already opened.
    await bot(identity).deliverMachineResult({
      schemaVersion: 1,
      ...identity,
      delivery,
    });
    expect(inputDeliveries(await storedRuns(identity))).toHaveLength(1);
  });

  test("the person's next message is not told what the delivery carried", async () => {
    const identity = await freshBot("told-once");
    await chat(identity, "hello-1", "hello");
    await bot(identity).deliverMachineResult({
      schemaVersion: 1,
      ...identity,
      delivery: {
        schemaVersion: 1,
        botId: identity.botId,
        runId: "ask-machine-1",
        machineId: "mac-1",
        commandId: "cmd-2",
        outcome: "ok",
        finishedAt: new Date().toISOString(),
        preview: "done",
      },
    });
    await settledDeliveries(identity);

    const next = await chat(identity, "chat-2", "anything else?");
    expect(
      userMessages(next).some((text) => text.includes('Command "cmd-2"')),
    ).toBe(false);
  });
});
