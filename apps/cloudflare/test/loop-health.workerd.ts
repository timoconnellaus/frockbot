// Loop health and the claim check, against the real Bot Durable Object.
//
// A long Turn is asked, every few steps, whether it is still getting
// anywhere; a stuck one is told so at the tail of its next request, never in
// its system prompt. A text send saying something was done that the Turn's
// calls did not do is withheld once, and the Turn goes on.
import { env } from "cloudflare:workers";
import {
  evictDurableObject,
  runDurableObjectAlarm,
  runInDurableObject,
} from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeJevAnswersV1 } from "@frockbot/app/supervision/testing";
import { provisionBot } from "./provision-bot.ts";
import {
  hydrateStoredRunEventsV1,
  hydratedStoredRunsV1,
  rewindStoredRunEventsV1,
} from "./session-log-probe.ts";
import {
  frockbotToolCall,
  JEV_STUB_ORIGIN,
  repeatedToolCallPrompt,
} from "./harness/miniflare.ts";

type Identity = { userId: string; botId: string };
type StoredEvent = {
  type: string;
  name?: string;
  content?: string;
  step?: number;
  outcome?: string;
  decision?: {
    stuck?: boolean;
    signals?: string[];
    send?: string;
    reason?: string;
  };
};
type WireRequest = { messages?: { role?: string; content?: unknown }[] };

const bot = (identity: Identity) =>
  env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as { run(command: unknown): Promise<unknown> };

async function run(identity: Identity, runId: string, text: string) {
  await bot(identity).run({
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

async function runEvents(
  identity: Identity,
  runId: string,
): Promise<StoredEvent[]> {
  const runs = await runInDurableObject(
    env.BOT_STATES.getByName(`${identity.userId}:${identity.botId}`),
    (_instance, state) =>
      hydratedStoredRunsV1<{ runId: string; sessionId: string }>(state.storage),
  );
  return (runs.find((candidate) => candidate.runId === runId)?.events ??
    []) as StoredEvent[];
}

const noul = (value: number) => ({ type: "noul", noul: value });
const choice = (label: string, labels: string[]) => ({
  type: "choice",
  choice: label,
  probabilities: Object.fromEntries(
    labels.map((each) => [
      each,
      each === label ? 0.9 : 0.1 / (labels.length - 1),
    ]),
  ),
  confidence: 0.9,
});

/**
 * Jev as the fake answers it, with `answer` overriding named questions, and
 * every model request the Turn made recorded as it was sent.
 */
function scripted(answer: (key: string, asked: number) => unknown) {
  const models: WireRequest[] = [];
  const jev: string[][] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.origin !== JEV_STUB_ORIGIN) {
      if (url.pathname === "/v1/chat/completions") {
        models.push((await request.clone().json()) as WireRequest);
      }
      return real(request);
    }
    const body = (await request.json()) as {
      questions?: Record<string, unknown>;
    };
    const keys = Object.keys(body.questions ?? {});
    jev.push(keys);
    const answers = fakeJevAnswersV1(body);
    for (const key of keys) {
      const asked = jev.filter((set) => set.includes(key)).length;
      const override = answer(key, asked);
      if (override instanceof Response) return override;
      if (override !== undefined) {
        (answers.answers as Record<string, unknown>)[key] = override;
      }
    }
    return Response.json(answers);
  });
  return { models, jev };
}

const text = (content: unknown) =>
  typeof content === "string" ? content : JSON.stringify(content ?? "");

afterEach(() => {
  vi.restoreAllMocks();
});

describe("loop health", () => {
  test("a Turn repeating one call is checked from step 5, told at the tail to change course, and the system prompt is untouched", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    // Moving, but not by much: stuck only because code sees a loop.
    const { models } = scripted((key) =>
      key === "progressing" ? noul(0.35) : undefined,
    );

    await run(
      identity,
      "run-1",
      repeatedToolCallPrompt(
        8,
        ...frockbotToolCall("memory_read", { path: "notes/missing.md" }),
      ),
    );
    const events = await runEvents(identity, "run-1");
    const checks = events.filter((e) => e.type === "supervision/progress");
    // Nothing before step 5. The stub model reads its script from the last
    // user message, which the note now is, so it stops repeating and answers.
    expect(checks.map((check) => check.step)).toEqual([5]);
    expect(checks[0]?.decision).toMatchObject({ stuck: true });
    expect(checks[0]?.decision?.signals).toContain("repeated_call");

    const note = "[FrockBot runtime: not getting anywhere]";
    const carries = (request: WireRequest | undefined) =>
      request?.messages?.some((m) => text(m.content).includes(note)) ?? false;
    // Steps 1-4 carry nothing; step 5 carries it as the last message.
    expect(models.slice(0, 4).map(carries)).toEqual([
      false,
      false,
      false,
      false,
    ]);
    expect(text(models[4]?.messages?.at(-1)?.content)).toContain(note);
    // Steered, the Turn stops calling and finishes with what it has.
    expect(models).toHaveLength(5);
    // The system prompt a cached prefix depends on never changes.
    const system = (request: WireRequest | undefined) =>
      text(request?.messages?.find((m) => m.role === "system")?.content);
    expect(system(models[4])).toBe(system(models[3]));
    expect(system(models[4])).not.toContain(note);
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("the same Turn, judged as moving despite the loop signal, is checked every 2 steps and never steered", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    // Above the signalled threshold (0.45): not stuck even with a loop signal.
    const { models } = scripted((key) =>
      key === "progressing" ? noul(0.5) : undefined,
    );
    await run(
      identity,
      "run-1",
      repeatedToolCallPrompt(
        8,
        ...frockbotToolCall("memory_read", { path: "notes/missing.md" }),
      ),
    );
    const events = await runEvents(identity, "run-1");
    const checks = events.filter((e) => e.type === "supervision/progress");
    expect(checks.map((check) => check.step)).toEqual([5, 7, 9]);
    expect(checks.every((check) => check.decision?.stuck === false)).toBe(true);
    const note = "[FrockBot runtime: not getting anywhere]";
    expect(
      models.some((request) =>
        request.messages?.some((m) => text(m.content).includes(note)),
      ),
    ).toBe(false);
  });

  test("a progress check recorded before the Turn was interrupted is reused on resume, not asked again", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    const { models, jev } = scripted((key) =>
      key === "progressing" ? noul(0.35) : undefined,
    );
    await run(
      identity,
      "run-1",
      repeatedToolCallPrompt(
        8,
        ...frockbotToolCall("memory_read", { path: "notes/missing.md" }),
      ),
    );
    // Rewind to the moment after step 5's check was recorded and before its
    // request was made: the object is lost there, and recovery resumes it.
    const stub = env.BOT_STATES.getByName(
      `${identity.userId}:${identity.botId}`,
    );
    await runInDurableObject(stub, async (_instance, state) => {
      const key = "run:run-1";
      const raw = (await state.storage.get<{
        sessionId: string;
        previousEventCount: number;
      }>(key))!;
      const { events } = await hydrateStoredRunEventsV1(state.storage, raw);
      const check = events.findIndex(
        (event) => event.type === "supervision/progress",
      );
      expect(check).toBeGreaterThan(-1);
      await rewindStoredRunEventsV1(
        state.storage,
        key,
        raw,
        events.slice(0, check + 1),
        { status: "running", phase: "executing" },
      );
      await state.storage.put("active-run", "run-1");
    });
    const askedBefore = jev.filter((keys) => keys.includes("progressing"));
    expect(askedBefore).toHaveLength(1);
    const requestsBefore = models.length;

    await evictDurableObject(stub);
    await runInDurableObject(stub, (_instance, state) =>
      state.storage.setAlarm(Date.now() + 60_000),
    );
    expect(await runDurableObjectAlarm(stub)).toBe(true);

    // Jev was not asked again; the recorded judgment still steered step 5.
    expect(jev.filter((keys) => keys.includes("progressing"))).toHaveLength(1);
    const resumed = models.slice(requestsBefore);
    expect(resumed.length).toBeGreaterThan(0);
    expect(text(resumed[0]?.messages?.at(-1)?.content)).toContain(
      "[FrockBot runtime: not getting anywhere]",
    );
    const events = await runEvents(identity, "run-1");
    expect(
      events
        .filter((e) => e.type === "supervision/progress")
        .map((e) => e.step),
    ).toEqual([5]);
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("a Jev failure on the progress check is retried once, then the Turn fails", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    const { jev } = scripted((key) =>
      key === "progressing"
        ? Response.json({ error: { message: "down" } }, { status: 503 })
        : undefined,
    );
    await run(
      identity,
      "run-1",
      repeatedToolCallPrompt(
        8,
        ...frockbotToolCall("memory_read", { path: "notes/missing.md" }),
      ),
    );
    const events = await runEvents(identity, "run-1");
    // The first ask and its one retry, then no more.
    expect(jev.filter((keys) => keys.includes("progressing"))).toHaveLength(2);
    expect(events.filter((e) => e.type === "supervision/progress")).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "model-error",
    });
  });
});

describe("claim check", () => {
  test("a finish claiming undone work is withheld once, the Turn goes on, and the audit says it claimed undone work", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    const { jev } = scripted((key, asked) =>
      key === "claim" && asked === 1
        ? choice("unsupported", ["no_claim", "supported", "unsupported"])
        : undefined,
    );
    await run(identity, "run-1", "Email Dana the March invoice.");
    const events = await runEvents(identity, "run-1");
    const sends = events.filter((e) => e.type === "supervision/send");
    expect(sends[0]?.decision).toMatchObject({
      send: "withhold",
      reason: "unsupported_claim",
    });
    // Asked once per Turn: nothing after the first withhold asks again.
    expect(jev.filter((keys) => keys.includes("claim"))).toHaveLength(1);
    const withheld = events.find(
      (e) => e.type === "tool/result" && e.name === "send_to_user",
    );
    expect(withheld?.content).toContain("not done");
    // The withheld finish did not end the Turn: the model was asked again.
    const firstSend = events.indexOf(withheld!);
    expect(
      events.slice(firstSend + 1).some((e) => e.type === "step/start"),
    ).toBe(true);

    const { entries } = await (
      env.USER_CONFIGURATIONS.getByName(identity.userId) as unknown as {
        readAuditEntries(input: unknown): Promise<{
          entries: { kind: string; preview?: string }[];
        }>;
      }
    ).readAuditEntries({
      schemaVersion: 1,
      userId: identity.userId,
      kind: "supervision",
    });
    expect(entries.map((entry) => entry.preview).join("\n")).toContain(
      "claimed undone work",
    );
  });

  test("a claim Jev is unsure about (below 0.7) is released", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionBot(identity);
    scripted((key) =>
      key === "claim"
        ? {
            type: "choice",
            choice: "unsupported",
            probabilities: {
              no_claim: 0.2,
              supported: 0.15,
              unsupported: 0.65,
            },
            confidence: 0.65,
          }
        : undefined,
    );
    await run(identity, "run-1", "Email Dana the March invoice.");
    const events = await runEvents(identity, "run-1");
    const sends = events.filter((e) => e.type === "supervision/send");
    expect(sends.map((send) => send.decision?.send)).toEqual(["release"]);
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });
});
