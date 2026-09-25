// Whether a Routine's report comes to the person, and whether it wakes a
// device, against a real Bot Durable Object. The judge is the real Jev judge;
// only Jev's HTTP answers are scripted.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, test } from "vitest";
import { hostedJevClientV1 } from "@frockbot/app/supervision";
import { createJevRoutineReportJudgeV1 } from "@frockbot/app/supervision/routine-report";
import { fakeJevAnswersV1 } from "@frockbot/app/supervision/testing";
import { provisionBot } from "./provision-bot.ts";
import { toolCallTriggerPrompt } from "./harness/miniflare.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";

interface Rpc {
  executeRoutineCommand(input: unknown): Promise<{ status: string }>;
  listRoutineInbox(input: unknown): Promise<{
    entries: Array<{ text: string }>;
  }>;
}

interface StoredRunProbe {
  runId: string;
  admission?: { origin?: { kind?: string; quiet?: boolean } };
}

type Jev = { worth: number; urgency: number } | { status: number };

// The production client, with Jev's answers scripted behind its fetch.
function scriptedJev(answer: Jev, calls: unknown[]) {
  return hostedJevClientV1(
    { JEV_API_KEY: "workerd-jev-key" },
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      const body = (await request.json()) as {
        questions: Record<string, unknown>;
        state: unknown;
      };
      calls.push(body.state);
      if ("status" in answer)
        return new Response("unavailable", { status: answer.status });
      const answered = fakeJevAnswersV1(body) as {
        answers: Record<string, Record<string, unknown>>;
      };
      answered.answers.worthTelling = { type: "noul", noul: answer.worth };
      answered.answers.urgency = {
        ...answered.answers.urgency,
        score: answer.urgency,
      };
      return Response.json(answered);
    },
  )!;
}

async function fireWith(report: string, answer: Jev | undefined) {
  const suffix = crypto.randomUUID();
  const identity = {
    userId: `judged-${suffix}`,
    botId: `judged-bot-${suffix}`,
  };
  await provisionBot(identity);
  const stub = env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`);
  const rpc = stub as unknown as Rpc;
  for (const command of [
    {
      type: "routine/create",
      commandId: `create-${suffix}`,
      routineId: "inbox",
      name: "Check my inbox for anything from the bank",
      prompt: toolCallTriggerPrompt(["wake_parent", { message: report }]),
      trigger: { kind: "webhook" },
    },
    { type: "routine/run", commandId: `run-${suffix}`, routineId: "inbox" },
  ]) {
    await rpc.executeRoutineCommand({
      schemaVersion: 1,
      ...identity,
      command: { schemaVersion: 1, botId: identity.botId, ...command },
    });
  }
  const calls: unknown[] = [];
  // The alarm runs the firing and then the hand-off delivery.
  await runInDurableObject(stub, async (instance) => {
    const state = (
      instance as unknown as {
        mountedShell?: { routineReportJudge: unknown };
      }
    ).mountedShell!;
    if (answer)
      state.routineReportJudge = createJevRoutineReportJudgeV1(
        scriptedJev(answer, calls),
      );
    await (instance as unknown as { alarm(): Promise<void> }).alarm();
  });
  const inbox = await rpc.listRoutineInbox({ schemaVersion: 1, ...identity });
  return runInDurableObject(stub, async (_instance, storage) => {
    const runs = await hydratedStoredRunsV1<StoredRunProbe>(storage.storage);
    const messages = [
      ...(
        await storage.storage.list<{ body: string; notify: boolean }>({
          prefix: "shell:message:",
        })
      ).values(),
    ];
    const wakes = [
      ...(await storage.storage.list({ prefix: "routine-wake:" })).keys(),
    ];
    return {
      calls,
      deliveries: runs
        .filter((run) => run.admission?.origin?.kind === "routine-delivery")
        .map((run) => run.admission!.origin!),
      messages: messages.map(({ body, notify }) => ({ body, notify })),
      wakes,
      log: inbox.entries.map((entry) => entry.text),
    };
  });
}

describe("a Routine report is judged before it is delivered", () => {
  test("nothing new is dismissed: no Turn, no message, still in the log", async () => {
    const report =
      "Checked your inbox. Nothing new from the bank since yesterday.";
    const result = await fireWith(report, { worth: 0.1, urgency: 0 });
    console.log("DISMISSED", JSON.stringify(result));
    expect(result.calls).toHaveLength(1);
    expect(result.deliveries).toEqual([]);
    expect(result.messages).toEqual([]);
    expect(result.wakes).toEqual([]);
    expect(result.log).toEqual([report]);
  });

  test("worth exactly 0.2 is still told", async () => {
    const result = await fireWith("Borderline report.", {
      worth: 0.2,
      urgency: 0,
    });
    console.log("BOUNDARY", JSON.stringify(result));
    expect(result.deliveries).toHaveLength(1);
  });

  test("a report that can wait lands quietly: notify false", async () => {
    const result = await fireWith("Weekly digest: 4 articles.", {
      worth: 0.9,
      urgency: 0.5,
    });
    console.log("QUIET", JSON.stringify(result));
    expect(result.deliveries).toEqual([
      expect.objectContaining({ kind: "routine-delivery", quiet: true }),
    ]);
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.every((message) => message.notify === false)).toBe(
      true,
    );
  });

  test("an urgent report is loud: notify true, no quiet flag", async () => {
    const result = await fireWith(
      "Your website returns 503; checkout is down.",
      {
        worth: 0.95,
        urgency: 3,
      },
    );
    console.log("LOUD", JSON.stringify(result));
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).not.toHaveProperty("quiet");
    expect(result.messages.length).toBeGreaterThan(0);
    expect(result.messages.every((message) => message.notify === true)).toBe(
      true,
    );
  });

  test("urgency exactly 0.8 is loud", async () => {
    const result = await fireWith("Worth knowing soon.", {
      worth: 0.9,
      urgency: 0.8,
    });
    console.log("BOUNDARY-URGENCY", JSON.stringify(result));
    expect(result.deliveries[0]).not.toHaveProperty("quiet");
    expect(result.messages.every((message) => message.notify === true)).toBe(
      true,
    );
  });

  test("Jev failing is retried once, then the report is delivered loudly", async () => {
    const result = await fireWith("Two new invoices.", { status: 503 });
    console.log("JEV-DOWN", JSON.stringify(result));
    expect(result.calls).toHaveLength(2);
    expect(result.deliveries).toHaveLength(1);
    expect(result.deliveries[0]).not.toHaveProperty("quiet");
    expect(result.messages.every((message) => message.notify === true)).toBe(
      true,
    );
  });
});
