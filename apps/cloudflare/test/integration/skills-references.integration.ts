// ADR 0030 step 2, end to end: a Skill is a directory, and the file beside its
// `SKILL.md` is reachable.
//
// Driven the way production drives it — every write and every read is a real
// `POST /api/bots/<id>/turns` whose stubbed model answers with a tool call, so
// the Agent loop inside the Bot Durable Object runs `skill_write` and
// `skill_load` over real R2 and the real Workspace generation ledger.
//
// Four claims: a reference authored inside the Skill's own `references/`
// directory lands; `skill_load` returns it with its header line on a later
// Turn; `skill/injected` records the reference and the generation it was
// listed at; and the boundary refuses a path outside that directory, a
// non-`.md` name, and a reference the Skill does not offer.
import { describe, expect, it } from "vitest";
import {
  frockbotToolCall,
  frockbotToolCallPrompt,
  toolCallTriggerPrompt,
} from "../harness/miniflare.ts";
import {
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const SLUG = "daily-standup";
const REFERENCE_BODY = "REFERENCE-FORMS-BODY: one row per Bot, blockers last.";

interface TurnEvent {
  type: string;
  content?: string;
  isError?: boolean;
}

interface StoredRun {
  runId?: string;
}

async function runTurn(
  userId: string,
  botId: string,
  commandId: string,
  text: string,
): Promise<TurnEvent[]> {
  const turn = (await expectOkJson(
    await postAsUser(userId, `/api/bots/${botId}/turns`, {
      schemaVersion: 1,
      commandId,
      text,
    }),
  )) as { events: TurnEvent[] };
  return turn.events;
}

function toolResults(events: TurnEvent[]): TurnEvent[] {
  return events.filter((event) => event.type === "tool/result");
}

async function runEvents(
  userId: string,
  botId: string,
  runId: string,
): Promise<Array<Record<string, unknown>>> {
  const run = await readStoredRunWithEventsV1<StoredRun>(userId, botId, runId);
  return (run?.events ?? []) as unknown as Array<Record<string, unknown>>;
}

describe("a Skill's references, end to end", () => {
  it("writes a reference beside the SKILL.md, reads it back on a later Turn, and refuses what falls outside it", async () => {
    const userId = freshUserId("skill-reference");
    const botId = "skill-reference-bot";
    await provisionThroughGateway({ userId, botId });

    // Turn 1: the Skill itself. A reference write requires its `SKILL.md`.
    const wrote = toolResults(
      await runTurn(
        userId,
        botId,
        "skill-reference-1",
        frockbotToolCallPrompt("skill_write", {
          name: "Daily standup",
          description: "Use this when assembling the weekday standup.",
          body: "Ask each Bot for its blockers. The forms are in forms.md.",
          slug: SLUG,
        }),
      ),
    );
    expect(wrote[0]?.isError, wrote[0]?.content).toBe(false);

    // Turn 2: one reference inside the Skill's own `references/` directory,
    // beside three the boundary must refuse — a path that climbs out of it, a
    // name that is not Markdown, and a reference for a Skill with no document.
    const second = toolResults(
      await runTurn(
        userId,
        botId,
        "skill-reference-2",
        toolCallTriggerPrompt(
          frockbotToolCall("skill_write", {
            slug: SLUG,
            reference: "forms.md",
            body: REFERENCE_BODY,
          }),
          frockbotToolCall("skill_write", {
            slug: SLUG,
            reference: "../../escape.md",
            body: "ESCAPED",
          }),
          frockbotToolCall("skill_write", {
            slug: SLUG,
            reference: "forms.txt",
            body: "NOT MARKDOWN",
          }),
          frockbotToolCall("skill_write", {
            slug: "no-such-skill",
            reference: "forms.md",
            body: "ORPHAN",
          }),
        ),
      ),
    );
    // The Turn's own closing `send_to_user` is the fifth result.
    expect(second.length).toBeGreaterThanOrEqual(4);
    expect(second[0]?.isError, second[0]?.content).toBe(false);
    expect(second[0]?.content).toContain(`skills/${SLUG}/references/forms.md`);
    // A name that climbs out of the Skill's own directory, and one that is not
    // Markdown, are both refused — the model is told, and nothing is written.
    expect(second[1]?.isError).toBe(true);
    expect(second[2]?.isError).toBe(true);
    // A reference needs the Skill's SKILL.md to exist already.
    expect(second[3]?.isError).toBe(true);
    expect(second[3]?.content).toContain("write its SKILL.md first");

    // Turn 3: the catalog this Turn assembled lists the reference, and
    // `skill_load` serves it with its header line. A reference the Skill does
    // not offer is refused in the same breath.
    const third = toolResults(
      await runTurn(
        userId,
        botId,
        "skill-reference-3",
        toolCallTriggerPrompt(
          frockbotToolCall("skill_load", {
            path: `bot/${SLUG}`,
            reference: "forms.md",
          }),
          frockbotToolCall("skill_load", {
            path: `bot/${SLUG}`,
            reference: "missing.md",
          }),
        ),
      ),
    );
    expect(third.length).toBeGreaterThanOrEqual(2);
    expect(third[0]?.isError, third[0]?.content).toBe(false);
    expect(third[0]?.content).toContain("# Daily standup · forms.md");
    expect(third[0]?.content).toContain(`skills/${SLUG}/references/forms.md`);
    expect(third[0]?.content).toContain(REFERENCE_BODY);
    expect(third[1]?.isError).toBe(true);
    expect(third[1]?.content).toContain('offers no reference "missing.md"');

    // The durable record of that Turn says which references were on offer and
    // at exactly which generation each was listed.
    const events = await runEvents(userId, botId, "skill-reference-3");
    const injected = events.find((event) => event.type === "skill/injected") as
      | {
          skills?: Array<{
            path: string;
            references?: Array<{ path: string; generationId: string }>;
          }>;
        }
      | undefined;
    const own = injected?.skills?.find(
      (skill) => skill.path === `skills/${SLUG}/SKILL.md`,
    );
    expect(own?.references?.map((reference) => reference.path)).toEqual([
      `skills/${SLUG}/references/forms.md`,
    ]);
    expect(own?.references?.[0]?.generationId).toEqual(expect.any(String));
    expect((own?.references?.[0]?.generationId ?? "").length).toBeGreaterThan(0);
  });
});
