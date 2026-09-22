import { describe, expect, test } from "bun:test";
import type { SessionEvent } from "@frockbot/core/contracts";
import {
  BotDurableAuthority,
  type BotDurableAuthorityHooks,
  type OwnedBotTurnCommand,
} from "./authority.ts";
import { bootstrapGeneration } from "./composition/generation.ts";
import { MemoryStorage } from "./memory-storage.fixture.ts";
import { createStoredRunCodecV1 } from "./run-records.ts";
import { BotTurnRecoveryRequiredError } from "./turn-errors.ts";

const codec = createStoredRunCodecV1<undefined>({
  decodeRunId: (value) => value as string,
  decodeConfigurationSnapshot: () => undefined,
});

const identity = { userId: "user-1", botId: "primary" };

function command(
  runId: string,
  text: string,
  extra: Partial<OwnedBotTurnCommand> = {},
): OwnedBotTurnCommand {
  return {
    ...identity,
    runId,
    sessionId: "user-1:primary",
    acceptedAt: "2026-09-22T00:00:00.000Z",
    text,
    ...extra,
  };
}

function authority(
  storage: MemoryStorage,
  executeTurn: BotDurableAuthorityHooks<undefined>["executeTurn"],
  extra: Partial<BotDurableAuthorityHooks<undefined>> = {},
): BotDurableAuthority<undefined> {
  const hooks: BotDurableAuthorityHooks<undefined> = {
    resolveAdmissionSnapshot: () => Promise.resolve(undefined),
    bootstrapComposition: () =>
      bootstrapGeneration({ createdAt: "2026-09-22T00:00:00.000Z" }),
    admittedSnapshot: () => Promise.resolve(undefined),
    executeTurn,
    notification: () => undefined,
    scheduledDeadlines: () => Promise.resolve([]),
    scheduledWorkInFlight: () => false,
    deferScheduledWork: () => Promise.resolve(),
    settleScheduledWork: () => Promise.resolve(),
    ...extra,
  };
  return new BotDurableAuthority({
    state: { storage } as unknown as DurableObjectState,
    codec,
    hooks,
  });
}

function completion(runId: string, text: string) {
  return {
    runId,
    text,
    events: [] as SessionEvent[],
  };
}

describe("admission returns before execution", () => {
  test("the receipt resolves while execution is still held", async () => {
    const storage = new MemoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    const bot = authority(storage, async (input) => {
      executions += 1;
      await gate;
      return completion(input.command.runId, "done");
    });

    const receipt = await bot.admit(command("run-1", "hello"));
    expect(receipt).toEqual({ runId: "run-1", state: "running" });
    const finished = bot.pendingWork();
    for (let turn = 0; turn < 8 && executions === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(executions).toBe(1);
    let settled = false;
    void finished?.then(() => {
      settled = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(settled).toBe(false);

    release();
    await finished;
    expect(await bot.readStoredRun("run-1")).toMatchObject({
      status: "completed",
    });
  });

  test("a queued command is acknowledged before the previous Turn settles", async () => {
    const storage = new MemoryStorage();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    const interrupts: string[] = [];
    let executions = 0;
    const bot = authority(
      storage,
      async (input) => {
        executions += 1;
        if (input.command.runId === "run-1") await firstGate;
        return completion(input.command.runId, input.command.text);
      },
      {
        interruptTurn: (runId) => {
          interrupts.push(runId);
        },
      },
    );

    expect(await bot.admit(command("run-1", "first"))).toMatchObject({
      state: "running",
    });
    for (let turn = 0; turn < 8 && executions === 0; turn += 1) {
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    expect(executions).toBe(1);
    const queued = await bot.admit(
      command("run-2", "second", {
        lane: "user",
        supersedes: { runId: "run-1" },
      }),
    );
    expect(queued).toEqual({ runId: "run-2", state: "queued" });
    expect((await bot.readStoredRun("run-1"))?.status).toBe("running");
    const interruptsBeforeReplay = interrupts.length;

    const again = await bot.admit(
      command("run-2", "second", {
        lane: "user",
        supersedes: { runId: "run-1" },
      }),
    );
    expect(again).toEqual({ runId: "run-2", state: "queued" });
    expect(interrupts).toHaveLength(interruptsBeforeReplay);

    releaseFirst();
    await bot.pendingWork();
    expect(executions).toBe(2);
    expect(await bot.readStoredRun("run-2")).toMatchObject({
      status: "completed",
    });
  });

  test("eviction resumes accepted work without another admission", async () => {
    const storage = new MemoryStorage();
    let executions = 0;
    const first = authority(storage, () => {
      executions += 1;
      throw new BotTurnRecoveryRequiredError([]);
    });
    const receipt = await first.admit(command("run-1", "hello"));
    expect(receipt.runId).toBe("run-1");
    await first.pendingWork();
    expect(await first.readStoredRun("run-1")).toMatchObject({
      status: "running",
      phase: "executing",
    });

    const resumed = authority(storage, async (input) => {
      executions += 1;
      return completion(input.command.runId, "resumed");
    });
    await resumed.alarm();
    expect(executions).toBe(2);
    expect(await resumed.readStoredRun("run-1")).toMatchObject({
      status: "completed",
    });
  });

  test("an identical command replays one admission and a different payload is refused", async () => {
    const storage = new MemoryStorage();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let executions = 0;
    const settled: string[] = [];
    const bot = authority(
      storage,
      async (input) => {
        executions += 1;
        await gate;
        return completion(input.command.runId, "done");
      },
      {
        runSettled: (runId) => {
          settled.push(runId);
          return Promise.resolve();
        },
      },
    );
    const running = await bot.admit(command("run-1", "hello"));
    expect(await bot.admit(command("run-1", "hello"))).toEqual(running);
    await expect(bot.admit(command("run-1", "different"))).rejects.toThrow(
      /idempotency key/,
    );
    expect(executions).toBe(1);

    release();
    await bot.pendingWork();
    expect(executions).toBe(1);
    expect(settled).toEqual(["run-1"]);
    expect(await bot.admit(command("run-1", "hello"))).toEqual({
      runId: "run-1",
      state: "terminal",
    });
    expect(executions).toBe(1);
    expect(settled).toEqual(["run-1"]);
  });

  test("a fenced command cannot be admitted afterwards", async () => {
    const storage = new MemoryStorage();
    const bot = authority(storage, async (input) =>
      completion(input.command.runId, "done"),
    );
    await bot.fenceRunAdmission(identity, "run-1");
    await expect(bot.admit(command("run-1", "hello"))).rejects.toThrow(
      /fenced/,
    );
    expect(await bot.readStoredRun("run-1")).toBeUndefined();
  });
});
