// The Bot Durable Object's half of the `subagent` hand-off: what one admitted
// Turn is, decided here rather than by the model's arguments.
import { describe, expect, test } from "bun:test";
import {
  agentRunIdV1,
  createBotSelfManagementHost,
  handoffRunIdV1,
  type BotSelfManagementAuthorities,
} from "./backend-flock.ts";

const IDENTITY = { userId: "user-1", botId: "bot-1" };

type SpawnRequest = Parameters<
  NonNullable<BotSelfManagementAuthorities["spawnSubagent"]>
>[0];

/** Every authority but the one under test; reaching for one is the failure. */
function unreachable(name: string): never {
  throw new Error(`a hand-off must not reach ${name}`);
}

function seam(handoffDepth?: number): {
  spawn: NonNullable<
    ReturnType<typeof createBotSelfManagementHost>["subagent"]
  >["spawn"];
  admitted: SpawnRequest[];
} {
  const admitted: SpawnRequest[] = [];
  const authorities: BotSelfManagementAuthorities = {
    readSettings: () => unreachable("readSettings"),
    executeConfiguration: () => unreachable("executeConfiguration"),
    listBots: () => unreachable("listBots"),
    createBot: () => unreachable("createBot"),
    reserveAgentTurn: () => unreachable("reserveAgentTurn"),
    releaseAgentTurn: () => unreachable("releaseAgentTurn"),
    runAgent: () => unreachable("runAgent"),
    readBotVoice: () => unreachable("readBotVoice"),
    updateBotVoice: () => unreachable("updateBotVoice"),
    spawnSubagent: async (request) => {
      admitted.push(request);
      return { status: "started" };
    },
  };
  const host = createBotSelfManagementHost(
    IDENTITY,
    {
      runId: "run-parent",
      turnId: "run-parent",
      sessionId: "user-1:bot-1",
      fromBotName: "Bot One",
      ...(handoffDepth === undefined ? {} : { handoffDepth }),
    },
    authorities,
  );
  if (!host.subagent) throw new Error("the hand-off seam was not bound");
  return { spawn: host.subagent.spawn, admitted };
}

describe("a spawned hand-off", () => {
  test("is an agent-lane Turn on this Bot, in this conversation", async () => {
    const { spawn, admitted } = seam();
    const outcome = await spawn({
      task: "reconcile last month",
      effectId: "tool:1:1:0",
    });

    expect(outcome.status).toBe("started");
    expect(admitted).toHaveLength(1);
    const [request] = admitted;
    expect(request.userId).toBe("user-1");
    expect(request.botId).toBe("bot-1");
    expect(request.command.sessionId).toBe("user-1:bot-1");
    expect(request.command.text).toBe("reconcile last month");
    // The lane is what makes this safe to start from inside a running Turn.
    expect(request.command.turnType).toBe("agent");
    expect(request.command.lane).toBe("agent");
    expect(request.command.origin).toEqual({
      kind: "handoff",
      parentRunId: "run-parent",
      depth: 1,
    });
    expect(request.command.runId).toBe(outcome.runId);
    expect(request.command.runId).toBe(
      await handoffRunIdV1(IDENTITY, "tool:1:1:0"),
    );
  });

  test("counts its depth up from the Turn that asked", async () => {
    // Nothing admits this today — the tool refuses above zero — but the depth
    // on the record is arithmetic, not a constant, so it says so.
    const { spawn, admitted } = seam(1);
    await spawn({ task: "go", effectId: "tool:1:1:0" });
    expect(admitted[0].command.origin.depth).toBe(2);
  });

  test("asks for the same run id when the same call is replayed", async () => {
    const first = seam();
    const second = seam();
    await first.spawn({ task: "go", effectId: "tool:1:1:0" });
    await second.spawn({ task: "go", effectId: "tool:1:1:0" });
    expect(first.admitted[0].command.runId).toBe(
      second.admitted[0].command.runId,
    );

    const other = seam();
    await other.spawn({ task: "go", effectId: "tool:1:1:1" });
    expect(other.admitted[0].command.runId).not.toBe(
      first.admitted[0].command.runId,
    );
  });

  test("is not offered at all when the host bound no admission", () => {
    const host = createBotSelfManagementHost(
      IDENTITY,
      {
        runId: "run-parent",
        turnId: "run-parent",
        sessionId: "user-1:bot-1",
        fromBotName: "Bot One",
      },
      {
        readSettings: () => unreachable("readSettings"),
        executeConfiguration: () => unreachable("executeConfiguration"),
        listBots: () => unreachable("listBots"),
        createBot: () => unreachable("createBot"),
        reserveAgentTurn: () => unreachable("reserveAgentTurn"),
        releaseAgentTurn: () => unreachable("releaseAgentTurn"),
        runAgent: () => unreachable("runAgent"),
        readBotVoice: () => unreachable("readBotVoice"),
        updateBotVoice: () => unreachable("updateBotVoice"),
      },
    );
    expect(host.subagent).toBeUndefined();
  });
});

describe("a question to another Bot", () => {
  test("runs as the Turn the asking Bot's reads name", async () => {
    const ran: string[] = [];
    const authorities: BotSelfManagementAuthorities = {
      readSettings: () => unreachable("readSettings"),
      executeConfiguration: () => unreachable("executeConfiguration"),
      listBots: async () =>
        ({
          schemaVersion: 1,
          bots: [{ botId: "bot-dog", initialName: "Dog" }],
        }) as never,
      createBot: () => unreachable("createBot"),
      reserveAgentTurn: async () => ({ status: "reserved" }) as never,
      releaseAgentTurn: async () => undefined as never,
      runAgent: async (request) => {
        ran.push(request.command.runId);
        return { text: "Early December." } as never;
      },
      readBotVoice: () => unreachable("readBotVoice"),
      updateBotVoice: () => unreachable("updateBotVoice"),
    };
    const host = createBotSelfManagementHost(
      IDENTITY,
      {
        runId: "run-parent",
        turnId: "run-parent",
        sessionId: "user-1:bot-1",
        fromBotName: "Bot One",
      },
      authorities,
    );
    const outcome = await host.messageBot({
      targetBotId: "bot-dog",
      message: "When is the Series B expected to close?",
      effectId: "tool:1:2:0",
    });
    // The client finds the answering Turn by this id, so it is the one
    // actually run, derived from the question's own effect.
    const expected = await agentRunIdV1(IDENTITY, "bot-dog", "tool:1:2:0");
    expect(ran).toEqual([expected]);
    expect(outcome.runId).toBe(expected);
  });
});
