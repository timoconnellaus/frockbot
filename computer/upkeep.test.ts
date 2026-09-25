// What a Turn keeps for the Computer: the User's sign-ins, and a recent
// checkpoint. The Computer here is the in-memory host, given a browser, and
// the vault is the host application's rules over a Map.
import { describe, expect, test } from "bun:test";
import { createAgentLoop } from "@frockbot/core/agent-loop";
import type { LlmProvider } from "@frockbot/core/contracts";
import { createAgentRuntimeHarness } from "@frockbot/app/testkit";
import type { ComputerHostV1 } from "@frockbot/computer/core/host";
import {
  createFakeComputerHostV1,
  fakeLoginNamesV1,
  fakeLoginsStateV1,
  type FakeComputerHostV1,
} from "@frockbot/computer/fake";
import { createComputerAgentFeature } from "./agent.js";
import {
  COMPUTER_CHECKPOINT_CHECK_INTERVAL_MS,
  COMPUTER_CHECKPOINT_RECORD_KEY,
  COMPUTER_LOGINS_CAPTURE_INTERVAL_MS,
  decodeStoredComputerCheckpointV1,
  upkeepComputerAfterTurnV1,
  type ComputerLoginsKeepOutcomeV1,
  type ComputerLoginsKeptV1,
  type ComputerLoginVaultV1,
} from "./upkeep.js";

const COMPOSITION = {
  generationId: "1970-01-01T00:00:00.000Z:0123456789abcdef",
  artifactSetHash: "a".repeat(64),
};

class MemoryRecords {
  readonly values = new Map<string, unknown>();

  get<T>(key: string): Promise<T | undefined> {
    return Promise.resolve(structuredClone(this.values.get(key)) as T);
  }

  put<T>(key: string, value: T): Promise<void> {
    this.values.set(key, structuredClone(value));
    return Promise.resolve();
  }
}

class MemoryVault implements ComputerLoginVaultV1 {
  held?: ComputerLoginsKeptV1;
  owedSince?: string;
  readonly keeps: ComputerLoginsKeepOutcomeV1[] = [];

  owed(): Promise<string | undefined> {
    return Promise.resolve(this.owedSince);
  }

  kept(): Promise<ComputerLoginsKeptV1 | undefined> {
    return Promise.resolve(this.held);
  }

  keep(capture: ComputerLoginsKeptV1): Promise<ComputerLoginsKeepOutcomeV1> {
    const outcome: ComputerLoginsKeepOutcomeV1 = this.owedSince
      ? "owed"
      : "kept";
    if (outcome === "kept") this.held = capture;
    this.keeps.push(outcome);
    return Promise.resolve(outcome);
  }

  owe(at: string): Promise<"owed" | "deleted"> {
    this.owedSince ??= at;
    return Promise.resolve("owed");
  }

  settle(owedSince: string): Promise<void> {
    if (this.owedSince === owedSince) this.owedSince = undefined;
    return Promise.resolve();
  }

  deletedSince(): Promise<boolean> {
    return Promise.resolve(false);
  }
}

/** The in-memory host, with a browser a Turn can drive. */
function withBrowser(host: FakeComputerHostV1): ComputerHostV1 {
  return {
    id: host.id,
    capabilities: host.capabilities,
    open: async (identity, tenant, assignment, options) => ({
      ...(await host.open(identity, tenant, assignment, options)),
      browser: {
        perform: () => Promise.resolve({ accessibilitySnapshot: "a page" }),
      },
    }),
  };
}

/** A model that drives the browser once, or not at all, and stops. */
function model(driveBrowser: boolean): LlmProvider {
  let issued = false;
  return {
    id: "scripted",
    async *stream() {
      if (!issued) {
        issued = true;
        yield {
          type: "tool-call",
          call: {
            id: "call-1",
            name: "call_dynamic_tool",
            input: {
              namespace: "frockbot",
              toolName: driveBrowser ? "computer_browser" : "computer_exec",
              arguments: driveBrowser
                ? { action: "snapshot" }
                : { command: "pwd" },
            },
          },
        };
        yield { type: "finish", reason: "tool-calls" };
        return;
      }
      yield { type: "text-delta", text: "done" };
      yield { type: "finish", reason: "completed" };
    },
  };
}

async function runTurn(input: {
  host: ComputerHostV1;
  records: MemoryRecords;
  vault: MemoryVault;
  driveBrowser: boolean;
  now: () => number;
}): Promise<void> {
  const runtime = createAgentRuntimeHarness();
  const scripted = model(input.driveBrowser);
  runtime.llm.register(scripted);
  runtime.computers.register(input.host);
  await runtime.mount(
    createComputerAgentFeature({
      userId: "user-1",
      defaultProviderId: input.host.id,
      upkeep: { records: input.records, vault: input.vault },
      now: input.now,
    }),
  );
  const loop = createAgentLoop(runtime, {
    maxSteps: 4,
    composition: COMPOSITION,
  });
  const handle = await loop.create({
    botId: "bot-1",
    sessionId: "session-1",
    provider: scripted.id,
    model: "test-model",
    admitEffect: () => Promise.resolve(true),
  });
  handle.agent.send("use the Computer");
  await handle.agent.whenIdle();
  await loop.dispose();
  await runtime.dispose();
}

describe("a Turn's upkeep of the Computer", () => {
  test("a Turn that drove the browser keeps the sign-ins and a checkpoint at its end", async () => {
    const now = Date.parse("2026-09-24T00:00:00.000Z");
    const fake = createFakeComputerHostV1({ now: () => now });
    fake.computerFor({ userId: "user-1" }).signIns = ["mail.example"];
    const records = new MemoryRecords();
    const vault = new MemoryVault();

    await runTurn({
      host: withBrowser(fake),
      records,
      vault,
      driveBrowser: true,
      now: () => now,
    });

    expect(vault.keeps).toEqual(["kept"]);
    expect(fakeLoginNamesV1(vault.held!.state)).toEqual(["mail.example"]);
    const checkpoint = decodeStoredComputerCheckpointV1(
      records.values.get(COMPUTER_CHECKPOINT_RECORD_KEY),
    );
    expect(checkpoint?.checkpoint?.createdAt).toBe("2026-09-24T00:00:00.000Z");
  });

  test("a Turn that never drove the browser keeps no sign-ins", async () => {
    const fake = createFakeComputerHostV1();
    const vault = new MemoryVault();

    await runTurn({
      host: withBrowser(fake),
      records: new MemoryRecords(),
      vault,
      driveBrowser: false,
      now: Date.now,
    });

    expect(vault.keeps).toEqual([]);
  });

  test("a machine owed the sign-ins has them back before the Turn's first look", async () => {
    const fake = createFakeComputerHostV1();
    const machine = fake.computerFor({ userId: "user-1" });
    machine.signIns = [];
    const vault = new MemoryVault();
    vault.held = {
      state: fakeLoginsStateV1(["mail.example"]),
      count: 1,
      capturedAt: "2026-09-23T00:00:00.000Z",
    };
    vault.owedSince = "2026-09-23T01:00:00.000Z";

    await runTurn({
      host: withBrowser(fake),
      records: new MemoryRecords(),
      vault,
      driveBrowser: false,
      now: Date.now,
    });

    expect(machine.signIns).toEqual(["mail.example"]);
    expect(vault.owedSince).toBeUndefined();
    const restore = fake.calls.indexOf("logins:restore:bot-1");
    expect(restore).toBeGreaterThan(-1);
    expect(restore).toBeLessThan(
      fake.calls.findIndex((call) => call.startsWith("exec:")),
    );
  });
});

describe("the upkeep's cadence", () => {
  async function session(fake: FakeComputerHostV1) {
    return fake.open(
      { userId: "user-1" },
      { botId: "bot-1" },
      { providerId: fake.id, generation: 1 },
    );
  }

  test("keeps the sign-ins at most once an interval, and asks for a checkpoint at most daily", async () => {
    let now = Date.parse("2026-09-24T00:00:00.000Z");
    const fake = createFakeComputerHostV1({ now: () => now });
    const computer = await session(fake);
    const records = new MemoryRecords();
    const vault = new MemoryVault();
    const run = () =>
      upkeepComputerAfterTurnV1({
        computer,
        records,
        vault,
        browserUsed: true,
        effectIdOf: (step) => Promise.resolve(`turn-${now}:${step}`),
        now: () => new Date(now),
      });

    await run();
    now += COMPUTER_LOGINS_CAPTURE_INTERVAL_MS - 1;
    await run();
    now += 1;
    await run();

    expect(vault.keeps).toEqual(["kept", "kept"]);
    expect(
      fake.calls.filter((call) => call.startsWith("checkpoint:")),
    ).toHaveLength(1);

    now += COMPUTER_CHECKPOINT_CHECK_INTERVAL_MS;
    await run();
    // Asked again after a day, and answered by the week-old one's youth.
    expect(
      fake.calls.filter((call) => call.startsWith("checkpoint:")),
    ).toHaveLength(2);
    expect(fake.computerFor({ userId: "user-1" }).checkpoints).toHaveLength(1);
  });

  test("a machine that refuses a checkpoint is asked again the next day, not every Turn", async () => {
    let now = Date.parse("2026-09-24T00:00:00.000Z");
    const records = new MemoryRecords();
    let asked = 0;
    const computer = {
      ...(await session(createFakeComputerHostV1())),
      machine: {
        checkpoint: () => {
          asked += 1;
          return Promise.reject(new Error("the Computer is updating"));
        },
        reset: () => Promise.reject(new Error("unused")),
        replace: () => Promise.reject(new Error("unused")),
      },
    };
    const run = () =>
      upkeepComputerAfterTurnV1({
        computer,
        records,
        browserUsed: false,
        effectIdOf: (step) => Promise.resolve(step),
        now: () => new Date(now),
      });

    await run();
    await run();
    now += COMPUTER_CHECKPOINT_CHECK_INTERVAL_MS;
    await run();

    expect(asked).toBe(2);
  });
});
