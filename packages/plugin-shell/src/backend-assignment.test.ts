import { describe, expect, test } from "bun:test";
import {
  settleAssignmentSaga,
  type AssignmentSagaEffects,
  type StoredAssignmentSaga,
} from "./backend-assignment.js";

function saga(phase: StoredAssignmentSaga["phase"]): StoredAssignmentSaga {
  return {
    schemaVersion: 1,
    commandId: "command-1",
    commandFingerprint: "configuration-command-v1:test",
    userId: "user-1",
    botId: "bot-1",
    assignmentId: "assignment-1",
    connectionId: "connection-1",
    generation: "generation-1",
    phase,
    deadlineAt: Date.now() + 60_000,
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
    rejectCommitted: () => {
      log.push("reject-committed");
      return Promise.resolve();
    },
  };
}

describe("assignment saga settlement", () => {
  test("compensates a dependency claim interrupted before Bot commit", async () => {
    const log: string[] = [];

    await expect(
      settleAssignmentSaga(saga("claiming"), effects(log)),
    ).resolves.toBe("compensated");
    expect(log).toEqual(["compensate"]);
  });

  test("acknowledges a dependency after its Bot commit", async () => {
    const log: string[] = [];

    await expect(
      settleAssignmentSaga(saga("committed"), effects(log)),
    ).resolves.toBe("acknowledged");
    expect(log).toEqual(["acknowledge"]);
  });

  test("rejects a committed Bot assignment when acknowledgement loses a race", async () => {
    const log: string[] = [];

    await expect(
      settleAssignmentSaga(saga("committed"), effects(log, false)),
    ).resolves.toBe("rejected");
    expect(log).toEqual(["acknowledge", "reject-committed"]);
  });
});
