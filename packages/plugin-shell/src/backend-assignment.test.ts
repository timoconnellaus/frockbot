import { describe, expect, test } from "bun:test";
import {
  nextAssignmentPhase,
  requireStoredAssignmentSaga,
  settleAssignmentSaga,
  type AssignmentSagaEffects,
  type StoredAssignmentSaga,
} from "./backend-assignment.js";

function saga(
  phase: StoredAssignmentSaga["phase"],
  input: Partial<StoredAssignmentSaga> = {},
): StoredAssignmentSaga {
  return {
    schemaVersion: 1,
    commandId: "command-1",
    commandFingerprint: "configuration-command-v1:test",
    userId: "user-1",
    botId: "bot-1",
    operation: "replacing",
    assignmentId: "mail",
    generation: "generation-1",
    phase,
    target: {
      assignmentId: "mail",
      packageId: "mail",
      capabilityId: "send",
      connectionId: "new-connection",
    },
    previous: {
      assignmentId: "mail",
      packageId: "mail",
      capabilityId: "send",
      connectionId: "old-connection",
      state: "enabled",
    },
    previousGeneration: "old-generation",
    deadlineAt: Date.now() + 60_000,
    ...input,
    acceptedReceipt: input.acceptedReceipt ?? {
      schemaVersion: 1,
      commandId: "command-1",
      revision: 0,
      status: "pending",
    },
  };
}

function effects(log: string[], acknowledge = true): AssignmentSagaEffects {
  return {
    acknowledge: () => {
      log.push("acknowledge");
      return Promise.resolve(acknowledge);
    },
    compensate: () => {
      log.push("compensate");
      return Promise.resolve();
    },
    release: () => {
      log.push("release");
      return Promise.resolve(true);
    },
    rejectCommitted: () => {
      log.push("reject-committed");
      return Promise.resolve();
    },
  };
}

describe("Assignment saga transitions", () => {
  test("orders Replace as claim, commit, acknowledge, release", () => {
    const committed = nextAssignmentPhase(saga("claiming"), "claimed")!;
    const acknowledged = nextAssignmentPhase(committed, "committed")!;
    const releasing = nextAssignmentPhase(acknowledged, "acknowledged")!;
    expect([committed.phase, acknowledged.phase, releasing.phase]).toEqual([
      "committing",
      "acknowledging",
      "releasing",
    ]);
    expect(nextAssignmentPhase(releasing, "released")).toBeUndefined();
  });

  test("finishes a connection-free Assign after commit", () => {
    expect(
      nextAssignmentPhase(
        saga("committing", {
          operation: "assigning",
          target: {
            assignmentId: "clock",
            packageId: "clock",
            capabilityId: "time",
          },
          previous: undefined,
          previousGeneration: undefined,
        }),
        "committed",
      ),
    ).toBeUndefined();
  });

  test("strictly decodes durable saga state", () => {
    expect(requireStoredAssignmentSaga(saga("claiming"))).toMatchObject({
      operation: "replacing",
      phase: "claiming",
    });
    expect(() =>
      requireStoredAssignmentSaga({ ...saga("claiming"), extra: true }),
    ).toThrow("invalid fields");
    const hidden = saga("claiming") as StoredAssignmentSaga & { hidden?: true };
    Object.defineProperty(hidden, "hidden", { value: true });
    expect(() => requireStoredAssignmentSaga(hidden)).toThrow("invalid fields");
    expect(() =>
      requireStoredAssignmentSaga({
        ...saga("claiming"),
        [Symbol("extra")]: true,
      }),
    ).toThrow("invalid fields");
    expect(() =>
      requireStoredAssignmentSaga({
        ...saga("claiming"),
        acceptedReceipt: {
          schemaVersion: 1,
          commandId: "command-1",
          revision: 0,
          status: "applied",
        },
      }),
    ).toThrow("accepted receipt is invalid");
  });

  test("rejects out-of-order advancement", () => {
    expect(() => nextAssignmentPhase(saga("claiming"), "released")).toThrow(
      "cannot apply released while claiming",
    );
  });

  test("compensates a claiming saga and rejects an unacknowledged commit", async () => {
    const compensated: string[] = [];
    await expect(
      settleAssignmentSaga(saga("claiming"), effects(compensated)),
    ).resolves.toBe("compensated");
    expect(compensated).toEqual(["compensate"]);

    const acknowledged: string[] = [];
    await expect(
      settleAssignmentSaga(saga("acknowledging"), effects(acknowledged)),
    ).resolves.toBe("acknowledged");
    expect(acknowledged).toEqual(["acknowledge"]);

    const log: string[] = [];
    await expect(
      settleAssignmentSaga(saga("acknowledging"), effects(log, false)),
    ).resolves.toBe("rejected");
    expect(log).toEqual([
      "acknowledge",
      "compensate",
      "release",
      "reject-committed",
    ]);
  });
});
