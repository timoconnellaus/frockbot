import { describe, expect, test } from "bun:test";
import type { ConnectionView } from "@frockbot/configuration-core";
import {
  acknowledgeDependentAssignment,
  claimDependentAssignment,
  compensateDependentAssignment,
} from "./dependency-coordination.js";

function assignmentConnection(): ConnectionView {
  return {
    connectionId: "connection-1",
    packageId: "composio",
    connectionTypeId: "gmail",
    displayName: "Gmail",
    state: "ready",
    safeMetadata: {},
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

  test("preserves an acknowledged generation until a replacement commits", () => {
    const acknowledged = {
      ...assignmentConnection(),
      state: "ready" as const,
      safeMetadata: {
        dependentAssignments: [
          {
            botId: "bot-1",
            generation: "generation-1",
            status: "acknowledged",
          },
        ],
      },
    };
    const claimed = claimDependentAssignment(
      acknowledged,
      "bot-1",
      "generation-2",
    );

    expect(claimed?.safeMetadata.dependentAssignments).toEqual([
      {
        botId: "bot-1",
        generation: "generation-1",
        status: "acknowledged",
      },
      { botId: "bot-1", generation: "generation-2", status: "pending" },
    ]);
    expect(
      compensateDependentAssignment(claimed!, "bot-1", "generation-2")
        ?.safeMetadata.dependentAssignments,
    ).toEqual([
      {
        botId: "bot-1",
        generation: "generation-1",
        status: "acknowledged",
      },
    ]);
    expect(
      acknowledgeDependentAssignment(claimed!, "bot-1", "generation-2")
        ?.safeMetadata.dependentAssignments,
    ).toEqual([
      {
        botId: "bot-1",
        generation: "generation-2",
        status: "acknowledged",
      },
    ]);
  });
});
