// Slice K2 end to end: the managed Skill source, through the gateway a browser
// talks to.
//
// One User, one Bot, two claims, both read back out of what the Bot durably
// recorded for the Turn:
//
//  1. The managed Skills — first-party, compiled into the Skills Package's
//     artifact — are in the injected catalog, under the Composition the Turn
//     pinned, with no Workspace file behind them.
//  2. Invoking a managed Skill by ref expands its body into the Turn's first
//     step, exactly as invoking a Bot's own Skill does.
//
// Every request crosses `SELF.fetch` into the deployed Worker.
import { describe, expect, it } from "vitest";
import {
  asUser,
  expectOkJson,
  freshUserId,
  postAsUser,
  provisionThroughGateway,
  readStoredRunWithEventsV1,
  useApplicationArtifact,
} from "./fixtures.ts";

useApplicationArtifact();

const MANAGED_REF = "managed/add-connector";
/** A line only the managed `add-connector` body carries. */
const MANAGED_BODY_MARKER = "Install it and switch it on";

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

async function turn(
  userId: string,
  botId: string,
  commandId: string,
  body: Record<string, unknown>,
): Promise<Array<Record<string, unknown>>> {
  const response = await postAsUser(userId, `/api/bots/${botId}/turns`, {
    schemaVersion: 1,
    commandId,
    ...body,
  });
  expect({
    status: response.status,
    body: await response.text(),
  }).toMatchObject({ status: 200 });
  return runEvents(userId, botId, commandId);
}

describe("the managed Skill source", () => {
  it("injects the managed set under the pinned Composition and expands an invoked body", async () => {
    const userId = freshUserId("skill-sources");
    const botId = "skill-sources-bot";
    await provisionThroughGateway({ userId, botId });

    const loaded = await turn(userId, botId, "skills-turn-1", {
      text: "What Skills do you have?",
    });

    const system = systemPromptOfStep(loaded, 1);
    expect(system).toContain("<agent_skills>");
    // The managed set, first-party and read-only.
    expect(system).toContain(MANAGED_REF);
    expect(system).toContain('source="managed"');
    // Progressive disclosure: the catalog is the description, never the body.
    expect(system).not.toContain(MANAGED_BODY_MARKER);

    // The catalog is injected under the Composition this Turn pinned: both
    // records are in the same Turn's durable log.
    const pinned = loaded.find((event) => event.type === "composition/pinned");
    const injected = loaded.find((event) => event.type === "skill/injected") as
      | {
          turn?: number;
          skills?: Array<{ path: string; generationId: string }>;
        }
      | undefined;
    expect(pinned).toMatchObject({ turn: 1 });
    expect(injected).toMatchObject({ turn: 1 });
    expect(injected?.skills?.map((skill) => skill.path)).toEqual([
      "managed/add-connector/SKILL.md",
      "managed/applets/SKILL.md",
      "managed/export-bot-template/SKILL.md",
      "managed/import-bot-template/SKILL.md",
      "managed/learn-from-demonstration/SKILL.md",
    ]);

    // The composer's popover sees the same catalog, refs and all, never a body.
    const popover = (await expectOkJson(
      await asUser(userId, `/api/bots/${botId}/skills`),
    )) as { skills: Array<{ ref: string }> };
    expect(popover.skills.map((entry) => entry.ref)).toContain(MANAGED_REF);
    expect(JSON.stringify(popover)).not.toContain(MANAGED_BODY_MARKER);

    // Invoking a managed Skill expands its body into step 1, exactly as
    // invoking a Bot's own does.
    const invoked = await turn(userId, botId, "skills-turn-invoke", {
      text: "Connect me to something.",
      skills: [{ schemaVersion: 1, source: "managed", slug: "add-connector" }],
    });
    const invokedSystem = systemPromptOfStep(invoked, 1);
    expect(invokedSystem).toContain("<invoked_skills>");
    expect(invokedSystem).toContain(MANAGED_BODY_MARKER);
    expect(
      invoked.find((event) => event.type === "skill/invoked"),
    ).toMatchObject({
      ref: { schemaVersion: 1, source: "managed", slug: "add-connector" },
    });
  });
});
