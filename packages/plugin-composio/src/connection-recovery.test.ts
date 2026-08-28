import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  completeAssignmentCompensation,
  expireAssignmentLease,
  isSettledBotCompensation,
} from "./connection-recovery.js";

function connection(
  state: ConnectionView["state"],
  safeMetadata: ConnectionView["safeMetadata"],
): ConnectionView {
  return {
    connectionId: "connection-1",
    packageId: "composio",
    connectionTypeId: "gmail",
    displayName: "Gmail",
    state,
    safeMetadata,
  };
}

describe("Connection recovery", () => {
  test("terminalizes an admitted callback after alarm compensation", () => {
    const admitted = connection("reconciliation-required", {
      authorizationStateConsumed: true,
      reconciliationOperation: "assignment",
      assignmentLeaseId: "lease-1",
      assignmentLeaseExpiresAt: 100,
      targetBotId: "primary",
      assignmentGeneration: "lease-1",
    });
    const interrupted = expireAssignmentLease(admitted, 101);

    const completed = interrupted
      ? completeAssignmentCompensation(interrupted, "lease-1")
      : undefined;

    expect(completed).toMatchObject({
      state: "failed",
      failure: "Bot assignment was interrupted; reconnect to retry",
      safeMetadata: { authorizationStateConsumed: true },
    });
    expect(completed?.safeMetadata).not.toHaveProperty(
      "reconciliationOperation",
    );
    expect(completed?.safeMetadata).not.toHaveProperty(
      "assignmentCompensationPending",
    );
  });

  test("fails an expired lease that has no Bot effect to compensate", () => {
    const admitted = connection("reconciliation-required", {
      authorizationStateConsumed: true,
      reconciliationOperation: "assignment",
      assignmentLeaseId: "lease-1",
      assignmentLeaseExpiresAt: 100,
    });

    expect(expireAssignmentLease(admitted, 101)).toMatchObject({
      state: "failed",
      failure: "Bot assignment was interrupted; reconnect to retry",
    });
  });

  test("treats stale Bot generations as settled compensation", () => {
    expect(isSettledBotCompensation("stale")).toBe(true);
    expect(isSettledBotCompensation("applied")).toBe(true);
  });

  test("keeps revocation scheduled until every generation settles", () => {
    const revoking = connection("revoking", {
      assignmentCompensationPending: true,
      compensationRetryAt: Date.now() + 60_000,
      assignmentCompensations: [
        { botId: "primary", id: "old", expectedGeneration: "gen-old" },
        { botId: "primary", id: "new", expectedGeneration: "gen-new" },
      ],
    });

    const afterOld = completeAssignmentCompensation(revoking, "old");
    const afterNew = afterOld
      ? completeAssignmentCompensation(afterOld, "new")
      : undefined;

    expect(afterOld?.safeMetadata).toMatchObject({
      assignmentCompensationPending: true,
      assignmentCompensations: [
        { botId: "primary", id: "new", expectedGeneration: "gen-new" },
      ],
    });
    expect(afterNew?.safeMetadata.assignmentCompensations).toEqual([]);
    expect(afterNew?.safeMetadata).not.toHaveProperty(
      "assignmentCompensationPending",
    );
  });
});
