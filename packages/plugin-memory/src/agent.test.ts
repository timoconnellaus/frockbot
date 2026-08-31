// The Memory runtime Contribution: what it injects, what it records, and what
// its tools refuse.
import { describe, expect, test } from "bun:test";
import { SessionStore, type Session } from "@frockbot/kernel-contracts";
import { Context } from "cordis";
import type { WorkspaceFilesV1 } from "@frockbot/kernel-contracts";
import {
  createMemoryForgetTool,
  createMemorySearchTool,
  createMemoryWriteTool,
  createProjectTools,
  MemoryProjection,
  type MemoryRuntimeHostV1,
} from "./agent.ts";
import { userMemoryRootV1 } from "./roots.ts";
import { MemoryStore, MEMORY_MAX_FILES_PER_TIER } from "./store.ts";
import {
  createInMemoryMemoryProjectsV1,
  createTestMemoryFilesV1,
} from "./testing.ts";

const OWNER = { userId: "user-1", botId: "bot-1" };
const WRITER = { sessionId: "user-1:bot-1", turnId: "turn-4", runId: "run-9" };
const AT = new Date("2026-08-31T10:00:00.000Z");

const CONTEXT = {
  botId: "bot-1",
  agentId: "bot-1",
  sessionId: "user-1:bot-1",
  compositionGenerationId: "2026-08-31T00:00:00.000Z:0123456789abcdef",
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

function hostFor(
  botId = "bot-1",
  files = createTestMemoryFilesV1({ userId: "user-1" }),
): MemoryRuntimeHostV1 & {
  writer: NonNullable<MemoryRuntimeHostV1["writer"]>;
} {
  return {
    owner: { userId: "user-1", botId },
    store: new MemoryStore({
      files,
      owner: { userId: "user-1", botId },
      botNames: { "bot-1": "General", "bot-2": "School" },
      clock: () => AT,
    }),
    writer: WRITER,
  };
}

/** The Bot provenance one shard's writes carry. */
function botWriter(botId: string) {
  return {
    kind: "bot" as const,
    botId,
    sessionId: `user-1:${botId}`,
    turnId: "turn-4",
    runId: "run-9",
  };
}

/**
 * A Workspace surface that serves reads normally and stops accepting writes
 * after `allowed` of them, so a change that spans two files can be interrupted
 * between them.
 */
function writesFailAfter(
  files: WorkspaceFilesV1,
  allowed: number,
): WorkspaceFilesV1 {
  let seen = 0;
  return {
    read: (path) => files.read(path),
    list: (request) => files.list(request),
    stat: (path) => files.stat(path),
    write: (request) => {
      seen += 1;
      if (seen > allowed) {
        return Promise.resolve({
          status: "unavailable" as const,
          reason: "the bucket went away",
        });
      }
      return files.write(request);
    },
    delete: (request) => files.delete(request),
  };
}

describe("memory_write", () => {
  test("records intent before the effect, then the generation it produced", async () => {
    const host = hostFor();
    const { session, sessions, dispose } = await openSession();
    const projection = new MemoryProjection(host);
    const tool = createMemoryWriteTool(host, sessions, projection);

    const result = await tool.execute(
      { scope: "user", tier: "profile", fact: "Tim lives in Wollongong." },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    const intent = session.events.find(
      (event) => event.type === "memory/write-intent",
    );
    const written = session.events.find(
      (event) => event.type === "memory/written",
    );
    expect(intent).toMatchObject({
      turn: 4,
      step: 2,
      action: "write",
      scope: "user",
      tier: "profile",
    });
    expect(written).toMatchObject({ action: "write", scope: "user" });
    expect(intent!.seq).toBeLessThan(written!.seq);
    if (written?.type !== "memory/written") throw new Error("unreachable");
    expect(written.path).toBe("by-agent/bot-1/profile.md");
    expect(written.effectId).toBe(
      intent?.type === "memory/write-intent" ? intent.effectId : "",
    );
    await dispose();
  });

  test("refuses a credential-shaped fact, visibly, and writes nothing", async () => {
    const host = hostFor();
    const { session, sessions, dispose } = await openSession();
    const tool = createMemoryWriteTool(
      host,
      sessions,
      new MemoryProjection(host),
    );

    const result = await tool.execute(
      { fact: "The key is sk-abcdefghijklmnopqrstuvwxyz." },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("no secrets");
    // The intent is still recorded: the refusal is an observable outcome of an
    // attempt, not an event that never happened.
    expect(
      session.events.some((event) => event.type === "memory/write-intent"),
    ).toBe(true);
    expect(
      session.events.some((event) => event.type === "memory/written"),
    ).toBe(false);
    await dispose();
  });
});

describe("memory_forget", () => {
  test("retracts another Bot's shared fact in this Bot's own shard", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const other = hostFor("bot-2", files);
    await other.store.write({
      root: userMemoryRootV1(OWNER),
      tier: "profile",
      fact: "Tim teaches on Tuesdays.",
      writer: {
        kind: "bot",
        botId: "bot-2",
        sessionId: "user-1:bot-2",
        turnId: "t",
        runId: "r",
      },
    });
    const host = hostFor("bot-1", files);
    const { session, sessions, dispose } = await openSession();
    const tool = createMemoryForgetTool(
      host,
      sessions,
      new MemoryProjection(host),
    );

    const result = await tool.execute(
      { scope: "user", fact: "Tim teaches on Tuesdays." },
      CONTEXT,
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain("retraction");
    const written = session.events.find(
      (event) => event.type === "memory/written",
    );
    if (written?.type !== "memory/written") throw new Error("unreachable");
    expect(written.action).toBe("forget");
    expect(written.path).toBe("by-agent/bot-1/log/2026-08.md");
    await dispose();
  });
});

describe("the Turn projection", () => {
  test("records exactly what it injected, generations included", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const other = hostFor("bot-2", files);
    const shared = await other.store.write({
      root: userMemoryRootV1(OWNER),
      tier: "profile",
      fact: "Tim teaches on Tuesdays.",
      writer: {
        kind: "bot",
        botId: "bot-2",
        sessionId: "user-1:bot-2",
        turnId: "t",
        runId: "r",
      },
    });
    const host = hostFor("bot-1", files);
    const { session, dispose } = await openSession();
    const projection = new MemoryProjection(host);

    const injection = await projection.refresh(4, session);

    expect(injection.text).toContain(
      "- (learned 2026-08-31) [via School] Tim teaches on Tuesdays.",
    );
    const injected = session.events.find(
      (event) => event.type === "memory/injected",
    );
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    expect(injected.turn).toBe(4);
    expect(injected.facts).toEqual([
      {
        scope: "user",
        projectId: "",
        tier: "profile",
        via: "School",
        learnedAt: "2026-08-31",
        text: "Tim teaches on Tuesdays.",
      },
    ]);
    expect(injected.sources).toEqual([
      {
        scope: "user",
        projectId: "",
        path: "by-agent/bot-2/profile.md",
        generationId:
          shared.status === "ok" ? shared.generationId : "unreachable",
        contentHash:
          shared.status === "ok" ? shared.contentHash : "unreachable",
      },
    ]);
    expect(projection.loadedTurn()).toBe(4);
    await dispose();
  });
});

describe("the Project tools", () => {
  test("create is join, and membership reaches durable state through the authority", async () => {
    const host = { ...hostFor(), projects: createInMemoryMemoryProjectsV1() };
    const { session, sessions, dispose } = await openSession();
    const projection = new MemoryProjection(host);
    const [create, join, leave] = createProjectTools(
      host,
      sessions,
      projection,
    );

    const created = await create!.execute(
      {
        project: "ghetto-movement",
        name: "Ghetto Movement",
        description: "The gym build.",
      },
      CONTEXT,
    );
    expect(created.isError).toBe(false);
    expect(await host.projects.joined()).toEqual([
      {
        projectId: "ghetto-movement",
        name: "Ghetto Movement",
        description: "The gym build.",
      },
    ]);

    // The descriptor is a Memory file, written with the User's authority.
    const descriptor = await host.store.reads.read({
      root: {
        kind: "project-memory",
        userId: "user-1",
        projectId: "ghetto-movement",
      },
      path: "projects/ghetto-movement/project.md",
    });
    expect(descriptor.status).toBe("ok");
    expect(
      descriptor.status === "ok"
        ? descriptor.file.generation.writer
        : undefined,
    ).toEqual({ kind: "user", userId: "user-1" });

    const intent = session.events.find(
      (event) => event.type === "memory/project-intent",
    );
    const changed = session.events.find(
      (event) => event.type === "memory/project-changed",
    );
    expect(intent).toMatchObject({
      action: "create",
      projectId: "ghetto-movement",
    });
    expect(changed).toMatchObject({ projects: ["ghetto-movement"] });
    expect(intent!.seq).toBeLessThan(changed!.seq);

    await leave!.execute({ project: "ghetto-movement" }, CONTEXT);
    expect(await host.projects.joined()).toEqual([]);
    const rejoined = await join!.execute(
      { project: "ghetto-movement" },
      CONTEXT,
    );
    expect(rejoined.isError).toBe(false);
    expect((await host.projects.joined()).map((p) => p.projectId)).toEqual([
      "ghetto-movement",
    ]);
    await dispose();
  });
});

describe("a Memory read that a bound cut short", () => {
  test("records an omission naming the tier rather than a complete-looking injection", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    // One profile shard per Bot, one more than the tier read bound.
    const shards = MEMORY_MAX_FILES_PER_TIER + 1;
    for (let index = 0; index < shards; index += 1) {
      const botId = `bot-${String(index).padStart(3, "0")}`;
      const store = new MemoryStore({
        files,
        owner: { userId: "user-1", botId },
        clock: () => AT,
      });
      const written = await store.write({
        root: userMemoryRootV1(OWNER),
        tier: "profile",
        fact: `Shard ${index} learned something.`,
        writer: botWriter(botId),
      });
      expect(written.status).toBe("ok");
    }
    const host = hostFor("bot-000", files);
    const { session, dispose } = await openSession();

    await new MemoryProjection(host).refresh(4, session);

    const injected = session.events.find(
      (event) => event.type === "memory/injected",
    );
    if (injected?.type !== "memory/injected") throw new Error("unreachable");
    const omission = injected.omissions.find(
      (entry) =>
        entry.scope === "user" && entry.reason.includes("read bound were not"),
    );
    expect(omission).toBeDefined();
    expect(omission?.reason).toContain(`1 Memory file(s)`);
    await dispose();
  });
});

describe("a project-scope change to a Project the Bot never joined", () => {
  test("is refused, and nothing is recorded or written", async () => {
    const host = { ...hostFor(), projects: createInMemoryMemoryProjectsV1() };
    const { session, sessions, dispose } = await openSession();
    const projection = new MemoryProjection(host);
    const write = createMemoryWriteTool(host, sessions, projection);
    const forget = createMemoryForgetTool(host, sessions, projection);

    const written = await write.execute(
      { scope: "project", project: "never-joined", fact: "A shared fact." },
      CONTEXT,
    );
    const forgotten = await forget.execute(
      { scope: "project", project: "never-joined", fact: "A shared fact." },
      CONTEXT,
    );

    expect(written.isError).toBe(true);
    expect(written.content).toContain("you have not joined");
    expect(forgotten.isError).toBe(true);
    expect(forgotten.content).toContain("you have not joined");
    expect(
      session.events.some((event) => event.type === "memory/written"),
    ).toBe(false);
    expect(
      session.events.some((event) => event.type === "memory/write-intent"),
    ).toBe(false);
    await dispose();
  });
});

describe("a memory_forget that changes one file and then fails", () => {
  test("records the generation it did write, so the log matches the files", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const seed = new MemoryStore({ files, owner: OWNER, clock: () => AT });
    const fact = "Tim teaches on Tuesdays.";
    for (const tier of ["profile", "log"] as const) {
      const written = await seed.write({
        root: userMemoryRootV1(OWNER),
        tier,
        fact,
        writer: botWriter("bot-1"),
      });
      expect(written.status).toBe("ok");
    }
    // The forget rewrites log/2026-08.md then profile.md; only the first lands.
    const host = hostFor("bot-1", writesFailAfter(files, 1));
    const { session, sessions, dispose } = await openSession();
    const tool = createMemoryForgetTool(
      host,
      sessions,
      new MemoryProjection(host),
    );

    const result = await tool.execute({ scope: "user", fact }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("after changing 1 file(s)");
    const written = session.events.filter(
      (event) => event.type === "memory/written",
    );
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      action: "forget",
      path: "by-agent/bot-1/log/2026-08.md",
    });
    // The event log names the file that really changed on disk.
    const remaining = await host.store.read(userMemoryRootV1(OWNER));
    expect(remaining.recent.map((entry) => entry.text)).toEqual([]);
    expect(remaining.profile.map((entry) => entry.text)).toEqual([fact]);
    await dispose();
  });
});

describe("project_create when the descriptor write conflicts", () => {
  test("is a visible refusal, and no membership change is recorded", async () => {
    const files = createTestMemoryFilesV1({ userId: "user-1" });
    const conflicting: WorkspaceFilesV1 = {
      read: (path) => files.read(path),
      list: (request) => files.list(request),
      stat: (path) => files.stat(path),
      write: () =>
        Promise.resolve({
          status: "conflict" as const,
          reason: "another writer holds a newer generation",
        }),
      delete: (request) => files.delete(request),
    };
    const host = {
      ...hostFor("bot-1", conflicting),
      projects: createInMemoryMemoryProjectsV1(),
    };
    const { session, sessions, dispose } = await openSession();
    const [create] = createProjectTools(
      host,
      sessions,
      new MemoryProjection(host),
    );

    const created = await create!.execute(
      { project: "ghetto-movement", name: "Ghetto Movement" },
      CONTEXT,
    );

    expect(created.isError).toBe(true);
    expect(created.content).toContain("conflict");
    expect(
      session.events.some((event) => event.type === "memory/project-changed"),
    ).toBe(false);
    expect(await host.projects.joined()).toEqual([]);
    await dispose();
  });
});

describe("memory_search", () => {
  test("decodes its input at the seam, refusing an unknown field", async () => {
    const host = hostFor();
    const projection = new MemoryProjection(host);
    const tool = createMemorySearchTool(host, projection);

    expect(tool.validate?.({ query: "tuesdays", limit: 3 })).toBe(false);
    const unknown = await tool.execute(
      { query: "tuesdays", limit: 3 },
      CONTEXT,
    );
    expect(unknown.isError).toBe(true);
    expect(unknown.content).toContain("unknown fields");

    expect(tool.validate?.({ query: "tuesdays", maxResults: 99 })).toBe(false);
    const range = await tool.execute(
      { query: "tuesdays", maxResults: 99 },
      CONTEXT,
    );
    expect(range.isError).toBe(true);
    expect(range.content).toContain("maxResults");

    const ok = await tool.execute({ query: "tuesdays" }, CONTEXT);
    expect(ok.isError).toBe(false);
  });
});
