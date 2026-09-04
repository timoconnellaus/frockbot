// Slice K1 end to end: a Skill one Bot writes to its User's shared root, and
// the next Bot's Turn runs under it.
//
// Driven the way production drives it. Bot A's stubbed model answers with a
// `skill_write` tool call carrying `scope: "user"`, so the Skill is authored by
// the Agent loop inside Bot A's Durable Object and lands in the User-global
// instruction root over R2 (ADR 0016). Bot B then takes an ordinary Turn.
//
// Three claims, every one read back out of what a Bot durably recorded:
//
//  1. Bot B's `skill/injected` names the Skill with Bot A's attribution, so
//     "this Turn ran under an instruction another Bot wrote" is visible in
//     durable state rather than only in the prompt.
//  2. The catalog block Bot B's model actually received says the same:
//     `source="user"` and `by="Bot A"`.
//  3. Bot B can invoke it from the composer, and Bot A's own root is untouched
//     — nothing was copied anywhere.
import { describe, expect, it } from "vitest";
import { TOOL_CALL_TRIGGER } from "../harness/miniflare.ts";
import {
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const SKILL_SLUG = "daily-standup";
const SKILL_NAME = "Daily standup";
const SKILL_BODY = "SHARED-STANDUP-BODY: ask each Bot for its blockers.";

interface StoredRun {}

/** The session events the Bot Durable Object durably recorded for one run. */
async function runEvents(
  userId: string,
  botId: string,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const run = await readStoredRunWithEventsV1<StoredRun>(userId, botId, runId);
  return (run?.events ?? []) as unknown as Array<Record<string, unknown>>;
}

function systemPromptOfStep(
  events: Array<Record<string, unknown>>,
  step: number,
): string {
  const request = events.find(
    (event) => event.type === "model/request" && event.step === step,
  ) as { request?: { system?: string } } | undefined;
  return request?.request?.system ?? "";
}

describe("a Skill in the User's shared instruction root", () => {
  it("is written by one Bot and injected into another's Turn with the writer's attribution", async () => {
    const userId = freshUserId("skill-user-root");
    const author = "standup-author";
    const reader = "standup-reader";
    await provisionThroughGateway({ userId, botId: author });
    // A second Bot for the same User; the Flock's revision has moved on by one.
    const created = await postAsUser(userId, "/api/bots", {
      schemaVersion: 1,
      type: "bot/create",
      commandId: `create-${reader}`,
      expectedRevision: 1,
      botId: reader,
      name: "Reader",
    });
    expect(created.status).toBe(201);

    // Bot A authors into the shared root, through its own Turn.
    const write = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${author}/turns`, {
        schemaVersion: 1,
        commandId: "user-skill-write",
        text: `${TOOL_CALL_TRIGGER}skill_write:${JSON.stringify({
          name: SKILL_NAME,
          description: "Use this when assembling the weekday standup.",
          body: SKILL_BODY,
          slug: SKILL_SLUG,
          scope: "user",
        })}`,
      }),
    )) as {
      events: Array<{ type: string; content?: string; isError?: boolean }>;
    };
    const result = write.events.find((event) => event.type === "tool/result");
    expect(result, "the Turn made no skill_write call").toBeDefined();
    expect(result?.isError, result?.content).toBe(false);
    expect(result?.content).toContain("shared instruction root");

    // Bot B takes an ordinary Turn and runs under it.
    const turn = await postAsUser(userId, `/api/bots/${reader}/turns`, {
      schemaVersion: 1,
      commandId: "reader-turn-1",
      text: "What Skills do you have?",
    });
    expect(turn.status).toBe(200);
    const events = await runEvents(userId, reader, "reader-turn-1");

    const injected = events.find((event) => event.type === "skill/injected") as
      | {
          turn?: number;
          skills?: Array<{ path: string; name: string; by?: string }>;
        }
      | undefined;
    expect(injected).toMatchObject({ turn: 1 });
    const shared = injected?.skills?.find((entry) => entry.name === SKILL_NAME);
    // The durable record names the writer: Bot A, not this Bot, and not the
    // anonymous "a Skill was injected".
    expect(shared?.by).toBe(`Bot "${author}"`);
    expect(shared?.path).toBe(`skills/${SKILL_SLUG}/SKILL.md`);

    // The prompt the model actually received says the same thing, and still
    // discloses no body: mentioning a Skill is not running it.
    const system = systemPromptOfStep(events, 1);
    expect(system).toContain(`ref="user/${SKILL_SLUG}"`);
    expect(system).toContain('source="user"');
    expect(system).toContain(`by="Bot &quot;${author}&quot;"`);
    expect(system).not.toContain(SKILL_BODY);

    // The composer's popover offers it to Bot B as an invocable ref.
    const popover = (await expectOkJson(
      await postAsUser(userId, `/api/bots/${reader}/turns`, {
        schemaVersion: 1,
        commandId: "reader-turn-invoke",
        text: "Run the standup.",
        skills: [{ schemaVersion: 1, source: "user", slug: SKILL_SLUG }],
      }),
    )) as unknown;
    expect(popover).toBeDefined();
    const invoked = await runEvents(userId, reader, "reader-turn-invoke");
    expect(
      invoked.find((event) => event.type === "skill/invoked"),
    ).toMatchObject({
      ref: { schemaVersion: 1, source: "user", slug: SKILL_SLUG },
    });
    // Invocation expands the body into step 1, exactly as it does for a Bot's
    // own Skill.
    expect(systemPromptOfStep(invoked, 1)).toContain(SKILL_BODY);

    // Nothing was copied into either Bot's own root: the shared root is the
    // one place the Skill lives.
    const authorEvents = await runEvents(userId, author, "user-skill-write");
    const authorInjected = authorEvents.find(
      (event) => event.type === "skill/injected",
    ) as { skills?: Array<{ name: string }> } | undefined;
    expect(
      authorInjected?.skills?.map((entry) => entry.name) ?? [],
    ).not.toContain(SKILL_NAME);
  });
});
