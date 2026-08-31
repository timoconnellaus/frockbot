import { describe, expect, test } from "bun:test";
import {
  MACHINE_QUOTA_DEFAULTS_V1,
  checkMachineQuotaV1,
  decodeMachineQuotaConfigV1,
  machineQuotaRefusalV1,
  type MachineQuotaOutcomeV1,
} from "./quota.ts";
import {
  MACHINE_COMMANDS_PER_DAY,
  MACHINE_MAX_PER_USER,
  MACHINE_MAX_QUEUE,
} from "./protocol.ts";

/**
 * `plugin-audit/src/bot.ts`'s `outcomeFor`, copied verbatim rather than
 * imported: a protocol package takes no dependency on a Package. The copy is
 * the point of the assertion — if the classifier's wording ever moves, this
 * test is where the machine refusals stop reading as `refused`.
 */
const AUDIT_REFUSAL = /\brefus|not allowed|denied|blocked while\b/i;

const refused = (outcome: MachineQuotaOutcomeV1) => {
  expect(outcome.status).toBe("refused");
  return outcome as Extract<MachineQuotaOutcomeV1, { status: "refused" }>;
};

describe("machine quota", () => {
  test("admits up to each limit and refuses at it", () => {
    expect(
      checkMachineQuotaV1({
        kind: "register",
        registeredMachines: MACHINE_MAX_PER_USER - 1,
      }),
    ).toEqual({ status: "within" });
    expect(
      refused(
        checkMachineQuotaV1({
          kind: "register",
          registeredMachines: MACHINE_MAX_PER_USER,
        }),
      ).limitName,
    ).toBe("machine-count");

    expect(
      checkMachineQuotaV1({
        kind: "dispatch",
        queuedCommands: MACHINE_MAX_QUEUE - 1,
        commandsToday: 0,
      }),
    ).toEqual({ status: "within" });
    expect(
      refused(
        checkMachineQuotaV1({
          kind: "dispatch",
          queuedCommands: MACHINE_MAX_QUEUE,
          commandsToday: 0,
        }),
      ).limitName,
    ).toBe("queue-depth");

    expect(
      refused(
        checkMachineQuotaV1({
          kind: "dispatch",
          queuedCommands: 0,
          commandsToday: MACHINE_COMMANDS_PER_DAY,
        }),
      ).limitName,
    ).toBe("commands-per-day");
  });

  test("a breach is an outcome, never a throw, and names its numbers", () => {
    const outcome = refused(
      checkMachineQuotaV1({
        kind: "dispatch",
        queuedCommands: MACHINE_MAX_QUEUE + 4,
        commandsToday: 0,
      }),
    );
    expect(outcome.used).toBe(MACHINE_MAX_QUEUE + 4);
    expect(outcome.limit).toBe(MACHINE_MAX_QUEUE);
    expect(outcome.reason).toContain(String(MACHINE_MAX_QUEUE));
  });

  test("every refusal reads as `refused` to the audit classifier", () => {
    const outcomes = [
      checkMachineQuotaV1({
        kind: "register",
        registeredMachines: MACHINE_MAX_PER_USER,
      }),
      checkMachineQuotaV1({
        kind: "dispatch",
        queuedCommands: MACHINE_MAX_QUEUE,
        commandsToday: 0,
      }),
      checkMachineQuotaV1({
        kind: "dispatch",
        queuedCommands: 0,
        commandsToday: MACHINE_COMMANDS_PER_DAY,
      }),
    ];
    for (const outcome of outcomes) {
      const text = machineQuotaRefusalV1(refused(outcome));
      expect(text.startsWith("Refused: ")).toBe(true);
      expect(AUDIT_REFUSAL.test(text)).toBe(true);
    }
  });

  test("a configured quota overrides the defaults", () => {
    const config = {
      ...MACHINE_QUOTA_DEFAULTS_V1,
      maxQueuedCommands: 2,
    };
    expect(
      checkMachineQuotaV1(
        { kind: "dispatch", queuedCommands: 1, commandsToday: 0 },
        config,
      ),
    ).toEqual({ status: "within" });
    expect(
      checkMachineQuotaV1(
        { kind: "dispatch", queuedCommands: 2, commandsToday: 0 },
        config,
      ).status,
    ).toBe("refused");
  });

  test("the defaults are the protocol's declared limits", () => {
    expect(MACHINE_QUOTA_DEFAULTS_V1).toEqual({
      schemaVersion: 1,
      maxMachinesPerUser: MACHINE_MAX_PER_USER,
      maxQueuedCommands: MACHINE_MAX_QUEUE,
      maxCommandsPerDay: MACHINE_COMMANDS_PER_DAY,
    });
  });

  test("the config decoder is exact-key and bounded", () => {
    expect(decodeMachineQuotaConfigV1(undefined)).toEqual(
      MACHINE_QUOTA_DEFAULTS_V1,
    );
    expect(
      decodeMachineQuotaConfigV1({ ...MACHINE_QUOTA_DEFAULTS_V1 }),
    ).toEqual(MACHINE_QUOTA_DEFAULTS_V1);
    for (const bad of [
      { ...MACHINE_QUOTA_DEFAULTS_V1, extra: 1 },
      { ...MACHINE_QUOTA_DEFAULTS_V1, schemaVersion: 2 },
      { ...MACHINE_QUOTA_DEFAULTS_V1, maxMachinesPerUser: 0 },
      { ...MACHINE_QUOTA_DEFAULTS_V1, maxQueuedCommands: 100_000 },
      { ...MACHINE_QUOTA_DEFAULTS_V1, maxCommandsPerDay: 1.5 },
      [MACHINE_QUOTA_DEFAULTS_V1],
    ]) {
      expect(() => decodeMachineQuotaConfigV1(bad)).toThrow();
    }
  });
});
