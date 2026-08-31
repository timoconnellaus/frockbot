import { describe, expect, test } from "bun:test";
import { SessionStore, type Session } from "@frockbot/kernel-contracts";
import { Context } from "cordis";
import {
  createSkillLoadTool,
  createSkillWriteTool,
  SkillCatalog,
  skillWriteScopeRefusalV1,
} from "./agent.ts";
import {
  assembleSkillCatalogV1,
  botInstructionRootV1,
  type LoadedSkillV1,
  loadFullSkillCatalogV1,
  renderSkillCatalogPromptV1,
  resolveSkillRefV1,
  SKILL_CATALOG_CAPS_V1,
  type SkillCatalogCapsV1,
  userInstructionRootV1,
} from "./catalog.ts";
import { loadManagedSkillsV1, MANAGED_SKILL_DOCUMENTS_V1 } from "./managed.ts";
import {
  loadPluginSkillsV1,
  type PluginSkillsSourceV1,
} from "./plugin-index.ts";
import { FakeWorkspace, skillMarkdown } from "./testing.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
const OWN_ROOT = botInstructionRootV1(OWNER);
const USER_ROOT = userInstructionRootV1(OWNER);
const BOT_WRITER = {
  kind: "bot" as const,
  botId: "bot-1",
  sessionId: "user-1:bot-1",
  turnId: "turn-1",
  runId: "run-1",
};
const CONTEXT = {
  botId: "bot-1",
  agentId: "bot-1",
  sessionId: "user-1:bot-1",
  compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
  turnType: "chat" as const,
  effectId: "tool:1:1:0",
  signal: new AbortController().signal,
};

function pluginSource(
  packages: {
    packageId: string;
    catalogId: string;
    generation: string;
    skills: { name: string; description?: string; body?: string }[];
  }[],
): PluginSkillsSourceV1 {
  return { read: () => Promise.resolve({ status: "ok", packages }) };
}

async function openSession(): Promise<{
  session: Session;
  sessions: { get(id: string): Session | undefined };
  dispose: () => Promise<void>;
}> {
  const root = new Context();
  await root.plugin(SessionStore);
  const session = root.sessions.create("user-1:bot-1");
  session.appendBatch([
    { type: "turn/start", turn: 1 },
    { type: "step/start", turn: 1, step: 1 },
  ]);
  return {
    session,
    sessions: root.sessions,
    dispose: () => root.fiber.dispose(),
  };
}

describe("the managed Skill source", () => {
  test("ships the four first-party Skills, content-addressed", async () => {
    const loaded = await loadManagedSkillsV1();

    expect(loaded.refusals).toEqual([]);
    expect(loaded.skills.map((skill) => skill.ref?.slug)).toEqual([
      "add-connector",
      "export-bot-template",
      "import-bot-template",
      "learn-from-demonstration",
    ]);
    for (const skill of loaded.skills) {
      expect(skill.ref?.source).toBe("managed");
      expect(skill.path).toBe(`managed/${skill.ref?.slug}/SKILL.md`);
      expect(skill.description.length).toBeGreaterThan(0);
      // The generation is the content hash: the bytes are the artifact's, and
      // the artifact set hash the Composition pins makes them reproducible.
      expect(skill.generationId).toBe(skill.contentHash);
      expect(skill.generationId).toMatch(/^[0-9a-f]{64}$/u);
    }
  });

  test("is stable across loads, so a pinned Composition reproduces it", async () => {
    const first = await loadManagedSkillsV1();
    const second = await loadManagedSkillsV1();

    expect(second.skills.map((skill) => skill.contentHash)).toEqual(
      first.skills.map((skill) => skill.contentHash),
    );
  });

  test("records a malformed bundled document as a refusal, never a throw", async () => {
    const loaded = await loadManagedSkillsV1([
      { slug: "broken", text: "no frontmatter here" },
      { slug: "Not A Slug", text: MANAGED_SKILL_DOCUMENTS_V1[0]?.text ?? "" },
      {
        slug: "add-connector",
        text: MANAGED_SKILL_DOCUMENTS_V1[0]?.text ?? "",
      },
    ]);

    expect(loaded.skills.map((skill) => skill.ref?.slug)).toEqual([
      "add-connector",
    ]);
    expect(loaded.refusals.map((refusal) => refusal.kind)).toEqual([
      "malformed",
      "malformed",
    ]);
  });

  test("is not editable this way", () => {
    expect(skillWriteScopeRefusalV1("bot")).toBeUndefined();
    expect(skillWriteScopeRefusalV1("managed")).toBe(
      "managed skills are not editable this way",
    );
    expect(skillWriteScopeRefusalV1("plugin")).toBe(
      "managed skills are not editable this way",
    );
    // The User-global root landed with ADR 0016, so `user` is writable and no
    // longer a refusal.
    expect(skillWriteScopeRefusalV1("user")).toBeUndefined();
  });

  test("refuses a managed-scope skill_write with GrokBot's own wording", async () => {
    const workspace = new FakeWorkspace();
    const { sessions, dispose } = await openSession();
    const tool = createSkillWriteTool(
      { owner: OWNER, reads: workspace, files: workspace },
      { sessionId: "user-1:bot-1", turnId: "turn-1", runId: "run-1" },
      sessions,
    );

    const refused = await tool.execute(
      {
        name: "Add connector",
        description: "Use this when connecting.",
        body: "Overwritten.",
        scope: "managed",
      },
      CONTEXT,
    );

    expect(refused.isError).toBe(true);
    expect(refused.content).toContain("managed skills are not editable");
    // Nothing was written: a refusal is not a partial write.
    expect(workspace.calls).toEqual([]);
    await dispose();
  });
});

describe("the plugin-borne Skill index", () => {
  test("indexes an installed entry's Skills at its pinned generation", async () => {
    const loaded = await loadPluginSkillsV1(
      pluginSource([
        {
          packageId: "composio",
          catalogId: "composio",
          generation: "gen-7",
          skills: [
            {
              name: "Compose email",
              description: "Use this when drafting mail.",
              body: "PLUGIN-BODY",
            },
          ],
        },
      ]),
    );

    expect(loaded.refusals).toEqual([]);
    expect(loaded.skills).toHaveLength(1);
    expect(loaded.skills[0]?.ref).toEqual({
      schemaVersion: 1,
      source: "plugin",
      slug: "compose-email",
      packageId: "composio",
    });
    expect(loaded.skills[0]?.path).toBe(
      "plugin/composio/compose-email/SKILL.md",
    );
    expect(loaded.skills[0]?.by).toBe('Package "composio"');
    expect(loaded.skills[0]?.generationId).toBe("catalog:gen-7");
    expect(loaded.skills[0]?.body).toBe("PLUGIN-BODY");
  });

  test("refuses a declaration with nothing to say, and keeps the rest", async () => {
    const loaded = await loadPluginSkillsV1(
      pluginSource([
        {
          packageId: "composio",
          catalogId: "composio",
          generation: "gen-7",
          skills: [
            { name: "No body", description: "Use this when nothing." },
            { name: "No description", body: "Body." },
            { name: "!!!", description: "Use this when unnamed.", body: "B." },
            { name: "Kept", description: "Use this when keeping.", body: "B." },
            {
              name: "kept",
              description: "Use this when colliding.",
              body: "B.",
            },
          ],
        },
      ]),
    );

    expect(loaded.skills.map((skill) => skill.ref?.slug)).toEqual(["kept"]);
    expect(loaded.refusals.map((refusal) => refusal.reason)).toEqual([
      "the Catalog entry lists this Skill without a body",
      "the Catalog entry lists this Skill without a description",
      'the Skill name "!!!" yields no usable slug',
      'Package "composio" declares "kept" more than once',
    ]);
  });

  test("records an unreadable Catalog as a refusal rather than failing the Turn", async () => {
    const loaded = await loadPluginSkillsV1({
      read: () =>
        Promise.resolve({ status: "unavailable", reason: "R2 is down" }),
    });

    expect(loaded.skills).toEqual([]);
    expect(loaded.refusals[0]).toMatchObject({
      path: "plugin",
      kind: "unreadable",
    });
    expect(loaded.refusals[0]?.reason).toContain("R2 is down");
  });

  test("an uninstalled Package contributes nothing on the next Turn", async () => {
    const installed = await loadPluginSkillsV1(
      pluginSource([
        {
          packageId: "composio",
          catalogId: "composio",
          generation: "gen-7",
          skills: [
            { name: "Kept", description: "Use this when keeping.", body: "B." },
          ],
        },
      ]),
    );
    expect(installed.skills).toHaveLength(1);

    // Uninstalling removes the installation row, so the next Turn's index has
    // nothing to read. Nothing was ever copied into a root, so nothing lingers.
    const uninstalled = await loadPluginSkillsV1(pluginSource([]));
    expect(uninstalled.skills).toEqual([]);
    expect(uninstalled.refusals).toEqual([]);
  });
});

function fakeSkill(
  source: "bot" | "user" | "managed" | "plugin",
  slug: string,
  packageId?: string,
): LoadedSkillV1 {
  return {
    path: `${source}/${slug}/SKILL.md`,
    ref: {
      schemaVersion: 1,
      source,
      slug,
      ...(packageId ? { packageId } : {}),
    },
    name: slug,
    description: "Use this when testing.",
    body: "Body.",
    generationId: "g",
    contentHash: "c",
  };
}

describe("assembling the catalog", () => {
  test("orders bot, then user, then managed, then plugin", () => {
    const catalog = assembleSkillCatalogV1(OWNER, {
      plugin: {
        skills: [
          fakeSkill("plugin", "p", "zed"),
          fakeSkill("plugin", "a", "abc"),
        ],
        refusals: [],
      },
      managed: { skills: [fakeSkill("managed", "m")], refusals: [] },
      user: { skills: [fakeSkill("user", "u")], refusals: [] },
      bot: { skills: [fakeSkill("bot", "b")], refusals: [] },
    });

    expect(catalog.skills.map((skill) => skill.path)).toEqual([
      "bot/b/SKILL.md",
      "user/u/SKILL.md",
      "managed/m/SKILL.md",
      "plugin/a/SKILL.md",
      "plugin/p/SKILL.md",
    ]);
  });

  test("records every drop over a source cap as a refusal", () => {
    const caps: SkillCatalogCapsV1 = {
      ...SKILL_CATALOG_CAPS_V1,
      managed: 1,
      plugin: 0,
    };
    const catalog = assembleSkillCatalogV1(
      OWNER,
      {
        managed: {
          skills: [fakeSkill("managed", "a"), fakeSkill("managed", "b")],
          refusals: [],
        },
        plugin: {
          skills: [fakeSkill("plugin", "c", "pkg")],
          refusals: [],
        },
      },
      caps,
    );

    expect(catalog.skills.map((skill) => skill.ref?.slug)).toEqual(["a"]);
    expect(catalog.refusals).toEqual([
      {
        path: "managed/b/SKILL.md",
        kind: "over-source-cap",
        reason:
          "the managed Skill source is bounded at 1 entries in one catalog",
      },
      {
        path: "plugin/c/SKILL.md",
        kind: "over-source-cap",
        reason:
          "the plugin Skill source is bounded at 0 entries in one catalog",
      },
    ]);
  });

  test("bounds the rendered block by bytes, visibly", () => {
    const catalog = assembleSkillCatalogV1(
      OWNER,
      {
        bot: {
          skills: [fakeSkill("bot", "a"), fakeSkill("bot", "b")],
          refusals: [],
        },
      },
      { ...SKILL_CATALOG_CAPS_V1, totalBytes: 40 },
    );

    expect(catalog.skills).toHaveLength(1);
    expect(catalog.refusals[0]).toMatchObject({ kind: "over-source-cap" });
    expect(catalog.refusals[0]?.reason).toContain("40 rendered bytes");
  });

  test("carries a source's own refusals through unchanged", () => {
    const catalog = assembleSkillCatalogV1(OWNER, {
      bot: {
        skills: [],
        refusals: [{ path: "x", kind: "authority", reason: "no" }],
      },
    });

    expect(catalog.refusals).toEqual([
      { path: "x", kind: "authority", reason: "no" },
    ]);
  });
});

describe("the rendered catalog block", () => {
  test("names each Skill's source and attribution", () => {
    const rendered = renderSkillCatalogPromptV1(
      assembleSkillCatalogV1(OWNER, {
        managed: { skills: [fakeSkill("managed", "teach")], refusals: [] },
        plugin: {
          skills: [
            {
              ...fakeSkill("plugin", "compose", "composio"),
              by: 'Package "composio"',
            },
          ],
          refusals: [],
        },
      }),
    );

    expect(rendered).toContain('source="managed" ref="managed/teach"');
    expect(rendered).toContain('source="plugin" ref="plugin/composio/compose"');
    expect(rendered).toContain('by="Package &quot;composio&quot;"');
    // Progressive disclosure survives the new sources.
    expect(rendered).not.toContain("Body.");
  });

  test("disambiguates a duplicated name by its ref", () => {
    const rendered = renderSkillCatalogPromptV1(
      assembleSkillCatalogV1(OWNER, {
        bot: { skills: [fakeSkill("bot", "standup")], refusals: [] },
        plugin: {
          skills: [fakeSkill("plugin", "standup", "composio")],
          refusals: [],
        },
      }),
    );

    expect(rendered).toContain('name="standup (bot/standup)"');
    expect(rendered).toContain('name="standup (plugin/composio/standup)"');
  });
});

describe("resolving a ref against a Turn's catalog", () => {
  test("resolves managed and plugin refs, and refuses an unknown one", () => {
    const catalog = assembleSkillCatalogV1(OWNER, {
      managed: { skills: [fakeSkill("managed", "teach")], refusals: [] },
      plugin: {
        skills: [fakeSkill("plugin", "compose", "composio")],
        refusals: [],
      },
    });

    expect(
      resolveSkillRefV1(catalog, {
        schemaVersion: 1,
        source: "managed",
        slug: "teach",
      })?.path,
    ).toBe("managed/teach/SKILL.md");
    expect(
      resolveSkillRefV1(catalog, {
        schemaVersion: 1,
        source: "plugin",
        slug: "compose",
        packageId: "composio",
      })?.path,
    ).toBe("plugin/compose/SKILL.md");
    // The same slug under another Package is another Skill, not this one.
    expect(
      resolveSkillRefV1(catalog, {
        schemaVersion: 1,
        source: "plugin",
        slug: "compose",
        packageId: "other",
      }),
    ).toBeUndefined();
    expect(
      resolveSkillRefV1(catalog, {
        schemaVersion: 1,
        source: "bot",
        slug: "teach",
      }),
    ).toBeUndefined();
  });
});

describe("a Turn's whole catalog", () => {
  test("assembles all three live sources and loads a body by ref", async () => {
    const workspace = await FakeWorkspace.seeded([
      {
        root: OWN_ROOT,
        path: "skills/standup/SKILL.md",
        text: skillMarkdown("Daily standup", "Use this when standing.", "OWN."),
        writer: BOT_WRITER,
      },
    ]);
    const { session, dispose } = await openSession();
    const catalog = new SkillCatalog(
      OWNER,
      workspace,
      pluginSource([
        {
          packageId: "composio",
          catalogId: "composio",
          generation: "gen-7",
          skills: [
            {
              name: "Compose email",
              description: "Use this when drafting mail.",
              body: "PLUGIN-BODY",
            },
          ],
        },
      ]),
    );

    await catalog.refresh(1, session);

    expect(catalog.current().skills.map((skill) => skill.ref?.source)).toEqual([
      "bot",
      "managed",
      "managed",
      "managed",
      "managed",
      "plugin",
    ]);

    const tool = createSkillLoadTool(catalog);
    const managed = await tool.execute(
      { path: "managed/add-connector" },
      CONTEXT,
    );
    expect(managed.isError).toBe(false);
    expect(managed.content).toContain("Ref: managed/add-connector");

    const plugin = await tool.execute(
      { path: "plugin/composio/compose-email" },
      CONTEXT,
    );
    expect(plugin.isError).toBe(false);
    expect(plugin.content).toContain("PLUGIN-BODY");

    // The path form still works, for one release.
    const byPath = await tool.execute(
      { path: "skills/standup/SKILL.md" },
      CONTEXT,
    );
    expect(byPath.isError).toBe(false);
    expect(byPath.content).toContain("OWN.");

    const unknown = await tool.execute({ path: "managed/nope" }, CONTEXT);
    expect(unknown.isError).toBe(true);
    await dispose();
  });

  test("omits the managed set when the host disables it", async () => {
    const workspace = new FakeWorkspace();
    const catalog = await loadFullSkillCatalogV1(workspace, OWNER, {
      managed: false,
    });

    expect(catalog.skills).toEqual([]);
  });
});

describe("the User-global instruction root", () => {
  const OTHER_BOT_WRITER = { ...BOT_WRITER, botId: "bot-2" };
  const USER_WRITER = { kind: "user" as const, userId: "user-1" };

  test("loads a Skill another of the User's Bots wrote, attributed to that Bot, and refuses what carries no authority", async () => {
    const workspace = await FakeWorkspace.seeded([
      {
        root: OWN_ROOT,
        path: "skills/own/SKILL.md",
        text: skillMarkdown("Own", "Use this when local.", "OWN."),
        writer: BOT_WRITER,
      },
      {
        root: USER_ROOT,
        path: "skills/standup/SKILL.md",
        text: skillMarkdown("Daily standup", "Use this when standing.", "A."),
        writer: OTHER_BOT_WRITER,
      },
      {
        root: USER_ROOT,
        path: "skills/house-style/SKILL.md",
        text: skillMarkdown("House style", "Use this when writing.", "U."),
        writer: USER_WRITER,
      },
      // A shell on the Computer dropped this one: nothing recorded a writer,
      // so it is data, never an instruction.
      {
        root: USER_ROOT,
        path: "skills/dropped/SKILL.md",
        text: skillMarkdown("Dropped", "Use this never.", "X."),
        writer: { kind: "unattributed" },
      },
      // Another User's root is not reachable from this owner at all.
      {
        root: { kind: "user-instructions", userId: "user-2" },
        path: "skills/foreign/SKILL.md",
        text: skillMarkdown("Foreign", "Use this never.", "X."),
        writer: OTHER_BOT_WRITER,
      },
    ]);

    const catalog = await loadFullSkillCatalogV1(workspace, OWNER, {
      managed: false,
    });

    expect(
      catalog.skills.map((skill) => [skill.ref?.source, skill.ref?.slug]),
    ).toEqual([
      ["bot", "own"],
      ["user", "house-style"],
      ["user", "standup"],
    ]);
    // The shared-tier attribution: the reading Bot is told whose instruction
    // it is about to follow, and its own Skill discloses nothing.
    expect(catalog.skills.map((skill) => skill.by)).toEqual([
      undefined,
      "your User",
      'Bot "bot-2"',
    ]);
    expect(
      catalog.refusals.map((refusal) => [refusal.path, refusal.kind]),
    ).toEqual([["skills/dropped/SKILL.md", "authority"]]);
    // Another User's root was never even listed.
    expect(catalog.skills.map((skill) => skill.name)).not.toContain("Foreign");

    const rendered = renderSkillCatalogPromptV1(catalog);
    expect(rendered).toContain('ref="user/standup"');
    expect(rendered).toContain('source="user"');
    expect(rendered).toContain('by="Bot &quot;bot-2&quot;"');
  });

  test("skill_write with scope user lands in the shared root with the writing Bot's full provenance", async () => {
    const workspace = new FakeWorkspace();
    const { sessions, dispose } = await openSession();
    const tool = createSkillWriteTool(
      { owner: OWNER, reads: workspace, files: workspace },
      { sessionId: "user-1:bot-1", turnId: "turn-1", runId: "run-1" },
      sessions,
    );

    const written = await tool.execute(
      {
        name: "Daily standup",
        description: "Use this when standing.",
        body: "Ask each Bot for its blockers.",
        scope: "user",
      },
      CONTEXT,
    );
    expect(written.isError).toBe(false);
    expect(written.content).toContain("shared instruction root");

    const stat = await workspace.stat({
      root: USER_ROOT,
      path: "skills/daily-standup/SKILL.md",
    });
    if (stat.status !== "ok") throw new Error(stat.reason);
    // The full Bot writer, not a bare id: the Session, Turn and run that
    // authored it are what make the write reconstructable.
    expect(stat.entry.generation.writer).toEqual({
      kind: "bot",
      botId: "bot-1",
      sessionId: "user-1:bot-1",
      turnId: "turn-1",
      runId: "run-1",
    });
    // Nothing was written to the Bot's own root.
    expect(
      (
        await workspace.stat({
          root: OWN_ROOT,
          path: "skills/daily-standup/SKILL.md",
        })
      ).status,
    ).toBe("not-found");

    // Another Bot of the same User loads it, and is told who wrote it.
    const catalog = await loadFullSkillCatalogV1(
      workspace,
      { userId: "user-1", botId: "bot-2" },
      { managed: false },
    );
    expect(catalog.skills.map((skill) => [skill.name, skill.by])).toEqual([
      ["Daily standup", 'Bot "bot-1"'],
    ]);
    await dispose();
  });

  test("the two roots have separate Skill-count quotas", async () => {
    const workspace = new FakeWorkspace();
    const { sessions, dispose } = await openSession();
    const tool = createSkillWriteTool(
      {
        owner: OWNER,
        reads: workspace,
        files: workspace,
        quota: {
          schemaVersion: 1,
          maxSkillsPerBot: 2,
          maxSkillsPerUser: 1,
          maxSkillBytes: 65_536,
        },
      },
      { sessionId: "user-1:bot-1", turnId: "turn-1", runId: "run-1" },
      sessions,
    );
    const write = (name: string, scope: "bot" | "user") =>
      tool.execute(
        {
          name,
          description: `Use this when ${name}.`,
          body: "Body.",
          scope,
        },
        CONTEXT,
      );

    expect((await write("one", "user")).isError).toBe(false);
    const overUser = await write("two", "user");
    expect(overUser.isError).toBe(true);
    expect(overUser.content).toContain("shared instruction root holds 1");

    // The Bot's own root is bounded separately, so the shared root filling up
    // never refuses a Bot its own self-modification.
    expect((await write("three", "bot")).isError).toBe(false);
    expect((await write("four", "bot")).isError).toBe(false);
    const overBot = await write("five", "bot");
    expect(overBot.isError).toBe(true);
    expect(overBot.content).toContain("this Bot holds 2");
    await dispose();
  });

  test("a User-global write that supersedes a Skill is admitted at the limit", async () => {
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
      { sessionId: "user-1:bot-1", turnId: "turn-1", runId: "run-1" },
      sessions,
    );
    const draft = {
      name: "Daily standup",
      description: "Use this when standing.",
      scope: "user" as const,
    };

    expect(
      (await tool.execute({ ...draft, body: "First." }, CONTEXT)).isError,
    ).toBe(false);
    // Superseding does not grow the root, so it is admitted at the cap.
    expect(
      (await tool.execute({ ...draft, body: "Second." }, CONTEXT)).isError,
    ).toBe(false);

    const read = await workspace.read({
      root: USER_ROOT,
      path: "skills/daily-standup/SKILL.md",
    });
    if (read.status !== "ok") throw new Error(read.reason);
    expect(new TextDecoder().decode(read.file.bytes)).toContain("Second.");
    await dispose();
  });
});
