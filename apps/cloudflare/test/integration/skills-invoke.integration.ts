// Slice K3 end to end: a User invoking a Skill from the composer.
//
// Driven the way production drives it — the first Turn's stubbed model answers
// with a `skill_write` tool call, so the Skill is authored by the Agent loop
// inside the Bot Durable Object and lands in the Bot's instruction root over
// R2. The second Turn is a plain `POST /api/bots/<id>/turns` carrying
// `skills: [{ source: "bot", slug }]`, which is exactly the body the composer's
// popover produces.
//
// Three claims, all read back through `SELF.fetch` or the Bot's own durable
// storage: the catalog route offers the Skill as an invocable ref; the invoked
// body reaches step 1's `model/request`; an unknown ref fails the command with
// a reason instead of being dropped.
import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const SKILL_SLUG = "daily-standup";
const SKILL_BODY = "INVOKED-STANDUP-BODY: ask each Bot for its blockers.";

interface StoredRun {
  runId?: string;
  events?: unknown[];
}

function botStub(userId: string, botId: string) {
  return env.BOT_STATES.get(env.BOT_STATES.idFromName(`${userId}:${botId}`));
}

/** The session events the Bot Durable Object durably recorded for one run. */
async function runEvents(
  userId: string,
  botId: string,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  return runInDurableObject(
    botStub(userId, botId),
    async (_instance, state) => {
      const stored = await state.storage.get<StoredRun>(`run:${runId}`);
      const events = stored?.events;
      return Array.isArray(events)
        ? (events as Array<Record<string, unknown>>)
        : [];
    },
  );
}

async function writeSkill(userId: string, botId: string): Promise<void> {
  const turn = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "skill-write-1",
      text: `${TOOL_CALL_TRIGGER}skill_write:${JSON.stringify({
        name: "Daily standup",
        description: "Use this when assembling the weekday standup.",
        body: SKILL_BODY,
        slug: SKILL_SLUG,
      })}`,
    }),
  )) as {
    events: Array<{ type: string; content?: string; isError?: boolean }>;
  };
  const result = turn.events.find((event) => event.type === "tool/result");
  expect(result, "the Turn made no skill_write call").toBeDefined();
  expect(result?.isError, result?.content).toBe(false);
}

describe("invoking a Skill from the composer", () => {
  it("offers the written Skill as a ref, expands its body into step 1, and refuses an unknown ref", async () => {
    const userId = freshUserId("skill-invoke");
    const botId = "skill-invoke-bot";
    await provisionThroughGateway({ userId, botId });

    await writeSkill(userId, botId);

    // The composer's popover reads the catalog through the same route a
    // browser calls: refs, names and descriptions, and never a body.
    const catalog = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/skills`),
    )) as {
      schemaVersion: number;
      skills: Array<{ ref: string; name: string; description: string }>;
    };
    expect(catalog.schemaVersion).toBe(1);
    expect(catalog.skills.map((entry) => entry.ref)).toContain(
      `bot/${SKILL_SLUG}`,
    );
    expect(JSON.stringify(catalog)).not.toContain(SKILL_BODY);

    // The invoking Turn: the same POST the composer makes, with one ref.
    const invoked = await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "skill-invoke-1",
      text: "Run the standup.",
      skills: [{ schemaVersion: 1, source: "bot", slug: SKILL_SLUG }],
    });
    expect(invoked.status).toBe(200);

    const events = await runEvents(userId, botId, "skill-invoke-1");
    const invocation = events.find((event) => event.type === "skill/invoked");
    expect(invocation).toMatchObject({
      type: "skill/invoked",
      ref: { schemaVersion: 1, source: "bot", slug: SKILL_SLUG },
    });
    expect(typeof invocation?.generationId).toBe("string");

    // The body reached the model, in step 1, in the request the log records —
    // so the exact prompt the Turn ran on is reconstructable.
    const firstRequest = events.find(
      (event) => event.type === "model/request" && event.step === 1,
    ) as { request?: { system?: string } } | undefined;
    expect(firstRequest?.request?.system ?? "").toContain(SKILL_BODY);
    expect(firstRequest?.request?.system ?? "").toContain("<invoked_skills>");

    // An unknown ref fails the command with a reason, never silently drops.
    const unknown = await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "skill-invoke-unknown",
      text: "Run the standup.",
      skills: [{ schemaVersion: 1, source: "bot", slug: "no-such-skill" }],
    });
    // The Turn settles on it rather than rejecting the request over the top of
    // its own settlement, so the answer is the run and the reason is durable.
    expect(unknown.status).toBe(200);
    const runs = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/turns`),
    )) as {
      runs: Array<{
        runId: string;
        status: string;
        outcome?: { message?: string };
      }>;
    };
    const failed = runs.runs.find(
      (entry) => entry.runId === "skill-invoke-unknown",
    );
    expect(failed?.status).toBe("failed");
    // The ref stays on the durable record for the debug surface; what the
    // person reads is the sentence for the outcome, with no ref in it.
    const stored = await runInDurableObject(
      env.BOT_STATES.getByName(`${userId}:${botId}`),
      (_instance, state) =>
        state.storage.get<{ failure?: string }>("run:skill-invoke-unknown"),
    );
    expect(stored?.failure ?? "").toContain("bot/no-such-skill");
    expect(failed?.outcome?.message ?? "").not.toContain("no-such-skill");

    // A malformed ref never reaches the Bot at all: the route refuses it.
    const malformed = await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId: "skill-invoke-malformed",
      text: "Run the standup.",
      skills: [{ schemaVersion: 1, source: "workflow", slug: SKILL_SLUG }],
    });
    expect(malformed.status).toBe(400);
  });
});
