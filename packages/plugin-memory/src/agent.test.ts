// The Memory runtime Contribution: what it injects, what it records, and what
// its tools refuse.
import { describe, expect, test } from "bun:test";
import { SessionStore, type Session } from "@frockbot/kernel-contracts";
import { Context } from "cordis";
import {
  createMemoryForgetTool,
  createMemoryWriteTool,
  createProjectTools,
  MemoryProjection,
  type MemoryRuntimeHostV1,
} from "./agent.ts";
import { userMemoryRootV1 } from "./roots.ts";
import { MemoryStore } from "./store.ts";
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

  test("makes no Computer interface call — nothing on the path holds one", async () => {
    // The structural half of the architecture check: this Package's runtime
    // host carries a Workspace file surface and nothing else, so there is no
    // Computer object a read or a write could reach.
    const host = hostFor();
    expect(Object.keys(host).sort()).toEqual(["owner", "store", "writer"]);
    const { session, dispose } = await openSession();
    await new MemoryProjection(host).refresh(4, session);
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
