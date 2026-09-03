import { describe, expect, test } from "bun:test";
import { SessionStore, type Session } from "@frockbot/kernel-contracts";
import { Context } from "cordis";
import {
  createSkillLoadTool,
  createSkillWriteTool,
  openSkillTurnPositionV1,
  SkillCatalog,
} from "./agent.ts";
import { botInstructionRootV1 } from "./catalog.ts";
import { FakeWorkspace, skillMarkdown } from "./testing.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
const OWN_ROOT = botInstructionRootV1(OWNER);
const WRITER = { sessionId: "user-1:bot-1", turnId: "turn-4", runId: "run-9" };
const BOT_WRITER = { kind: "bot" as const, botId: "bot-1", ...WRITER };

const CONTEXT = {
  botId: "bot-1",
  agentId: "bot-1",
  sessionId: "user-1:bot-1",
  compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
  turnType: "chat" as const,
  effectId: "tool:1:1:0",
  signal: new AbortController().signal,
};

async function openSession(): Promise<{
  session: Session;
  sessions: { get(id: string): Session | undefined };
  dispose(): Promise<void>;
}> {
  const root = new Context();
  await root.plugin(SessionStore);
  const session = root.sessions.create("user-1:bot-1");
  session.appendBatch([
    { type: "turn/start", turn: 4 },
    { type: "step/start", turn: 4, step: 2 },
  ]);
  return {
    session,
    sessions: root.sessions,
    dispose: () => root.fiber.dispose(),
  };
}

describe("the Skill catalog", () => {
  test("records exactly what it injected on the Turn", async () => {
    const workspace = await FakeWorkspace.seeded([
      {
        root: OWN_ROOT,
        path: "skills/kept/SKILL.md",
        text: skillMarkdown("kept", "Use this when keeping.", "Body."),
        writer: BOT_WRITER,
      },
      {
        root: OWN_ROOT,
        path: "skills/refused/SKILL.md",
        text: skillMarkdown("refused", "Use this never.", "Body."),
        writer: { kind: "first-party", packageId: "memory" },
      },
    ]);
    const { session, dispose } = await openSession();
    const catalog = new SkillCatalog(OWNER, workspace);

    await catalog.refresh(4, session);

    const injected = session.events.find(
      (event) => event.type === "skill/injected",
    );
    // Ordering is the catalog's: the Bot's own Skills, then the managed set
    // this Package compiles in. Nothing else is installed in this fixture.
    expect(injected).toMatchObject({
      type: "skill/injected",
      turn: 4,
      skills: [
        { path: "skills/kept/SKILL.md", name: "kept" },
        { path: "managed/add-connector/SKILL.md" },
        { path: "managed/applets/SKILL.md" },
        { path: "managed/export-bot-template/SKILL.md" },
        { path: "managed/import-bot-template/SKILL.md" },
        { path: "managed/learn-from-demonstration/SKILL.md" },
      ],
    });
    expect(
      injected?.type === "skill/injected" ? injected.refusals : [],
    ).toHaveLength(1);
    expect(
      injected?.type === "skill/injected"
        ? injected.skills[0]?.generationId
        : undefined,
    ).toBe(catalog.current().skills[0]?.generationId);
    expect(catalog.loadedTurn()).toBe(4);
    await dispose();
  });
});

describe("the skill_load tool", () => {
  test("discloses a loaded body and nothing else", async () => {
    const workspace = await FakeWorkspace.seeded([
      {
        root: OWN_ROOT,
        path: "skills/kept/SKILL.md",
        text: skillMarkdown("kept", "Use this when keeping.", "Recipe body."),
        writer: BOT_WRITER,
      },
      {
        root: OWN_ROOT,
        path: "skills/refused/SKILL.md",
        text: skillMarkdown("refused", "Use this never.", "Forbidden body."),
        writer: { kind: "user", userId: "user-2" },
      },
    ]);
    const { session, dispose } = await openSession();
    const catalog = new SkillCatalog(OWNER, workspace);
    await catalog.refresh(4, session);
    const tool = createSkillLoadTool(catalog);

    const loaded = await tool.execute(
      { path: "skills/kept/SKILL.md" },
      CONTEXT,
    );
    expect(loaded.isError).toBe(false);
    expect(loaded.content).toContain("Recipe body.");

    const refused = await tool.execute(
      { path: "skills/refused/SKILL.md" },
      CONTEXT,
    );
    expect(refused.isError).toBe(true);
    expect(refused.content).not.toContain("Forbidden body.");
    await dispose();
  });
});

describe("the skill_write tool", () => {
  test("records intent, writes with Bot provenance, then records the generation", async () => {
    const workspace = new FakeWorkspace();
    const { session, sessions, dispose } = await openSession();
    const tool = createSkillWriteTool(
      { owner: OWNER, reads: workspace, files: workspace },
      WRITER,
      sessions,
    );

    const result = await tool.execute(
      {
        name: "Daily standup",
        description: "Use this when assembling the weekday standup.",
        body: "# Steps\n1. Ask.",
      },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    const intent = session.events.find(
      (event) => event.type === "skill/write-intent",
    );
    const written = session.events.find(
      (event) => event.type === "skill/written",
    );
    expect(intent).toMatchObject({
      turn: 4,
      step: 2,
      path: "skills/daily-standup/SKILL.md",
    });
    expect(written).toMatchObject({ path: "skills/daily-standup/SKILL.md" });
    expect(intent!.seq).toBeLessThan(written!.seq);

    const stored = await workspace.stat({
      root: OWN_ROOT,
      path: "skills/daily-standup/SKILL.md",
    });
    expect(stored.status).toBe("ok");
    expect(
      stored.status === "ok" ? stored.entry.generation.writer : undefined,
    ).toEqual({ kind: "bot", botId: "bot-1", ...WRITER });

    // The Skill it wrote is loadable on the next Turn, by its own authority.
    const catalog = new SkillCatalog(OWNER, workspace);
    await catalog.refresh(5, session);
    expect(
      catalog
        .current()
        .skills.filter((skill) => skill.ref?.source === "bot")
        .map((skill) => skill.name),
    ).toEqual(["Daily standup"]);
    await dispose();
  });

  test("refuses a breach of the bounded per-Bot Skill quota, visibly", async () => {
    const workspace = new FakeWorkspace();
    const { sessions, dispose } = await openSession();
    const tool = createSkillWriteTool(
      {
        owner: OWNER,
        reads: workspace,
        files: workspace,
        quota: {
          schemaVersion: 1,
          maxSkillsPerBot: 1,
          maxSkillsPerUser: 1,
          maxSkillBytes: 65_536,
        },
      },
      WRITER,
      sessions,
    );

    const first = await tool.execute(
      { name: "one", description: "Use this when first.", body: "Body." },
      CONTEXT,
    );
    expect(first.isError).toBe(false);
    const second = await tool.execute(
      { name: "two", description: "Use this when second.", body: "Body." },
      CONTEXT,
    );
    expect(second.isError).toBe(true);
    expect(second.content).toContain("the quota allows 1");

    const third = await tool.execute(
      {
        name: "one",
        description: "Use this when superseding.",
        body: "New body.",
      },
      CONTEXT,
    );
    // Superseding an existing Skill does not grow the root, so it is admitted.
    expect(third.isError).toBe(false);
    await dispose();
  });

  test("counts every page of the root, so the 201st Skill is refused", async () => {
    const workspace = new FakeWorkspace();
    // The store's default page is 100, so 200 Skills span more than one page.
    // A single unpaged count would see 100 and admit the 201st forever.
    workspace.listPageSize = 100;
    for (let index = 0; index < 200; index += 1) {
      const slug = `held-${String(index).padStart(3, "0")}`;
      await workspace.seed({
        root: OWN_ROOT,
        path: `skills/${slug}/SKILL.md`,
        text: skillMarkdown(slug, "Use this when counting.", "Body."),
        writer: BOT_WRITER,
      });
    }
    const { sessions, dispose } = await openSession();
    const tool = createSkillWriteTool(
      { owner: OWNER, reads: workspace, files: workspace },
      WRITER,
      sessions,
    );

    const result = await tool.execute(
      {
        name: "two hundred and one",
        description: "Use this when exceeding.",
        body: "Body.",
      },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("this Bot holds 200 Skills");
    expect(
      workspace.calls.some((call) =>
        call.startsWith("write:skills/two-hundred-and-one/"),
      ),
    ).toBe(false);
    await dispose();
  });

  test("refuses the write when the instruction root cannot be listed", async () => {
    const workspace = new FakeWorkspace();
    workspace.listFailure = {
      status: "unavailable",
      reason: "the bucket is unreachable",
    };
    const { session, sessions, dispose } = await openSession();
    const tool = createSkillWriteTool(
      { owner: OWNER, reads: workspace, files: workspace },
      WRITER,
      sessions,
    );

    const result = await tool.execute(
      { name: "unbounded", description: "Use this when blind.", body: "Body." },
      CONTEXT,
    );

    // An unreadable listing makes the quota unknowable, so the write is
    // refused visibly rather than proceeding against a count of zero.
    expect(result.isError).toBe(true);
    expect(result.content).toContain("quota cannot be enforced");
    expect(workspace.calls.some((call) => call.startsWith("write:"))).toBe(
      false,
    );
    expect(
      session.events.some((event) => event.type === "skill/write-intent"),
    ).toBe(false);
    await dispose();
  });

  test("refuses a name carrying control characters, before any write", async () => {
    const workspace = new FakeWorkspace();
    const { sessions, dispose } = await openSession();
    const tool = createSkillWriteTool(
      { owner: OWNER, reads: workspace, files: workspace },
      WRITER,
      sessions,
    );

    const result = await tool.execute(
      {
        name: "broken\nname: injected",
        description: "Use this when breaking the frontmatter.",
        body: "Body.",
      },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("newlines or control characters");
    expect(workspace.calls).toEqual([]);
    await dispose();
  });

  test("refuses input it cannot decode without touching the Workspace", async () => {
    const workspace = new FakeWorkspace();
    const { sessions, dispose } = await openSession();
    const tool = createSkillWriteTool(
      { owner: OWNER, reads: workspace, files: workspace },
      WRITER,
      sessions,
    );
    expect(tool.validate?.({ name: "a" })).toBe(false);
    const result = await tool.execute({ name: "a", description: "b" }, CONTEXT);
    expect(result.isError).toBe(true);
    expect(workspace.calls).toEqual([]);
    await dispose();
  });
});

describe("the recorded step", () => {
  test("refuses to record against a closed step", async () => {
    const root = new Context();
    await root.plugin(SessionStore);
    const session = root.sessions.create("closed");
    session.appendBatch([
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      { type: "step/end", turn: 1, step: 1, outcome: "completed" },
    ]);
    expect(() => openSkillTurnPositionV1(session)).toThrow(
      "no open step to record against",
    );
    await root.fiber.dispose();
  });
});
