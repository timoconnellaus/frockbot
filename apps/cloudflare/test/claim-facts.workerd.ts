// The facts half of the claim check, against the real Bot Durable Object.
//
// A Turn that read a page has what its sends say the page said checked
// against the page. A send saying a page said what it did not is withheld
// once, the model is told to say only what the pages say, and the Turn goes
// on. A Turn that read no page is asked about its claims alone.
import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { fakeJevAnswersV1 } from "@frockbot/app/supervision/testing";
import { provisionBot } from "./provision-bot.ts";
import { hydratedStoredRunsV1 } from "./session-log-probe.ts";
import {
  frockbotToolCallPrompt,
  JEV_STUB_ORIGIN,
} from "./harness/miniflare.ts";

type Identity = { userId: string; botId: string };
type StoredEvent = {
  type: string;
  name?: string;
  content?: string;
  outcome?: string;
  decision?: { send?: string; reason?: string };
};
type JevBody = {
  questions?: Record<string, unknown>;
  state?: {
    pagesThisTurn?: { tool: string; text: string; clipped: boolean }[];
    pagesNotShown?: number;
    message?: string;
  };
};

const bot = (identity: Identity) =>
  env.BOT_STATES.getByName(
    `${identity.userId}:${identity.botId}`,
  ) as unknown as { run(command: unknown): Promise<unknown> };

interface Configuration {
  readConfiguration(input: unknown): Promise<{ revision: number }>;
  executeConfiguration(input: unknown): Promise<{ status: string }>;
  readAuditEntries(input: unknown): Promise<{
    entries: { kind: string; preview?: string }[];
  }>;
}
const user = (userId: string) =>
  env.USER_CONFIGURATIONS.getByName(userId) as unknown as Configuration;

async function provisionReader(identity: Identity): Promise<void> {
  await provisionBot(identity);
  const configuration = user(identity.userId);
  const { revision } = await configuration.readConfiguration({
    schemaVersion: 1,
    userId: identity.userId,
  });
  expect(
    await configuration.executeConfiguration({
      schemaVersion: 1,
      userId: identity.userId,
      command: {
        schemaVersion: 1,
        type: "user/install-package",
        commandId: `install-web-${identity.botId}`,
        expectedRevision: revision,
        packageId: "web",
        version: "0.0.1",
      },
    }),
  ).toMatchObject({ status: "applied" });
}

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

const facts = (unsupported: number) => ({
  type: "choice",
  choice: "unsupported",
  probabilities: {
    no_page_facts: (1 - unsupported) / 2,
    supported: (1 - unsupported) / 2,
    unsupported,
  },
  confidence: unsupported,
});

/** Jev as the fake answers it, with `answer` overriding named questions. */
function scripted(answer: (key: string, asked: number) => unknown) {
  const jev: JevBody[] = [];
  const real = globalThis.fetch;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const request = new Request(input, init);
    if (new URL(request.url).origin !== JEV_STUB_ORIGIN) return real(request);
    const body = (await request.json()) as JevBody;
    jev.push(body);
    const answers = fakeJevAnswersV1(body);
    for (const key of Object.keys(body.questions ?? {})) {
      const asked = jev.filter((each) => key in (each.questions ?? {})).length;
      const override = answer(key, asked);
      if (override !== undefined) {
        (answers.answers as Record<string, unknown>)[key] = override;
      }
    }
    return Response.json(answers);
  });
  return jev;
}

const claimAsks = (jev: JevBody[]) =>
  jev.filter((body) => "claim" in (body.questions ?? {}));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("facts check", () => {
  test("a send saying a fetched page said what it did not is withheld once, the model is told to say only what the pages say, and the Turn goes on", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionReader(identity);
    const jev = scripted((key, asked) =>
      key === "facts" && asked === 1 ? facts(0.9) : undefined,
    );
    await run(
      identity,
      "run-1",
      frockbotToolCallPrompt("web_fetch", {
        url: "https://example.test/page",
        format: "markdown",
      }),
    );
    const events = await runEvents(identity, "run-1");

    // The page was read through call_dynamic_tool, and Jev saw it as web_fetch.
    const fetched = events.find((e) => e.type === "tool/result");
    expect(fetched?.content).toContain("quick brown fox");
    const asks = claimAsks(jev);
    expect(Object.keys(asks[0]?.questions ?? {}).sort()).toEqual([
      "claim",
      "facts",
    ]);
    expect(asks[0]?.state?.pagesThisTurn).toHaveLength(1);
    expect(asks[0]?.state?.pagesThisTurn?.[0]).toMatchObject({
      tool: "web_fetch",
      clipped: false,
    });
    expect(asks[0]?.state?.pagesThisTurn?.[0]?.text).toContain(
      "quick brown fox",
    );
    expect(asks[0]?.state?.pagesNotShown).toBe(0);
    // Once per Turn: the send after the withhold is not checked again.
    expect(asks).toHaveLength(1);

    const sends = events.filter((e) => e.type === "supervision/send");
    expect(sends[0]?.decision).toMatchObject({
      send: "withhold",
      reason: "unsupported_fact",
    });
    expect(sends.at(-1)?.decision?.send).toBe("release");
    const withheld = events.find(
      (e) => e.type === "tool/result" && e.name === "send_to_user",
    );
    expect(withheld?.content).toContain(
      "says a page said something that the pages this Turn read do not say. Say only what they say",
    );
    const after = events.slice(events.indexOf(withheld!) + 1);
    expect(after.some((e) => e.type === "step/start")).toBe(true);
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });

    const { entries } = await user(identity.userId).readAuditEntries({
      schemaVersion: 1,
      userId: identity.userId,
      kind: "supervision",
    });
    expect(entries.map((entry) => entry.preview).join("\n")).toContain(
      "said a page said what it did not",
    );
  });

  test("facts Jev is unsure about (below 0.7) are released", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionReader(identity);
    const jev = scripted((key) => (key === "facts" ? facts(0.65) : undefined));
    await run(
      identity,
      "run-1",
      frockbotToolCallPrompt("web_fetch", {
        url: "https://example.test/page",
        format: "markdown",
      }),
    );
    const events = await runEvents(identity, "run-1");
    expect(Object.keys(claimAsks(jev)[0]?.questions ?? {})).toContain("facts");
    expect(
      events
        .filter((e) => e.type === "supervision/send")
        .map((e) => e.decision?.send),
    ).toEqual(["release"]);
    expect(events.at(-1)).toMatchObject({
      type: "turn/end",
      outcome: "completed",
    });
  });

  test("a Turn that read no page is asked about its claims only, even when facts would be unsupported", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionReader(identity);
    const jev = scripted((key) => (key === "facts" ? facts(0.99) : undefined));
    await run(identity, "run-1", "What does example.test say about foxes?");
    const events = await runEvents(identity, "run-1");
    const asks = claimAsks(jev);
    expect(asks).toHaveLength(1);
    expect(Object.keys(asks[0]?.questions ?? {})).toEqual(["claim"]);
    expect(asks[0]?.state?.pagesThisTurn).toBeUndefined();
    expect(
      events
        .filter((e) => e.type === "supervision/send")
        .map((e) => e.decision?.send),
    ).toEqual(["release"]);
  });

  test("a fetch that failed is not a page: its Turn is asked about claims only", async () => {
    const identity = { userId: `user-${crypto.randomUUID()}`, botId: "bot-1" };
    await provisionReader(identity);
    const jev = scripted((key) => (key === "facts" ? facts(0.99) : undefined));
    await run(
      identity,
      "run-1",
      frockbotToolCallPrompt("web_fetch", {
        url: "http://169.254.169.254/latest/meta-data",
      }),
    );
    const events = await runEvents(identity, "run-1");
    const refused = events.find((e) => e.type === "tool/result");
    expect(refused?.content).toContain("error");
    const asks = claimAsks(jev);
    expect(Object.keys(asks[0]?.questions ?? {})).toEqual(["claim"]);
    expect(
      events
        .filter((e) => e.type === "supervision/send")
        .map((e) => e.decision?.send),
    ).toEqual(["release"]);
  });
});
