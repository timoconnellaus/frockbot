import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  acknowledgeDependentAssignment,
  claimDependentAssignment,
} from "./dependency-coordination.js";

function assignmentConnection(): ConnectionView {
  return {
    connectionId: "connection-1",
    packageId: "composio",
    connectionTypeId: "gmail",
    displayName: "Gmail",
    state: "reconciliation-required",
    safeMetadata: {
      reconciliationOperation: "assignment",
      assignmentLeaseId: "generation-1",
    },
  };
}

describe("Connection dependency coordination", () => {
  test("records intent before acknowledgement and rejects revocation races", () => {
    const claimed = claimDependentAssignment(
      assignmentConnection(),
      "bot-1",
      "generation-1",
    );
    expect(claimed?.safeMetadata.dependentAssignments).toEqual([
      { botId: "bot-1", generation: "generation-1", status: "pending" },
    ]);
    expect(
      acknowledgeDependentAssignment(claimed!, "bot-1", "generation-1")
        ?.safeMetadata.dependentAssignments,
    ).toEqual([
      {
        botId: "bot-1",
        generation: "generation-1",
        status: "acknowledged",
      },
    ]);
    expect(
      claimDependentAssignment(
        {
          ...assignmentConnection(),
          state: "revoking",
          safeMetadata: {
            ...assignmentConnection().safeMetadata,
            revocationRequested: true,
          },
        },
        "bot-1",
        "generation-1",
      ),
    ).toBeUndefined();
  });
});
