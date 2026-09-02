import { describe, expect, test } from "bun:test";
import { SessionStore, type Session } from "@frockbot/kernel-contracts";
import { Context } from "cordis";
import {
  createPackageAuthorTool,
  createPackageInspectSelfTool,
  createPackageUndoTool,
  openTurnPositionV1,
  type AuthorPackageRequestV1,
  type PackageAuthoringHost,
} from "./agent.ts";
import { sha256HexV1, type AuthorPackageOutcomeV1 } from "./shared.ts";

const INPUT = {
  packageId: "weather-lookup",
  displayName: "Weather lookup",
  tools: [{ name: "weather_lookup", description: "Looks up", inputSchema: {} }],
  source: "export const tools = [];\nexport async function execute() {}\n",
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

function stubHost(
  outcome: AuthorPackageOutcomeV1,
  seen: AuthorPackageRequestV1[] = [],
): PackageAuthoringHost {
  return {
    effectIdFor: () => Promise.resolve("author-0123456789abcdef"),
    author: (request) => {
      seen.push(request);
      return Promise.resolve(outcome);
    },
    undoEffectIdFor: () => Promise.resolve("undo-0123456789abcdef"),
    undo: () =>
      Promise.resolve({
        status: "recorded",
        effectId: "undo-0123456789abcdef",
        generationId: "revert-generation",
        targetGenerationId: "target-generation",
      }),
    inspectSelf: () =>
      Promise.resolve({
        contextContract: "interface BotPackageExecutionContextV1 {}",
        composition: {
          generationId: "current-generation",
          status: "active",
          members: [],
        },
        failures: [],
      }),
  };
}

describe("the package_author tool", () => {
  test("records intent before the effect and the outcome after it", async () => {
    const { session, sessions, dispose } = await openSession();
    const seen: AuthorPackageRequestV1[] = [];
    const tool = createPackageAuthorTool(
      stubHost(
        {
          status: "authored",
          packageId: "weather-lookup",
          version: "0.0.1",
          contentHash: "b".repeat(64),
          generationId: "2026-08-31T01:00:00.000Z:fedcba9876543210",
        },
        seen,
      ),
      sessions,
    );

    const result = await tool.execute(INPUT, CONTEXT);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("version 0.0.1");
    expect(result.content).toContain(
      "2026-08-31T01:00:00.000Z:fedcba9876543210",
    );
    expect(result.content).toContain("activates on the next Turn");
    const types = session.events.map((event) => event.type);
    expect(types.slice(-2)).toEqual([
      "package/author-intent",
      "package/authored",
    ]);
    // The intent is recorded before the host is reached at all.
    expect(seen).toHaveLength(1);
    expect(seen[0]?.position).toEqual({ turn: 4, step: 2 });
    await dispose();
  });

  test("includes the UI HTML hash and declared hooks in the effect identity", async () => {
    const { sessions, dispose } = await openSession();
    const effectInputs: Parameters<PackageAuthoringHost["effectIdFor"]>[0][] =
      [];
    const host = stubHost({
      status: "authored",
      packageId: "weather-lookup",
      version: "0.0.1",
      contentHash: "b".repeat(64),
      generationId: "2026-08-31T01:00:00.000Z:fedcba9876543210",
    });
    host.effectIdFor = (input) => {
      effectInputs.push(input);
      return Promise.resolve("author-0123456789abcdef");
    };
    const tool = createPackageAuthorTool(host, sessions);
    const html = "<!doctype html><h1>Weather</h1>";

    await tool.execute(
      {
        ...INPUT,
        hooks: ["agent/tool-exposure"],
        ui: {
          html,
          mounts: [{ slot: "frockbot.tool-result:weather_lookup" }],
        },
      },
      CONTEXT,
    );

    expect(effectInputs).toEqual([
      {
        packageId: "weather-lookup",
        sourceHash: await sha256HexV1(INPUT.source),
        uiHtmlHash: await sha256HexV1(html),
        hooks: ["agent/tool-exposure"],
      },
    ]);
    await dispose();
  });

  test("a refusal leaves the intent recorded and no authored event", async () => {
    const { session, sessions, dispose } = await openSession();
    const tool = createPackageAuthorTool(
      stubHost({
        status: "refused",
        reason: "a durable per-User quota refused this Package",
        failureId: "authoring-failure-1",
      }),
      sessions,
    );

    const result = await tool.execute(INPUT, CONTEXT);

    expect(result.isError).toBe(true);
    expect(result.content).toContain("authoring-failure-1");
    expect(session.events.map((event) => event.type)).toContain(
      "package/author-intent",
    );
    expect(session.events.map((event) => event.type)).not.toContain(
      "package/authored",
    );
    await dispose();
  });

  test("an undecodable input is a tool error, not a durable effect", async () => {
    const { session, sessions, dispose } = await openSession();
    const seen: AuthorPackageRequestV1[] = [];
    const tool = createPackageAuthorTool(
      stubHost(
        {
          status: "authored",
          packageId: "x",
          version: "0.0.1",
          contentHash: "b".repeat(64),
          generationId: "g",
        },
        seen,
      ),
      sessions,
    );

    expect(tool.validate?.({ packageId: "Weather" })).toBe(false);
    const result = await tool.execute({ packageId: "Weather" }, CONTEXT);

    expect(result.isError).toBe(true);
    expect(seen).toHaveLength(0);
    expect(session.events.map((event) => event.type)).not.toContain(
      "package/author-intent",
    );
    await dispose();
  });

  test("authoring outside an open step is refused", async () => {
    const root = new Context();
    await root.plugin(SessionStore);
    const session = root.sessions.create("user-1:bot-1");
    session.appendBatch([
      { type: "turn/start", turn: 1 },
      { type: "step/start", turn: 1, step: 1 },
      { type: "step/end", turn: 1, step: 1, outcome: "completed" },
    ]);
    expect(() => openTurnPositionV1(session)).toThrow();
    await root.fiber.dispose();
  });
});

describe("the Package setup companion tools", () => {
  test("package_undo records intent before the durable revert outcome", async () => {
    const { session, sessions, dispose } = await openSession();
    const host = stubHost({
      status: "refused",
      reason: "unused",
      failureId: "unused",
    });
    const tool = createPackageUndoTool(host, sessions);

    const result = await tool.execute({}, CONTEXT);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("activates on the next Turn");
    expect(result.content).toContain("did not undo any action");
    expect(session.events.slice(-2).map((event) => event.type)).toEqual([
      "package/undo-intent",
      "package/undo-recorded",
    ]);
    await dispose();
  });

  test("package_inspect_self returns the host's generated catalog read-only", async () => {
    const host = stubHost({
      status: "refused",
      reason: "unused",
      failureId: "unused",
    });
    const tool = createPackageInspectSelfTool(host);

    const result = await tool.execute({}, CONTEXT);

    expect(result.isError).toBe(false);
    expect(result.content).toContain("BotPackageExecutionContextV1");
    expect(tool.idempotent).toBe(true);
  });
});
