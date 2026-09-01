import { beforeEach, describe, expect, test } from "bun:test";
import {
  MACHINE_LIMITS_V1,
  machineConnectedV1,
  type MachineCommandV1,
} from "@frockbot/machine-protocol";
import {
  claimMachineCommandV1,
  dispatchMachineCommandV1,
  enrollMachineV1,
  listMachineRecordsV1,
  pendingMachineCommandsV1,
  readMachineRecordV1,
  readMachineResultV1,
  recordMachineResultV1,
  revokeMachineV1,
  sweepMachineLeasesV1,
  touchMachineV1,
  writeMachinePairingV1,
  MachineRegistryError,
} from "./store.ts";
import { createMemoryMachineStorageV1 } from "./testing.ts";
import { machineQueuePrefixV1, machineResultKeyV1 } from "./storage-keys.ts";

const USER = "store-user";
/** A `SHA-256` shaped digest: the record decoder insists on one. */
const digestFor = (seed: string): string =>
  [...seed]
    .reduce((hash, ch) => hash + ch.charCodeAt(0), 0)
    .toString(16)
    .padStart(2, "0")
    .repeat(32)
    .slice(0, 64);
const T0 = Date.parse("2026-09-01T00:00:00.000Z");

let storage = createMemoryMachineStorageV1();

beforeEach(() => {
  storage = createMemoryMachineStorageV1();
});

async function register(
  machineId: string,
  options: { now?: number; capabilities?: ("exec" | "files")[] } = {},
) {
  const now = options.now ?? T0;
  await writeMachinePairingV1(storage, {
    userId: USER,
    machineId,
    codeDigest: digestFor(`code-${machineId}`),
    now,
  });
  return enrollMachineV1(storage, {
    userId: USER,
    machineId,
    enrollment: {
      schemaVersion: 1,
      code: `code-${machineId}`,
      label: `${machineId}.local`,
      platform: "macos",
      agentVersion: "0.0.1",
      capabilities: options.capabilities ?? ["exec", "files"],
    },
    codeDigest: digestFor(`code-${machineId}`),
    tokenDigest: digestFor(`token-${machineId}`),
    now,
  });
}

function command(
  machineId: string,
  commandId: string,
  overrides: Partial<MachineCommandV1> = {},
): MachineCommandV1 {
  return {
    schemaVersion: 1,
    commandId,
    machineId,
    botId: "bot",
    runId: "run",
    turn: 1,
    approvalId: commandId,
    op: {
      kind: "exec",
      command: "git status",
      timeoutMs: 30_000,
      maxOutputBytes: 4_096,
    },
    issuedAt: new Date(T0).toISOString(),
    status: "queued",
    ...overrides,
  };
}

describe("the registry", () => {
  test("enrollment spends the pairing offer exactly once", async () => {
    const machineId = "m-1";
    const record = await register(machineId);
    expect(record).toMatchObject({ machineId, userId: USER, keyVersion: 1 });
    // The offer is gone, so the same code cannot register a second machine.
    await expect(
      enrollMachineV1(storage, {
        userId: USER,
        machineId,
        enrollment: {
          schemaVersion: 1,
          code: `code-${machineId}`,
          label: "again.local",
          platform: "macos",
          agentVersion: "0.0.1",
          capabilities: ["exec"],
        },
        codeDigest: digestFor(`code-${machineId}`),
        tokenDigest: digestFor("token-again"),
        now: T0,
      }),
    ).rejects.toThrow(/invalid or has expired/);
  });

  test("an expired offer, another User's, and a different code are all refused", async () => {
    await writeMachinePairingV1(storage, {
      userId: USER,
      machineId: "m-expired",
      codeDigest: digestFor("digest"),
      now: T0,
    });
    const enrollment = {
      schemaVersion: 1 as const,
      code: "code",
      label: "late.local",
      platform: "macos" as const,
      agentVersion: "0.0.1",
      capabilities: ["exec" as const],
    };
    const attempt = (input: {
      userId?: string;
      codeDigest?: string;
      now?: number;
    }) =>
      enrollMachineV1(storage, {
        userId: input.userId ?? USER,
        machineId: "m-expired",
        enrollment,
        codeDigest: input.codeDigest ?? digestFor("digest"),
        tokenDigest: digestFor("token"),
        now: input.now ?? T0,
      });
    await expect(
      attempt({ now: T0 + MACHINE_LIMITS_V1.pairingTtlMs + 1 }),
    ).rejects.toThrow(MachineRegistryError);
    await expect(attempt({ userId: "someone-else" })).rejects.toThrow(
      MachineRegistryError,
    );
    await expect(attempt({ codeDigest: digestFor("another") })).rejects.toThrow(
      MachineRegistryError,
    );
    // …and the untouched offer still works, so none of the refusals spent it.
    await expect(attempt({})).resolves.toMatchObject({
      machineId: "m-expired",
    });
  });

  test("the machine quota refuses the ninth registration", async () => {
    for (let index = 0; index < MACHINE_LIMITS_V1.maxMachinesPerUser; index++) {
      await register(`m-${index}`);
    }
    await expect(register("m-over")).rejects.toThrow(/^Refused: /);
    // A revoked machine frees its slot: the row stays as evidence, the quota
    // counts what is live.
    await revokeMachineV1(storage, "m-0", T0);
    await expect(register("m-freed")).resolves.toMatchObject({
      machineId: "m-freed",
    });
  });

  test("presence is arithmetic over lastSeenAt, and a revoked machine is never connected", async () => {
    await register("m-live");
    const fresh = await readMachineRecordV1(storage, "m-live");
    expect(machineConnectedV1(fresh!, T0)).toBe(true);
    expect(
      machineConnectedV1(fresh!, T0 + MACHINE_LIMITS_V1.presenceTtlMs + 1),
    ).toBe(false);
    await touchMachineV1(storage, "m-live", T0 + 60_000);
    const touched = await readMachineRecordV1(storage, "m-live");
    expect(machineConnectedV1(touched!, T0 + 60_000)).toBe(true);
    const revoked = await revokeMachineV1(storage, "m-live", T0 + 60_000);
    expect(revoked.keyVersion).toBe(2);
    expect(machineConnectedV1(revoked, T0 + 60_000)).toBe(false);
  });

  test("revocation purges the queue and leaves the row", async () => {
    await register("m-revoke");
    await dispatchMachineCommandV1(storage, command("m-revoke", "c-1"), T0);
    await revokeMachineV1(storage, "m-revoke", T0);
    expect(
      storage
        .keys()
        .filter((key) => key.startsWith(machineQueuePrefixV1("m-revoke"))),
    ).toEqual([]);
    expect(await listMachineRecordsV1(storage)).toHaveLength(1);
  });
});

describe("the queue", () => {
  test("a dispatch is idempotent on commandId", async () => {
    await register("m-q");
    const first = await dispatchMachineCommandV1(
      storage,
      command("m-q", "c-1"),
      T0,
    );
    const second = await dispatchMachineCommandV1(
      storage,
      command("m-q", "c-1"),
      T0,
    );
    expect(first.status).toBe("queued");
    expect(second.status).toBe("duplicate");
    expect(await pendingMachineCommandsV1(storage, "m-q")).toHaveLength(1);
  });

  test("the queue refuses visibly at its depth limit", async () => {
    await register("m-full");
    for (let index = 0; index < MACHINE_LIMITS_V1.maxQueue; index++) {
      const outcome = await dispatchMachineCommandV1(
        storage,
        command("m-full", `c-${index}`),
        T0,
      );
      expect(outcome.status).toBe("queued");
    }
    const refused = await dispatchMachineCommandV1(
      storage,
      command("m-full", "c-over"),
      T0,
    );
    expect(refused).toMatchObject({ status: "refused" });
    // The wording is what `plugin-audit` classifies `refused` rather than
    // `error`, so it is asserted rather than assumed.
    expect(refused.status === "refused" ? refused.reason : "").toMatch(
      /^Refused: /,
    );
  });

  test("a machine that is unknown, revoked or lacks the capability is refused", async () => {
    expect(
      await dispatchMachineCommandV1(storage, command("m-none", "c"), T0),
    ).toMatchObject({ status: "refused" });
    await register("m-files", { capabilities: ["files"] });
    expect(
      await dispatchMachineCommandV1(storage, command("m-files", "c"), T0),
    ).toMatchObject({ status: "refused" });
    await register("m-gone");
    await revokeMachineV1(storage, "m-gone", T0);
    expect(
      await dispatchMachineCommandV1(storage, command("m-gone", "c"), T0),
    ).toMatchObject({ status: "refused" });
  });

  test("the daily quota counts dispatches rather than the queue's depth", async () => {
    await register("m-day");
    // Drain after each dispatch, so the queue is never deep: only a durable
    // counter can notice a Bot that has asked five hundred times today.
    for (let index = 0; index < 4; index++) {
      await dispatchMachineCommandV1(
        storage,
        command("m-day", `c-${index}`),
        T0,
      );
      await claimMachineCommandV1(storage, "m-day", `c-${index}`, T0);
      await recordMachineResultV1(
        storage,
        "m-day",
        {
          schemaVersion: 1,
          commandId: `c-${index}`,
          finishedAt: new Date(T0).toISOString(),
          outcome: "ok",
          truncated: false,
          exitCode: 0,
        },
        T0,
      );
    }
    const usage = storage
      .keys()
      .filter((key) => key.startsWith("machine-usage:"));
    expect(usage).toHaveLength(1);
    expect(await storage.get(usage[0]!)).toMatchObject({ count: 4 });
  });
});

describe("claims, results and leases", () => {
  test("the second claim answers already-claimed with the first claim's lease", async () => {
    await register("m-claim");
    await dispatchMachineCommandV1(storage, command("m-claim", "c-1"), T0);
    const first = await claimMachineCommandV1(storage, "m-claim", "c-1", T0);
    const second = await claimMachineCommandV1(
      storage,
      "m-claim",
      "c-1",
      T0 + 5,
    );
    expect(first.status).toBe("claimed");
    expect(second).toMatchObject({
      status: "already-claimed",
      leaseExpiresAt: first.leaseExpiresAt,
    });
    // A claimed command is not offered to the next poll.
    expect(await pendingMachineCommandsV1(storage, "m-claim")).toEqual([]);
  });

  test("a result is recorded once and replayed thereafter", async () => {
    await register("m-result");
    await dispatchMachineCommandV1(storage, command("m-result", "c-1"), T0);
    await claimMachineCommandV1(storage, "m-result", "c-1", T0);
    const result = {
      schemaVersion: 1 as const,
      commandId: "c-1",
      finishedAt: new Date(T0 + 1_000).toISOString(),
      outcome: "ok" as const,
      truncated: false,
      exitCode: 0,
      stdout: "clean",
    };
    const first = await recordMachineResultV1(storage, "m-result", result, T0);
    expect(first.receipt.status).toBe("recorded");
    const replay = await recordMachineResultV1(
      storage,
      "m-result",
      { ...result, stdout: "different" },
      T0,
    );
    expect(replay.receipt.status).toBe("replayed");
    // The replay changed nothing: the first answer is still the answer.
    expect(await readMachineResultV1(storage, "c-1")).toMatchObject({
      stdout: "clean",
    });
    expect(
      storage
        .keys()
        .filter((key) => key.startsWith(machineQueuePrefixV1("m-result"))),
    ).toEqual([]);
  });

  test("a lease expiry re-queues once and then terminates as unknown", async () => {
    await register("m-lease");
    await dispatchMachineCommandV1(storage, command("m-lease", "c-1"), T0);
    await claimMachineCommandV1(storage, "m-lease", "c-1", T0);

    const early = await sweepMachineLeasesV1(
      storage,
      "m-lease",
      T0 + MACHINE_LIMITS_V1.leaseMs - 1,
    );
    expect(early).toMatchObject({ requeued: [], terminated: [] });

    const first = await sweepMachineLeasesV1(
      storage,
      "m-lease",
      T0 + MACHINE_LIMITS_V1.leaseMs + 1,
    );
    expect(first.requeued).toEqual(["c-1"]);
    expect(await pendingMachineCommandsV1(storage, "m-lease")).toHaveLength(1);

    const second = T0 + MACHINE_LIMITS_V1.leaseMs + 2;
    await claimMachineCommandV1(storage, "m-lease", "c-1", second);
    const terminal = await sweepMachineLeasesV1(
      storage,
      "m-lease",
      second + MACHINE_LIMITS_V1.leaseMs + 1,
    );
    expect(terminal).toMatchObject({ requeued: [], terminated: ["c-1"] });
    expect(await pendingMachineCommandsV1(storage, "m-lease")).toEqual([]);
    // The terminal fact is durable and says the outcome is unknown, rather
    // than the command quietly disappearing off somebody's laptop.
    expect(await storage.get(machineResultKeyV1("c-1"))).toMatchObject({
      outcome: "error",
      message: expect.stringContaining("unknown"),
    });
  });

  test("a claim or a result for a command that is not queued is a 404", async () => {
    await register("m-missing");
    await expect(
      claimMachineCommandV1(storage, "m-missing", "nope", T0),
    ).rejects.toThrow(MachineRegistryError);
    await expect(
      recordMachineResultV1(
        storage,
        "m-missing",
        {
          schemaVersion: 1,
          commandId: "nope",
          finishedAt: new Date(T0).toISOString(),
          outcome: "ok",
          truncated: false,
        },
        T0,
      ),
    ).rejects.toThrow(MachineRegistryError);
  });
});
